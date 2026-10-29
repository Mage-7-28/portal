//! Portal 的 SSH/SFTP 后端实现。
//!
//! 本模块负责维护连接和主机指纹，提供远程目录/文件操作、递归目录大小统计、
//! 文件传输以及交互式 PTY 终端。耗时的扫描和传输会放到独立线程或 Tauri
//! blocking runtime 中执行，并通过事件把进度和状态返回给前端。

use std::collections::{HashMap, VecDeque};
#[cfg(test)]
use std::fs;
use std::fs::File;
use std::io::{BufReader, BufWriter, Read, Write};
use std::net::{SocketAddr, TcpStream, ToSocketAddrs};
use std::path::{Component, Path, PathBuf};
use std::sync::atomic::{AtomicBool, AtomicUsize, Ordering};
use std::sync::{Arc, Condvar, Mutex, RwLock};
use std::thread;
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

use crate::local_transfer::{LocalDownload, LocalTransferRoot};
use crate::remote_policy::{parse_remote_uid, RemoteMutationPolicy};
use crate::scan_budget::ScanBudget;
use crate::terminal_flow::{InputSequence, OutputFlow, PendingResize};
use crate::transfer_tasks::{TaskSnapshot, TransferTasks};
use crate::transfer_validation::{
    validate_transfer, validate_upload_target, SourceStamp, UploadTargetStamp,
};
use base64::{engine::general_purpose::STANDARD as BASE64_STANDARD, Engine as _};
use serde::Serialize;
use serde_json::json;
use ssh2::{Channel, ErrorCode, ExtendedData, HashType, RenameFlags, Session, Sftp};
use tauri::{AppHandle, Emitter, State, WebviewWindow};
#[path = "transfer_pool.rs"]
mod transfer_pool;
#[path = "transfer_prefetch.rs"]
mod transfer_prefetch;
#[path = "transfer_service.rs"]
mod transfer_service;
use thiserror::Error;
use transfer_pool::{IdleTransferSession, TransferSessionLease};

// SSH 建连默认超时、文件传输缓冲、保活间隔和并发传输上限。
const DEFAULT_TIMEOUT_MS: u64 = 30_000;
const TRANSFER_BUFFER_SIZE: usize = 64 * 1024;
const KEEPALIVE_INTERVAL_SECS: u32 = 30;
// 目录大小统计最多同时使用 4 个独立工作会话，兼顾速度与远端 SSH 会话压力。
const MAX_CONCURRENT_DIRECTORY_SIZE_WORKERS: usize = 4;
// 同一工作会话连续处理少量子目录，降低反复创建 SFTP 子会话的开销，同时保留调度公平性。
const DIRECTORY_SIZE_WORKER_BATCH_SIZE: usize = 8;
// GNU/Linux 的远端 `du` 只返回一行汇总结果；限制输出大小，避免异常远端命令占满内存。
const MAX_DIRECTORY_SIZE_COMMAND_OUTPUT_BYTES: usize = 64 * 1024;
// 监控命令采集可见进程并限制总数和输出大小，避免远端数据占用过多本地内存。
const MAX_SERVER_MONITOR_OUTPUT_BYTES: usize = 512 * 1024;
const MAX_SERVER_MONITOR_PROCESSES: usize = 500;
const SERVER_MONITOR_COMMAND_TIMEOUT_MS: u32 = 10_000;
const SERVER_MONITOR_MIN_INTERVAL: Duration = Duration::from_secs(3);
// 目录命令轮询、预览大小和终端输入/控制/尺寸的安全边界。
const DIRECTORY_SIZE_COMMAND_POLL_INTERVAL: Duration = Duration::from_millis(20);
const MAX_PREVIEW_BYTES: u64 = 5 * 1024 * 1024;
const MAX_CONCURRENT_PREVIEWS: usize = 2;
static NEXT_PREVIEW_ID: AtomicUsize = AtomicUsize::new(0);
const MAX_TERMINAL_INPUT_BYTES: usize = 64 * 1024;
const TERMINAL_WRITE_TIMEOUT: Duration = Duration::from_secs(10);
const TERMINAL_CONTROL_TIMEOUT: Duration = Duration::from_secs(2);
const TERMINAL_POLL_INTERVAL: Duration = Duration::from_millis(12);
const MAX_BLOCKING_COMMANDS: usize = 16;
static ACTIVE_BLOCKING_COMMANDS: AtomicUsize = AtomicUsize::new(0);

struct BlockingCommandSlot;

impl Drop for BlockingCommandSlot {
    fn drop(&mut self) {
        ACTIVE_BLOCKING_COMMANDS.fetch_sub(1, Ordering::AcqRel);
    }
}

/// 在创建后台任务前取得名额，任务完成或创建失败时由 RAII 释放。
fn blocking_command_slot() -> Result<BlockingCommandSlot, SshError> {
    ACTIVE_BLOCKING_COMMANDS
        .fetch_update(Ordering::AcqRel, Ordering::Acquire, |count| {
            (count < MAX_BLOCKING_COMMANDS).then_some(count + 1)
        })
        .map_err(|_| SshError::BackgroundBusy)?;
    Ok(BlockingCommandSlot)
}

/// 原生异步命令只负责调度；同步DNS/SSH/SFTP在有界阻塞池中执行。
async fn run_blocking_command<T: Send + 'static>(
    task: impl FnOnce() -> Result<T, SshError> + Send + 'static,
) -> Result<T, SshError> {
    let slot = blocking_command_slot()?;
    tauri::async_runtime::spawn_blocking(move || {
        let _slot = slot;
        task()
    })
    .await
    .map_err(|error| SshError::FileOperationFailed(format!("后台操作失败: {error}")))?
}

// libssh2-sys 中的传输和 SFTP 错误码。这里在本地维护，避免 ssh2 已提供原始值时
// 再增加一个直接依赖。
const LIBSSH2_ERROR_SOCKET_SEND: i32 = -7;
const LIBSSH2_ERROR_TIMEOUT: i32 = -9;
const LIBSSH2_ERROR_SOCKET_DISCONNECT: i32 = -13;
const LIBSSH2_ERROR_SOCKET_TIMEOUT: i32 = -30;
const LIBSSH2_ERROR_SOCKET_RECV: i32 = -43;
const LIBSSH2_ERROR_BAD_SOCKET: i32 = -45;
const LIBSSH2_ERROR_EAGAIN: i32 = -37;
const LIBSSH2_FX_NO_SUCH_FILE: i32 = 2;
const LIBSSH2_FX_NO_CONNECTION: i32 = 6;
const LIBSSH2_FX_CONNECTION_LOST: i32 = 7;
const LIBSSH2_FX_FAILURE: i32 = 4;
const LIBSSH2_FX_OP_UNSUPPORTED: i32 = 8;

/// 可序列化的 SSH/SFTP 领域错误，作为 Tauri IPC 的统一错误协议返回前端。
#[derive(Clone, Error, Debug, Serialize)]
#[serde(tag = "code", content = "message")]
pub enum SshError {
    /// 请求的连接不存在，或尚未建立可用会话。
    #[error("连接不存在或未连接")]
    ConnectionNotFound,
    /// 旧操作不可在同 ID 的新会话上重新登记。
    #[error("连接会话已更新，请重新操作")]
    ConnectionGenerationChanged,
    /// 只限制启动登记等待，不限制已经运行的健康传输时长。
    #[error("文件任务启动请求已过期，未执行该请求")]
    TransferStartExpired,
    /// 队列、窗口或请求校验在任务登记前拒绝；前端可安全结束等待。
    #[error("文件任务未启动: {0}")]
    TransferRejected(String),
    /// TCP 连接或会话创建失败。
    #[error("无法连接到服务器: {0}")]
    ConnectionFailed(String),
    /// SSH 协议握手或主机密钥读取失败。
    #[error("SSH 握手失败: {0}")]
    HandshakeFailed(String),
    /// 账户密码认证失败。
    #[error("认证失败: {0}")]
    AuthFailed(String),
    /// 调用方请求了当前版本未实现的认证方式。
    #[error("认证方式不支持: {0}")]
    UnsupportedAuth(String),
    /// SSH 库未给出具体原因的认证失败。
    #[error("认证失败")]
    AuthFailedUnknown,
    /// 首次连接尚未确认服务器主机指纹。
    #[error("主机密钥需要确认: {0}")]
    HostKeyVerificationRequired(String),
    /// 已保存的主机指纹与服务器当前指纹不一致。
    #[error("主机密钥不匹配，期望 {expected}，实际 {actual}")]
    HostKeyMismatch { expected: String, actual: String },
    /// 读取远程文件或命令输出失败。
    #[error("读取输出失败: {0}")]
    ReadFailed(String),
    /// 创建或使用 SFTP 子会话失败。
    #[error("创建 SFTP 会话失败: {0}")]
    SftpFailed(String),
    /// 通用远程或本地文件系统操作失败。
    #[error("文件操作失败: {0}")]
    FileOperationFailed(String),
    #[error("目标已存在: {0}")]
    TargetExists(String),
    #[error("没有文件访问权限: {0}")]
    PermissionDenied(String),
    #[error("目标路径无效: {0}")]
    InvalidTargetPath(String),
    #[error("目标文件名称冲突: {0}")]
    TargetNameCollision(String),
    #[error("文件系统不支持所需的安全操作: {0}")]
    UnsupportedFilesystem(String),
    #[error("服务器不支持安全归档传输: {0}")]
    ArchiveUnsupported(String),
    /// 读取远程目录或目录统计状态失败。
    #[error("读取目录失败: {0}")]
    ReadDirFailed(String),
    /// 文件传输在安全检查点收到取消请求。
    #[error("传输已取消")]
    TransferCancelled,
    #[error("源文件发生变化: {0}")]
    SourceChanged(String),
    #[error("提交结果无法确认: {0}")]
    CommitOutcomeUnknown(String),
    #[error("服务器不支持安全覆盖")]
    AtomicRenameUnsupported,
    /// 操作尚未取得执行名额，重试不会重复发送用户数据。
    #[error("后台操作已达到并发上限，请稍后重试")]
    BackgroundBusy,
    /// 原尺寸请求尚未完成，保留 libssh2 状态供下一次调用继续。
    #[error("终端尺寸同步等待网络发送完成")]
    TerminalResizePending,
    /// 递归目录大小统计收到取消请求。
    #[error("目录大小统计已取消")]
    DirectorySizeCancelled,
    /// 目录统计工作会话数量达到保护上限。
    #[error("目录大小统计任务数量已达到上限")]
    DirectorySizeLimitReached,
    /// 请求预览的远程文件超过内存安全上限。
    #[error("预览文件超过大小限制")]
    PreviewTooLarge,
    /// 用户或所属窗口取消了预览。
    #[error("文件预览已取消")]
    PreviewCancelled,
    /// 远端系统未提供可用的监控命令，或监控输出不符合预期。
    #[error("服务器监控不可用: {0}")]
    MonitorUnavailable(String),
    /// 请求的远程 PTY 会话已不存在。
    #[error("终端会话不存在")]
    TerminalNotFound,
    /// 单次终端输入超过防护上限。
    #[error("终端输入超过大小限制")]
    TerminalInputTooLong,
    /// 创建、读写或控制远程 PTY 失败。
    #[error("终端会话失败: {0}")]
    TerminalFailed(String),
}

impl From<std::io::Error> for SshError {
    fn from(error: std::io::Error) -> Self {
        if error
            .get_ref()
            .is_some_and(|inner| inner.is::<crate::local_transfer::LocalNameCollision>())
        {
            return Self::TargetNameCollision(error.to_string());
        }
        match error.kind() {
            std::io::ErrorKind::AlreadyExists => Self::TargetExists(error.to_string()),
            std::io::ErrorKind::PermissionDenied => Self::PermissionDenied(error.to_string()),
            std::io::ErrorKind::InvalidInput | std::io::ErrorKind::InvalidFilename => {
                Self::InvalidTargetPath(error.to_string())
            }
            std::io::ErrorKind::Unsupported => Self::UnsupportedFilesystem(error.to_string()),
            _ => Self::FileOperationFailed(error.to_string()),
        }
    }
}

impl From<ssh2::Error> for SshError {
    fn from(error: ssh2::Error) -> Self {
        SshError::ConnectionFailed(error.to_string())
    }
}

type SharedSession = Arc<Mutex<Session>>;
type MonitorSessionMap = Arc<Mutex<HashMap<String, (u64, SharedSession)>>>;
type MonitorSnapshotMap = Arc<Mutex<HashMap<String, (u64, Instant, ServerMonitorSnapshot)>>>;
type MonitorCpuMap = Arc<Mutex<HashMap<String, (u64, (u64, u64))>>>;
type TerminalOpeningMap = Arc<Mutex<HashMap<String, (String, String, String)>>>;

/// Tauri 管理的全局 SSH 状态。
///
/// 连接、会话池和异步任务表均使用共享锁，保证文件操作、目录统计与终端
/// 可以并行运行，同时在断线时集中清理关联资源。
#[derive(Clone, Default)]
pub struct SshState {
    /// 已保存的连接配置及其连接标记。
    pub connections: Arc<RwLock<HashMap<String, SshConnection>>>,
    /// 同一连接配置的连接、断开和配置更新锁，避免多个窗口并发替换会话。
    connection_operation_locks: Arc<Mutex<HashMap<String, Arc<Mutex<()>>>>>,
    /// 已认证的 SSH 会话池，按连接 ID 复用。
    pub connection_pool: Arc<RwLock<HashMap<String, Arc<Mutex<Session>>>>>,
    /// 独立于 SFTP/PTY 主会话的远程监控会话池。
    monitor_sessions: MonitorSessionMap,
    /// 每个连接最新的监控快照和采集时间，合并窗口间重复采样请求。
    monitor_snapshot_cache: MonitorSnapshotMap,
    /// Linux CPU 计数器的上一次采样值，用于计算采样间隔内的占用率。
    monitor_cpu_samples: MonitorCpuMap,
    /// 用于向前端发送 Tauri 事件的应用句柄。
    pub app_handle: Arc<Mutex<Option<AppHandle>>>,
    /// 原生任务表及独占文件传输会话，禁止与浏览连接混用。
    tasks: Arc<TransferTasks>,
    transfer_pool: Arc<Mutex<Vec<IdleTransferSession>>>,
    transfer_registry: Arc<transfer_service::Registry>,
    connection_generations: Arc<Mutex<HashMap<String, u64>>>,
    /// 专用文件连接使用主会话已经验证的对端，避免重复 DNS 和取消时阻塞解析。
    connection_endpoints: Arc<Mutex<HashMap<String, SocketAddr>>>,
    runtime_stop: Arc<AtomicBool>,
    /// 文件工作线程错误仅影响独占会话，不重置主连接。
    isolated_transport: bool,
    directory_requests: Arc<crate::directory_requests::DirectoryRequests>,
    /// 预览使用独立连接、取消登记及全局并发限制，不影响文件浏览会话。
    preview_registry: Arc<PreviewRegistry>,
    terminal_openings: TerminalOpeningMap,
    terminal_requests: Arc<crate::directory_requests::DirectoryRequests>,
    window_generations: Arc<Mutex<HashMap<String, u64>>>,
    /// 连接 ID 到目录统计取消信号的映射。
    directory_size_cancellations: Arc<Mutex<HashMap<String, DirectorySizeCancellation>>>,
    /// 每条连接可复用的目录统计工作会话池。
    directory_size_worker_pools: Arc<RwLock<HashMap<String, Arc<Mutex<DirectorySizeWorkerPool>>>>>,
    // 远端可能没有 POSIX shell 或兼容的 GNU `du`；只缓存已确认“不支持”的结果，
    // 避免每个目录都重复握手后再回退到 SFTP 扫描。
    directory_size_fast_path_support: Arc<Mutex<HashMap<String, bool>>>,
    /// 当前占用目录统计工作名额的线程数。
    active_directory_size_workers: Arc<AtomicUsize>,
    /// 工作会话达到上限时用于休眠和唤醒等待者的条件变量。
    directory_size_worker_wait: Arc<DirectorySizeWorkerWait>,
    /// 终端 ID 到 PTY 会话的映射，独立于 SFTP 主连接池。
    terminal_sessions: Arc<RwLock<HashMap<String, Arc<TerminalSession>>>>,
}

/// 前端可见的 SSH 连接配置和连接状态。
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SshConnection {
    /// 前端生成的稳定连接标识。
    pub id: String,
    /// 服务器主机名或 IP 地址。
    pub host: String,
    /// SSH 服务端口。
    pub port: u16,
    /// 登录用户名。
    pub username: String,
    /// 当前使用的认证方式标识。
    pub auth_method: String,
    /// 用户确认过的服务器主机指纹。
    pub host_key_fingerprint: Option<String>,
    /// 仅保存在当前进程内的认证密码，序列化给前端时会被省略。
    #[serde(skip_serializing)]
    pub password: String,
    /// 是否存在可复用的已认证会话。
    pub connected: bool,
}

/// SSH 服务器主机密钥的指纹和算法信息。
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct HostKeyInfo {
    /// SHA-256 指纹，使用 OpenSSH 常见的 Base64 表示。
    pub fingerprint: String,
    /// libssh2 报告的主机密钥算法名称。
    pub algorithm: String,
}

/// 建立连接命令的结果。
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ConnectResult {
    /// 是否已完成认证并建立可用会话。
    pub connected: bool,
    /// 是否需要前端确认首次见到的主机指纹。
    pub requires_host_key_confirmation: bool,
    /// 本次握手取得的主机密钥信息。
    pub host_key: HostKeyInfo,
    /// 主会话代次，用于拒绝重连前迟到的文件任务。
    pub generation: u64,
}

/// 服务器进程列表中的单条进程数据。
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ServerProcess {
    /// 进程标识。
    pub pid: u64,
    /// 不包含命令行参数的进程名称。
    pub name: String,
    /// 进程 CPU 占用百分比。
    pub cpu_percent: f64,
    /// 进程常驻内存字节数。
    pub memory_bytes: u64,
}

/// 单次远端资源监控采样结果。
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ServerMonitorSnapshot {
    /// 远端操作系统标识。
    pub platform: String,
    /// 远端可用的逻辑 CPU 核心数。
    pub cpu_count: usize,
    /// 整机 CPU 占用率；首次 Linux 采样建立基线时为空。
    pub cpu_percent: Option<f64>,
    /// 物理内存总量，单位为字节。
    pub memory_total_bytes: u64,
    /// 已使用物理内存，单位为字节。
    pub memory_used_bytes: u64,
    /// 按 CPU 占用降序排列的进程列表。
    pub processes: Vec<ServerProcess>,
    /// 去重后、截断前当前账户可见的进程总数。
    pub process_count: usize,
    /// 超出展示上限时另外保留内存排名，避免内存排序遗漏低 CPU 的大进程。
    #[serde(skip_serializing_if = "Vec::is_empty")]
    pub memory_processes: Vec<ServerProcess>,
    /// 采集完成时间的 Unix 毫秒时间戳。
    pub collected_at: u128,
}

/// 尚未计算 Linux 整机 CPU 占用率的远端原始采样数据。
struct RemoteMonitorSample {
    platform: String,
    cpu_count: usize,
    cpu_percent: Option<f64>,
    cpu_ticks: Option<(u64, u64)>,
    memory_total_bytes: u64,
    memory_used_bytes: u64,
    processes: Vec<ServerProcess>,
    process_count: usize,
    memory_processes: Vec<ServerProcess>,
}

struct RemoteCommandOutput {
    bytes: Vec<u8>,
    exit_status: i32,
}

const LINUX_MONITOR_COMMAND: &str = r#"LC_ALL=C
export LC_ALL
printf 'OS\tlinux\n'
cpu_count=$(getconf _NPROCESSORS_ONLN 2>/dev/null || grep -c '^processor[[:space:]]*:' /proc/cpuinfo 2>/dev/null || echo 1)
printf 'CPUCOUNT\t%s\n' "$cpu_count"
awk '
  /^cpu / { total=0; for (i=2; i<=NF; i++) total+=$i; printf "CPUSTAT\t%.0f\t%.0f\n", total, $5+$6 }
  $1 == "MemTotal:" { total_mem=$2*1024 }
  $1 == "MemAvailable:" { available=$2*1024; has_available=1 }
  $1 == "MemFree:" { free_mem=$2*1024 }
  $1 == "Buffers:" { buffers=$2*1024 }
  $1 == "Cached:" { cached=$2*1024 }
  END { if (!has_available) available=free_mem+buffers+cached; printf "MEM\t%.0f\t%.0f\n", total_mem, total_mem-available }
' /proc/stat /proc/meminfo
ps -eo pid=,pcpu=,rss=,comm= 2>/dev/null | awk 'NF >= 4 { pid=$1; cpu=$2+0; rss=$3+0; $1=$2=$3=""; sub(/^[ \t]+/, ""); gsub(/[\t\r]/, " ", $0); printf "PROC\t%s\t%.2f\t%.0f\t%s\n", pid, cpu, rss*1024, $0 }'
"#;

const MACOS_MONITOR_COMMAND: &str = r#"LC_ALL=C
export LC_ALL
printf 'OS\tdarwin\n'
cpu_count=$(sysctl -n hw.logicalcpu 2>/dev/null || sysctl -n hw.ncpu 2>/dev/null || echo 1)
printf 'CPUCOUNT\t%s\n' "$cpu_count"
memory_total=$(sysctl -n hw.memsize)
memory_available=$(vm_stat | awk '
  NR == 1 { line=$0; sub(/^.*page size of /, "", line); sub(/ bytes.*$/, "", line); page=line+0 }
  $1 == "Pages" && $2 == "free:" { free_pages=$3+0 }
  $1 == "Pages" && $2 == "inactive:" { inactive_pages=$3+0 }
  $1 == "Pages" && $2 == "speculative:" { speculative_pages=$3+0 }
  $1 == "Pages" && $2 == "purgeable:" { purgeable_pages=$3+0 }
  END { printf "%.0f", (free_pages+inactive_pages+speculative_pages+purgeable_pages)*page }
')
printf 'MEM\t%s\t%s\n' "$memory_total" "$((memory_total-memory_available))"
top -l 1 -n 0 | awk -F'[ ,%]+' '/CPU usage:/ { printf "CPU\t%.2f\n", $3+$5; exit }'
ps -Ao pid=,%cpu=,rss=,comm= 2>/dev/null | awk 'NF >= 4 { pid=$1; cpu=$2+0; rss=$3+0; $1=$2=$3=""; sub(/^[ \t]+/, ""); gsub(/[\t\r]/, " ", $0); printf "PROC\t%s\t%.2f\t%.0f\t%s\n", pid, cpu, rss*1024, $0 }'
"#;

const FREEBSD_MONITOR_COMMAND: &str = r#"LC_ALL=C
export LC_ALL
printf 'OS\tfreebsd\n'
cpu_count=$(sysctl -n hw.ncpu 2>/dev/null || echo 1)
printf 'CPUCOUNT\t%s\n' "$cpu_count"
memory_total=$(sysctl -n hw.physmem)
page_size=$(sysctl -n hw.pagesize)
free_pages=$(sysctl -n vm.stats.vm.v_free_count)
inactive_pages=$(sysctl -n vm.stats.vm.v_inactive_count)
cache_pages=$(sysctl -n vm.stats.vm.v_cache_count 2>/dev/null || echo 0)
memory_available=$(((free_pages+inactive_pages+cache_pages)*page_size))
printf 'MEM\t%s\t%s\n' "$memory_total" "$((memory_total-memory_available))"
vmstat 1 2 | awk '{ for (i=1; i<=NF; i++) if ($i == "id") idle_column=i; if (idle_column && $1 ~ /^[0-9]+$/ && $idle_column ~ /^[0-9.]+$/) idle=$idle_column } END { if (idle != "") printf "CPU\t%.2f\n", 100-idle }'
ps -axo pid=,%cpu=,rss=,comm= 2>/dev/null | awk 'NF >= 4 { pid=$1; cpu=$2+0; rss=$3+0; $1=$2=$3=""; sub(/^[ \t]+/, ""); gsub(/[\t\r]/, " ", $0); printf "PROC\t%s\t%.2f\t%.0f\t%s\n", pid, cpu, rss*1024, $0 }'
"#;

const DRAGONFLY_MONITOR_COMMAND: &str = r#"LC_ALL=C
export LC_ALL
printf 'OS\tdragonfly\n'
cpu_count=$(sysctl -n hw.ncpu 2>/dev/null || echo 1)
printf 'CPUCOUNT\t%s\n' "$cpu_count"
memory_total=$(sysctl -n hw.physmem)
page_size=$(sysctl -n hw.pagesize)
free_pages=$(vmstat | awk '{ for (i=1; i<=NF; i++) if ($i == "fre") free_column=i; if (free_column && $1 ~ /^[0-9]+$/ && $free_column ~ /^[0-9]+$/) free_pages=$free_column } END { if (free_pages != "") print free_pages }')
test -n "$free_pages"
memory_available=$((free_pages*page_size))
printf 'MEM\t%s\t%s\n' "$memory_total" "$((memory_total-memory_available))"
vmstat 1 2 | awk '{ for (i=1; i<=NF; i++) if ($i == "id") idle_column=i; if (idle_column && $1 ~ /^[0-9]+$/ && $idle_column ~ /^[0-9.]+$/) idle=$idle_column } END { if (idle != "") printf "CPU\t%.2f\n", 100-idle }'
ps -axo pid=,%cpu=,rss=,comm= 2>/dev/null | awk 'NF >= 4 { pid=$1; cpu=$2+0; rss=$3+0; $1=$2=$3=""; sub(/^[ \t]+/, ""); gsub(/[\t\r]/, " ", $0); printf "PROC\t%s\t%.2f\t%.0f\t%s\n", pid, cpu, rss*1024, $0 }'
"#;

const OPENBSD_MONITOR_COMMAND: &str = r#"LC_ALL=C
export LC_ALL
printf 'OS\topenbsd\n'
cpu_count=$(sysctl -n hw.ncpu 2>/dev/null || echo 1)
printf 'CPUCOUNT\t%s\n' "$cpu_count"
memory_total=$(sysctl -n hw.physmem)
page_size=$(sysctl -n hw.pagesize)
free_pages=$(vmstat | awk '{ for (i=1; i<=NF; i++) if ($i == "fre") free_column=i; if (free_column && $1 ~ /^[0-9]+$/ && $free_column ~ /^[0-9]+$/) free_pages=$free_column } END { if (free_pages != "") print free_pages }')
test -n "$free_pages"
memory_available=$((free_pages*page_size))
printf 'MEM\t%s\t%s\n' "$memory_total" "$((memory_total-memory_available))"
vmstat 1 2 | awk '{ for (i=1; i<=NF; i++) if ($i == "id") idle_column=i; if (idle_column && $1 ~ /^[0-9]+$/ && $idle_column ~ /^[0-9.]+$/) idle=$idle_column } END { if (idle != "") printf "CPU\t%.2f\n", 100-idle }'
ps -axo pid=,%cpu=,rss=,comm= 2>/dev/null | awk 'NF >= 4 { pid=$1; cpu=$2+0; rss=$3+0; $1=$2=$3=""; sub(/^[ \t]+/, ""); gsub(/[\t\r]/, " ", $0); printf "PROC\t%s\t%.2f\t%.0f\t%s\n", pid, cpu, rss*1024, $0 }'
"#;

const NETBSD_MONITOR_COMMAND: &str = r#"LC_ALL=C
export LC_ALL
printf 'OS\tnetbsd\n'
cpu_count=$(sysctl -n hw.ncpu 2>/dev/null || echo 1)
printf 'CPUCOUNT\t%s\n' "$cpu_count"
memory_total=$(sysctl -n hw.physmem64)
page_size=$(sysctl -n hw.pagesize)
free_pages=$(vmstat | awk '{ for (i=1; i<=NF; i++) if ($i == "fre") free_column=i; if (free_column && $1 ~ /^[0-9]+$/ && $free_column ~ /^[0-9]+$/) free_pages=$free_column } END { if (free_pages != "") print free_pages }')
test -n "$free_pages"
memory_available=$((free_pages*page_size))
printf 'MEM\t%s\t%s\n' "$memory_total" "$((memory_total-memory_available))"
vmstat 1 2 | awk '{ for (i=1; i<=NF; i++) if ($i == "id") idle_column=i; if (idle_column && $1 ~ /^[0-9]+$/ && $idle_column ~ /^[0-9.]+$/) idle=$idle_column } END { if (idle != "") printf "CPU\t%.2f\n", 100-idle }'
ps -axo pid=,%cpu=,rss=,comm= 2>/dev/null | awk 'NF >= 4 { pid=$1; cpu=$2+0; rss=$3+0; $1=$2=$3=""; sub(/^[ \t]+/, ""); gsub(/[\t\r]/, " ", $0); printf "PROC\t%s\t%.2f\t%.0f\t%s\n", pid, cpu, rss*1024, $0 }'
"#;

const WINDOWS_MONITOR_SCRIPT: &str = r#"$ErrorActionPreference='Stop';$os=Get-CimInstance Win32_OperatingSystem;$total=[uint64]$os.TotalVisibleMemorySize*1024;$used=($os.TotalVisibleMemorySize-$os.FreePhysicalMemory)*1024;$cpu=(Get-CimInstance Win32_PerfFormattedData_PerfOS_Processor|Where-Object Name -eq '_Total').PercentProcessorTime;$cpuCount=[math]::Max([int](Get-CimInstance Win32_ComputerSystem).NumberOfLogicalProcessors,1);$logical=[double]$cpuCount;$all=@(Get-CimInstance Win32_PerfFormattedData_PerfProc_Process|Where-Object {$_.IDProcess -gt 0 -and $_.Name -ne '_Total' -and $_.Name -ne 'Idle'});$selected=@($all|Sort-Object PercentProcessorTime -Descending);$processes=@($selected|ForEach-Object {[pscustomobject]@{pid=[uint64]$_.IDProcess;name=[string]$_.Name;cpuPercent=[math]::Round(([double]$_.PercentProcessorTime/$logical),2);memoryBytes=[uint64]$_.WorkingSet}});[pscustomobject]@{platform='windows';cpuCount=[int]$cpuCount;cpuPercent=[double]$cpu;memoryTotalBytes=$total;memoryUsedBytes=[uint64]$used;processes=$processes}|ConvertTo-Json -Compress -Depth 4"#;

/// 连接测试命令的结果，不会写入连接池。
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ConnectionTestResult {
    /// 主机指纹确认和认证是否均已通过。
    pub success: bool,
    /// 是否需要用户确认主机指纹后再次测试。
    pub requires_host_key_confirmation: bool,
    /// 本次测试读取到的主机密钥信息。
    pub host_key: HostKeyInfo,
}

/// 远程目录列表中的一个文件系统条目。
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RemoteEntry {
    /// 当前目录显示名称。
    pub name: String,
    /// 服务器返回的完整路径。
    pub path: String,
    /// 是否为目录。
    #[serde(rename = "isDirectory")]
    pub is_directory: bool,
    /// 条目类型，如 file、directory 或 symlink。
    pub kind: String,
    /// 文件或链接自身的字节数。
    pub size: u64,
    /// 服务器提供的修改时间（Unix 秒）。
    pub modified_at: Option<u64>,
    /// 服务器提供的权限位。
    pub permissions: Option<u32>,
}

/// 远程目录递归大小统计结果。
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RemoteDirectorySize {
    /// 已统计条目的总字节数。
    pub size: u64,
    /// 是否完整遍历；权限不足的子目录会使其为 false。
    pub complete: bool,
    /// 因权限、删除或其他可恢复错误未能访问的目录数量。
    pub inaccessible_count: usize,
    /// 已成功读取并纳入统计的目录条目数量。
    pub scanned_entries: usize,
}

/// 文件夹上传计划中的单个普通文件及其相对路径。
struct FolderUploadFile {
    /// 相对于上传根目录的远程目标路径。
    relative_path: PathBuf,
    stamp: SourceStamp,
}

/// 预扫描得到的文件夹上传目录、文件和总字节数。
struct FolderUploadPlan {
    /// 需要先创建的相对目录列表。
    directories: Vec<PathBuf>,
    /// 待上传的普通文件及相对路径。
    files: Vec<FolderUploadFile>,
    /// 计划中所有文件的总字节数，用于总体进度。
    total_bytes: u64,
    /// 预扫描时因权限或类型跳过的条目数量。
    skipped_entries: usize,
}

/// 文件夹下载计划中的远程文件及其本地相对路径。
struct FolderDownloadFile {
    /// 远程源文件路径。
    remote_path: String,
    /// 相对于下载根目录的本地目标路径。
    relative_path: PathBuf,
    stamp: SourceStamp,
}

/// 预扫描得到的文件夹下载目录、文件和总字节数。
struct FolderDownloadPlan {
    /// 需要创建的本地目录列表。
    directories: Vec<PathBuf>,
    /// 待下载的远程普通文件及相对路径。
    files: Vec<FolderDownloadFile>,
    /// 计划中所有文件的总字节数。
    total_bytes: u64,
    total_known: bool,
    /// 预扫描时因权限或类型跳过的条目数量。
    skipped_entries: usize,
}

/// 递归删除计划中的远程目标。
struct RemoteDeleteTarget {
    /// 远程项目的规范化相对路径。
    path: PathBuf,
    /// 面向事件和错误消息的可读路径。
    display_path: String,
    /// 是否为目录；目录需要在文件删除后逆序清理。
    is_directory: bool,
}

// 文件上传和下载共享的上下文，保证两条传输路径使用相同的连接与取消语义。
struct FileTransferContext<'a> {
    state: &'a SshState,
    connection: &'a SshConnection,
    sftp: &'a Sftp,
    session: &'a Arc<Mutex<Session>>,
    transfer_id: &'a str,
    overwrite: bool,
    /// 批次中每个工作者独立进入提交屏障，不能遮蔽其他工作者的取消信号。
    worker_id: Option<&'a str>,
    buffer: Option<&'a Mutex<Vec<u8>>>,
    rename_client: Option<&'a Mutex<Option<crate::sftp_commit::PosixRenameClient>>>,
    expected_source: Option<&'a SourceStamp>,
    local_cancellation: Option<&'a AtomicBool>,
}

impl FileTransferContext<'_> {
    fn cancelled(&self) -> bool {
        self.local_cancellation
            .is_some_and(|flag| flag.load(Ordering::Acquire))
            || self.worker_id.map_or_else(
                || is_cancelled(self.state, self.transfer_id),
                |worker| self.state.tasks.cancelled_worker(self.transfer_id, worker),
            )
    }

    fn begin_commit(&self) -> Result<(), SshError> {
        match self.worker_id {
            Some(worker) => self.state.tasks.begin_commit(self.transfer_id, worker),
            None => self.state.tasks.committing(self.transfer_id),
        }
        .map_err(|_| SshError::TransferCancelled)
    }
}

/// 完成 TCP/SSH 握手后等待主机指纹确认的会话结果。
struct OpenSession {
    session: Session,
    host_key: HostKeyInfo,
    peer_addr: SocketAddr,
}

// 终端会话独立于文件传输会话，避免交互式读取阻塞 SFTP 通道。
/// 一个交互式远程 PTY 会话及其读写同步状态。
struct TerminalSession {
    /// 所属 SSH 连接 ID，用于断线时批量关闭。
    connection_id: String,
    /// 远程 PTY channel 的共享互斥封装。
    channel: Arc<Mutex<Channel>>,
    /// 读线程停止标记。
    stop: Arc<AtomicBool>,
    /// 串行化多个输入写入，避免交错破坏终端字节流。
    write_lock: Mutex<InputSequence>,
    resize_request: Mutex<PendingResize>,
    owner: String,
    generation: String,
    output: tauri::ipc::Channel<serde_json::Value>,
    output_flow: Mutex<OutputFlow>,
    output_wake: Condvar,
}

// 统计任务使用独立 SSH 会话；保留所属连接标识，主连接关闭时可一并取消。
/// 目录统计任务的取消信号和连接归属。
struct DirectorySizeCancellation {
    /// 取消信号所属的连接 ID。
    connection_id: String,
    /// 工作线程定期检查的原子取消标志。
    signal: Arc<AtomicBool>,
    /// 唤醒等待任务退出或继续工作的条件变量。
    wake: Arc<Condvar>,
}

// 工作会话达到上限时，等待者通过条件变量休眠，避免忙等占用 CPU。
struct DirectorySizeWorkerWait {
    /// 与条件变量配套的等待锁。
    wait_lock: Mutex<()>,
    /// 工作名额释放时唤醒等待者。
    wake: Condvar,
}

impl Default for DirectorySizeWorkerWait {
    fn default() -> Self {
        Self {
            wait_lock: Mutex::new(()),
            wake: Condvar::new(),
        }
    }
}

// RAII 保证统计任务无论成功、失败还是被取消，都会归还并发名额并唤醒等待者。
struct DirectorySizeWorkerSlot {
    active_workers: Arc<AtomicUsize>,
    worker_wait: Arc<DirectorySizeWorkerWait>,
}

impl Drop for DirectorySizeWorkerSlot {
    fn drop(&mut self) {
        self.active_workers.fetch_sub(1, Ordering::AcqRel);
        self.worker_wait.wake.notify_all();
    }
}

/// 单个连接的目录统计工作会话复用池。
#[derive(Default)]
struct DirectorySizeWorkerPool {
    /// 已建立且可复用的工作会话。
    workers: Vec<Arc<DirectorySizeWorker>>,
    /// 正在建立但尚未加入 workers 的会话数量。
    opening_workers: usize,
    /// 当前使用该池的扫描任务引用数。
    active_tasks: usize,
}

/// 可复用的已认证目录统计 SSH 工作会话。
struct DirectorySizeWorker {
    /// 已认证的 SSH 会话。
    session: Arc<Mutex<Session>>,
    /// 是否暂时借出给某个目录扫描。
    in_use: AtomicBool,
}

// 建立统计会话时也占用池内名额；异常或取消时由 RAII 自动归还预留数量。
struct DirectorySizeOpeningLease {
    /// 需要在 Drop 时归还 opening_workers 预留名额的池。
    pool: Arc<Mutex<DirectorySizeWorkerPool>>,
}

impl Drop for DirectorySizeOpeningLease {
    fn drop(&mut self) {
        if let Ok(mut pool) = self.pool.lock() {
            pool.opening_workers = pool.opening_workers.saturating_sub(1);
        }
    }
}

// 独占一个统计工作会话，释放时将它归还给同一连接的复用池。
struct DirectorySizeWorkerLease {
    /// 被当前扫描独占的工作会话。
    worker: Arc<DirectorySizeWorker>,
}

impl Drop for DirectorySizeWorkerLease {
    fn drop(&mut self) {
        self.worker.in_use.store(false, Ordering::Release);
    }
}

// 字段按声明顺序释放，确保 SFTP 子会话先关闭，再归还底层 SSH 工作会话。
struct DirectorySizeSftpSession {
    /// 当前工作会话创建的 SFTP 子会话。
    sftp: Sftp,
    /// 保持借用关系，确保 SFTP 字段先于工作会话归还。
    _worker_lease: DirectorySizeWorkerLease,
}

// 一个扫描任务共享待处理目录和聚合结果；工作者完成一个目录后继续取下一个目录。
/// 在多个工作线程之间共享的递归目录扫描状态。
struct DirectorySizeScan {
    /// 所有工作者共用累计预算，不能按子目录重新开始计数。
    budget: Mutex<ScanBudget>,
    /// 待处理目录和聚合结果的互斥状态。
    state: Mutex<DirectorySizeScanState>,
    /// 目录入队或任务完成时唤醒工作线程。
    wake: Arc<Condvar>,
    /// 所有工作线程共享的取消标志。
    cancellation: Arc<AtomicBool>,
}

/// 目录扫描队列和聚合结果；由 `DirectorySizeScan` 的锁保护。
struct DirectorySizeScanState {
    /// 待扫描目录队列，bool 标记是否为根目录。
    pending: VecDeque<(PathBuf, bool)>,
    /// 队列及正在处理中的目录总数。
    pending_count: usize,
    /// 当前等待领取任务的工作线程数量。
    waiting_workers: usize,
    /// 已成功统计的文件字节总数。
    total_size: u64,
    /// 读取失败但允许继续扫描的目录数量。
    inaccessible_count: usize,
    /// 已读取并纳入统计的条目数量。
    scanned_entries: usize,
    /// 遇到不可恢复错误时保存的失败原因。
    error: Option<SshError>,
    /// 是否已经产生最终结果。
    finished: bool,
}

/// 目录大小统计任务的不可变执行上下文。
///
/// 将任务参数集中保存，避免统计入口出现过长参数列表，同时保证工作线程
/// 使用同一份连接、取消信号和工作会话池。
struct DirectorySizeCalculationContext {
    /// 共享 SSH 状态。
    state: SshState,
    /// 任务所属连接 ID。
    id: String,
    /// 创建统计工作会话所需的连接配置快照。
    connection: SshConnection,
    /// 待统计的远程根路径。
    remote_path: String,
    /// 当前统计任务的取消信号。
    cancellation: Arc<AtomicBool>,
    /// 用于唤醒等待中的目录工作线程。
    wake: Arc<Condvar>,
    /// 当前连接的目录统计工作会话池。
    pool: Arc<Mutex<DirectorySizeWorkerPool>>,
    /// 是否包含隐藏文件和目录。
    show_hidden_files: bool,
}

/// 将当前值转换为 0 到 100 的整数百分比；总数为零时返回 100。
fn percentage(current: u64, total: u64) -> u64 {
    percentage_with_empty_value(current, total, 100)
}

/// 将当前值转换为 0 到 100 的整数百分比，并允许调用方定义零总数结果。
fn percentage_with_empty_value(current: u64, total: u64, empty_value: u64) -> u64 {
    current
        .saturating_mul(100)
        .checked_div(total)
        .unwrap_or(empty_value)
        .min(100)
}

/// 计算两次累计 CPU 计数器之间的使用率；计数器回退或没有进展时返回空值。
fn calculate_cpu_percent(previous: (u64, u64), current: (u64, u64)) -> Option<f64> {
    let total_delta = current.0.checked_sub(previous.0)?;
    let idle_delta = current.1.checked_sub(previous.1)?;
    if total_delta == 0 || idle_delta > total_delta {
        return None;
    }
    let used_delta = total_delta - idle_delta;
    Some((used_delta as f64 / total_delta as f64 * 100.0).clamp(0.0, 100.0))
}

/// 按远端 `uname` 结果选择监控采集脚本。
fn monitor_command_for_platform(platform: &str) -> Option<&'static str> {
    match platform {
        "linux" | "gnu/linux" => Some(LINUX_MONITOR_COMMAND),
        "darwin" => Some(MACOS_MONITOR_COMMAND),
        "freebsd" => Some(FREEBSD_MONITOR_COMMAND),
        "dragonfly" => Some(DRAGONFLY_MONITOR_COMMAND),
        "openbsd" => Some(OPENBSD_MONITOR_COMMAND),
        "netbsd" => Some(NETBSD_MONITOR_COMMAND),
        _ => None,
    }
}

/// 解析由受限远端采集命令生成的制表符记录。
fn parse_remote_monitor_output(output: &[u8]) -> Result<RemoteMonitorSample, SshError> {
    if output.len() > MAX_SERVER_MONITOR_OUTPUT_BYTES {
        return Err(SshError::MonitorUnavailable(
            "监控结果超过大小限制".to_string(),
        ));
    }

    if output
        .iter()
        .copied()
        .find(|byte| !byte.is_ascii_whitespace())
        == Some(b'{')
    {
        return parse_windows_monitor_output(output);
    }

    let text = String::from_utf8_lossy(output);
    let mut platform = None;
    let mut cpu_count = None;
    let mut cpu_percent = None;
    let mut cpu_ticks = None;
    let mut memory = None;
    let mut processes = Vec::new();

    for line in text.lines() {
        let mut fields = line.splitn(5, '\t');
        match fields.next() {
            Some("OS") => {
                platform = fields
                    .next()
                    .filter(|value| !value.is_empty())
                    .map(str::to_string)
            }
            Some("CPUCOUNT") => {
                cpu_count = fields.next().and_then(|value| value.parse::<usize>().ok());
            }
            Some("CPU") => {
                cpu_percent = fields.next().and_then(|value| value.parse::<f64>().ok());
            }
            Some("CPUSTAT") => {
                let total = fields.next().and_then(|value| value.parse::<u64>().ok());
                let idle = fields.next().and_then(|value| value.parse::<u64>().ok());
                cpu_ticks = total.zip(idle);
            }
            Some("MEM") => {
                let total = fields.next().and_then(|value| value.parse::<u64>().ok());
                let used = fields.next().and_then(|value| value.parse::<u64>().ok());
                memory = total.zip(used);
            }
            Some("PROC") => {
                let pid = fields.next().and_then(|value| value.parse::<u64>().ok());
                let cpu = fields.next().and_then(|value| value.parse::<f64>().ok());
                let memory_bytes = fields.next().and_then(|value| value.parse::<u64>().ok());
                let name = fields
                    .next()
                    .map(str::trim)
                    .filter(|value| !value.is_empty());
                let (pid, cpu_percent, memory_bytes, name) = (pid, cpu, memory_bytes, name);
                if pid.is_none()
                    || cpu_percent.is_none()
                    || memory_bytes.is_none()
                    || name.is_none()
                {
                    return Err(SshError::MonitorUnavailable(
                        "远端返回格式无效的进程记录".to_string(),
                    ));
                }
                let process = ServerProcess {
                    pid: pid.unwrap(),
                    name: name.unwrap().chars().take(256).collect(),
                    cpu_percent: cpu_percent.unwrap(),
                    memory_bytes: memory_bytes.unwrap(),
                };
                if process.pid == 0
                    || !process.cpu_percent.is_finite()
                    || !(0.0..=10_000.0).contains(&process.cpu_percent)
                    || process.name.is_empty()
                {
                    return Err(SshError::MonitorUnavailable(
                        "远端返回超出范围的进程数据".to_string(),
                    ));
                }
                processes.push(process);
            }
            _ => {}
        }
    }

    let platform =
        platform.ok_or_else(|| SshError::MonitorUnavailable("无法识别远端操作系统".to_string()))?;
    let (memory_total_bytes, memory_used_bytes) =
        memory.ok_or_else(|| SshError::MonitorUnavailable("远端未返回有效内存数据".to_string()))?;
    let mut sample = RemoteMonitorSample {
        platform,
        cpu_count: cpu_count
            .ok_or_else(|| SshError::MonitorUnavailable("远端未返回有效 CPU 核心数".to_string()))?,
        cpu_percent,
        cpu_ticks,
        memory_total_bytes,
        memory_used_bytes,
        processes,
        process_count: 0,
        memory_processes: Vec::new(),
    };
    validate_remote_monitor_sample(&mut sample)?;
    Ok(sample)
}

/// 解析 Windows PowerShell 输出的 JSON 监控结果。
fn parse_windows_monitor_output(output: &[u8]) -> Result<RemoteMonitorSample, SshError> {
    let value: serde_json::Value = serde_json::from_slice(output)
        .map_err(|_| SshError::MonitorUnavailable("Windows 监控结果格式无效".to_string()))?;
    let cpu_count = value
        .get("cpuCount")
        .and_then(serde_json::Value::as_u64)
        .and_then(|value| usize::try_from(value).ok())
        .ok_or_else(|| SshError::MonitorUnavailable("Windows CPU 核心数无效".to_string()))?;
    let cpu_percent = value.get("cpuPercent").and_then(serde_json::Value::as_f64);
    let memory_total_bytes = value
        .get("memoryTotalBytes")
        .and_then(serde_json::Value::as_u64)
        .ok_or_else(|| SshError::MonitorUnavailable("Windows 内存总量无效".to_string()))?;
    let memory_used_bytes = value
        .get("memoryUsedBytes")
        .and_then(serde_json::Value::as_u64)
        .ok_or_else(|| SshError::MonitorUnavailable("Windows 内存使用量无效".to_string()))?;
    let processes = value
        .get("processes")
        .and_then(serde_json::Value::as_array)
        .ok_or_else(|| SshError::MonitorUnavailable("Windows 进程列表无效".to_string()))?
        .iter()
        .map(|process| {
            Ok(ServerProcess {
                pid: process
                    .get("pid")
                    .and_then(serde_json::Value::as_u64)
                    .ok_or_else(|| {
                        SshError::MonitorUnavailable("Windows 进程 PID 无效".to_string())
                    })?,
                name: process
                    .get("name")
                    .and_then(serde_json::Value::as_str)
                    .ok_or_else(|| {
                        SshError::MonitorUnavailable("Windows 进程名称无效".to_string())
                    })?
                    .chars()
                    .take(256)
                    .collect(),
                cpu_percent: process
                    .get("cpuPercent")
                    .and_then(serde_json::Value::as_f64)
                    .ok_or_else(|| {
                        SshError::MonitorUnavailable("Windows 进程 CPU 数据无效".to_string())
                    })?,
                memory_bytes: process
                    .get("memoryBytes")
                    .and_then(serde_json::Value::as_u64)
                    .ok_or_else(|| {
                        SshError::MonitorUnavailable("Windows 进程内存数据无效".to_string())
                    })?,
            })
        })
        .collect::<Result<Vec<_>, SshError>>()?;

    let mut sample = RemoteMonitorSample {
        platform: "windows".to_string(),
        cpu_count,
        cpu_percent,
        cpu_ticks: None,
        memory_total_bytes,
        memory_used_bytes,
        processes,
        process_count: 0,
        memory_processes: Vec::new(),
    };
    validate_remote_monitor_sample(&mut sample)?;
    Ok(sample)
}

/// 校验不同系统采集器输出的通用资源范围，并按 CPU 占用排序。
fn validate_remote_monitor_sample(sample: &mut RemoteMonitorSample) -> Result<(), SshError> {
    if sample.cpu_count == 0 {
        return Err(SshError::MonitorUnavailable(
            "远端 CPU 核心数无效".to_string(),
        ));
    }
    if sample.memory_total_bytes == 0 || sample.memory_used_bytes > sample.memory_total_bytes {
        return Err(SshError::MonitorUnavailable("远端内存数据无效".to_string()));
    }
    if sample
        .cpu_percent
        .is_some_and(|value| !value.is_finite() || !(0.0..=100.0).contains(&value))
    {
        return Err(SshError::MonitorUnavailable(
            "远端 CPU 数据无效".to_string(),
        ));
    }
    sample.processes.retain(|process| {
        process.pid > 0
            && process.cpu_percent.is_finite()
            && (0.0..=10_000.0).contains(&process.cpu_percent)
            && !process.name.is_empty()
    });
    let mut processes_by_pid = HashMap::<u64, ServerProcess>::new();
    for process in sample.processes.drain(..) {
        processes_by_pid
            .entry(process.pid)
            .and_modify(|existing| {
                if process.cpu_percent > existing.cpu_percent {
                    existing.cpu_percent = process.cpu_percent;
                    existing.name.clone_from(&process.name);
                }
                existing.memory_bytes = existing.memory_bytes.max(process.memory_bytes);
            })
            .or_insert(process);
    }
    sample.processes = processes_by_pid.into_values().collect();
    sample.process_count = sample.processes.len();
    sample.memory_processes.clear();
    if sample.process_count > MAX_SERVER_MONITOR_PROCESSES {
        sample.memory_processes = sample.processes.clone();
        sample.memory_processes.sort_by(|left, right| {
            right
                .memory_bytes
                .cmp(&left.memory_bytes)
                .then_with(|| left.pid.cmp(&right.pid))
        });
        sample
            .memory_processes
            .truncate(MAX_SERVER_MONITOR_PROCESSES);
    }
    sample.processes.sort_by(|left, right| {
        right
            .cpu_percent
            .total_cmp(&left.cpu_percent)
            .then_with(|| left.pid.cmp(&right.pid))
    });
    sample.processes.truncate(MAX_SERVER_MONITOR_PROCESSES);
    Ok(())
}

/// 比较两个连接配置是否可安全复用已认证会话。
fn same_connection_configuration(left: &SshConnection, right: &SshConnection) -> bool {
    left.host == right.host
        && left.port == right.port
        && left.username == right.username
        && left.auth_method == right.auth_method
        && left.host_key_fingerprint == right.host_key_fingerprint
        && left.password == right.password
}

/// 在不破坏活动会话的情况下保存连接；只有认证参数实质变化时才释放旧资源。
fn save_ssh_connection(state: &SshState, connection: SshConnection) -> Result<String, SshError> {
    validate_connection(&connection)?;
    let id = connection.id.clone();
    let previous = state.connections.read().unwrap().get(&id).cloned();
    if previous
        .as_ref()
        .is_some_and(|previous| same_connection_configuration(previous, &connection))
    {
        return Ok(id);
    }

    close_terminals_for_connection(state, &id);
    remove_cached_session(state, &id);
    remove_monitor_session(state, &id);
    clear_monitor_cache(state, &id);
    state
        .directory_size_fast_path_support
        .lock()
        .unwrap()
        .remove(&id);
    state
        .connections
        .write()
        .unwrap()
        .insert(id.clone(), connection);
    Ok(id)
}

/// 通过新建 SSH 认证会话执行固定只读采集脚本，不影响文件和终端主会话。
fn execute_monitor_command(
    _state: &SshState,
    _connection_id: &str,
    session: &Session,
    command: &str,
) -> Result<RemoteCommandOutput, SshError> {
    session.set_timeout(SERVER_MONITOR_COMMAND_TIMEOUT_MS);
    let result = (|| {
        let mut channel = session
            .channel_session()
            .map_err(|error| SshError::MonitorUnavailable(format!("无法打开监控通道：{error}")))?;
        channel
            .handle_extended_data(ExtendedData::Merge)
            .map_err(|error| SshError::MonitorUnavailable(format!("无法读取监控通道：{error}")))?;
        channel.exec(command).map_err(|error| {
            SshError::MonitorUnavailable(format!("远端拒绝执行监控命令：{error}"))
        })?;

        let mut output = Vec::new();
        let mut buffer = [0_u8; 8192];
        loop {
            match channel.read(&mut buffer) {
                Ok(0) => break,
                Ok(read) => {
                    if output.len().saturating_add(read) > MAX_SERVER_MONITOR_OUTPUT_BYTES {
                        let _ = channel.close();
                        return Err(SshError::MonitorUnavailable(
                            "监控结果超过大小限制".to_string(),
                        ));
                    }
                    output.extend_from_slice(&buffer[..read]);
                }
                Err(error) => {
                    let _ = channel.close();
                    return Err(SshError::MonitorUnavailable(format!(
                        "读取远端监控结果失败：{error}"
                    )));
                }
            }
        }
        channel.wait_close().map_err(|error| {
            SshError::MonitorUnavailable(format!("等待远端监控命令结束失败：{error}"))
        })?;
        let exit_status = channel.exit_status().map_err(|error| {
            SshError::MonitorUnavailable(format!("读取远端监控命令状态失败：{error}"))
        })?;
        Ok(RemoteCommandOutput {
            bytes: output,
            exit_status,
        })
    })();
    session.set_timeout(DEFAULT_TIMEOUT_MS as u32);
    result
}

/// 只在持有代次短锁时检查当前连接，避免把旧身份和新代次组合起来。
fn check_monitor_generation(
    state: &SshState,
    generations: &HashMap<String, u64>,
    id: &str,
    generation: u64,
) -> Result<(), SshError> {
    if generations.get(id).copied().unwrap_or(0) != generation
        || connection_info(state, id, true).is_err()
    {
        return Err(SshError::ConnectionGenerationChanged);
    }
    Ok(())
}

/// 仅移除探测失败的那一个会话，不能删除并发替换后的新会话。
fn remove_monitor_session_if_same(
    state: &SshState,
    id: &str,
    generation: u64,
    session: &Arc<Mutex<Session>>,
) {
    let removed = {
        let mut sessions = state.monitor_sessions.lock().unwrap();
        if sessions
            .get(id)
            .is_some_and(|(current_generation, current)| {
                *current_generation == generation && Arc::ptr_eq(current, session)
            })
        {
            sessions.remove(id)
        } else {
            None
        }
    };
    drop(removed);
}

/// 为捕获的连接代次创建或复用独立只读监控会话；网络 IO 不持有生命周期锁。
fn monitor_session_for(
    state: &SshState,
    id: &str,
    connection: &SshConnection,
    generation: u64,
) -> Result<Arc<Mutex<Session>>, SshError> {
    let cached = {
        let generations = state.connection_generations.lock().unwrap();
        check_monitor_generation(state, &generations, id, generation)?;
        state
            .monitor_sessions
            .lock()
            .unwrap()
            .get(id)
            .filter(|(cached_generation, _)| *cached_generation == generation)
            .map(|(_, session)| Arc::clone(session))
    };
    if let Some(session) = cached {
        let healthy = session
            .lock()
            .map(|session| match session.keepalive_send() {
                Ok(_) => true,
                Err(error) => matches!(error.code(), ErrorCode::Session(LIBSSH2_ERROR_EAGAIN)),
            })
            .unwrap_or(false);
        if healthy {
            let generations = state.connection_generations.lock().unwrap();
            check_monitor_generation(state, &generations, id, generation)?;
            let still_cached = state.monitor_sessions.lock().unwrap().get(id).is_some_and(
                |(current_generation, current)| {
                    *current_generation == generation && Arc::ptr_eq(current, &session)
                },
            );
            if still_cached {
                return Ok(session);
            }
        } else {
            remove_monitor_session_if_same(state, id, generation, &session);
        }
    }
    let session = open_authenticated_session(connection)
        .map_err(|error| SshError::MonitorUnavailable(format!("无法建立监控会话：{error}")))?;
    let session = Arc::new(Mutex::new(session));
    let (selected, replaced) = {
        let generations = state.connection_generations.lock().unwrap();
        check_monitor_generation(state, &generations, id, generation)?;
        let mut sessions = state.monitor_sessions.lock().unwrap();
        if let Some((_, cached)) = sessions
            .get(id)
            .filter(|(current, _)| *current == generation)
        {
            (Arc::clone(cached), None)
        } else {
            let replaced = sessions.insert(id.to_string(), (generation, Arc::clone(&session)));
            (session, replaced)
        }
    };
    drop(replaced);
    Ok(selected)
}

fn cached_monitor_snapshot(
    state: &SshState,
    id: &str,
    generation: u64,
) -> Result<Option<ServerMonitorSnapshot>, SshError> {
    let generations = state.connection_generations.lock().unwrap();
    check_monitor_generation(state, &generations, id, generation)?;
    Ok(state
        .monitor_snapshot_cache
        .lock()
        .unwrap()
        .get(id)
        .filter(|(cached_generation, collected_at, _)| {
            *cached_generation == generation && collected_at.elapsed() < SERVER_MONITOR_MIN_INTERVAL
        })
        .map(|(_, _, snapshot)| snapshot.clone()))
}

fn commit_monitor_sample(
    state: &SshState,
    id: &str,
    generation: u64,
    mut sample: RemoteMonitorSample,
) -> Result<ServerMonitorSnapshot, SshError> {
    let generations = state.connection_generations.lock().unwrap();
    check_monitor_generation(state, &generations, id, generation)?;
    if let Some(current) = sample.cpu_ticks {
        let previous = state
            .monitor_cpu_samples
            .lock()
            .unwrap()
            .insert(id.to_string(), (generation, current));
        sample.cpu_percent = previous
            .filter(|(cached_generation, _)| *cached_generation == generation)
            .and_then(|(_, previous)| calculate_cpu_percent(previous, current));
    }
    let snapshot = ServerMonitorSnapshot {
        platform: sample.platform,
        cpu_count: sample.cpu_count,
        cpu_percent: sample.cpu_percent,
        memory_total_bytes: sample.memory_total_bytes,
        memory_used_bytes: sample.memory_used_bytes,
        processes: sample.processes,
        process_count: sample.process_count,
        memory_processes: sample.memory_processes,
        collected_at: SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap_or_default()
            .as_millis(),
    };
    state.monitor_snapshot_cache.lock().unwrap().insert(
        id.to_string(),
        (generation, Instant::now(), snapshot.clone()),
    );
    Ok(snapshot)
}

/// 读取远端资源快照，报告可见进程总数并分别保留 CPU、内存排名的有限进程列表。
#[tauri::command]
pub async fn get_server_monitor_snapshot(
    state: State<'_, SshState>,
    id: String,
) -> Result<ServerMonitorSnapshot, SshError> {
    let state = state.inner().clone();
    run_blocking_command(move || {
        let (connection, generation) = {
            let generations = state.connection_generations.lock().unwrap();
            (
                connection_info(&state, &id, true)?,
                generations.get(&id).copied().unwrap_or(0),
            )
        };
        if let Some(snapshot) = cached_monitor_snapshot(&state, &id, generation)? {
            return Ok(snapshot);
        }
        let session = monitor_session_for(&state, &id, &connection, generation)?;
        let session = session
            .lock()
            .map_err(|_| SshError::MonitorUnavailable("SSH 会话锁已损坏".to_string()))?;
        // 同会话采样仍串行；在等待会话锁后复查缓存，合并同时到达的请求。
        if let Some(snapshot) = cached_monitor_snapshot(&state, &id, generation)? {
            return Ok(snapshot);
        }
        let sample = collect_remote_monitor_sample(&state, &id, &session)?;
        commit_monitor_sample(&state, &id, generation, sample)
    })
    .await
}

/// 按当前操作系统选择有界的远端只读资源采集器。
fn collect_remote_monitor_sample(
    state: &SshState,
    connection_id: &str,
    session: &Session,
) -> Result<RemoteMonitorSample, SshError> {
    let platform = execute_monitor_command(state, connection_id, session, "uname -s")
        .ok()
        .filter(|output| output.exit_status == 0)
        .map(|output| {
            String::from_utf8_lossy(&output.bytes)
                .trim()
                .to_ascii_lowercase()
        })
        .unwrap_or_default();

    let output = if platform.is_empty()
        || platform.starts_with("mingw")
        || platform.starts_with("msys")
        || platform.starts_with("cygwin")
        || platform.starts_with("windows")
    {
        let encoded_script: Vec<u8> = WINDOWS_MONITOR_SCRIPT
            .encode_utf16()
            .flat_map(u16::to_le_bytes)
            .collect();
        let encoded = BASE64_STANDARD.encode(encoded_script);
        let command =
            format!("powershell.exe -NoLogo -NoProfile -NonInteractive -EncodedCommand {encoded}");
        let output = execute_monitor_command(state, connection_id, session, &command)?;
        if output.exit_status != 0 {
            let message = String::from_utf8_lossy(&output.bytes);
            let details = message.trim();
            return Err(SshError::MonitorUnavailable(if details.is_empty() {
                "远端未提供系统识别命令或 PowerShell，无法采集监控数据".to_string()
            } else {
                format!(
                    "Windows 监控命令执行失败：{}",
                    details.chars().take(240).collect::<String>()
                )
            }));
        }
        if String::from_utf8_lossy(&output.bytes).trim().is_empty() {
            return Err(SshError::MonitorUnavailable(
                "远端监控命令未返回数据".to_string(),
            ));
        }
        output
    } else {
        let command = match monitor_command_for_platform(&platform) {
            Some(command) => command,
            None => {
                return Err(SshError::MonitorUnavailable(if platform.is_empty() {
                    "远端未提供系统识别命令或 PowerShell".to_string()
                } else {
                    format!("暂不支持远端操作系统：{platform}")
                }));
            }
        };
        execute_monitor_command(state, connection_id, session, command)?
    };

    if output.exit_status != 0 {
        return Err(SshError::MonitorUnavailable(
            "远端监控命令执行失败".to_string(),
        ));
    }
    parse_remote_monitor_output(&output.bytes)
}

impl DirectorySizeScan {
    /// 创建包含根目录的初始扫描任务。
    fn new(remote_path: &str, cancellation: Arc<AtomicBool>, wake: Arc<Condvar>) -> Self {
        let mut pending = VecDeque::new();
        pending.push_back((PathBuf::from(remote_path), true));
        Self {
            budget: Mutex::new(ScanBudget::default()),
            state: Mutex::new(DirectorySizeScanState {
                pending,
                pending_count: 1,
                waiting_workers: 0,
                total_size: 0,
                inaccessible_count: 0,
                scanned_entries: 0,
                error: None,
                finished: false,
            }),
            wake,
            cancellation,
        }
    }

    /// 以失败状态结束扫描并唤醒等待的工作线程。
    fn fail(&self, error: SshError) {
        let Ok(mut scan) = self.state.lock() else {
            self.wake.notify_all();
            return;
        };
        if !scan.finished {
            scan.error = Some(error);
            scan.finished = true;
        }
        self.wake.notify_all();
    }

    /// 合并一个目录的统计结果，并把新发现的子目录加入共享队列。
    fn complete_directory(
        &self,
        child_directories: Vec<PathBuf>,
        file_size: u64,
        scanned_entries: usize,
        inaccessible_count: usize,
    ) {
        let Ok(mut scan) = self.state.lock() else {
            self.wake.notify_all();
            return;
        };
        if scan.finished {
            self.wake.notify_all();
            return;
        }
        scan.total_size = scan.total_size.saturating_add(file_size);
        scan.scanned_entries = scan.scanned_entries.saturating_add(scanned_entries);
        scan.inaccessible_count = scan.inaccessible_count.saturating_add(inaccessible_count);
        for directory in child_directories {
            scan.pending.push_back((directory, false));
            scan.pending_count = scan.pending_count.saturating_add(1);
        }
        scan.pending_count = scan.pending_count.saturating_sub(1);
        if scan.pending_count == 0 {
            scan.finished = true;
        }
        self.wake.notify_all();
    }

    /// 读取最终聚合结果，检查任务是否正常完成。
    fn result(&self) -> Result<RemoteDirectorySize, SshError> {
        let mut scan = self
            .state
            .lock()
            .map_err(|_| SshError::ReadDirFailed("目录大小统计状态已损坏".to_string()))?;
        if let Some(error) = scan.error.take() {
            return Err(error);
        }
        if !scan.finished {
            return Err(SshError::ReadDirFailed(
                "目录大小统计未正常完成".to_string(),
            ));
        }
        Ok(RemoteDirectorySize {
            size: scan.total_size,
            complete: scan.inaccessible_count == 0,
            inaccessible_count: scan.inaccessible_count,
            scanned_entries: scan.scanned_entries,
        })
    }
}

/// 按 ID 读取连接配置，并可选择要求其已有已认证会话。
fn connection_info(
    state: &SshState,
    id: &str,
    require_connected: bool,
) -> Result<SshConnection, SshError> {
    let connections = state.connections.read().unwrap();
    connections
        .get(id)
        .filter(|connection| !require_connected || connection.connected)
        .cloned()
        .ok_or(SshError::ConnectionNotFound)
}

/// 获取单连接生命周期锁，锁对象在连接并发期间保持稳定。
fn connection_operation_lock(state: &SshState, id: &str) -> Arc<Mutex<()>> {
    Arc::clone(
        state
            .connection_operation_locks
            .lock()
            .unwrap()
            .entry(id.to_string())
            .or_insert_with(|| Arc::new(Mutex::new(()))),
    )
}

/// 移除独立监控 SSH 会话，不触碰终端与 SFTP 的主连接。
fn remove_monitor_session(state: &SshState, id: &str) {
    // 活跃采样持有自己的 Arc；不要在生命周期锁内等待它的网络操作或主动断开。
    let session = state.monitor_sessions.lock().unwrap().remove(id);
    drop(session);
}

/// 清理连接对应的 CPU 基线和采样缓存。
fn clear_monitor_cache(state: &SshState, id: &str) {
    state.monitor_cpu_samples.lock().unwrap().remove(id);
    state.monitor_snapshot_cache.lock().unwrap().remove(id);
}

/// 对主机指纹执行不带尾部填充的 Base64 编码。
fn base64_encode(bytes: &[u8]) -> String {
    const TABLE: &[u8; 64] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
    let mut output = String::with_capacity(bytes.len().div_ceil(3) * 4);
    let mut index = 0;
    while index < bytes.len() {
        let first = bytes[index] as u32;
        let second = bytes.get(index + 1).copied().unwrap_or(0) as u32;
        let third = bytes.get(index + 2).copied().unwrap_or(0) as u32;
        let chunk = (first << 16) | (second << 8) | third;
        output.push(TABLE[((chunk >> 18) & 0x3f) as usize] as char);
        output.push(TABLE[((chunk >> 12) & 0x3f) as usize] as char);
        output.push(if index + 1 < bytes.len() {
            TABLE[((chunk >> 6) & 0x3f) as usize] as char
        } else {
            '='
        });
        output.push(if index + 2 < bytes.len() {
            TABLE[(chunk & 0x3f) as usize] as char
        } else {
            '='
        });
        index += 3;
    }
    output.trim_end_matches('=').to_string()
}

/// 从已完成握手的 libssh2 会话提取主机密钥信息。
fn host_key_info(session: &Session) -> Result<HostKeyInfo, SshError> {
    let fingerprint = session
        .host_key_hash(HashType::Sha256)
        .ok_or_else(|| SshError::HandshakeFailed("服务器未提供主机密钥".to_string()))?
        .to_vec();
    let algorithm = session
        .host_key()
        .map(|(_, key_type)| format!("{key_type:?}"))
        .unwrap_or_else(|| "unknown".to_string());

    Ok(HostKeyInfo {
        fingerprint: format!("SHA256:{}", base64_encode(&fingerprint)),
        algorithm,
    })
}

/// 解析服务器地址并按超时连接 TCP，同时设置读写超时。
fn connect_tcp(host: &str, port: u16, timeout: Duration) -> Result<TcpStream, SshError> {
    let target = if host.contains(':') && !host.starts_with('[') {
        format!("[{host}]:{port}")
    } else {
        format!("{host}:{port}")
    };
    let addresses: Vec<SocketAddr> = target
        .to_socket_addrs()
        .map_err(|error| SshError::ConnectionFailed(format!("解析服务器地址失败: {error}")))?
        .collect();
    if addresses.is_empty() {
        return Err(SshError::ConnectionFailed(
            "服务器地址无可用解析结果".to_string(),
        ));
    }

    let mut last_error = None;
    for address in addresses {
        match TcpStream::connect_timeout(&address, timeout) {
            Ok(stream) => {
                stream
                    .set_read_timeout(Some(timeout))
                    .map_err(|error| SshError::ConnectionFailed(error.to_string()))?;
                stream
                    .set_write_timeout(Some(timeout))
                    .map_err(|error| SshError::ConnectionFailed(error.to_string()))?;
                return Ok(stream);
            }
            Err(error) => last_error = Some(error),
        }
    }
    Err(SshError::ConnectionFailed(
        last_error
            .map(|error| error.to_string())
            .unwrap_or_else(|| "连接服务器失败".to_string()),
    ))
}

/// 完成 TCP 连接、SSH 握手和 keepalive 设置，但暂不认证账户。
fn open_session_with_timeout(
    connection: &SshConnection,
    timeout: Duration,
) -> Result<OpenSession, SshError> {
    let tcp = connect_tcp(&connection.host, connection.port, timeout)?;
    let peer_addr = tcp.peer_addr()?;
    let mut session =
        Session::new().map_err(|error| SshError::ConnectionFailed(error.to_string()))?;
    session.set_tcp_stream(tcp);
    session.set_timeout(timeout.as_millis().min(u32::MAX as u128) as u32);
    session
        .handshake()
        .map_err(|error| SshError::HandshakeFailed(error.to_string()))?;
    session.set_keepalive(true, KEEPALIVE_INTERVAL_SECS);
    let host_key = host_key_info(&session)?;
    Ok(OpenSession {
        session,
        host_key,
        peer_addr,
    })
}

/// 使用默认超时打开一个待认证 SSH 会话。
fn open_session(connection: &SshConnection) -> Result<OpenSession, SshError> {
    open_session_with_timeout(connection, Duration::from_millis(DEFAULT_TIMEOUT_MS))
}

/// 校验连接地址、账户、端口和当前支持的认证方式。
fn validate_connection(connection: &SshConnection) -> Result<(), SshError> {
    if connection.host.trim().is_empty() {
        return Err(SshError::ConnectionFailed("主机地址不能为空".to_string()));
    }
    if connection.username.trim().is_empty() {
        return Err(SshError::AuthFailed("用户名不能为空".to_string()));
    }
    if connection.port == 0 {
        return Err(SshError::ConnectionFailed(
            "端口必须在 1-65535 范围内".to_string(),
        ));
    }
    match connection.auth_method.as_str() {
        "password" | "" => Ok(()),
        _ => Err(SshError::UnsupportedAuth(
            "当前版本仅支持账户密码认证".to_string(),
        )),
    }
}

/// 将服务器本次握手得到的指纹与用户已确认值进行比对。
fn verify_host_key(connection: &SshConnection, host_key: &HostKeyInfo) -> Result<(), SshError> {
    match connection.host_key_fingerprint.as_deref() {
        None | Some("") => Err(SshError::HostKeyVerificationRequired(
            host_key.fingerprint.clone(),
        )),
        Some(expected) if fingerprint_matches(expected, &host_key.fingerprint) => Ok(()),
        Some(expected) => Err(SshError::HostKeyMismatch {
            expected: expected.to_string(),
            actual: host_key.fingerprint.clone(),
        }),
    }
}

/// SHA-256 指纹的 Base64 大小写有意义；仅兼容可选的尾部填充。
fn fingerprint_matches(expected: &str, actual: &str) -> bool {
    fn decode(value: &str) -> Option<Vec<u8>> {
        let encoded = value.strip_prefix("SHA256:")?;
        if encoded.len() != 43 && !(encoded.len() == 44 && encoded.ends_with('=')) {
            return None;
        }
        let unpadded = encoded.trim_end_matches('=');
        base64::engine::general_purpose::STANDARD_NO_PAD
            .decode(unpadded)
            .ok()
            .filter(|bytes| bytes.len() == 32)
    }
    match (decode(expected), decode(actual)) {
        (Some(left), Some(right)) => left == right,
        _ => false,
    }
}

/// 使用账户密码完成 SSH 用户认证。
fn authenticate(session: &Session, connection: &SshConnection) -> Result<(), SshError> {
    if !matches!(connection.auth_method.as_str(), "password" | "") {
        return Err(SshError::UnsupportedAuth(
            "当前版本仅支持账户密码认证".to_string(),
        ));
    }
    let result = session.userauth_password(&connection.username, &connection.password);

    result.map_err(|error| SshError::AuthFailed(error.to_string()))?;
    if session.authenticated() {
        Ok(())
    } else {
        Err(SshError::AuthFailedUnknown)
    }
}

/// 打开会话、校验主机指纹并完成认证，供 SFTP 和终端共享。
fn open_authenticated_session(connection: &SshConnection) -> Result<Session, SshError> {
    let opened = open_session(connection)?;
    verify_host_key(connection, &opened.host_key)?;
    authenticate(&opened.session, connection)?;
    Ok(opened.session)
}

/// 将前端终端尺寸限制在远端 PTY 可接受的范围内。
fn normalize_terminal_dimensions(columns: u32, rows: u32) -> (u32, u32) {
    crate::terminal_flow::normalize_dimensions(columns, rows)
}

/// 创建并启动 xterm PTY Shell，返回非阻塞的 SSH channel。
fn open_terminal_channel(
    connection: &SshConnection,
    columns: u32,
    rows: u32,
) -> Result<Channel, SshError> {
    let session = open_authenticated_session(connection)?;
    let mut channel = session
        .channel_session()
        .map_err(|error| SshError::TerminalFailed(error.to_string()))?;
    let (columns, rows) = normalize_terminal_dimensions(columns, rows);
    channel
        .request_pty("xterm-256color", None, Some((columns, rows, 0, 0)))
        .map_err(|error| SshError::TerminalFailed(format!("申请 PTY 失败: {error}")))?;
    channel
        .shell()
        .map_err(|error| SshError::TerminalFailed(format!("启动远程 Shell 失败: {error}")))?;
    // 非阻塞读取让读线程和键盘输入可以并行工作，不会互相占用 SSH Session 锁。
    session.set_blocking(false);
    session.set_timeout(0);
    Ok(channel)
}

/// 从终端会话表取得指定会话。
fn terminal_session_for(
    state: &SshState,
    terminal_id: &str,
) -> Result<Arc<TerminalSession>, SshError> {
    state
        .terminal_sessions
        .read()
        .unwrap()
        .get(terminal_id)
        .cloned()
        .ok_or(SshError::TerminalNotFound)
}

/// 停止并移除终端会话，关闭其远程 channel。
fn close_terminal_session(
    terminal_sessions: &Arc<RwLock<HashMap<String, Arc<TerminalSession>>>>,
    terminal_id: &str,
) {
    let session = terminal_sessions.write().unwrap().remove(terminal_id);
    if let Some(session) = session {
        session.stop.store(true, Ordering::Release);
        session.output_flow.lock().unwrap().cancel();
        session.output_wake.notify_all();
        if let Ok(mut channel) = session.channel.lock() {
            let _ = channel.close();
        }
    }
}

/// 关闭某条连接下的全部 PTY，通常在断线或断开连接时调用。
fn close_terminals_for_connection(state: &SshState, connection_id: &str) {
    state
        .terminal_openings
        .lock()
        .unwrap()
        .retain(|_, (_, _, connection)| connection != connection_id);
    let terminal_ids: Vec<String> = state
        .terminal_sessions
        .read()
        .unwrap()
        .iter()
        .filter(|(_, session)| session.connection_id == connection_id)
        .map(|(terminal_id, _)| terminal_id.clone())
        .collect();
    for terminal_id in terminal_ids {
        close_terminal_session(&state.terminal_sessions, &terminal_id);
    }
}

/// 等待前端完成解析，期间不持有 SSH channel 或输入锁。
fn wait_for_terminal_output(session: &TerminalSession) -> bool {
    let mut flow = session.output_flow.lock().unwrap();
    while flow.should_wait() && !session.stop.load(Ordering::Acquire) {
        flow = session
            .output_wake
            .wait_timeout(flow, Duration::from_millis(100))
            .unwrap()
            .0;
    }
    !session.stop.load(Ordering::Acquire) && !flow.is_cancelled()
}
fn send_terminal_packet(
    session: &TerminalSession,
    terminal_id: &str,
    event: &str,
    text: &str,
) -> bool {
    if !wait_for_terminal_output(session) {
        return false;
    }
    let sequence = session
        .output_flow
        .lock()
        .unwrap()
        .record_sent(if event == "data" { text.len() } else { 0 });
    let Some(sequence) = sequence else {
        return false;
    };
    let sent = session.output.send(json!({"terminalId": terminal_id, "generation": session.generation, "sequence": sequence, "event": event, "data": if event == "data" { Some(text) } else { None }, "message": if event == "data" { None } else { Some(text) }})).is_ok();
    if !sent {
        session.stop.store(true, Ordering::Release);
    }
    sent
}
fn send_terminal_text(session: &TerminalSession, terminal_id: &str, text: &str) -> bool {
    let mut remaining = text;
    while !remaining.is_empty() {
        let mut end = remaining.len().min(32 * 1024);
        while !remaining.is_char_boundary(end) {
            end -= 1;
        }
        if !send_terminal_packet(session, terminal_id, "data", &remaining[..end]) {
            return false;
        }
        remaining = &remaining[end..];
    }
    true
}
/// 保留跨读取边界的不完整 UTF-8 后缀，不重排 ANSI 或用户数据。
fn send_terminal_bytes(
    session: &TerminalSession,
    terminal_id: &str,
    pending: &mut Vec<u8>,
    bytes: &[u8],
) -> bool {
    let text = crate::terminal_flow::decode_output(pending, bytes);
    send_terminal_text(session, terminal_id, &text)
}
/// 有界读取线程；读取暂停不阻塞键盘输入，前端消费 ACK 唤醒线程。
fn spawn_terminal_reader(
    state: SshState,
    terminal_id: String,
    session: Arc<TerminalSession>,
) -> Result<(), SshError> {
    thread::Builder::new()
        .name("terminal-reader".into())
        .spawn(move || {
            let mut buffer = vec![0_u8; 32 * 1024];
            let mut pending_utf8 = Vec::new();
            let mut failure = None;
            loop {
                if !wait_for_terminal_output(&session) {
                    break;
                }
                let result = session.channel.lock().unwrap().read(&mut buffer);
                match result {
                    Ok(0) => break,
                    Ok(size) => {
                        if !send_terminal_bytes(
                            &session,
                            &terminal_id,
                            &mut pending_utf8,
                            &buffer[..size],
                        ) {
                            break;
                        }
                    }
                    Err(error) if error.kind() == std::io::ErrorKind::WouldBlock => {
                        thread::sleep(TERMINAL_POLL_INTERVAL)
                    }
                    Err(error) => {
                        failure = Some(error.to_string());
                        break;
                    }
                }
            }
            if !session.stop.load(Ordering::Acquire) {
                if !pending_utf8.is_empty() {
                    send_terminal_text(
                        &session,
                        &terminal_id,
                        &String::from_utf8_lossy(&pending_utf8),
                    );
                }
                if let Some(error) = failure {
                    send_terminal_packet(&session, &terminal_id, "error", &error);
                } else {
                    send_terminal_packet(&session, &terminal_id, "exit", "远程 Shell 已退出");
                }
            }
            session.stop.store(true, Ordering::Release);
            let mut sessions = state.terminal_sessions.write().unwrap();
            if sessions
                .get(&terminal_id)
                .is_some_and(|current| Arc::ptr_eq(current, &session))
            {
                sessions.remove(&terminal_id);
            }
        })
        .map(|_| ())
        .map_err(|error| SshError::TerminalFailed(format!("无法创建终端读取线程: {error}")))
}

/// 在非阻塞 channel 上可靠写入终端输入，带有取消和超时保护。
fn write_terminal_input(
    session: &Arc<TerminalSession>,
    data: &[u8],
    sequence: u64,
) -> Result<(), SshError> {
    let mut write_guard = session
        .write_lock
        .lock()
        .map_err(|_| SshError::TerminalFailed("终端输入锁已损坏".to_string()))?;
    if !write_guard.accept(sequence) {
        return Err(SshError::TerminalFailed("终端输入序号不连续".into()));
    }
    write_terminal_bytes(
        data,
        || session.stop.load(Ordering::Acquire),
        |bytes| {
            session
                .channel
                .lock()
                .map_err(|_| std::io::Error::other("终端会话锁已损坏"))?
                .write(bytes)
        },
        thread::sleep,
        TERMINAL_WRITE_TIMEOUT,
    )
}

/// 保留 IO 错误种类；EAGAIN 的错误文本并不保证包含 would block。
fn write_terminal_bytes(
    data: &[u8],
    stopped: impl Fn() -> bool,
    mut write: impl FnMut(&[u8]) -> std::io::Result<usize>,
    mut pause: impl FnMut(Duration),
    timeout: Duration,
) -> Result<(), SshError> {
    let mut last_progress = Instant::now();
    let mut offset = 0;
    while offset < data.len() {
        if stopped() {
            return Err(SshError::TerminalNotFound);
        }
        match write(&data[offset..]) {
            Ok(0) => return Err(SshError::TerminalFailed("终端输入通道已关闭".into())),
            Ok(size) => {
                offset += size;
                last_progress = Instant::now();
            }
            Err(error) if error.kind() == std::io::ErrorKind::WouldBlock => {
                if last_progress.elapsed() >= timeout {
                    return Err(SshError::TerminalFailed("终端输入发送超时".into()));
                }
                pause(TERMINAL_POLL_INTERVAL);
            }
            Err(error) if error.kind() == std::io::ErrorKind::Interrupted => continue,
            Err(error) => return Err(SshError::TerminalFailed(error.to_string())),
        }
    }
    Ok(())
}

/// 向远程 PTY 发送尺寸更新，在 libssh2 EAGAIN 时短暂重试。
fn resize_terminal(
    session: &Arc<TerminalSession>,
    columns: u32,
    rows: u32,
) -> Result<(), SshError> {
    let started_at = Instant::now();
    let requested = (columns, rows);
    let mut pending = session
        .resize_request
        .lock()
        .map_err(|_| SshError::TerminalFailed("终端尺寸锁已损坏".into()))?;
    loop {
        if session.stop.load(Ordering::Acquire) {
            return Err(SshError::TerminalNotFound);
        }
        let (columns, rows) = pending.next(requested);
        let result = session
            .channel
            .lock()
            .map_err(|_| SshError::TerminalFailed("终端会话锁已损坏".into()))?
            .request_pty_size(columns, rows, None, None);
        match result {
            Ok(()) => {
                pending.complete();
                if (columns, rows) == requested {
                    return Ok(());
                }
            }
            Err(error) if matches!(error.code(), ErrorCode::Session(LIBSSH2_ERROR_EAGAIN)) => {
                if started_at.elapsed() >= TERMINAL_CONTROL_TIMEOUT {
                    // 保留缓存中的尺寸 A；下一次调用必须先完成 A，再提交最新尺寸 B。
                    return Err(SshError::TerminalResizePending);
                }
                thread::sleep(TERMINAL_POLL_INTERVAL);
            }
            Err(error) => {
                return Err(SshError::TerminalFailed(format!(
                    "调整终端大小失败: {error}"
                )))
            }
        }
    }
}

/// 向已注册的 Tauri 应用句柄发送事件；未初始化时安全忽略。
fn emit_event(
    state_handle: &Arc<Mutex<Option<AppHandle>>>,
    event: &str,
    payload: serde_json::Value,
) {
    let app_handle = state_handle.lock().unwrap();
    if let Some(handle) = app_handle.as_ref() {
        let _ = handle.emit(event, payload);
    }
}

// libssh2 通过数字错误码暴露传输故障。这里有意只保留传输相关错误，
// 让文件、路径和权限错误可以恢复，而不必把用户退回连接列表。
fn is_connection_loss(error: &ssh2::Error) -> bool {
    match error.code() {
        ErrorCode::Session(code) => matches!(
            code,
            LIBSSH2_ERROR_SOCKET_SEND
                | LIBSSH2_ERROR_TIMEOUT
                | LIBSSH2_ERROR_SOCKET_DISCONNECT
                | LIBSSH2_ERROR_SOCKET_TIMEOUT
                | LIBSSH2_ERROR_SOCKET_RECV
                | LIBSSH2_ERROR_BAD_SOCKET
        ),
        ErrorCode::SFTP(code) => {
            matches!(code, LIBSSH2_FX_NO_CONNECTION | LIBSSH2_FX_CONNECTION_LOST)
        }
    }
}

/// 判断本地 IO 错误是否属于远程 socket 断线，而非普通文件错误。
///
/// # Arguments
///
/// * `error` - 由 TCP、SSH 或文件通道产生的 IO 错误。
///
/// # Returns
///
/// 若错误码或文本表明连接已经断开则返回 `true`。
fn is_io_connection_loss(error: &std::io::Error) -> bool {
    let transport_kind = matches!(
        error.kind(),
        std::io::ErrorKind::BrokenPipe
            | std::io::ErrorKind::ConnectionAborted
            | std::io::ErrorKind::ConnectionReset
            | std::io::ErrorKind::NotConnected
            | std::io::ErrorKind::TimedOut
            | std::io::ErrorKind::UnexpectedEof
    );
    let message = error.to_string().to_ascii_lowercase();
    transport_kind
        || message.contains("socket")
        || message.contains("connection lost")
        || message.contains("connection disconnected")
        || message.contains("sftp(6)")
        || message.contains("sftp(7)")
}

/// 集中处理连接断线：清理会话、统计任务、终端并发送前端事件。
fn mark_connection_disconnected(state: &SshState, id: &str, reason: String) {
    let generation = connection_generation(state, id);
    let was_connected = invalidate_file_sessions(state, id);

    // 丢弃缓存会话即可关闭已损坏的传输连接；正在进行的传输任务可能仍会持有
    // 自己的 Arc，直到任务结束。
    state.connection_pool.write().unwrap().remove(id);
    remove_monitor_session(state, id);
    clear_monitor_cache(state, id);
    cancel_directory_size_tasks_for_connection(state, id);
    remove_directory_size_worker_pool(state, id);
    close_terminals_for_connection(state, id);
    if was_connected {
        emit_event(
            &state.app_handle,
            "ssh-disconnected",
            json!({ "id": id, "reason": reason, "generation": generation }),
        );
    }
}

/// 仅在 SSH 错误属于传输断线时更新连接状态。
///
/// # Arguments
///
/// * `state` - 全局 SSH 状态。
/// * `id` - 发生错误的连接 ID。
/// * `error` - libssh2 返回的原始错误。
fn mark_ssh_error_if_connection_lost(state: &SshState, id: &str, error: &ssh2::Error) {
    if !state.isolated_transport && is_connection_loss(error) {
        mark_connection_disconnected(state, id, error.to_string());
    }
}

/// 仅在 IO 错误属于传输断线时更新连接状态。
///
/// # Arguments
///
/// * `state` - 全局 SSH 状态。
/// * `id` - 发生错误的连接 ID。
/// * `error` - 本地 socket 或通道的 IO 错误。
fn mark_io_error_if_connection_lost(state: &SshState, id: &str, error: &std::io::Error) {
    if !state.isolated_transport && is_io_connection_loss(error) {
        mark_connection_disconnected(state, id, error.to_string());
    }
}

/// 判断是否可以去掉可选的原子/本机标志重试重命名；始终保留旧目标。
///
/// # Arguments
///
/// * `error` - 远程 SFTP 重命名返回的错误。
///
/// # Returns
///
/// 目标服务器不支持原子重命名或目标已存在时返回 `true`。
fn is_rename_compatibility_error(error: &ssh2::Error) -> bool {
    matches!(
        error.code(),
        ErrorCode::SFTP(LIBSSH2_FX_FAILURE | LIBSSH2_FX_OP_UNSUPPORTED)
    )
}

/// 判断 SFTP 错误是否表示目标路径已经不存在。
///
/// # Arguments
///
/// * `error` - SFTP 操作返回的错误。
///
/// # Returns
///
/// 错误码为“无此文件/目录”时返回 `true`。
fn is_sftp_missing_path(error: &ssh2::Error) -> bool {
    matches!(error.code(), ErrorCode::SFTP(LIBSSH2_FX_NO_SUCH_FILE))
}

/// 从已认证会话读取 UID；不能用可由其他用户拥有的 home 目录反推身份。
///
/// SFTP 不提供目录句柄相对变更，权限策略只保护普通 POSIX 私有目录。
/// 不支持 UID 命令或可信权限元数据的服务器会明确拒绝变更，不静默降级。
fn remote_mutation_policy(
    state: &SshState,
    id: &str,
    session: &Arc<Mutex<Session>>,
) -> Result<RemoteMutationPolicy, SshError> {
    let channel = {
        let session = session
            .lock()
            .map_err(|_| SshError::SftpFailed("会话锁已损坏".to_string()))?;
        session.channel_session()
    };
    let mut channel = channel.map_err(|error| {
        mark_ssh_error_if_connection_lost(state, id, &error);
        SshError::FileOperationFailed(format!("无法验证远端变更身份: {error}"))
    })?;
    let result = (|| -> Result<u32, SshError> {
        channel.handle_extended_data(ExtendedData::Merge)?;
        channel.exec("id -u")?;
        let mut output = Vec::new();
        (&mut channel).take(32).read_to_end(&mut output)?;
        // 先解析有界输出，避免异常命令持续输出或永不退出时等待关闭。
        let uid = parse_remote_uid(&output).map_err(SshError::FileOperationFailed)?;
        channel.wait_close()?;
        if channel.exit_status()? != 0 {
            return Err(SshError::FileOperationFailed(
                "远端无法提供可信 UID，已拒绝变更".to_string(),
            ));
        }
        Ok(uid)
    })();
    let _ = channel.close();
    result.map(RemoteMutationPolicy::new)
}

// 递归统计时，子目录的权限或瞬时删除不应丢弃已经得出的统计结果。
// 会话层错误仍按连接异常处理，避免把断线误显示为不完整的目录大小。
fn is_recoverable_directory_size_error(error: &ssh2::Error) -> bool {
    matches!(error.code(), ErrorCode::SFTP(code) if !matches!(
        code,
        LIBSSH2_FX_NO_CONNECTION | LIBSSH2_FX_CONNECTION_LOST
    ))
}

/// 将经过校验的本地相对路径安全拼接到远程 POSIX 路径。
fn join_remote_path(base_path: &str, relative_path: &Path) -> Result<String, SshError> {
    let mut remote_path = base_path.trim_end_matches('/').to_string();
    if remote_path.is_empty() {
        remote_path.push('/');
    }

    for component in relative_path.components() {
        let Component::Normal(segment) = component else {
            if matches!(component, Component::CurDir) {
                continue;
            }
            return Err(SshError::FileOperationFailed(
                "本地目录包含不安全的相对路径".to_string(),
            ));
        };
        let segment = segment.to_str().ok_or_else(|| {
            SshError::FileOperationFailed("本地文件名不是有效的 UTF-8 文本".to_string())
        })?;

        if remote_path != "/" {
            remote_path.push('/');
        }
        remote_path.push_str(segment);
    }
    Ok(remote_path)
}

/// 把跨平台相对路径转换为事件和错误消息中使用的显示文本。
#[cfg(test)]
fn display_relative_path(relative_path: &Path) -> String {
    relative_path
        .components()
        .filter_map(|component| match component {
            Component::Normal(segment) => Some(segment.to_string_lossy().to_string()),
            _ => None,
        })
        .collect::<Vec<_>>()
        .join("/")
}

/// 预扫描本地目录，建立不跟随符号链接的上传计划。
#[cfg(test)]
fn collect_folder_upload_plan(
    local_root: &LocalTransferRoot,
    cancelled: impl Fn() -> bool,
    progressed: impl Fn(),
) -> Result<FolderUploadPlan, SshError> {
    collect_folder_upload_plan_with_progress(local_root, cancelled, progressed, |_, _| {})
}

fn collect_folder_upload_plan_with_progress(
    local_root: &LocalTransferRoot,
    cancelled: impl Fn() -> bool,
    progressed: impl Fn(),
    mut discovered: impl FnMut(&Path, SourceStamp),
) -> Result<FolderUploadPlan, SshError> {
    let mut plan = FolderUploadPlan {
        directories: Vec::new(),
        files: Vec::new(),
        total_bytes: 0,
        skipped_entries: 0,
    };
    let mut pending_directories = vec![PathBuf::new()];
    let mut budget = ScanBudget::for_transfer();

    while let Some(directory) = pending_directories.pop() {
        if cancelled() {
            return Err(SshError::TransferCancelled);
        }
        budget.check().map_err(SshError::ReadDirFailed)?;
        let mut entries = Vec::new();
        for entry in local_root.entries(&directory)? {
            if cancelled() {
                return Err(SshError::TransferCancelled);
            }
            let entry = entry?;
            progressed();
            budget
                .record(&directory.join(entry.file_name()))
                .map_err(SshError::ReadDirFailed)?;
            entries.push(entry);
        }
        entries.sort_by_key(|entry| entry.file_name());

        for entry in entries {
            if cancelled() {
                return Err(SshError::TransferCancelled);
            }
            budget.check().map_err(SshError::ReadDirFailed)?;
            let relative_path = directory.join(entry.file_name());
            let metadata = local_root.metadata(&relative_path).map_err(|error| {
                SshError::FileOperationFailed(format!(
                    "无法读取本地文件“{}”: {error}",
                    relative_path.display()
                ))
            })?;
            progressed();
            budget.check().map_err(SshError::ReadDirFailed)?;

            if metadata.file_type().is_symlink() {
                plan.skipped_entries += 1;
            } else if metadata.is_dir() {
                plan.directories.push(relative_path.clone());
                pending_directories.push(relative_path);
            } else if metadata.is_file() {
                let size = metadata.len();
                plan.total_bytes = plan.total_bytes.saturating_add(size);
                let stamp = SourceStamp::new(
                    Some(size),
                    metadata.modified().ok().map(|time| time.into_std()),
                );
                discovered(&relative_path, stamp);
                plan.files.push(FolderUploadFile {
                    relative_path,
                    stamp,
                });
            } else {
                plan.skipped_entries += 1;
            }
        }
    }

    plan.directories.sort_by(|left, right| {
        left.components()
            .count()
            .cmp(&right.components().count())
            .then_with(|| left.cmp(right))
    });
    plan.files
        .sort_by(|left, right| left.relative_path.cmp(&right.relative_path));
    Ok(plan)
}

/// 逐条读取远端目录，收集前检查共享预算和取消信号。
fn bounded_remote_entries(
    sftp: &Sftp,
    path: &Path,
    budget: &Mutex<ScanBudget>,
    cancelled: impl Fn() -> bool,
) -> Result<Vec<(PathBuf, ssh2::FileStat)>, ssh2::Error> {
    bounded_remote_entries_with_progress(sftp, path, budget, cancelled, || {})
}

fn bounded_remote_entries_with_progress(
    sftp: &Sftp,
    path: &Path,
    budget: &Mutex<ScanBudget>,
    cancelled: impl Fn() -> bool,
    progressed: impl Fn(),
) -> Result<Vec<(PathBuf, ssh2::FileStat)>, ssh2::Error> {
    // 使用客户端本地错误码，避免被目录统计当作可忽略的 SFTP 权限错误。
    let failure = |message: &'static str| ssh2::Error::new(ErrorCode::Session(-34), message);
    let mut directory = sftp.opendir(path)?;
    let mut entries = Vec::new();
    loop {
        if cancelled() {
            return Err(failure("目录扫描已取消"));
        }
        budget
            .lock()
            .map_err(|_| failure("扫描预算锁已损坏"))?
            .check()
            .map_err(|_| failure("目录扫描超过120秒总时限，请缩小操作范围"))?;
        match directory.readdir() {
            Ok((name, stat)) => {
                progressed();
                if name == Path::new(".") || name == Path::new("..") {
                    continue;
                }
                // 保留 POSIX 的原始文件名；下载转换到本地路径时另行校验可表示性。
                let mut components = name.components();
                if !matches!(components.next(), Some(Component::Normal(_)))
                    || components.next().is_some()
                {
                    return Err(failure("远端目录包含不安全的项目名称"));
                }
                let child = path.join(name);
                budget
                    .lock()
                    .map_err(|_| failure("扫描预算锁已损坏"))?
                    .record(&child)
                    .map_err(|_| {
                        failure("目录扫描超过条目、路径内存、深度或120秒预算，请缩小操作范围")
                    })?;
                entries.push((child, stat));
            }
            // ssh2::File::readdir 使用 LIBSSH2_ERROR_FILE 表示目录结束。
            Err(error) if error.code() == ErrorCode::Session(-16) => break,
            Err(error) if error.code() == ErrorCode::Session(-37) => {
                thread::sleep(Duration::from_millis(10))
            }
            Err(error) => return Err(error),
        }
    }
    Ok(entries)
}

/// 校验远程子项名称并按 SFTP 规则拼接子路径。
fn join_remote_child_path(base_path: &str, name: &str) -> Result<String, SshError> {
    if name.is_empty() || name == "." || name == ".." || name.contains('/') || name.contains('\\') {
        return Err(SshError::FileOperationFailed(
            "远程目录包含不安全的项目名称".to_string(),
        ));
    }
    let mut components = Path::new(name).components();
    if !matches!(components.next(), Some(Component::Normal(_))) || components.next().is_some() {
        return Err(SshError::FileOperationFailed(
            "远程目录包含不安全的项目名称".to_string(),
        ));
    }

    // SFTP 路径始终使用斜杠分隔符，即使桌面程序运行在 Windows 上也是如此。
    // 在这里统一规范化，可以让递归下载不受本机 Path 分隔符影响。
    let mut remote_path = base_path.replace('\\', "/");
    while remote_path.len() > 1 && remote_path.ends_with('/') {
        remote_path.pop();
    }
    if remote_path.is_empty() {
        remote_path.push('/');
    }
    if remote_path != "/" {
        remote_path.push('/');
    }
    remote_path.push_str(name);
    Ok(remote_path)
}

/// 递归预扫描远程目录，建立不跟随符号链接的本地下载计划。
fn collect_folder_download_plan_with_progress(
    state: &SshState,
    connection_id: &str,
    sftp: &Sftp,
    remote_path: &str,
    transfer_id: &str,
    mut discovered: impl FnMut(&Path, &str, SourceStamp),
) -> Result<FolderDownloadPlan, SshError> {
    let normalized_root = remote_path.replace('\\', "/");
    let root_stat = sftp.lstat(Path::new(&normalized_root)).map_err(|error| {
        mark_ssh_error_if_connection_lost(state, connection_id, &error);
        SshError::FileOperationFailed(format!("无法读取远程文件夹“{remote_path}”: {error}"))
    })?;
    if root_stat.file_type() == ssh2::FileType::Symlink || !root_stat.is_dir() {
        return Err(SshError::FileOperationFailed(
            "远程路径不是可下载的文件夹".to_string(),
        ));
    }

    let mut plan = FolderDownloadPlan {
        directories: Vec::new(),
        files: Vec::new(),
        total_bytes: 0,
        total_known: true,
        skipped_entries: 0,
    };
    let mut pending = vec![(normalized_root, PathBuf::new())];
    let budget = Mutex::new(ScanBudget::for_transfer());

    while let Some((directory, relative_directory)) = pending.pop() {
        if is_cancelled(state, transfer_id) {
            return Err(SshError::TransferCancelled);
        }
        let entries = bounded_remote_entries_with_progress(
            sftp,
            Path::new(&directory),
            &budget,
            || is_cancelled(state, transfer_id),
            || state.tasks.heartbeat(transfer_id),
        )
        .map_err(|error| {
            if is_cancelled(state, transfer_id) {
                return SshError::TransferCancelled;
            }
            mark_ssh_error_if_connection_lost(state, connection_id, &error);
            SshError::FileOperationFailed(format!("读取远程文件夹“{directory}”失败: {error}"))
        })?;

        for (listed_path, listed_stat) in entries {
            if is_cancelled(state, transfer_id) {
                return Err(SshError::TransferCancelled);
            }
            budget
                .lock()
                .map_err(|_| SshError::ReadDirFailed("扫描预算锁已损坏".to_string()))?
                .check()
                .map_err(SshError::ReadDirFailed)?;
            let Some(name) = listed_path.file_name().and_then(|value| value.to_str()) else {
                plan.skipped_entries = plan.skipped_entries.saturating_add(1);
                continue;
            };
            if name == "." || name == ".." {
                continue;
            }
            let child_remote_path = match join_remote_child_path(&directory, name) {
                Ok(path) => path,
                Err(_) => {
                    plan.skipped_entries = plan.skipped_entries.saturating_add(1);
                    continue;
                }
            };
            // READDIR 通常已包含完整属性；只在服务器省略类型时补一次 LSTAT。
            let child_stat = match if listed_stat.perm.is_some() {
                Ok(listed_stat)
            } else {
                sftp.lstat(Path::new(&child_remote_path))
            } {
                Ok(stat) => stat,
                Err(error) if is_sftp_missing_path(&error) => {
                    plan.skipped_entries = plan.skipped_entries.saturating_add(1);
                    continue;
                }
                Err(error) => {
                    mark_ssh_error_if_connection_lost(state, connection_id, &error);
                    return Err(SshError::FileOperationFailed(format!(
                        "无法读取远程项目“{child_remote_path}”: {error}"
                    )));
                }
            };
            state.tasks.heartbeat(transfer_id);
            budget
                .lock()
                .map_err(|_| SshError::ReadDirFailed("扫描预算锁已损坏".to_string()))?
                .check()
                .map_err(SshError::ReadDirFailed)?;
            if child_stat.file_type() == ssh2::FileType::Symlink {
                // 跳过扫描时发现的远端链接；本地根约束由 LocalTransferRoot 保证。
                plan.skipped_entries = plan.skipped_entries.saturating_add(1);
                continue;
            }

            let relative_path = relative_directory.join(name);
            if child_stat.is_dir() {
                plan.directories.push(relative_path.clone());
                pending.push((child_remote_path, relative_path));
            } else if child_stat.is_file() {
                plan.total_known &= child_stat.size.is_some();
                let size = child_stat.size.unwrap_or(0);
                plan.total_bytes = plan.total_bytes.saturating_add(size);
                discovered(
                    &relative_path,
                    &child_remote_path,
                    remote_source_stamp(&child_stat)?,
                );
                plan.files.push(FolderDownloadFile {
                    remote_path: child_remote_path,
                    relative_path,
                    stamp: remote_source_stamp(&child_stat)?,
                });
            } else {
                plan.skipped_entries = plan.skipped_entries.saturating_add(1);
            }
        }
    }

    plan.directories.sort_by(|left, right| {
        left.components()
            .count()
            .cmp(&right.components().count())
            .then_with(|| left.cmp(right))
    });
    plan.files
        .sort_by(|left, right| left.relative_path.cmp(&right.relative_path));
    Ok(plan)
}

/// 不使用本机 PathBuf::join，避免 Windows 将协议路径拼成反斜杠。
fn append_remote_leaf(parent: &Path, name: &std::ffi::OsStr) -> PathBuf {
    let mut path = parent.as_os_str().to_os_string();
    if !parent.to_string_lossy().ends_with('/') {
        path.push("/");
    }
    path.push(name);
    PathBuf::from(path)
}

fn map_commit_error(error: crate::sftp_commit::CommitError) -> SshError {
    match error {
        crate::sftp_commit::CommitError::Unsupported => SshError::AtomicRenameUnsupported,
        crate::sftp_commit::CommitError::Cancelled => SshError::TransferCancelled,
        crate::sftp_commit::CommitError::OutcomeUnknown(message) => {
            SshError::CommitOutcomeUnknown(message)
        }
        other => SshError::FileOperationFailed(other.to_string()),
    }
}

/// 不删除旧目标；v3 安全覆盖通过服务器宣告的 POSIX 扩展完成。
fn rename_remote_file(
    sftp: &Sftp,
    session: &Session,
    source_path: &Path,
    target_path: &Path,
    overwrite: bool,
    cancelled: impl Fn() -> bool,
    begin_commit: impl Fn() -> Result<(), crate::sftp_commit::CommitError>,
) -> Result<(), SshError> {
    rename_remote_file_cached(
        sftp,
        session,
        source_path,
        target_path,
        overwrite,
        None,
        cancelled,
        begin_commit,
    )
}

#[allow(clippy::too_many_arguments)] // 独立兼容包装保持现有单文件与重命名调用不变。
fn rename_remote_file_cached(
    sftp: &Sftp,
    session: &Session,
    source_path: &Path,
    target_path: &Path,
    overwrite: bool,
    client: Option<&Mutex<Option<crate::sftp_commit::PosixRenameClient>>>,
    cancelled: impl Fn() -> bool,
    begin_commit: impl Fn() -> Result<(), crate::sftp_commit::CommitError>,
) -> Result<(), SshError> {
    if cancelled() {
        return Err(SshError::TransferCancelled);
    }
    if overwrite {
        fn absolute(sftp: &Sftp, path: &Path) -> Result<PathBuf, SshError> {
            let name = path
                .file_name()
                .ok_or_else(|| SshError::FileOperationFailed("重命名路径缺少文件名".into()))?;
            let parent = path
                .parent()
                .filter(|p| !p.as_os_str().is_empty())
                .unwrap_or(Path::new("."));
            let parent = sftp
                .realpath(parent)
                .map_err(|error| SshError::FileOperationFailed(error.to_string()))?;
            Ok(append_remote_leaf(&parent, name))
        }
        let source = absolute(sftp, source_path)?;
        let target = absolute(sftp, target_path)?;
        let deadline = Instant::now() + Duration::from_secs(60);
        let cancelled = || cancelled() || Instant::now() >= deadline;
        let result = if let Some(client) = client {
            let mut client = client.lock().unwrap();
            if client.is_none() {
                *client = Some(
                    crate::sftp_commit::PosixRenameClient::open(session, cancelled)
                        .map_err(map_commit_error)?,
                );
            }
            client
                .as_mut()
                .unwrap()
                .rename(&source, &target, cancelled, begin_commit)
        } else {
            crate::sftp_commit::posix_rename(session, &source, &target, cancelled, begin_commit)
        };
        result.map_err(|error| match error {
            crate::sftp_commit::CommitError::Unsupported => SshError::AtomicRenameUnsupported,
            crate::sftp_commit::CommitError::Cancelled => SshError::TransferCancelled,
            crate::sftp_commit::CommitError::OutcomeUnknown(message) => {
                SshError::CommitOutcomeUnknown(message)
            }
            other => SshError::FileOperationFailed(other.to_string()),
        })
    } else {
        begin_commit().map_err(|error| match error {
            crate::sftp_commit::CommitError::Cancelled => SshError::TransferCancelled,
            other => SshError::FileOperationFailed(other.to_string()),
        })?;
        sftp.rename(
            source_path,
            target_path,
            Some(RenameFlags::ATOMIC | RenameFlags::NATIVE),
        )
        .or_else(|error| {
            if is_rename_compatibility_error(&error) {
                sftp.rename(source_path, target_path, Some(RenameFlags::empty()))
            } else {
                Err(error)
            }
        })
        .map_err(|error| match error.code() {
            ErrorCode::SFTP(code) if code > 0 && !is_connection_loss(&error) => {
                SshError::FileOperationFailed(error.to_string())
            }
            _ => SshError::CommitOutcomeUnknown(error.to_string()),
        })
    }
}

fn session_for(state: &SshState, id: &str) -> Result<Arc<Mutex<Session>>, SshError> {
    let _ = connection_info(state, id, true)?;
    state
        .connection_pool
        .read()
        .unwrap()
        .get(id)
        .cloned()
        .ok_or(SshError::ConnectionNotFound)
}

/// 从连接会话创建一个 SFTP 子会话，并统一处理断线错误。
fn sftp_for(state: &SshState, id: &str) -> Result<Sftp, SshError> {
    let session = session_for(state, id)?;
    let session = session
        .lock()
        .map_err(|_| SshError::SftpFailed("会话锁已损坏".to_string()))?;
    session.sftp().map_err(|error| {
        mark_ssh_error_if_connection_lost(state, id, &error);
        SshError::SftpFailed(error.to_string())
    })
}

/// 使用单引号转义远程 Shell 路径，避免 `du` 快速路径产生命令注入。
fn shell_quote_remote_path(path: &str) -> Option<String> {
    if path.as_bytes().contains(&0) {
        return None;
    }

    let mut quoted = String::with_capacity(path.len() + 2);
    quoted.push('\'');
    for character in path.chars() {
        if character == '\'' {
            quoted.push_str("'\\''");
        } else {
            quoted.push(character);
        }
    }
    quoted.push('\'');
    Some(quoted)
}

/// 判断路径是否适合交给远程 POSIX Shell 的 `du` 命令。
fn is_absolute_posix_remote_path(path: &str) -> bool {
    path.starts_with('/')
}

/// 解析严格的 `du -s -b` 输出，异常或附加日志会触发 SFTP 回退。
fn parse_remote_du_size(output: &[u8]) -> Option<u64> {
    // GNU du 的汇总输出应以大小字段开头。若远端包装脚本额外输出了内容，
    // 放弃快速路径并回退，避免把无关数字误显示为文件夹大小。
    let line = output
        .split(|byte| *byte == b'\n')
        .find(|line| line.iter().any(|byte| !byte.is_ascii_whitespace()))?;
    let value = line
        .split(|byte| byte.is_ascii_whitespace())
        .find(|part| !part.is_empty())?;
    std::str::from_utf8(value).ok()?.parse::<u64>().ok()
}

/// 判断远端命令输出是否表明没有可用的兼容 `du`。
fn remote_du_is_unavailable(output: &[u8]) -> bool {
    let message = String::from_utf8_lossy(output).to_ascii_lowercase();
    [
        "command not found",
        "not found",
        "not recognized",
        "invalid option",
        "illegal option",
        "unknown option",
        "unrecognized option",
        "usage:",
    ]
    .iter()
    .any(|pattern| message.contains(pattern))
}

/// 读取非阻塞 `du` channel 的输出，并响应目录统计取消信号。
fn read_directory_size_command_output(
    state: &SshState,
    connection_id: &str,
    channel: &mut Channel,
    cancellation: &AtomicBool,
) -> Result<Option<Vec<u8>>, SshError> {
    let mut output = Vec::with_capacity(128);
    let mut buffer = [0_u8; 4096];
    let budget = ScanBudget::default();
    loop {
        if cancellation.load(Ordering::Acquire) {
            let _ = channel.close();
            return Err(SshError::DirectorySizeCancelled);
        }
        if let Err(message) = budget.check() {
            let _ = channel.close();
            return Err(SshError::ReadFailed(message));
        }

        match channel.read(&mut buffer) {
            // ssh2 的非阻塞读取在暂时没有数据时也可能返回 0；只有远端已发送
            // EOF 才表示命令输出已完整读取。
            Ok(0) if channel.eof() => return Ok(Some(output)),
            Ok(0) => thread::sleep(DIRECTORY_SIZE_COMMAND_POLL_INTERVAL),
            Ok(size) => {
                output.extend_from_slice(&buffer[..size]);
                if output.len() > MAX_DIRECTORY_SIZE_COMMAND_OUTPUT_BYTES {
                    let _ = channel.close();
                    return Ok(None);
                }
            }
            Err(error)
                if error.kind() == std::io::ErrorKind::WouldBlock
                    || error
                        .to_string()
                        .to_ascii_lowercase()
                        .contains("would block") =>
            {
                thread::sleep(DIRECTORY_SIZE_COMMAND_POLL_INTERVAL);
            }
            Err(error) => {
                mark_io_error_if_connection_lost(state, connection_id, &error);
                return Err(SshError::ReadFailed(error.to_string()));
            }
        }
    }
}

// GNU/Linux 的 `du` 在服务器本机遍历目录，避免客户端通过 SFTP 为每个子目录
// 往返一次。命令失败或服务器没有兼容的 `du` 时返回 None，由调用方走 SFTP 兜底。
fn try_remote_directory_size(
    state: &SshState,
    connection: &SshConnection,
    remote_path: &str,
    cancellation: &AtomicBool,
) -> Result<Option<RemoteDirectorySize>, SshError> {
    if cancellation.load(Ordering::Acquire) {
        return Err(SshError::DirectorySizeCancelled);
    }
    // SFTP 的相对路径或 Windows 风格路径未必与 SSH Shell 的目录空间一致，
    // 因此只为绝对 POSIX 路径启用远端 du；其他情况保持 SFTP 递归基线。
    if !is_absolute_posix_remote_path(remote_path) {
        return Ok(None);
    }
    if state
        .directory_size_fast_path_support
        .lock()
        .unwrap()
        .get(&connection.id)
        .copied()
        == Some(false)
    {
        return Ok(None);
    }

    let Some(quoted_path) = shell_quote_remote_path(remote_path) else {
        return Ok(None);
    };
    let session = match open_authenticated_session(connection) {
        Ok(session) => session,
        Err(_) => return Ok(None),
    };
    let mut channel = match session.channel_session() {
        Ok(channel) => channel,
        Err(_) => return Ok(None),
    };
    if channel.handle_extended_data(ExtendedData::Merge).is_err() {
        return Ok(None);
    }
    let command = format!("LC_ALL=C du -s -b -l -P -- {quoted_path}");
    if channel.exec(&command).is_err() {
        return Ok(None);
    }

    // 非阻塞读取允许取消请求及时终止长时间运行的远端 du。
    session.set_blocking(false);
    let output =
        read_directory_size_command_output(state, &connection.id, &mut channel, cancellation)?;
    session.set_blocking(true);
    let Some(output) = output else {
        return Ok(None);
    };
    if channel.wait_close().is_err() {
        return Ok(None);
    }
    if channel.exit_status().unwrap_or(1) != 0 {
        if remote_du_is_unavailable(&output) {
            state
                .directory_size_fast_path_support
                .lock()
                .unwrap()
                .insert(connection.id.clone(), false);
        }
        return Ok(None);
    }

    let Some(size) = parse_remote_du_size(&output) else {
        return Ok(None);
    };
    state
        .directory_size_fast_path_support
        .lock()
        .unwrap()
        .insert(connection.id.clone(), true);
    Ok(Some(RemoteDirectorySize {
        size,
        complete: true,
        inaccessible_count: 0,
        scanned_entries: 0,
    }))
}

// 统计任务开始时登记引用，避免另一个任务结束时误清理仍在使用的会话池。
fn begin_directory_size_task(
    state: &SshState,
    id: &str,
) -> Result<Arc<Mutex<DirectorySizeWorkerPool>>, SshError> {
    let mut pools = state
        .directory_size_worker_pools
        .write()
        .map_err(|_| SshError::SftpFailed("目录统计会话池已损坏".to_string()))?;
    let pool = pools
        .entry(id.to_string())
        .or_insert_with(|| Arc::new(Mutex::new(DirectorySizeWorkerPool::default())))
        .clone();
    let mut pool_state = pool
        .lock()
        .map_err(|_| SshError::SftpFailed("目录统计会话池已损坏".to_string()))?;
    pool_state.active_tasks = pool_state.active_tasks.saturating_add(1);
    drop(pool_state);
    Ok(pool)
}

// 最后一个统计任务结束时清空并移除会话池；下次统计按需重新建立，避免长期占用远端资源。
fn end_directory_size_task(state: &SshState, id: &str, pool: &Arc<Mutex<DirectorySizeWorkerPool>>) {
    let Ok(mut pools) = state.directory_size_worker_pools.write() else {
        return;
    };
    let Some(current_pool) = pools.get(id) else {
        return;
    };
    if !Arc::ptr_eq(current_pool, pool) {
        return;
    }
    let Ok(mut pool_state) = pool.lock() else {
        return;
    };
    pool_state.active_tasks = pool_state.active_tasks.saturating_sub(1);
    if pool_state.active_tasks != 0 {
        return;
    }
    // 所有任务均已等待结束，此时不会再有工作会话或建连动作持有该池。
    pool_state.workers.clear();
    drop(pool_state);

    pools.remove(id);
}

/// 在连接关闭时移除目录统计会话池，正在运行的任务会通过取消信号退出。
fn remove_directory_size_worker_pool(state: &SshState, id: &str) {
    // 移除池中的持有引用即可关闭空闲会话；正在执行的统计会在取消后自然释放。
    state
        .directory_size_worker_pools
        .write()
        .unwrap()
        .remove(id);
}

/// 从连接的工作池借出一个会话，必要时按上限建立新会话。
fn checkout_directory_size_worker(
    state: &SshState,
    id: &str,
    pool: &Arc<Mutex<DirectorySizeWorkerPool>>,
    cancellation: &AtomicBool,
) -> Result<DirectorySizeWorkerLease, SshError> {
    if cancellation.load(Ordering::Acquire) {
        return Err(SshError::DirectorySizeCancelled);
    }
    let connection = connection_info(state, id, true)?;
    let mut pool_state = pool
        .lock()
        .map_err(|_| SshError::SftpFailed("目录统计会话池已损坏".to_string()))?;

    if cancellation.load(Ordering::Acquire) {
        return Err(SshError::DirectorySizeCancelled);
    }
    if let Some(worker) = pool_state.workers.iter().find(|worker| {
        worker
            .in_use
            .compare_exchange(false, true, Ordering::AcqRel, Ordering::Relaxed)
            .is_ok()
    }) {
        return Ok(DirectorySizeWorkerLease {
            worker: Arc::clone(worker),
        });
    }
    if pool_state.workers.len() + pool_state.opening_workers
        >= MAX_CONCURRENT_DIRECTORY_SIZE_WORKERS
    {
        return Err(SshError::DirectorySizeLimitReached);
    }
    // 先预留名额再释放锁，允许多条 SSH 会话并行握手而不会超过上限。
    pool_state.opening_workers = pool_state.opening_workers.saturating_add(1);
    drop(pool_state);
    let opening_lease = DirectorySizeOpeningLease {
        pool: Arc::clone(pool),
    };

    // 首次使用时才建立工作会话；以后优先复用，避免反复 SSH 握手和认证。
    let session = open_authenticated_session(&connection);
    let mut pool_state = pool
        .lock()
        .map_err(|_| SshError::SftpFailed("目录统计会话池已损坏".to_string()))?;
    if cancellation.load(Ordering::Acquire) {
        return Err(SshError::DirectorySizeCancelled);
    }
    let session = session?;
    let worker = Arc::new(DirectorySizeWorker {
        session: Arc::new(Mutex::new(session)),
        in_use: AtomicBool::new(true),
    });
    pool_state.workers.push(Arc::clone(&worker));
    drop(pool_state);
    drop(opening_lease);
    Ok(DirectorySizeWorkerLease { worker })
}

// 目录大小扫描使用独立、可复用的 SFTP 会话，避免递归 readdir 占用主会话传输锁。
fn directory_size_sftp_for(
    state: &SshState,
    id: &str,
    pool: &Arc<Mutex<DirectorySizeWorkerPool>>,
    cancellation: &AtomicBool,
) -> Result<DirectorySizeSftpSession, SshError> {
    let worker_lease = checkout_directory_size_worker(state, id, pool, cancellation)?;
    if cancellation.load(Ordering::Acquire) {
        return Err(SshError::DirectorySizeCancelled);
    }
    let session = worker_lease
        .worker
        .session
        .lock()
        .map_err(|_| SshError::SftpFailed("目录统计会话锁已损坏".to_string()))?;
    let sftp = session.sftp().map_err(|error| {
        mark_ssh_error_if_connection_lost(state, id, &error);
        SshError::SftpFailed(error.to_string())
    })?;
    drop(session);
    Ok(DirectorySizeSftpSession {
        sftp,
        _worker_lease: worker_lease,
    })
}

/// 生成递归删除进度中展示的远程项目名称。
fn remote_delete_display_path(path: &Path) -> String {
    path.file_name()
        .map(|name| name.to_string_lossy().to_string())
        .filter(|name| !name.is_empty())
        .unwrap_or_else(|| path.to_string_lossy().to_string())
}

/// 预扫描远程目录并生成“文件优先、目录逆序”的删除计划。
fn collect_remote_delete_plan(
    state: &SshState,
    connection_id: &str,
    sftp: &Sftp,
    policy: &RemoteMutationPolicy,
    remote_path: &Path,
    operation_id: Option<&str>,
) -> Result<Vec<RemoteDeleteTarget>, SshError> {
    // lstat 不递归扫描当时的链接；实际操作前仍需核验路径和共享目录策略。
    let mut pending = vec![(
        remote_path.to_path_buf(),
        remote_delete_display_path(remote_path),
    )];
    let mut files = Vec::new();
    let mut directories = Vec::new();
    let budget = Mutex::new(ScanBudget::for_transfer());

    while let Some((path, display_path)) = pending.pop() {
        if operation_id.is_some_and(|id| is_cancelled(state, id)) {
            return Err(SshError::TransferCancelled);
        }
        budget
            .lock()
            .map_err(|_| SshError::ReadDirFailed("扫描预算锁已损坏".to_string()))?
            .check()
            .map_err(SshError::ReadDirFailed)?;
        policy
            .validate_parent(sftp, &path)
            .map_err(SshError::FileOperationFailed)?;
        let stat = match sftp.lstat(&path) {
            Ok(stat) => stat,
            // 其他客户端可能已经删除了该项目。由于目标状态已经达到，
            // 不需要再把它加入处理计划。
            Err(error) if is_sftp_missing_path(&error) => continue,
            Err(error) => {
                mark_ssh_error_if_connection_lost(state, connection_id, &error);
                return Err(SshError::FileOperationFailed(format!(
                    "无法读取远程项目“{}”: {error}",
                    path.display()
                )));
            }
        };

        if let Some(id) = operation_id {
            state.tasks.heartbeat(id);
        }
        if !stat.is_dir() {
            files.push(RemoteDeleteTarget {
                path,
                display_path,
                is_directory: false,
            });
            continue;
        }

        policy
            .validate_directory(sftp, &path)
            .map_err(SshError::FileOperationFailed)?;

        directories.push(RemoteDeleteTarget {
            path: path.clone(),
            display_path: display_path.clone(),
            is_directory: true,
        });
        let entries = bounded_remote_entries_with_progress(
            sftp,
            &path,
            &budget,
            || operation_id.is_some_and(|id| is_cancelled(state, id)),
            || {
                if let Some(id) = operation_id {
                    state.tasks.heartbeat(id);
                }
            },
        )
        .map_err(|error| {
            mark_ssh_error_if_connection_lost(state, connection_id, &error);
            SshError::FileOperationFailed(format!(
                "读取远程文件夹“{}”失败: {error}",
                path.display()
            ))
        })?;

        for (listed_path, _) in entries {
            let name = listed_path.file_name().ok_or_else(|| {
                SshError::FileOperationFailed(format!(
                    "无法识别远程文件夹“{}”中的项目名称",
                    path.display()
                ))
            })?;
            if name == "." || name == ".." {
                continue;
            }
            let child_name = name.to_string_lossy();
            pending.push((path.join(name), format!("{display_path}/{child_name}")));
        }
    }

    // 目录树先访问父目录再访问子项目；反转目录部分后，
    // 每个目录都会在内容删除完成后再被删除。
    directories.reverse();
    files.extend(directories);
    budget
        .lock()
        .map_err(|_| SshError::ReadDirFailed("扫描预算锁已损坏".to_string()))?
        .check()
        .map_err(SshError::ReadDirFailed)?;
    Ok(files)
}

/// 发送远程删除扫描/清理阶段的进度事件。
fn delete_progress(
    state: &SshState,
    connection_id: &str,
    operation_id: Option<&str>,
    file_name: &str,
    item_index: usize,
    item_total: usize,
    phase: &str,
) {
    let Some(operation_id) = operation_id else {
        return;
    };
    let progress = if phase == "cleaning" {
        100
    } else {
        percentage_with_empty_value(item_index.saturating_add(1) as u64, item_total as u64, 0)
    };
    if !state.tasks.progress(
        operation_id,
        item_index as u64,
        Some(item_total as u64),
        &format!("{phase}:{file_name}"),
    ) {
        return;
    }
    emit_task_event(
        state,
        operation_id,
        "delete-progress",
        json!({
            "id": connection_id,
            "operationId": operation_id,
            "progress": progress,
            "fileName": file_name,
            "itemIndex": item_index,
            "itemTotal": item_total,
            "phase": phase
        }),
    );
}

/// 执行已生成的远程删除计划，并对并发删除保持幂等。
fn delete_remote_path(
    state: &SshState,
    connection_id: &str,
    sftp: &Sftp,
    policy: &RemoteMutationPolicy,
    remote_path: &Path,
    operation_id: Option<&str>,
) -> Result<(), SshError> {
    let root_name = remote_delete_display_path(remote_path);
    delete_progress(
        state,
        connection_id,
        operation_id,
        &root_name,
        0,
        0,
        "scanning",
    );
    let plan = collect_remote_delete_plan(
        state,
        connection_id,
        sftp,
        policy,
        remote_path,
        operation_id,
    )?;
    let file_total = plan.iter().filter(|target| !target.is_directory).count();
    let mut file_index = 0usize;
    let mut cleaning_started = false;

    for target in plan.iter() {
        if operation_id.is_some_and(|id| is_cancelled(state, id)) {
            return Err(SshError::TransferCancelled);
        }
        match sftp.lstat(&target.path) {
            // 已由其他客户端删除的子树，无需再检查不存在的父目录。
            Err(error) if is_sftp_missing_path(&error) => {
                if let Some(id) = operation_id {
                    state.tasks.heartbeat(id);
                }
                if !target.is_directory {
                    delete_progress(
                        state,
                        connection_id,
                        operation_id,
                        &target.display_path,
                        file_index,
                        file_total,
                        "deleting",
                    );
                    file_index = file_index.saturating_add(1);
                }
                continue;
            }
            Err(error) => {
                mark_ssh_error_if_connection_lost(state, connection_id, &error);
                return Err(SshError::FileOperationFailed(error.to_string()));
            }
            Ok(_) => {}
        }
        if let Some(id) = operation_id {
            state.tasks.heartbeat(id);
        }
        // 扫描和删除之间可能有其他客户端操作；不能仅信任预扫描的父路径。
        policy
            .validate_parent(sftp, &target.path)
            .map_err(SshError::FileOperationFailed)?;
        if target.is_directory {
            policy
                .validate_directory(sftp, &target.path)
                .map_err(SshError::FileOperationFailed)?;
        }
        if target.is_directory && !cleaning_started {
            delete_progress(
                state,
                connection_id,
                operation_id,
                &target.display_path,
                file_index,
                file_total,
                "cleaning",
            );
            cleaning_started = true;
        }
        let result = if target.is_directory {
            sftp.rmdir(&target.path)
        } else {
            sftp.unlink(&target.path)
        };
        if let Err(error) = result {
            if is_sftp_missing_path(&error) {
                if let Some(id) = operation_id {
                    state.tasks.heartbeat(id);
                }
                if !target.is_directory {
                    delete_progress(
                        state,
                        connection_id,
                        operation_id,
                        &target.display_path,
                        file_index,
                        file_total,
                        "deleting",
                    );
                    file_index = file_index.saturating_add(1);
                }
                continue;
            }
            mark_ssh_error_if_connection_lost(state, connection_id, &error);
            let action = if target.is_directory {
                "删除远程文件夹"
            } else {
                "删除远程项目"
            };
            return Err(SshError::FileOperationFailed(format!(
                "{action}“{}”失败: {error}",
                target.path.display()
            )));
        }
        if let Some(id) = operation_id {
            state.tasks.heartbeat(id);
        }
        if !target.is_directory {
            delete_progress(
                state,
                connection_id,
                operation_id,
                &target.display_path,
                file_index,
                file_total,
                "deleting",
            );
            file_index = file_index.saturating_add(1);
        }
    }
    Ok(())
}

/// 为后台删除线程创建 SFTP 子会话并执行递归删除。
fn run_delete(
    state: &SshState,
    session: &Arc<Mutex<Session>>,
    connection_id: &str,
    remote_path: &str,
    operation_id: &str,
) -> Result<(), SshError> {
    let policy = remote_mutation_policy(state, connection_id, session)?;
    let session = session
        .lock()
        .map_err(|_| SshError::SftpFailed("会话锁已损坏".to_string()))?;
    let sftp = session.sftp().map_err(|error| {
        mark_ssh_error_if_connection_lost(state, connection_id, &error);
        SshError::SftpFailed(error.to_string())
    })?;
    drop(session);

    delete_remote_path(
        state,
        connection_id,
        &sftp,
        &policy,
        Path::new(remote_path),
        Some(operation_id),
    )
}

/// 确认远程目录存在；根据覆盖策略处理同名项目。
fn ensure_remote_directory(
    state: &SshState,
    connection_id: &str,
    sftp: &Sftp,
    policy: &RemoteMutationPolicy,
    remote_path: &str,
    allow_existing: bool,
) -> Result<(), SshError> {
    let path = Path::new(remote_path);
    policy
        .validate_parent(sftp, path)
        .map_err(SshError::FileOperationFailed)?;
    match sftp.lstat(path) {
        Ok(stat) if stat.is_dir() && allow_existing => policy
            .validate_directory(sftp, path)
            .map_err(SshError::FileOperationFailed),
        Ok(stat) if stat.is_dir() => Err(SshError::TargetExists(format!(
            "远程文件夹已存在: {remote_path}"
        ))),
        Ok(_) => Err(SshError::TargetExists(format!(
            "远程路径存在同名文件: {remote_path}"
        ))),
        Err(error) if is_sftp_missing_path(&error) => {
            match sftp.mkdir(path, 0o700) {
                Ok(()) => policy
                    .validate_directory(sftp, path)
                    .map_err(SshError::FileOperationFailed),
                Err(mkdir_error) => match sftp.lstat(path) {
                    // 其他客户端可能在 stat 和 mkdir 之间创建了目录；
                    // 在已确认合并的情况下可以安全继续。
                    Ok(stat) if stat.is_dir() && allow_existing => policy
                        .validate_directory(sftp, path)
                        .map_err(SshError::FileOperationFailed),
                    Ok(stat) if stat.is_dir() => Err(SshError::TargetExists(format!(
                        "远程文件夹已存在: {remote_path}"
                    ))),
                    Ok(_) => Err(SshError::TargetExists(format!(
                        "远程路径存在同名文件: {remote_path}"
                    ))),
                    Err(stat_error) => {
                        mark_ssh_error_if_connection_lost(state, connection_id, &mkdir_error);
                        mark_ssh_error_if_connection_lost(state, connection_id, &stat_error);
                        Err(SshError::FileOperationFailed(mkdir_error.to_string()))
                    }
                },
            }
        }
        Err(error) => {
            mark_ssh_error_if_connection_lost(state, connection_id, &error);
            Err(SshError::FileOperationFailed(error.to_string()))
        }
    }
}

/// 原子申请目录统计工作线程名额，达到上限时返回可重试错误。
fn try_directory_size_worker_slot(state: &SshState) -> Result<DirectorySizeWorkerSlot, SshError> {
    loop {
        let current = state.active_directory_size_workers.load(Ordering::Acquire);
        if current >= MAX_CONCURRENT_DIRECTORY_SIZE_WORKERS {
            return Err(SshError::DirectorySizeLimitReached);
        }
        if state
            .active_directory_size_workers
            .compare_exchange(current, current + 1, Ordering::AcqRel, Ordering::Relaxed)
            .is_ok()
        {
            return Ok(DirectorySizeWorkerSlot {
                active_workers: Arc::clone(&state.active_directory_size_workers),
                worker_wait: Arc::clone(&state.directory_size_worker_wait),
            });
        }
    }
}

// 动态工作者在会话满载时等待释放，而不是把后续子目录统计直接判定为失败。
fn directory_size_worker_slot(
    state: &SshState,
    cancellation: &AtomicBool,
) -> Result<DirectorySizeWorkerSlot, SshError> {
    loop {
        if cancellation.load(Ordering::Acquire) {
            return Err(SshError::DirectorySizeCancelled);
        }
        match try_directory_size_worker_slot(state) {
            Ok(slot) => return Ok(slot),
            Err(SshError::DirectorySizeLimitReached) => {
                let wait_guard = state
                    .directory_size_worker_wait
                    .wait_lock
                    .lock()
                    .map_err(|_| SshError::SftpFailed("目录统计等待状态已损坏".to_string()))?;
                if cancellation.load(Ordering::Acquire) {
                    return Err(SshError::DirectorySizeCancelled);
                }
                if state.active_directory_size_workers.load(Ordering::Acquire)
                    >= MAX_CONCURRENT_DIRECTORY_SIZE_WORKERS
                {
                    let (wait_guard, _) = state
                        .directory_size_worker_wait
                        .wake
                        .wait_timeout(wait_guard, Duration::from_millis(100))
                        .map_err(|_| SshError::SftpFailed("目录统计等待状态已损坏".to_string()))?;
                    drop(wait_guard);
                }
            }
            Err(error) => return Err(error),
        }
    }
}

/// 通知一条连接正在运行的目录统计任务停止。
fn cancel_directory_size_tasks_for_connection(state: &SshState, connection_id: &str) {
    state
        .directory_size_cancellations
        .lock()
        .unwrap()
        .values()
        .filter(|task| task.connection_id == connection_id)
        .for_each(|task| {
            task.signal.store(true, Ordering::Release);
            task.wake.notify_all();
        });
    state.directory_size_worker_wait.wake.notify_all();
}

/// 查询任务取消及连接代次，提交阶段由实际提交返回值决定结果。
fn is_cancelled(state: &SshState, transfer_id: &str) -> bool {
    state.tasks.cancelled(transfer_id)
}

/// 测试 SSH/SFTP 连接、主机指纹和账户认证，不写入连接池。
///
/// # Arguments
///
/// * `host` - SSH 服务器主机名或 IP 地址。
/// * `port` - SSH 服务端口。
/// * `username` - 登录用户名。
/// * `password` - 本次测试使用的账户密码，仅在当前调用期间使用。
/// * `auth_method` - 认证方式标识；省略时使用 `password`。
/// * `timeout` - 连接超时时间（毫秒），会限制在 1 秒至 120 秒之间。
/// * `host_key_fingerprint` - 已确认的主机指纹；首次测试可省略以获取待确认结果。
///
/// # Returns
///
/// 返回连接测试结果，包括认证状态、是否需要确认主机指纹及主机密钥信息。
///
/// # Errors
///
/// 当连接参数无效、TCP/SSH 握手、主机指纹校验、认证或 SFTP 会话创建失败时返回错误。
#[tauri::command]
pub async fn test_sftp_connection(
    host: String,
    port: u16,
    username: String,
    password: String,
    auth_method: Option<String>,
    timeout: Option<u64>,
    host_key_fingerprint: Option<String>,
) -> Result<ConnectionTestResult, SshError> {
    run_blocking_command(move || {
        test_sftp_connection_blocking(
            host,
            port,
            username,
            password,
            auth_method,
            timeout,
            host_key_fingerprint,
        )
    })
    .await
}

fn test_sftp_connection_blocking(
    host: String,
    port: u16,
    username: String,
    password: String,
    auth_method: Option<String>,
    timeout: Option<u64>,
    host_key_fingerprint: Option<String>,
) -> Result<ConnectionTestResult, SshError> {
    let connection = SshConnection {
        id: "test".to_string(),
        host,
        port,
        username,
        auth_method: auth_method.unwrap_or_else(|| "password".to_string()),
        host_key_fingerprint,
        password,
        connected: false,
    };

    validate_connection(&connection)?;
    let opened = open_session_with_timeout(
        &connection,
        Duration::from_millis(timeout.unwrap_or(DEFAULT_TIMEOUT_MS).clamp(1_000, 120_000)),
    )?;
    if connection.host_key_fingerprint.is_none() {
        return Ok(ConnectionTestResult {
            success: false,
            requires_host_key_confirmation: true,
            host_key: opened.host_key,
        });
    }
    verify_host_key(&connection, &opened.host_key)?;
    authenticate(&opened.session, &connection)?;
    opened
        .session
        .sftp()
        .map_err(|error| SshError::SftpFailed(error.to_string()))?;
    Ok(ConnectionTestResult {
        success: true,
        requires_host_key_confirmation: false,
        host_key: opened.host_key,
    })
}

/// 保存或覆盖一条连接配置；配置未变化时保留同 ID 的活动会话。
///
/// # Arguments
///
/// * `state` - Tauri 管理的共享 SSH 状态。
/// * `id` - 连接配置的稳定标识。
/// * `host` - SSH 服务器主机名或 IP 地址。
/// * `port` - SSH 服务端口。
/// * `username` - 登录用户名。
/// * `password` - 连接密码，仅保存在当前进程内存中。
/// * `auth_method` - 认证方式标识；省略时使用 `password`。
/// * `host_key_fingerprint` - 用户已经确认的服务器主机指纹。
///
/// # Returns
///
/// 返回保存后的连接 ID。
///
/// # Errors
///
/// 当连接参数缺失或无效时返回错误。
#[tauri::command]
// 参数名称与前端既有 IPC 契约保持一致；此处有意保留较长签名，避免破坏旧版本调用方。
#[allow(clippy::too_many_arguments)]
pub async fn add_ssh_connection(
    state: State<'_, SshState>,
    id: String,
    host: String,
    port: u16,
    username: String,
    password: String,
    auth_method: Option<String>,
    host_key_fingerprint: Option<String>,
) -> Result<String, SshError> {
    let state = state.inner().clone();
    let connection = SshConnection {
        id: id.clone(),
        host,
        port,
        username,
        auth_method: auth_method.unwrap_or_else(|| "password".to_string()),
        host_key_fingerprint,
        password,
        connected: false,
    };

    run_blocking_command(move || {
        let operation_lock = connection_operation_lock(&state, &id);
        let _operation = operation_lock.lock().unwrap();
        save_ssh_connection(&state, connection)
    })
    .await
}

/// 更新连接配置中的已确认主机指纹。
///
/// # Arguments
///
/// * `state` - Tauri 管理的共享 SSH 状态。
/// * `id` - 要更新的连接配置 ID。
/// * `fingerprint` - 用户确认过的服务器主机指纹。
///
/// # Returns
///
/// 更新成功时返回 `Ok(true)`。
///
/// # Errors
///
/// 当指纹为空或连接配置不存在时返回错误。
#[tauri::command]
pub async fn set_ssh_host_key(
    state: State<'_, SshState>,
    id: String,
    fingerprint: String,
) -> Result<bool, SshError> {
    let state = state.inner().clone();
    run_blocking_command(move || set_ssh_host_key_blocking(state, id, fingerprint)).await
}

fn set_ssh_host_key_blocking(
    state: SshState,
    id: String,
    fingerprint: String,
) -> Result<bool, SshError> {
    if fingerprint.trim().is_empty() {
        return Err(SshError::HandshakeFailed("主机指纹不能为空".to_string()));
    }
    let operation_lock = connection_operation_lock(&state, &id);
    let _operation = operation_lock.lock().unwrap();
    let mut connection = connection_info(&state, &id, false)?;
    connection.host_key_fingerprint = Some(fingerprint);
    connection.connected = false;
    save_ssh_connection(&state, connection)?;
    Ok(true)
}

/// 返回当前保存的全部 SSH 连接配置（密码字段不会序列化）。
///
/// # Arguments
///
/// * `state` - Tauri 管理的共享 SSH 状态。
///
/// # Returns
///
/// 返回全部连接配置数组；密码字段在序列化给前端时会被省略。
///
/// # Errors
///
/// 当共享连接状态锁已损坏时返回错误。
#[tauri::command]
pub fn list_ssh_connections(state: State<SshState>) -> Result<Vec<SshConnection>, SshError> {
    Ok(state
        .connections
        .read()
        .unwrap()
        .values()
        .cloned()
        .collect())
}

/// 建立并缓存一条已认证 SSH 会话；未知主机指纹时返回待确认结果。
///
/// # Arguments
///
/// * `state` - Tauri 管理的共享 SSH 状态。
/// * `id` - 要连接的配置 ID。
///
/// # Returns
///
/// 返回连接结果，包括会话是否已建立、是否需要确认主机指纹及主机密钥信息。
///
/// # Errors
///
/// 当连接配置不存在、网络连接、SSH 握手、主机指纹校验或账户认证失败时返回错误。
#[tauri::command]
pub async fn connect_ssh(
    state: State<'_, SshState>,
    id: String,
) -> Result<ConnectResult, SshError> {
    let state = state.inner().clone();
    run_blocking_command(move || connect_ssh_blocking(state, id)).await
}

fn connect_ssh_blocking(state: SshState, id: String) -> Result<ConnectResult, SshError> {
    let operation_lock = connection_operation_lock(&state, &id);
    let _operation = operation_lock.lock().unwrap();
    let connection = connection_info(&state, &id, false)?;
    validate_connection(&connection)?;
    // 失效分支会重新写池，不能让临时读锁延续到该分支内。
    let cached = state.connection_pool.read().unwrap().get(&id).cloned();
    if let Some(session) = cached {
        let healthy = session
            .lock()
            .map(|session| session.keepalive_send().is_ok())
            .unwrap_or(false);
        if healthy
            && state
                .connections
                .read()
                .unwrap()
                .get(&id)
                .is_some_and(|item| item.connected)
        {
            let host_key = session
                .lock()
                .map_err(|_| SshError::ConnectionFailed("会话锁已损坏".to_string()))
                .and_then(|session| host_key_info(&session))?;
            return Ok(ConnectResult {
                connected: true,
                requires_host_key_confirmation: false,
                host_key,
                generation: connection_generation(&state, &id),
            });
        }
        remove_cached_session(&state, &id);
    }
    let opened = open_session(&connection)?;
    if connection.host_key_fingerprint.is_none() {
        return Ok(ConnectResult {
            connected: false,
            requires_host_key_confirmation: true,
            host_key: opened.host_key,
            generation: connection_generation(&state, &id),
        });
    }
    verify_host_key(&connection, &opened.host_key)?;
    authenticate(&opened.session, &connection)?;

    state
        .connection_endpoints
        .lock()
        .unwrap()
        .insert(id.clone(), opened.peer_addr);
    state
        .connection_pool
        .write()
        .unwrap()
        .insert(id.clone(), Arc::new(Mutex::new(opened.session)));
    if let Some(item) = state.connections.write().unwrap().get_mut(&id) {
        item.connected = true;
    }
    clear_monitor_cache(&state, &id);

    Ok(ConnectResult {
        connected: true,
        requires_host_key_confirmation: false,
        host_key: opened.host_key,
        generation: connection_generation(&state, &id),
    })
}

fn remove_cached_session(state: &SshState, id: &str) {
    invalidate_file_sessions(state, id);
    cancel_directory_size_tasks_for_connection(state, id);
    remove_directory_size_worker_pool(state, id);
    // 池锁必须在等待会话锁之前释放；错误路径可能持有会话锁并清理连接池。
    let session = { state.connection_pool.write().unwrap().remove(id) };
    if let Some(session) = session {
        if let Ok(session) = session.lock() {
            let _ = session.disconnect(None, "客户端关闭连接", None);
        }
    }
}

/// 关闭指定 SSH 会话及其终端、目录统计工作池。
///
/// # Arguments
///
/// * `state` - Tauri 管理的共享 SSH 状态。
/// * `id` - 要断开的连接 ID。
///
/// # Returns
///
/// 清理完成时返回 `Ok(true)`。
///
/// # Errors
///
/// 当连接配置不存在时返回错误。
#[tauri::command]
pub async fn disconnect_ssh(state: State<'_, SshState>, id: String) -> Result<bool, SshError> {
    let state = state.inner().clone();
    run_blocking_command(move || disconnect_ssh_blocking(state, id)).await
}

fn disconnect_ssh_blocking(state: SshState, id: String) -> Result<bool, SshError> {
    let operation_lock = connection_operation_lock(&state, &id);
    let _operation = operation_lock.lock().unwrap();
    let _ = connection_info(&state, &id, false)?;
    close_terminals_for_connection(&state, &id);
    remove_cached_session(&state, &id);
    remove_monitor_session(&state, &id);
    if let Some(connection) = state.connections.write().unwrap().get_mut(&id) {
        connection.connected = false;
    }
    clear_monitor_cache(&state, &id);
    Ok(true)
}

/// 发送 SSH keepalive 探测连接；发现传输层错误时同步标记断线。
///
/// # Arguments
///
/// * `state` - Tauri 管理的共享 SSH 状态。
/// * `id` - 要探测的连接 ID。
///
/// # Returns
///
/// 连接仍可用或暂时返回非阻塞重试状态时返回 `Ok(true)`。
///
/// # Errors
///
/// 当连接不存在、会话锁损坏或探测确认连接已失效时返回错误。
#[tauri::command]
pub async fn check_ssh_connection(
    state: State<'_, SshState>,
    id: String,
) -> Result<bool, SshError> {
    let state = state.inner().clone();
    run_blocking_command(move || check_ssh_connection_blocking(state, id)).await
}

fn check_ssh_connection_blocking(state: SshState, id: String) -> Result<bool, SshError> {
    // 主会话错误清理必须先于同 ID 重连完成，不能由迟到错误撤销新会话。
    let operation_lock = connection_operation_lock(&state, &id);
    let _operation = operation_lock.lock().unwrap();
    let session = session_for(&state, &id)?;
    let result = session
        .lock()
        .map_err(|_| SshError::ConnectionFailed("会话锁已损坏".to_string()))?
        .keepalive_send();

    match result {
        Ok(_) => Ok(true),
        // 非阻塞保活可能暂时返回 EAGAIN；下一次探测会重试，
        // 这并不代表 SSH 连接已经断开。
        Err(error) if matches!(error.code(), ErrorCode::Session(LIBSSH2_ERROR_EAGAIN)) => Ok(true),
        Err(error) => {
            let message = error.to_string();
            if is_connection_loss(&error) {
                mark_connection_disconnected(&state, &id, message.clone());
            }
            Err(SshError::ConnectionFailed(message))
        }
    }
}

/// 删除连接配置并释放其所有远程资源。
///
/// # Arguments
///
/// * `state` - Tauri 管理的共享 SSH 状态。
/// * `id` - 要删除的连接配置 ID。
///
/// # Returns
///
/// 找到并删除配置时返回 `Ok(true)`；配置不存在时返回 `Ok(false)`。
///
/// # Errors
///
/// 当共享连接状态锁已损坏时返回错误。
#[tauri::command]
pub async fn remove_ssh_connection(
    state: State<'_, SshState>,
    id: String,
) -> Result<bool, SshError> {
    let state = state.inner().clone();
    run_blocking_command(move || remove_ssh_connection_blocking(state, id)).await
}

fn remove_ssh_connection_blocking(state: SshState, id: String) -> Result<bool, SshError> {
    let operation_lock = connection_operation_lock(&state, &id);
    let _operation = operation_lock.lock().unwrap();
    close_terminals_for_connection(&state, &id);
    remove_cached_session(&state, &id);
    remove_monitor_session(&state, &id);
    state
        .directory_size_fast_path_support
        .lock()
        .unwrap()
        .remove(&id);
    clear_monitor_cache(&state, &id);
    Ok(state.connections.write().unwrap().remove(&id).is_some())
}

/// 已持久化的服务器身份发生变化或被删除后，撤销所有旧身份的运行态资源。
pub(crate) fn invalidate_profile_runtime(state: &SshState, id: &str) {
    let operation_lock = connection_operation_lock(state, id);
    let _operation = operation_lock.lock().unwrap();
    close_terminals_for_connection(state, id);
    remove_cached_session(state, id);
    remove_monitor_session(state, id);
    clear_monitor_cache(state, id);
}

// SFTP 没有跨服务器统一的“隐藏属性”字段，使用以点开头的名称是 Windows、macOS、Linux
// 服务器之间唯一可稳定复用的判断方式；当前目录项 . 和 .. 始终不应展示或计入统计。
fn should_skip_remote_entry(name: &str, show_hidden_files: bool) -> bool {
    name == "." || name == ".." || (!show_hidden_files && name.starts_with('.'))
}

/// 列出远程目录；隐藏文件是否返回由 `show_hidden_files` 控制。
///
/// # Arguments
///
/// * `state` - Tauri 管理的共享 SSH 状态。
/// * `id` - 已建立会话的连接 ID。
/// * `remote_path` - 要读取的远程目录路径。
/// * `show_hidden_files` - 是否包含名称以点开头的隐藏条目。
///
/// # Returns
///
/// 返回远程目录的直接子项数组，不递归统计目录大小。
///
/// # Errors
///
/// 当连接不存在、SFTP 会话不可用或远程目录读取失败时返回错误。
#[tauri::command]
pub async fn list_sftp_directory(
    state: State<'_, SshState>,
    window: WebviewWindow,
    id: String,
    remote_path: String,
    show_hidden_files: bool,
    request_id: Option<String>,
) -> Result<Vec<RemoteEntry>, SshError> {
    let request_id = request_id.unwrap_or_else(uuid_fallback);
    let cancellation = state
        .directory_requests
        .begin(window.label(), &id, &request_id)
        .map_err(SshError::ReadDirFailed)?;
    let state_handle = state.inner().clone();
    let signal = cancellation.clone();
    let result = run_blocking_command(move || {
        list_sftp_directory_blocking(state_handle, id, remote_path, show_hidden_files, signal)
    })
    .await;
    state
        .directory_requests
        .finish(window.label(), &request_id, &cancellation);
    result
}
/// 只取消调用窗口自己的目录读取，不关闭共享的浏览会话。
#[tauri::command]
pub fn cancel_sftp_directory_request(
    state: State<SshState>,
    window: WebviewWindow,
    id: String,
    request_id: String,
) -> bool {
    state
        .directory_requests
        .cancel(window.label(), &id, &request_id)
}
fn list_sftp_directory_blocking(
    state: SshState,
    id: String,
    remote_path: String,
    show_hidden_files: bool,
    cancellation: Arc<AtomicBool>,
) -> Result<Vec<RemoteEntry>, SshError> {
    // 主会话错误清理必须先于同 ID 重连完成，不能由迟到错误撤销新会话。
    let operation_lock = connection_operation_lock(&state, &id);
    let _operation = operation_lock.lock().unwrap();
    if cancellation.load(Ordering::Acquire) {
        return Err(SshError::DirectorySizeCancelled);
    }
    let sftp = sftp_for(&state, &id)?;
    let entries = bounded_remote_entries(
        &sftp,
        Path::new(&remote_path),
        &Mutex::new(ScanBudget::default()),
        || cancellation.load(Ordering::Acquire),
    )
    .map_err(|error| {
        if cancellation.load(Ordering::Acquire) {
            return SshError::DirectorySizeCancelled;
        }
        mark_ssh_error_if_connection_lost(&state, &id, &error);
        SshError::ReadDirFailed(error.to_string())
    })?;
    if cancellation.load(Ordering::Acquire) {
        return Err(SshError::DirectorySizeCancelled);
    }

    let mut files = Vec::with_capacity(entries.len());
    for (path, stat) in entries {
        let name = path
            .file_name()
            .map(|value| value.to_string_lossy().to_string())
            .unwrap_or_default();
        if should_skip_remote_entry(&name, show_hidden_files) {
            continue;
        }
        let kind = if stat.is_dir() {
            "directory"
        } else if stat.file_type() == ssh2::FileType::Symlink {
            "symlink"
        } else if stat.is_file() {
            "file"
        } else {
            "other"
        };
        files.push(RemoteEntry {
            name,
            path: path.to_string_lossy().to_string(),
            is_directory: stat.is_dir(),
            kind: kind.to_string(),
            size: stat.size.unwrap_or(0),
            modified_at: stat.mtime,
            permissions: stat.perm,
        });
    }
    Ok(files)
}

// 从共享队列领取一个子目录。工作会话只在真正有任务时占用，避免空闲会话阻塞其他扫描。
fn next_directory_size_job(
    state: &SshState,
    scan: &DirectorySizeScan,
) -> Result<Option<(DirectorySizeWorkerSlot, PathBuf, bool)>, SshError> {
    loop {
        if scan.cancellation.load(Ordering::Acquire) {
            return Err(SshError::DirectorySizeCancelled);
        }

        let mut scan_state = scan
            .state
            .lock()
            .map_err(|_| SshError::ReadDirFailed("目录大小统计状态已损坏".to_string()))?;
        if scan_state.finished {
            return Ok(None);
        }
        if scan_state.pending.is_empty() {
            if scan_state.pending_count == 0 {
                scan_state.finished = true;
                scan.wake.notify_all();
                return Ok(None);
            }
            scan_state.waiting_workers = scan_state.waiting_workers.saturating_add(1);
            let (mut scan_state, _) = scan
                .wake
                .wait_timeout(scan_state, Duration::from_millis(100))
                .map_err(|_| SshError::ReadDirFailed("目录大小统计状态已损坏".to_string()))?;
            scan_state.waiting_workers = scan_state.waiting_workers.saturating_sub(1);
            drop(scan_state);
            continue;
        }
        drop(scan_state);

        // 先获取全局并发名额，再真正取出任务；若任务已被其他工作者领取，立即归还名额。
        let worker_slot = directory_size_worker_slot(state, scan.cancellation.as_ref())?;
        let mut scan_state = scan
            .state
            .lock()
            .map_err(|_| SshError::ReadDirFailed("目录大小统计状态已损坏".to_string()))?;
        if scan_state.finished {
            drop(scan_state);
            drop(worker_slot);
            return Ok(None);
        }
        if scan.cancellation.load(Ordering::Acquire) {
            drop(scan_state);
            drop(worker_slot);
            return Err(SshError::DirectorySizeCancelled);
        }
        if let Some((directory, is_root_directory)) = scan_state.pending.pop_front() {
            return Ok(Some((worker_slot, directory, is_root_directory)));
        }
        drop(scan_state);
        drop(worker_slot);
    }
}

// 不等待地领取已就绪子目录。队列暂时为空时释放工作会话，把并发名额让给其他扫描任务。
fn take_ready_directory_size_job(
    scan: &DirectorySizeScan,
) -> Result<Option<(PathBuf, bool)>, SshError> {
    if scan.cancellation.load(Ordering::Acquire) {
        return Err(SshError::DirectorySizeCancelled);
    }
    let mut scan_state = scan
        .state
        .lock()
        .map_err(|_| SshError::ReadDirFailed("目录大小统计状态已损坏".to_string()))?;
    if scan_state.finished {
        return Ok(None);
    }
    // 已有工作者等待新目录时，当前工作者让出会话，优先唤醒等待者参与并行扫描。
    if scan_state.waiting_workers > 0 {
        return Ok(None);
    }
    Ok(scan_state.pending.pop_front())
}

fn process_directory_size_job(
    state: &SshState,
    id: &str,
    scan: &DirectorySizeScan,
    sftp: &Sftp,
    directory: PathBuf,
    is_root_directory: bool,
    show_hidden_files: bool,
) -> bool {
    if scan.cancellation.load(Ordering::Acquire) {
        scan.fail(SshError::DirectorySizeCancelled);
        return false;
    }
    let entries = bounded_remote_entries(sftp, &directory, &scan.budget, || {
        scan.cancellation.load(Ordering::Acquire)
    });
    match entries {
        Ok(entries) => {
            let mut child_directories = Vec::new();
            let mut file_size = 0_u64;
            let mut scanned_entries = 0_usize;
            for (path, stat) in entries {
                if scan.cancellation.load(Ordering::Acquire) {
                    scan.fail(SshError::DirectorySizeCancelled);
                    return false;
                }
                let name = path
                    .file_name()
                    .map(|value| value.to_string_lossy().to_string())
                    .unwrap_or_default();
                if should_skip_remote_entry(&name, show_hidden_files) {
                    continue;
                }
                scanned_entries = scanned_entries.saturating_add(1);

                // 目录项元数据可能来自符号链接的目标，显式排除链接后再决定是否递归。
                if stat.file_type() != ssh2::FileType::Symlink && stat.is_dir() {
                    child_directories.push(path);
                } else {
                    // 普通文件和符号链接只计入自身返回的大小，不主动跟随链接。
                    file_size = file_size.saturating_add(stat.size.unwrap_or(0));
                }
            }
            scan.complete_directory(child_directories, file_size, scanned_entries, 0);
            true
        }
        Err(error) => {
            if scan.cancellation.load(Ordering::Acquire) {
                scan.fail(SshError::DirectorySizeCancelled);
                return false;
            }
            mark_ssh_error_if_connection_lost(state, id, &error);
            if is_root_directory || !is_recoverable_directory_size_error(&error) {
                scan.fail(SshError::ReadDirFailed(format!(
                    "读取远程文件夹“{}”失败: {error}",
                    directory.display()
                )));
                return false;
            }
            // 子目录权限不足或被其他客户端删除时，保留已统计部分并标记为不完整。
            scan.complete_directory(Vec::new(), 0, 0, 1);
            true
        }
    }
}

// 每个工作者独占一个 SFTP 会话处理一小批子目录，减少建会话开销并保留动态调度能力。
fn directory_size_worker_loop(
    state: SshState,
    id: String,
    pool: Arc<Mutex<DirectorySizeWorkerPool>>,
    scan: Arc<DirectorySizeScan>,
    show_hidden_files: bool,
) {
    loop {
        let (worker_slot, directory, is_root_directory) =
            match next_directory_size_job(&state, &scan) {
                Ok(Some(job)) => job,
                Ok(None) => return,
                Err(error) => {
                    scan.fail(error);
                    return;
                }
            };

        let directory_size_session =
            match directory_size_sftp_for(&state, &id, &pool, scan.cancellation.as_ref()) {
                Ok(session) => session,
                Err(error) => {
                    scan.fail(error);
                    return;
                }
            };

        let mut job = Some((directory, is_root_directory));
        let mut processed_count = 0_usize;
        while let Some((directory, is_root_directory)) = job.take() {
            if !process_directory_size_job(
                &state,
                &id,
                &scan,
                &directory_size_session.sftp,
                directory,
                is_root_directory,
                show_hidden_files,
            ) {
                return;
            }
            processed_count = processed_count.saturating_add(1);

            // 根目录完成或尚有空闲并发名额时优先让出会话，让等待工作者尽快接手子目录。
            // 四个名额均已在工作时才保留小批量处理，减少反复创建 SFTP 子会话的开销。
            let has_idle_capacity = state.active_directory_size_workers.load(Ordering::Acquire)
                < MAX_CONCURRENT_DIRECTORY_SIZE_WORKERS;
            if is_root_directory
                || has_idle_capacity
                || processed_count >= DIRECTORY_SIZE_WORKER_BATCH_SIZE
            {
                break;
            }
            job = match take_ready_directory_size_job(&scan) {
                Ok(next_job) => next_job,
                Err(error) => {
                    scan.fail(error);
                    return;
                }
            };
        }
        drop(directory_size_session);
        drop(worker_slot);
    }
}

/// 递归统计远程目录大小。子目录通过共享队列动态分发给空闲工作会话。
fn calculate_sftp_directory_size(
    context: DirectorySizeCalculationContext,
) -> Result<RemoteDirectorySize, SshError> {
    let DirectorySizeCalculationContext {
        state,
        id,
        connection,
        remote_path,
        cancellation,
        wake,
        pool,
        show_hidden_files,
    } = context;
    if cancellation.load(Ordering::Acquire) {
        return Err(SshError::DirectorySizeCancelled);
    }

    // 标准 du 无法表达“跳过所有以点开头的后代项目”，因此仅在显示全部内容时使用。
    if show_hidden_files {
        if let Some(result) =
            try_remote_directory_size(&state, &connection, &remote_path, cancellation.as_ref())?
        {
            return Ok(result);
        }
    }

    let scan = Arc::new(DirectorySizeScan::new(&remote_path, cancellation, wake));
    let mut workers = Vec::with_capacity(MAX_CONCURRENT_DIRECTORY_SIZE_WORKERS);
    for _ in 0..MAX_CONCURRENT_DIRECTORY_SIZE_WORKERS {
        let state_for_worker = state.clone();
        let id_for_worker = id.clone();
        let pool_for_worker = Arc::clone(&pool);
        let scan_for_worker = Arc::clone(&scan);
        let scan_for_failure = Arc::clone(&scan);
        workers.push(thread::spawn(move || {
            if std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
                directory_size_worker_loop(
                    state_for_worker,
                    id_for_worker,
                    pool_for_worker,
                    scan_for_worker,
                    show_hidden_files,
                )
            }))
            .is_err()
            {
                scan_for_failure.fail(SshError::ReadDirFailed(
                    "目录大小统计工作线程异常退出".to_string(),
                ));
            }
        }));
    }
    for worker in workers {
        if worker.join().is_err() {
            scan.fail(SshError::ReadDirFailed(
                "目录大小统计工作线程异常退出".to_string(),
            ));
        }
    }
    scan.result()
}

/// 异步统计远程目录大小，支持隐藏文件筛选和按操作 ID 取消。
///
/// # Arguments
///
/// * `state` - Tauri 管理的共享 SSH 状态。
/// * `id` - 已建立会话的连接 ID。
/// * `remote_path` - 要统计的远程目录路径。
/// * `show_hidden_files` - 是否将名称以点开头的文件和目录计入统计。
/// * `operation_id` - 本次统计任务的唯一标识，供取消命令关联。
///
/// # Returns
///
/// 返回目录总字节数、完整性和扫描条目统计信息。
///
/// # Errors
///
/// 当操作 ID 为空、连接不可用、目录读取失败、达到并发限制或任务被取消时返回错误。
#[tauri::command]
pub async fn get_sftp_directory_size(
    state: State<'_, SshState>,
    id: String,
    remote_path: String,
    show_hidden_files: bool,
    operation_id: String,
) -> Result<RemoteDirectorySize, SshError> {
    if operation_id.trim().is_empty() {
        return Err(SshError::FileOperationFailed(
            "目录大小统计标识不能为空".to_string(),
        ));
    }

    let mut state = state.inner().clone();
    state.isolated_transport = true;
    let connection = connection_info(&state, &id, true)?;
    let cancellation = Arc::new(AtomicBool::new(false));
    let wake = Arc::new(Condvar::new());
    state.directory_size_cancellations.lock().unwrap().insert(
        operation_id.clone(),
        DirectorySizeCancellation {
            connection_id: id.clone(),
            signal: cancellation.clone(),
            wake: Arc::clone(&wake),
        },
    );
    let worker_pool = match begin_directory_size_task(&state, &id) {
        Ok(pool) => pool,
        Err(error) => {
            state
                .directory_size_cancellations
                .lock()
                .unwrap()
                .remove(&operation_id);
            return Err(error);
        }
    };
    let state_for_task = state.clone();
    let id_for_task = id.clone();
    let remote_path_for_task = remote_path.clone();
    let cancellation_for_task = Arc::clone(&cancellation);
    let wake_for_task = Arc::clone(&wake);
    let worker_pool_for_task = Arc::clone(&worker_pool);
    let result = tauri::async_runtime::spawn_blocking(move || {
        calculate_sftp_directory_size(DirectorySizeCalculationContext {
            state: state_for_task,
            id: id_for_task,
            connection,
            remote_path: remote_path_for_task,
            cancellation: cancellation_for_task,
            wake: wake_for_task,
            pool: worker_pool_for_task,
            show_hidden_files,
        })
    })
    .await
    .map_err(|error| SshError::ReadDirFailed(format!("目录大小统计任务失败: {error}")))
    .and_then(|result| result);

    end_directory_size_task(&state, &id, &worker_pool);
    state
        .directory_size_cancellations
        .lock()
        .unwrap()
        .remove(&operation_id);
    result
}

/// 取消指定的远程目录大小统计；任务已完成时保持幂等成功。
///
/// # Arguments
///
/// * `state` - Tauri 管理的共享 SSH 状态。
/// * `operation_id` - 要取消的目录统计任务 ID。
///
/// # Returns
///
/// 无论任务是否已经结束，都返回 `Ok(true)`，保证取消操作幂等。
///
/// # Errors
///
/// 当取消状态锁不可用时返回错误。
#[tauri::command]
pub fn cancel_sftp_directory_size(
    state: State<SshState>,
    operation_id: String,
) -> Result<bool, SshError> {
    // 取消请求允许晚于任务结束到达，找不到任务时保持幂等成功。
    if let Some(cancellation) = state
        .directory_size_cancellations
        .lock()
        .unwrap()
        .get(&operation_id)
    {
        cancellation.signal.store(true, Ordering::Release);
        cancellation.wake.notify_all();
    }
    state.directory_size_worker_wait.wake.notify_all();
    Ok(true)
}

struct PreviewEntry {
    connection_id: String,
    generation: u64,
    cancellation: Arc<AtomicBool>,
    socket: Option<TcpStream>,
    running: bool,
}

/// 活动预览有界排队；登记与 socket 归属始终绑定窗口和请求 ID。
#[derive(Default)]
struct PreviewRegistry {
    requests: crate::directory_requests::DirectoryRequests,
    entries: Mutex<HashMap<(String, String), PreviewEntry>>,
    wake: Condvar,
}

struct PreviewLease {
    registry: Arc<PreviewRegistry>,
    owner: String,
    id: String,
    connection_id: String,
    generation: u64,
    cancellation: Arc<AtomicBool>,
}

impl PreviewLease {
    fn cancelled(&self) -> bool {
        self.cancellation.load(Ordering::Acquire)
    }
}

impl Drop for PreviewLease {
    fn drop(&mut self) {
        let mut entries = self.registry.entries.lock().unwrap();
        let key = (self.owner.clone(), self.id.clone());
        if entries
            .get(&key)
            .is_some_and(|entry| Arc::ptr_eq(&entry.cancellation, &self.cancellation))
        {
            if let Some(entry) = entries.remove(&key) {
                if let Some(socket) = entry.socket {
                    let _ = socket.shutdown(std::net::Shutdown::Both);
                }
            }
        }
        drop(entries);
        self.registry
            .requests
            .finish(&self.owner, &self.id, &self.cancellation);
        self.registry.wake.notify_all();
    }
}

impl PreviewRegistry {
    fn begin(
        self: &Arc<Self>,
        owner: &str,
        connection_id: &str,
        id: &str,
        generation: u64,
    ) -> Result<PreviewLease, SshError> {
        // 取消命令只带 preview_id，故在独立登记表中使用固定连接键保存提前取消墓碑。
        let cancellation = self
            .requests
            .begin(owner, "preview", id)
            .map_err(SshError::FileOperationFailed)?;
        if cancellation.load(Ordering::Acquire) {
            self.requests.finish(owner, id, &cancellation);
            return Err(SshError::PreviewCancelled);
        }
        self.entries.lock().unwrap().insert(
            (owner.to_owned(), id.to_owned()),
            PreviewEntry {
                connection_id: connection_id.to_owned(),
                generation,
                cancellation: Arc::clone(&cancellation),
                socket: None,
                running: false,
            },
        );
        Ok(PreviewLease {
            registry: Arc::clone(self),
            owner: owner.to_owned(),
            id: id.to_owned(),
            connection_id: connection_id.to_owned(),
            generation,
            cancellation,
        })
    }

    fn try_acquire(&self, lease: &PreviewLease) -> bool {
        let mut entries = self.entries.lock().unwrap();
        let key = (lease.owner.clone(), lease.id.clone());
        let Some(current) = entries.get(&key) else {
            return false;
        };
        if !Arc::ptr_eq(&current.cancellation, &lease.cancellation)
            || current.generation != lease.generation
            || lease.cancelled()
        {
            return false;
        }
        if current.running {
            return true;
        }
        if entries.values().filter(|entry| entry.running).count() >= MAX_CONCURRENT_PREVIEWS
            || entries
                .values()
                .any(|entry| entry.running && entry.connection_id == lease.connection_id)
        {
            return false;
        }
        entries.get_mut(&key).unwrap().running = true;
        true
    }

    fn attach_socket(&self, lease: &PreviewLease, socket: TcpStream) -> Result<(), SshError> {
        let mut entries = self.entries.lock().unwrap();
        let key = (lease.owner.clone(), lease.id.clone());
        if lease.cancelled() {
            let _ = socket.shutdown(std::net::Shutdown::Both);
            return Err(SshError::PreviewCancelled);
        }
        match entries.get_mut(&key) {
            Some(entry)
                if Arc::ptr_eq(&entry.cancellation, &lease.cancellation)
                    && entry.generation == lease.generation
                    && entry.running =>
            {
                entry.socket = Some(socket);
                Ok(())
            }
            _ => {
                let _ = socket.shutdown(std::net::Shutdown::Both);
                Err(SshError::PreviewCancelled)
            }
        }
    }

    fn cancel(&self, owner: &str, id: &str) -> bool {
        let accepted = self.requests.cancel(owner, "preview", id);
        if accepted {
            let entries = self.entries.lock().unwrap();
            if let Some(entry) = entries.get(&(owner.to_owned(), id.to_owned())) {
                if let Some(socket) = &entry.socket {
                    let _ = socket.shutdown(std::net::Shutdown::Both);
                }
            }
            self.wake.notify_all();
        }
        accepted
    }

    fn cancel_matching(&self, owner: Option<&str>, connection_id: Option<&str>) {
        let entries = self.entries.lock().unwrap();
        for ((entry_owner, _), entry) in entries.iter() {
            if owner.is_none_or(|owner| owner == entry_owner)
                && connection_id.is_none_or(|id| id == entry.connection_id)
            {
                entry.cancellation.store(true, Ordering::Release);
                if let Some(socket) = &entry.socket {
                    let _ = socket.shutdown(std::net::Shutdown::Both);
                }
            }
        }
        self.wake.notify_all();
    }
}

/// 连接失效时撤销该连接的活动和排队预览。
pub(crate) fn cancel_sftp_previews_for_connection(state: &SshState, id: &str) {
    state.preview_registry.cancel_matching(None, Some(id));
}

/// 窗口关闭时撤销该窗口的活动和排队预览。
pub(crate) fn cancel_sftp_previews_for_window(state: &SshState, owner: &str) {
    state.preview_registry.cancel_matching(Some(owner), None);
}

/// 应用退出时撤销全部活动和排队预览。
pub(crate) fn cancel_all_sftp_previews(state: &SshState) {
    state.preview_registry.cancel_matching(None, None);
}

/// 在文件预览读取过程中向前端发送进度事件。
fn preview_progress(
    state: &SshState,
    connection_id: &str,
    lease: &PreviewLease,
    window_generation: u64,
    current: u64,
    total: u64,
) {
    if lease.cancelled()
        || state
            .window_generations
            .lock()
            .unwrap()
            .get(&lease.owner)
            .copied()
            .unwrap_or(0)
            != window_generation
    {
        return;
    }
    let progress = percentage(current, total);
    if let Some(handle) = state.app_handle.lock().unwrap().clone() {
        let _ = handle.emit_to(
            tauri::EventTarget::WebviewWindow {
                label: lease.owner.clone(),
            },
            "preview-progress",
            json!({
                "id": connection_id,
                "previewId": lease.id,
                "progress": progress,
                "current": current,
                "total": total
            }),
        );
    }
}

fn check_preview_active(
    state: &SshState,
    lease: &PreviewLease,
    window_generation: u64,
) -> Result<(), SshError> {
    if lease.cancelled()
        || state.runtime_stop.load(Ordering::Acquire)
        || state
            .window_generations
            .lock()
            .unwrap()
            .get(&lease.owner)
            .copied()
            .unwrap_or(0)
            != window_generation
    {
        return Err(SshError::PreviewCancelled);
    }
    let generations = state.connection_generations.lock().unwrap();
    if generations.get(&lease.connection_id).copied().unwrap_or(0) != lease.generation
        || connection_info(state, &lease.connection_id, true).is_err()
    {
        return Err(SshError::ConnectionGenerationChanged);
    }
    Ok(())
}

/// 在排队和 TCP 建连期间持续检查取消，不占用浏览连接。
async fn wait_for_preview_slot(
    state: &SshState,
    lease: &PreviewLease,
    window_generation: u64,
) -> Result<(), SshError> {
    loop {
        check_preview_active(state, lease, window_generation)?;
        if lease.registry.try_acquire(lease) {
            return check_preview_active(state, lease, window_generation);
        }
        tokio::time::sleep(Duration::from_millis(50)).await;
    }
}

/// 在 libssh2 析构前关闭独占 socket，避免协议清理继续阻塞。
struct PreviewTransport {
    session: Session,
    socket: TcpStream,
}

impl Drop for PreviewTransport {
    fn drop(&mut self) {
        let _ = self.socket.shutdown(std::net::Shutdown::Both);
    }
}

fn open_preview_transport(
    state: &SshState,
    lease: &PreviewLease,
    connection: &SshConnection,
    endpoint: SocketAddr,
    window_generation: u64,
) -> Result<PreviewTransport, SshError> {
    check_preview_active(state, lease, window_generation)?;
    let timeout = Duration::from_millis(DEFAULT_TIMEOUT_MS);
    let tcp = crate::transfer_connect::connect(endpoint, timeout, || {
        check_preview_active(state, lease, window_generation).is_err()
    })
    .map_err(|error| {
        check_preview_active(state, lease, window_generation)
            .err()
            .unwrap_or_else(|| SshError::ConnectionFailed(error.to_string()))
    })?;
    let socket = tcp.try_clone()?;
    lease.registry.attach_socket(lease, socket.try_clone()?)?;
    check_preview_active(state, lease, window_generation)?;
    tcp.set_nonblocking(true)?;
    let mut session =
        Session::new().map_err(|error| SshError::ConnectionFailed(error.to_string()))?;
    session.set_tcp_stream(tcp);
    session.set_timeout(DEFAULT_TIMEOUT_MS as u32);
    let mut transport = PreviewTransport { session, socket };
    let result = (|| {
        transport
            .session
            .handshake()
            .map_err(|error| SshError::HandshakeFailed(error.to_string()))?;
        check_preview_active(state, lease, window_generation)?;
        verify_host_key(connection, &host_key_info(&transport.session)?)?;
        authenticate(&transport.session, connection)?;
        check_preview_active(state, lease, window_generation)?;
        Ok(())
    })();
    if let Err(error) = result {
        return Err(check_preview_active(state, lease, window_generation)
            .err()
            .unwrap_or(error));
    }
    Ok(transport)
}

/// 同步分块读取远程预览文件，并限制最大内容大小。
fn read_sftp_file_content(
    state: &SshState,
    connection: SshConnection,
    endpoint: SocketAddr,
    remote_path: String,
    lease: &PreviewLease,
    window_generation: u64,
) -> Result<Vec<u8>, SshError> {
    let transport = open_preview_transport(state, lease, &connection, endpoint, window_generation)?;
    let sftp = transport.session.sftp().map_err(|error| {
        check_preview_active(state, lease, window_generation)
            .err()
            .unwrap_or_else(|| SshError::SftpFailed(error.to_string()))
    })?;
    check_preview_active(state, lease, window_generation)?;
    let mut file = sftp.open(Path::new(&remote_path)).map_err(|error| {
        check_preview_active(state, lease, window_generation)
            .err()
            .unwrap_or_else(|| SshError::FileOperationFailed(error.to_string()))
    })?;
    let size = file
        .stat()
        .map_err(|error| {
            check_preview_active(state, lease, window_generation)
                .err()
                .unwrap_or_else(|| SshError::FileOperationFailed(error.to_string()))
        })?
        .size
        .unwrap_or(0);
    check_preview_active(state, lease, window_generation)?;
    if size > MAX_PREVIEW_BYTES {
        return Err(SshError::PreviewTooLarge);
    }
    let mut content = Vec::with_capacity(size.min(MAX_PREVIEW_BYTES) as usize);
    let mut reader = file.take(MAX_PREVIEW_BYTES.saturating_add(1));
    let mut buffer = vec![0_u8; TRANSFER_BUFFER_SIZE];
    let mut current = 0_u64;
    preview_progress(
        state,
        &connection.id,
        lease,
        window_generation,
        current,
        size,
    );
    // 分块读取，让界面在 SFTP 读取较慢时仍能持续接收进度事件。
    loop {
        check_preview_active(state, lease, window_generation)?;
        let read = reader.read(&mut buffer).map_err(|error| {
            check_preview_active(state, lease, window_generation)
                .err()
                .unwrap_or_else(|| SshError::ReadFailed(error.to_string()))
        })?;
        check_preview_active(state, lease, window_generation)?;
        if read == 0 {
            break;
        }
        content.extend_from_slice(&buffer[..read]);
        current = current.saturating_add(read as u64);
        if current > MAX_PREVIEW_BYTES {
            return Err(SshError::PreviewTooLarge);
        }
        preview_progress(
            state,
            &connection.id,
            lease,
            window_generation,
            current,
            size,
        );
    }
    check_preview_active(state, lease, window_generation)?;
    preview_progress(
        state,
        &connection.id,
        lease,
        window_generation,
        current,
        size,
    );
    Ok(content)
}

async fn run_sftp_preview(
    state: SshState,
    connection: SshConnection,
    endpoint: SocketAddr,
    remote_path: String,
    lease: PreviewLease,
    window_generation: u64,
) -> Result<Vec<u8>, SshError> {
    wait_for_preview_slot(&state, &lease, window_generation).await?;
    run_blocking_command(move || {
        read_sftp_file_content(
            &state,
            connection,
            endpoint,
            remote_path,
            &lease,
            window_generation,
        )
    })
    .await
}

/// 分块读取远程文件内容，供前端预览并发送读取进度事件。
///
/// # Arguments
///
/// * `state` - Tauri 管理的共享 SSH 状态。
/// * `window` - 预览所属窗口，取消和进度事件均按窗口隔离。
/// * `id` - 已建立会话的连接 ID。
/// * `remote_path` - 要读取的远程文件路径。
/// * `preview_id` - 可选的前端预览任务 ID；省略时自动生成。
/// * `expected_generation` - 可选的预期连接代次，用于拒绝迟到请求。
///
/// # Returns
///
/// 返回远程文件的 UTF-8 原始字节；内容大小受预览上限限制。
///
/// # Errors
///
/// 当连接不可用、文件读取失败、文件超过预览大小限制或后台任务失败时返回错误。
#[tauri::command]
pub async fn get_sftp_file_content(
    state: State<'_, SshState>,
    window: WebviewWindow,
    id: String,
    remote_path: String,
    preview_id: Option<String>,
    expected_generation: Option<u64>,
) -> Result<Vec<u8>, SshError> {
    let state = state.inner().clone();
    let owner = window.label().to_string();
    let window_generation = state
        .window_generations
        .lock()
        .unwrap()
        .get(&owner)
        .copied()
        .unwrap_or(0);
    let preview_id = preview_id.unwrap_or_else(|| {
        format!(
            "preview-{}-{}",
            uuid_fallback(),
            NEXT_PREVIEW_ID.fetch_add(1, Ordering::Relaxed)
        )
    });
    let (connection, endpoint, lease) = {
        let generations = state.connection_generations.lock().unwrap();
        let connection = connection_info(&state, &id, true)?;
        let generation = generations.get(&id).copied().unwrap_or(0);
        if expected_generation.is_some_and(|expected| expected != generation) {
            return Err(SshError::ConnectionGenerationChanged);
        }
        let endpoint = state
            .connection_endpoints
            .lock()
            .unwrap()
            .get(&id)
            .copied()
            .ok_or(SshError::ConnectionNotFound)?;
        let windows = state.window_generations.lock().unwrap();
        if state.runtime_stop.load(Ordering::Acquire)
            || windows.get(&owner).copied().unwrap_or(0) != window_generation
        {
            return Err(SshError::PreviewCancelled);
        }
        let lease = state
            .preview_registry
            .begin(&owner, &id, &preview_id, generation)?;
        (connection, endpoint, lease)
    };
    run_sftp_preview(
        state,
        connection,
        endpoint,
        remote_path,
        lease,
        window_generation,
    )
    .await
}

/// 幂等取消所属窗口的预览；提前到达的取消会保留有界、短期的墓碑。
#[tauri::command]
pub fn cancel_sftp_preview(
    state: State<'_, SshState>,
    window: WebviewWindow,
    preview_id: String,
) -> Result<bool, SshError> {
    Ok(state.preview_registry.cancel(window.label(), &preview_id))
}

/// 在远程创建一个目录。
///
/// # Arguments
///
/// * `state` - Tauri 管理的共享 SSH 状态。
/// * `id` - 已建立会话的连接 ID。
/// * `remote_path` - 要创建的远程目录路径。
///
/// # Returns
///
/// 创建成功时返回 `Ok(true)`。
///
/// # Errors
///
/// 当连接不可用、路径无效或远程目录创建失败时返回错误。
#[tauri::command]
pub async fn sftp_mkdir(
    state: State<'_, SshState>,
    id: String,
    remote_path: String,
    expected_generation: u64,
) -> Result<bool, SshError> {
    let state = state.inner().clone();
    run_blocking_command(move || sftp_mkdir_blocking(state, id, remote_path, expected_generation))
        .await
}

fn sftp_mkdir_blocking(
    state: SshState,
    id: String,
    remote_path: String,
    expected_generation: u64,
) -> Result<bool, SshError> {
    // 主会话错误清理必须先于同 ID 重连完成，不能由迟到错误撤销新会话。
    let operation_lock = connection_operation_lock(&state, &id);
    let _operation = operation_lock.lock().unwrap();
    if connection_generation(&state, &id) != expected_generation {
        return Err(SshError::ConnectionGenerationChanged);
    }
    let policy = remote_mutation_policy(&state, &id, &session_for(&state, &id)?)?;
    let sftp = sftp_for(&state, &id)?;
    ensure_remote_directory(&state, &id, &sftp, &policy, &remote_path, false)?;
    Ok(true)
}

/// 异步删除远程文件或目录，并通过事件报告递归删除结果。
///
/// # Arguments
///
/// * `state` - Tauri 管理的共享 SSH 状态。
/// * `id` - 已建立会话的连接 ID。
/// * `remote_path` - 要删除的远程文件或目录路径。
/// * `is_directory` - 调用方提供的条目类型提示；实际删除流程仍会校验远端类型。
/// * `operation_id` - 可选的删除任务 ID；省略时由后端生成。
///
/// # Returns
///
/// 返回已登记的任务快照；最终结果可通过事件通知或任务状态查询取得。
///
/// # Errors
///
/// 当连接不存在、会话不可用或后台删除任务无法启动时返回错误。
#[tauri::command]
#[allow(clippy::too_many_arguments)] // Tauri IPC 保留显式命名参数。
pub fn sftp_delete(
    state: State<SshState>,
    window: WebviewWindow,
    id: String,
    expected_generation: u64,
    expires_at: u64,
    remote_path: String,
    is_directory: bool,
    operation_id: Option<String>,
) -> Result<TaskSnapshot, SshError> {
    let _ = is_directory;
    launch_file_task(
        state.inner(),
        window.label(),
        id,
        operation_id,
        "delete",
        expected_generation,
        expires_at,
        FileTaskOperation::Delete(remote_path),
    )
}

/// 重命名远程文件或目录，可选择覆盖已有目标。
///
/// # Arguments
///
/// * `state` - Tauri 管理的共享 SSH 状态。
/// * `id` - 已建立会话的连接 ID。
/// * `source_path` - 原远程文件或目录路径。
/// * `target_path` - 新远程文件或目录路径。
/// * `overwrite` - 是否允许覆盖已存在的目标；省略时为 `false`。
///
/// # Returns
///
/// 重命名成功时返回 `Ok(true)`。
///
/// # Errors
///
/// 当连接不可用、路径无效或远程重命名失败时返回错误。
#[tauri::command]
pub async fn sftp_rename(
    state: State<'_, SshState>,
    id: String,
    source_path: String,
    target_path: String,
    overwrite: Option<bool>,
    expected_generation: u64,
) -> Result<bool, SshError> {
    let state = state.inner().clone();
    run_blocking_command(move || {
        sftp_rename_blocking(
            state,
            id,
            source_path,
            target_path,
            overwrite,
            expected_generation,
        )
    })
    .await
}

fn sftp_rename_blocking(
    state: SshState,
    id: String,
    source_path: String,
    target_path: String,
    overwrite: Option<bool>,
    expected_generation: u64,
) -> Result<bool, SshError> {
    // 主会话错误清理必须先于同 ID 重连完成，不能由迟到错误撤销新会话。
    let operation_lock = connection_operation_lock(&state, &id);
    let _operation = operation_lock.lock().unwrap();
    if connection_generation(&state, &id) != expected_generation {
        return Err(SshError::ConnectionGenerationChanged);
    }
    let policy = remote_mutation_policy(&state, &id, &session_for(&state, &id)?)?;
    let sftp = sftp_for(&state, &id)?;
    policy
        .validate_parent(&sftp, Path::new(&source_path))
        .map_err(SshError::FileOperationFailed)?;
    policy
        .validate_parent(&sftp, Path::new(&target_path))
        .map_err(SshError::FileOperationFailed)?;
    let session = session_for(&state, &id)?;
    let session = session
        .lock()
        .map_err(|_| SshError::SftpFailed("会话锁已损坏".into()))?;
    rename_remote_file(
        &sftp,
        &session,
        Path::new(&source_path),
        Path::new(&target_path),
        overwrite.unwrap_or(false),
        || false,
        || Ok(()),
    )?;
    Ok(true)
}

/// 获取远程账户的规范化主目录路径。
///
/// # Arguments
///
/// * `state` - Tauri 管理的共享 SSH 状态。
/// * `id` - 已建立会话的连接 ID。
///
/// # Returns
///
/// 返回远程账户的规范化绝对主目录路径。
///
/// # Errors
///
/// 当连接不可用或远程路径解析失败时返回错误。
#[tauri::command]
pub async fn get_sftp_user_home(
    state: State<'_, SshState>,
    id: String,
) -> Result<String, SshError> {
    let state = state.inner().clone();
    run_blocking_command(move || get_sftp_user_home_blocking(state, id)).await
}

fn get_sftp_user_home_blocking(state: SshState, id: String) -> Result<String, SshError> {
    // 主会话错误清理必须先于同 ID 重连完成，不能由迟到错误撤销新会话。
    let operation_lock = connection_operation_lock(&state, &id);
    let _operation = operation_lock.lock().unwrap();
    let sftp = sftp_for(&state, &id)?;
    Ok(sftp
        .realpath(Path::new("."))
        .map_err(|error| {
            mark_ssh_error_if_connection_lost(&state, &id, &error);
            SshError::FileOperationFailed(error.to_string())
        })?
        .to_string_lossy()
        .to_string())
}

/// 打开一个远程 PTY Shell，并开始后台读取终端输出。
///
/// # Arguments
///
/// * `state` - Tauri 管理的共享 SSH 状态。
/// * `id` - 已建立会话的连接 ID。
/// * `terminal_id` - 前端生成的终端会话 ID。
/// * `columns` - 请求的终端列数。
/// * `rows` - 请求的终端行数。
///
/// # Returns
///
/// PTY 创建并开始读取时返回实际使用的行列数。
///
/// # Errors
///
/// 当终端 ID 为空、连接不可用、PTY 创建失败或后台启动任务失败时返回错误。
#[tauri::command]
#[allow(clippy::too_many_arguments)] // Tauri Channel 和窗口句柄是独立注入参数。
pub async fn open_ssh_terminal(
    state: State<'_, SshState>,
    window: WebviewWindow,
    id: String,
    terminal_id: String,
    columns: u32,
    rows: u32,
    generation: String,
    on_output: tauri::ipc::Channel<serde_json::Value>,
) -> Result<serde_json::Value, SshError> {
    if terminal_id.is_empty()
        || terminal_id.len() > 256
        || generation.is_empty()
        || generation.len() > 128
    {
        return Err(SshError::TerminalFailed("终端标识无效".into()));
    }
    let owner = window.label().to_string();
    let window_generation = state
        .window_generations
        .lock()
        .unwrap()
        .get(&owner)
        .copied()
        .unwrap_or(0);
    let (connection, connection_generation) = {
        let generations = state.connection_generations.lock().unwrap();
        (
            connection_info(state.inner(), &id, true)?,
            generations.get(&id).copied().unwrap_or(0),
        )
    };
    {
        let mut openings = state.terminal_openings.lock().unwrap();
        if state
            .window_generations
            .lock()
            .unwrap()
            .get(&owner)
            .copied()
            .unwrap_or(0)
            != window_generation
        {
            return Err(SshError::TerminalNotFound);
        }
        if openings
            .get(&terminal_id)
            .is_some_and(|entry| entry.0 != owner)
            || state
                .terminal_sessions
                .read()
                .unwrap()
                .get(&terminal_id)
                .is_some_and(|entry| entry.owner != owner)
        {
            return Err(SshError::TerminalNotFound);
        }
        openings.insert(
            terminal_id.clone(),
            (owner.clone(), generation.clone(), id.clone()),
        );
    }
    close_terminal_session(&state.terminal_sessions, &terminal_id);
    let (columns, rows) = normalize_terminal_dimensions(columns, rows);
    let cancellation = match state
        .terminal_requests
        .begin(&owner, &terminal_id, &generation)
    {
        Ok(cancellation) => cancellation,
        Err(error) => {
            let mut openings = state.terminal_openings.lock().unwrap();
            if openings
                .get(&terminal_id)
                .is_some_and(|entry| entry.0 == owner && entry.1 == generation)
            {
                openings.remove(&terminal_id);
            }
            return Err(SshError::TerminalFailed(error));
        }
    };
    let result = if cancellation.load(Ordering::Acquire) {
        Err(SshError::TerminalNotFound)
    } else {
        run_blocking_command(move || open_terminal_channel(&connection, columns, rows)).await
    };
    state
        .terminal_requests
        .finish(&owner, &generation, &cancellation);
    let mut openings = state.terminal_openings.lock().unwrap();
    let current = openings
        .get(&terminal_id)
        .is_some_and(|entry| entry.0 == owner && entry.1 == generation);
    if current {
        openings.remove(&terminal_id);
    }
    let current_window_generation = state
        .window_generations
        .lock()
        .unwrap()
        .get(&owner)
        .copied()
        .unwrap_or(0);
    let current_connection_generation = state
        .connection_generations
        .lock()
        .unwrap()
        .get(&id)
        .copied()
        .unwrap_or(0);
    if !current
        || cancellation.load(Ordering::Acquire)
        || state.runtime_stop.load(Ordering::Acquire)
        || current_window_generation != window_generation
        || current_connection_generation != connection_generation
    {
        return Err(SshError::TerminalNotFound);
    }
    let channel = result?;
    let terminal = Arc::new(TerminalSession {
        connection_id: id,
        owner,
        generation,
        channel: Arc::new(Mutex::new(channel)),
        stop: Arc::new(AtomicBool::new(false)),
        write_lock: Mutex::new(InputSequence::default()),
        resize_request: Mutex::new(PendingResize::default()),
        output: on_output,
        output_flow: Mutex::new(OutputFlow::default()),
        output_wake: Condvar::new(),
    });
    state
        .terminal_sessions
        .write()
        .unwrap()
        .insert(terminal_id.clone(), terminal.clone());
    drop(openings);
    if let Err(error) = spawn_terminal_reader(state.inner().clone(), terminal_id.clone(), terminal)
    {
        close_terminal_session(&state.terminal_sessions, &terminal_id);
        return Err(error);
    }
    Ok(json!({"columns":columns,"rows":rows}))
}
fn owned_terminal(
    state: &SshState,
    owner: &str,
    terminal_id: &str,
    generation: &str,
) -> Result<Arc<TerminalSession>, SshError> {
    let terminal = terminal_session_for(state, terminal_id)?;
    if terminal.owner != owner || terminal.generation != generation {
        return Err(SshError::TerminalNotFound);
    }
    Ok(terminal)
}
/// 输入序号在写锁内校验，前端顺序队列仍是正常输入的唯一生产者。
#[tauri::command]
pub async fn write_ssh_terminal(
    state: State<'_, SshState>,
    window: WebviewWindow,
    terminal_id: String,
    data: String,
    generation: String,
    sequence: u64,
) -> Result<bool, SshError> {
    if data.len() > MAX_TERMINAL_INPUT_BYTES {
        return Err(SshError::TerminalInputTooLong);
    }
    let terminal = owned_terminal(&state, window.label(), &terminal_id, &generation)?;
    let writing_terminal = terminal.clone();
    let result = run_blocking_command(move || {
        write_terminal_input(&writing_terminal, data.as_bytes(), sequence)
    })
    .await;
    if result
        .as_ref()
        .is_err_and(|error| !matches!(error, SshError::BackgroundBusy | SshError::TerminalNotFound))
    {
        let _openings = state.terminal_openings.lock().unwrap();
        if state
            .terminal_sessions
            .read()
            .unwrap()
            .get(&terminal_id)
            .is_some_and(|entry| Arc::ptr_eq(entry, &terminal))
        {
            close_terminal_session(&state.terminal_sessions, &terminal_id);
        }
    }
    result?;
    Ok(true)
}
/// ACK 为累计确认，非法的超前序号不会释放背压预算。
#[tauri::command]
pub fn ack_ssh_terminal_output(
    state: State<SshState>,
    window: WebviewWindow,
    terminal_id: String,
    generation: String,
    sequence: u64,
) -> Result<bool, SshError> {
    let terminal = owned_terminal(&state, window.label(), &terminal_id, &generation)?;
    let accepted = terminal.output_flow.lock().unwrap().acknowledge(sequence);
    terminal.output_wake.notify_all();
    Ok(accepted)
}
#[tauri::command]
pub async fn resize_ssh_terminal(
    state: State<'_, SshState>,
    window: WebviewWindow,
    terminal_id: String,
    generation: String,
    columns: u32,
    rows: u32,
) -> Result<serde_json::Value, SshError> {
    let terminal = owned_terminal(&state, window.label(), &terminal_id, &generation)?;
    let (columns, rows) = normalize_terminal_dimensions(columns, rows);
    run_blocking_command(move || resize_terminal(&terminal, columns, rows)).await?;
    Ok(json!({"columns":columns,"rows":rows}))
}
#[tauri::command]
pub fn close_ssh_terminal(
    state: State<SshState>,
    window: WebviewWindow,
    terminal_id: String,
    generation: String,
) -> Result<bool, SshError> {
    state
        .terminal_requests
        .cancel(window.label(), &terminal_id, &generation);
    let mut openings = state.terminal_openings.lock().unwrap();
    if openings
        .get(&terminal_id)
        .is_some_and(|entry| entry.0 == window.label() && entry.1 == generation)
    {
        openings.remove(&terminal_id);
    }
    if state
        .terminal_sessions
        .read()
        .unwrap()
        .get(&terminal_id)
        .is_some_and(|entry| entry.owner == window.label() && entry.generation == generation)
    {
        close_terminal_session(&state.terminal_sessions, &terminal_id);
    }
    Ok(true)
}

fn upload_target_stamp(sftp: &Sftp, path: &Path) -> Result<Option<UploadTargetStamp>, SshError> {
    match sftp.lstat(path) {
        Ok(stat) => UploadTargetStamp::from_stat(&stat)
            .map(Some)
            .map_err(|message| SshError::FileOperationFailed(message.into())),
        Err(error) if is_sftp_missing_path(&error) => Ok(None),
        Err(error) => Err(SshError::FileOperationFailed(error.to_string())),
    }
}

/// 清理连接独占的截止时间守卫；提前结束会唤醒并回收线程，不留下延迟关 socket 的任务。
struct CleanupSocketGuard {
    completed: Arc<(Mutex<bool>, Condvar)>,
    worker: Option<thread::JoinHandle<()>>,
}

impl CleanupSocketGuard {
    fn new(
        socket: TcpStream,
        timeout: Duration,
        abort: impl Fn() -> bool + Send + 'static,
    ) -> std::io::Result<Self> {
        let completed = Arc::new((Mutex::new(false), Condvar::new()));
        let signal = completed.clone();
        let deadline = Instant::now() + timeout;
        let worker = thread::Builder::new()
            .name("file-cleanup-deadline".into())
            .spawn(move || {
                let (lock, wake) = &*signal;
                let mut done = lock.lock().unwrap();
                while !*done {
                    if Instant::now() >= deadline || abort() {
                        drop(done);
                        let _ = socket.shutdown(std::net::Shutdown::Both);
                        return;
                    }
                    let remaining = deadline.saturating_duration_since(Instant::now());
                    done = wake
                        .wait_timeout(done, remaining.min(Duration::from_millis(25)))
                        .unwrap()
                        .0;
                }
            })?;
        Ok(Self {
            completed,
            worker: Some(worker),
        })
    }
}

impl Drop for CleanupSocketGuard {
    fn drop(&mut self) {
        let (lock, wake) = &*self.completed;
        *lock.lock().unwrap() = true;
        wake.notify_all();
        if let Some(worker) = self.worker.take() {
            let _ = worker.join();
        }
    }
}

/// 用户取消允许清理自己的临时文件，但配置换代、断开和退出均禁止新建清理连接。
fn upload_cleanup_endpoint(
    state: &SshState,
    connection: &SshConnection,
    generation: u64,
) -> Option<SocketAddr> {
    if state.runtime_stop.load(Ordering::Acquire) {
        return None;
    }
    let generations = state.connection_generations.lock().unwrap();
    if generations.get(&connection.id).copied().unwrap_or(0) != generation {
        return None;
    }
    let connections = state.connections.read().unwrap();
    let current = connections.get(&connection.id)?;
    if !current.connected || !same_connection_configuration(current, connection) {
        return None;
    }
    state
        .connection_endpoints
        .lock()
        .unwrap()
        .get(&connection.id)
        .copied()
}

/// 仅清理本次排他创建的随机临时叶子，不接触目标，也不重试原上传。
///
/// 被取消的传输 socket 已关闭时，最多用五秒独立清理连接重新验证主机指纹、
/// 登录身份及父目录。网络不可达、身份换代或应用退出时只能尽力清理，不能
/// 据此宣称远端残留一定已移除；始终保留原任务的取消或失败结果。
fn cleanup_upload_temporary(
    context: &FileTransferContext<'_>,
    policy: &RemoteMutationPolicy,
    path: &Path,
) {
    fn unlink(sftp: &Sftp, policy: &RemoteMutationPolicy, path: &Path) -> Result<(), SshError> {
        policy
            .validate_parent(sftp, path)
            .map_err(SshError::FileOperationFailed)?;
        match sftp.unlink(path) {
            Ok(()) => Ok(()),
            Err(error) if is_sftp_missing_path(&error) => Ok(()),
            Err(error) => Err(SshError::FileOperationFailed(error.to_string())),
        }
    }
    if unlink(context.sftp, policy, path).is_ok() {
        return;
    }
    let state = context.state;
    let connection = context.connection;
    let Some(generation) = state.tasks.generation(context.transfer_id) else {
        return;
    };
    let Some(endpoint) = upload_cleanup_endpoint(state, connection, generation) else {
        return;
    };
    let cleanup_state = state.clone();
    let cleanup_connection = connection.clone();
    let deadline = Instant::now() + Duration::from_secs(5);
    let aborted =
        move || upload_cleanup_endpoint(&cleanup_state, &cleanup_connection, generation).is_none();
    let result = (|| -> Result<(), SshError> {
        let tcp = crate::transfer_connect::connect(endpoint, Duration::from_secs(3), || {
            aborted() || Instant::now() >= deadline
        })?;
        // libssh2 保持阻塞 API，但底层 socket 必须非阻塞才能应用协议超时。
        tcp.set_nonblocking(true)?;
        let _deadline_guard = CleanupSocketGuard::new(
            tcp.try_clone()?,
            deadline.saturating_duration_since(Instant::now()),
            aborted,
        )?;
        let mut session =
            Session::new().map_err(|error| SshError::ConnectionFailed(error.to_string()))?;
        session.set_tcp_stream(tcp);
        session.set_timeout(2_000);
        session.handshake()?;
        verify_host_key(connection, &host_key_info(&session)?)?;
        authenticate(&session, connection)?;
        let session = Arc::new(Mutex::new(session));
        let cleanup_policy = remote_mutation_policy(state, &connection.id, &session)?;
        let sftp = session.lock().unwrap().sftp()?;
        if upload_cleanup_endpoint(state, connection, generation).is_none() {
            return Err(SshError::TransferCancelled);
        }
        unlink(&sftp, &cleanup_policy, path)
    })();
    // 清理失败不能改变提交结果，也不能掩盖源变化或取消；下次不重试原操作。
    let _ = result;
}

/// 源文件长度和元数据验证通过、远端 CLOSE 成功后才提交同目录临时文件。
fn upload_file_to_sftp<F>(
    context: &FileTransferContext<'_>,
    policy: &RemoteMutationPolicy,
    local_file: File,
    remote_path: &str,
    mut report_progress: F,
) -> Result<u64, SshError>
where
    F: FnMut(u64, Option<u64>),
{
    let state = context.state;
    let sftp = context.sftp;
    let transfer_id = context.transfer_id;
    state.tasks.running(transfer_id);
    if context.cancelled() {
        return Err(SshError::TransferCancelled);
    }
    policy
        .validate_parent(sftp, Path::new(remote_path))
        .map_err(SshError::FileOperationFailed)?;
    let target_before = upload_target_stamp(sftp, Path::new(remote_path))?;
    if target_before.is_some() && !context.overwrite {
        return Err(SshError::TargetExists(format!(
            "远程文件已存在: {remote_path}"
        )));
    }
    let before = SourceStamp::from_local_metadata(&local_file.metadata()?)?;
    if let Some(expected) = context.expected_source {
        validate_transfer(expected, &before, before.size.unwrap_or(0))
            .map_err(|error| SshError::SourceChanged(error.to_string()))?;
    }
    let temporary_name = format!(".portal-part-{:032x}", rand::random::<u128>());
    let temporary_path = match remote_path.rsplit_once('/') {
        Some((parent, _)) => format!("{parent}/{temporary_name}"),
        None => temporary_name,
    };
    let mut remote_file = sftp
        .open_mode(
            Path::new(&temporary_path),
            ssh2::OpenFlags::WRITE | ssh2::OpenFlags::CREATE | ssh2::OpenFlags::EXCLUSIVE,
            0o600,
            ssh2::OpenType::File,
        )
        .map_err(|error| SshError::FileOperationFailed(error.to_string()))?;
    let mut reader = BufReader::new(local_file);
    let mut owned_buffer = Vec::new();
    let mut shared_buffer = context.buffer.map(|buffer| buffer.lock().unwrap());
    let buffer = if let Some(buffer) = shared_buffer.as_mut() {
        buffer.as_mut_slice()
    } else {
        owned_buffer.resize(TRANSFER_BUFFER_SIZE, 0);
        owned_buffer.as_mut_slice()
    };
    let mut current = 0u64;
    report_progress(0, before.size);
    let result = (|| -> Result<(), SshError> {
        loop {
            if context.cancelled() {
                return Err(SshError::TransferCancelled);
            }
            let count = reader.read(buffer)?;
            if count == 0 {
                break;
            }
            if before
                .size
                .is_some_and(|size| current.saturating_add(count as u64) > size)
            {
                return Err(SshError::SourceChanged("源文件长度增加".into()));
            }
            remote_file.write_all(&buffer[..count])?;
            current = current.saturating_add(count as u64);
            report_progress(current, before.size);
        }
        let after = SourceStamp::from_local_metadata(&reader.get_ref().metadata()?)?;
        validate_transfer(&before, &after, current)
            .map_err(|error| SshError::SourceChanged(error.to_string()))?;
        remote_file
            .close()
            .map_err(|error| SshError::FileOperationFailed(error.to_string()))?;
        Ok(())
    })();
    drop(remote_file);
    let result = result.and_then(|_| {
        if context.cancelled() {
            return Err(SshError::TransferCancelled);
        }
        policy
            .validate_parent(sftp, Path::new(remote_path))
            .map_err(SshError::FileOperationFailed)?;
        let mode = validate_upload_target(
            target_before,
            upload_target_stamp(sftp, Path::new(remote_path))?,
        )
        .map_err(|message| SshError::FileOperationFailed(message.into()))?;
        sftp.setstat(
            Path::new(&temporary_path),
            ssh2::FileStat {
                size: None,
                uid: None,
                gid: None,
                perm: Some(mode),
                atime: None,
                mtime: None,
            },
        )
        .map_err(|error| SshError::FileOperationFailed(error.to_string()))?;
        let session = context
            .session
            .lock()
            .map_err(|_| SshError::SftpFailed("会话锁已损坏".into()))?;
        rename_remote_file_cached(
            sftp,
            &session,
            Path::new(&temporary_path),
            Path::new(remote_path),
            context.overwrite,
            context.rename_client,
            || context.cancelled(),
            || {
                // 扩展协商可能耗时，在真正发送替换前再次检查目标，不能恢复旧权限。
                let current =
                    upload_target_stamp(sftp, Path::new(remote_path)).map_err(|error| {
                        crate::sftp_commit::CommitError::Protocol(error.to_string())
                    })?;
                validate_upload_target(target_before, current)
                    .map_err(|message| crate::sftp_commit::CommitError::Protocol(message.into()))?;
                context
                    .begin_commit()
                    .map_err(|_| crate::sftp_commit::CommitError::Cancelled)
            },
        )
    });
    if result.is_err() {
        cleanup_upload_temporary(context, policy, Path::new(&temporary_path));
    }
    result.map(|_| current)
}

fn remote_source_stamp(stat: &ssh2::FileStat) -> Result<SourceStamp, SshError> {
    let modified = stat
        .mtime
        .map(|time| {
            std::time::UNIX_EPOCH
                .checked_add(Duration::from_secs(time))
                .ok_or_else(|| SshError::FileOperationFailed("远端文件修改时间超出范围".into()))
        })
        .transpose()?;
    Ok(SourceStamp::new(stat.size, modified))
}
/// 已知长度、元数据和远端关闭均验证通过后，才同步并提交本地临时文件。
fn download_file_to_local<F>(
    context: &FileTransferContext<'_>,
    remote_path: &str,
    mut target: LocalDownload,
    mut report_progress: F,
) -> Result<u64, SshError>
where
    F: FnMut(u64, Option<u64>),
{
    let state = context.state;
    let transfer_id = context.transfer_id;
    state.tasks.running(transfer_id);
    if context.cancelled() {
        return Err(SshError::TransferCancelled);
    }
    let mut remote_file = context
        .sftp
        .open(Path::new(remote_path))
        .map_err(|error| SshError::FileOperationFailed(error.to_string()))?;
    let before = remote_source_stamp(
        &remote_file
            .stat()
            .map_err(|error| SshError::FileOperationFailed(error.to_string()))?,
    )?;
    if let Some(expected) = context.expected_source {
        validate_transfer(expected, &before, before.size.unwrap_or(0))
            .map_err(|error| SshError::SourceChanged(error.to_string()))?;
    }
    let mut owned_buffer = Vec::new();
    let mut shared_buffer = context.buffer.map(|buffer| buffer.lock().unwrap());
    let buffer = if let Some(buffer) = shared_buffer.as_mut() {
        buffer.as_mut_slice()
    } else {
        owned_buffer.resize(TRANSFER_BUFFER_SIZE, 0);
        owned_buffer.as_mut_slice()
    };
    let mut current = 0u64;
    report_progress(0, before.size);
    {
        let mut writer = BufWriter::new(target.file_mut());
        loop {
            if context.cancelled() {
                return Err(SshError::TransferCancelled);
            }
            let count = remote_file.read(buffer)?;
            if count == 0 {
                break;
            }
            if before
                .size
                .is_some_and(|size| current.saturating_add(count as u64) > size)
            {
                return Err(SshError::SourceChanged("源文件长度增加".into()));
            }
            writer.write_all(&buffer[..count])?;
            current = current.saturating_add(count as u64);
            report_progress(current, before.size);
        }
        writer.flush()?;
    }
    let after = remote_source_stamp(
        &remote_file
            .stat()
            .map_err(|error| SshError::FileOperationFailed(error.to_string()))?,
    )?;
    validate_transfer(&before, &after, current)
        .map_err(|error| SshError::SourceChanged(error.to_string()))?;
    remote_file
        .close()
        .map_err(|error| SshError::FileOperationFailed(error.to_string()))?;
    context.begin_commit()?;
    target.commit()?;
    Ok(current)
}

/// 只允许任务所属窗口查询；已经结束的任务保留有界缓存。
#[tauri::command]
pub fn get_transfer_statuses(
    state: State<SshState>,
    window: WebviewWindow,
    transfer_ids: Vec<String>,
) -> Vec<TaskSnapshot> {
    state.tasks.snapshots(window.label(), &transfer_ids)
}
/// 取消为幂等请求，不将接收请求误报为已经取消完成。
#[tauri::command]
pub fn cancel_transfer(
    state: State<SshState>,
    window: WebviewWindow,
    transfer_id: String,
) -> Option<TaskSnapshot> {
    state.tasks.cancel(window.label(), &transfer_id)
}

/// 批量上传、下载共用同一原生入口；前端只登记父任务，文件调度完全由后端控制。
#[tauri::command]
#[allow(clippy::too_many_arguments)] // Tauri 命名参数保持 IPC 兼容，实际传输配置集中在 request。
pub fn start_transfer(
    state: State<'_, SshState>,
    window: WebviewWindow,
    id: String,
    expected_generation: u64,
    expires_at: u64,
    transfer_id: String,
    request: transfer_service::TransferRequest,
) -> Result<TaskSnapshot, SshError> {
    request.validate()?;
    let kind = if request.direction == "upload" {
        "upload"
    } else {
        "download"
    };
    launch_file_task(
        &state,
        window.label(),
        id,
        Some(transfer_id),
        kind,
        expected_generation,
        expires_at,
        FileTaskOperation::Batch(request),
    )
}

/// 明细只返回给创建任务的窗口；分页限制避免一个 IPC 事件携带完整大目录清单。
#[tauri::command]
pub fn get_transfer_results(
    state: State<'_, SshState>,
    window: WebviewWindow,
    transfer_id: String,
    offset: Option<usize>,
    limit: Option<usize>,
) -> Option<serde_json::Value> {
    state.transfer_registry.result_page(
        &transfer_id,
        window.label(),
        offset.unwrap_or(0),
        limit.unwrap_or(256).clamp(1, 256),
    )
}

/// 重试由后端原始结果构建，只重传确认失败或尚未执行的项，不重试未知提交结果。
#[tauri::command]
#[allow(clippy::too_many_arguments)]
pub fn retry_transfer(
    state: State<'_, SshState>,
    window: WebviewWindow,
    id: String,
    previous_transfer_id: String,
    transfer_id: String,
    expected_generation: u64,
    expires_at: u64,
) -> Result<TaskSnapshot, SshError> {
    let original = state
        .tasks
        .snapshots(window.label(), std::slice::from_ref(&previous_transfer_id));
    if !original
        .iter()
        .any(|task| task.allows_retry_for(&id, expected_generation))
    {
        return Err(SshError::TransferRejected(
            "重试必须属于原窗口、原连接及原连接代次".into(),
        ));
    }
    let request = state
        .transfer_registry
        .retry(&previous_transfer_id, window.label())
        .ok_or_else(|| {
            SshError::TransferRejected("结果已过期、没有可重试项目或窗口不匹配".into())
        })?;
    start_transfer(
        state,
        window,
        id,
        expected_generation,
        expires_at,
        transfer_id,
        request,
    )
}

enum FileTaskOperation {
    Batch(transfer_service::TransferRequest),
    Delete(String),
}
fn connection_generation(state: &SshState, id: &str) -> u64 {
    state
        .connection_generations
        .lock()
        .unwrap()
        .get(id)
        .copied()
        .unwrap_or(0)
}

/// 与身份捕获及登记共用代次锁，迟到 IPC 不能改用已重连的会话。
fn validate_file_task_start(
    current: u64,
    expected: u64,
    expires_at: u64,
    now: u64,
) -> Result<(), SshError> {
    if current != expected {
        return Err(SshError::ConnectionGenerationChanged);
    }
    if expires_at <= now || expires_at.saturating_sub(now) > 60_000 {
        return Err(SshError::TransferStartExpired);
    }
    Ok(())
}

#[allow(clippy::too_many_arguments)] // 统一启动边界同时验证窗口、连接代次和过期时间。
fn launch_file_task(
    state: &SshState,
    owner: &str,
    id: String,
    task_id: Option<String>,
    kind: &'static str,
    expected_generation: u64,
    expires_at: u64,
    operation: FileTaskOperation,
) -> Result<TaskSnapshot, SshError> {
    let window_generation = state
        .window_generations
        .lock()
        .unwrap()
        .get(owner)
        .copied()
        .unwrap_or(0);
    // 只持有身份/代次的短锁；不要在主线程等待可能包含网络 IO 的连接生命周期锁。
    let generations = state.connection_generations.lock().unwrap();
    let connection = connection_info(state, &id, true)?;
    let task_id = task_id.unwrap_or_else(|| format!("{kind}-{}", uuid_fallback()));
    let generation = generations.get(&id).copied().unwrap_or(0);
    let now = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map_err(|_| SshError::TransferStartExpired)?
        .as_millis();
    validate_file_task_start(
        generation,
        expected_generation,
        expires_at,
        now.min(u64::MAX as u128) as u64,
    )?;
    let endpoint = state
        .connection_endpoints
        .lock()
        .unwrap()
        .get(&id)
        .copied()
        .ok_or(SshError::ConnectionNotFound)?;
    let windows = state.window_generations.lock().unwrap();
    if state.runtime_stop.load(Ordering::Acquire)
        || windows.get(owner).copied().unwrap_or(0) != window_generation
    {
        return Err(SshError::TransferRejected(
            "窗口已关闭，未启动文件任务".into(),
        ));
    }
    let snapshot = state
        .tasks
        .register(
            owner,
            &task_id,
            &id,
            generation,
            &transfer_pool::server_key(endpoint),
        )
        .map_err(|error| {
            if error == "传输已取消" {
                SshError::TransferCancelled
            } else {
                SshError::TransferRejected(error)
            }
        })?;
    drop(windows);
    drop(generations);
    let mut worker_state = state.clone();
    worker_state.isolated_transport = true;
    let thread_id = task_id.clone();
    let event_owner = owner.to_string();
    let started = transfer_service::submit_coordinator(Box::new(move || {
        let result = std::panic::catch_unwind(std::panic::AssertUnwindSafe(
            || -> Result<String, SshError> {
                if let FileTaskOperation::Batch(request) = operation {
                    worker_state.tasks.running(&thread_id);
                    return transfer_service::run_batch(
                        &worker_state,
                        &connection,
                        &thread_id,
                        request,
                    );
                }
                let _slot = worker_state
                    .tasks
                    .acquire(&thread_id)
                    .map_err(|_| SshError::TransferCancelled)?;
                let mut lease =
                    TransferSessionLease::checkout(&worker_state, &connection, &thread_id)?;
                if is_cancelled(&worker_state, &thread_id) {
                    return Err(SshError::TransferCancelled);
                }
                worker_state.tasks.running(&thread_id);
                let session = lease.session();
                let result = match operation {
                    FileTaskOperation::Batch(_) => unreachable!("批量任务已交由协调器处理"),
                    FileTaskOperation::Delete(remote) => {
                        run_delete(&worker_state, &session, &connection.id, &remote, &thread_id)
                            .map(|_| "删除成功".into())
                    }
                };
                if result.is_ok() && !is_cancelled(&worker_state, &thread_id) {
                    lease.reuse_on_success();
                }
                result
            },
        ))
        .unwrap_or_else(|_| Err(SshError::FileOperationFailed("文件任务异常退出".into())));
        let result = result.map_err(|error| {
            let message = error.to_string();
            let mut error = if worker_state.tasks.cancelled(&thread_id) {
                serde_json::to_value(SshError::TransferCancelled).unwrap()
            } else {
                serde_json::to_value(error).unwrap()
            };
            if !error.get("message").is_some_and(|value| value.is_string()) {
                error["message"] = json!(if error["code"] == "TransferCancelled" {
                    "传输已取消".to_string()
                } else {
                    message
                });
            }
            error["scope"] = json!("transfer");
            error
        });
        if let Some(snapshot) = worker_state.tasks.finish(&thread_id, result) {
            let mut payload = serde_json::to_value(&snapshot).unwrap();
            payload["success"] = json!(matches!(snapshot.status.as_str(), "succeeded" | "partial"));
            payload["cancelled"] = json!(snapshot.status == "cancelled");
            payload["operationId"] = json!(snapshot.transfer_id);
            // 不再根据可淘汰、可重新登记的 ID 查找其他窗口的 owner。
            let handle = worker_state.app_handle.lock().unwrap().clone();
            if let Some(handle) = handle.filter(|_| {
                worker_state
                    .window_generations
                    .lock()
                    .unwrap()
                    .get(&event_owner)
                    .copied()
                    .unwrap_or(0)
                    == window_generation
            }) {
                let _ = handle.emit_to(
                    tauri::EventTarget::WebviewWindow { label: event_owner },
                    &format!("{kind}-complete"),
                    payload,
                );
            }
        }
    }));
    if let Err(error) = started {
        state.tasks.finish(
            &task_id,
            Err(json!({"code":"TaskStartFailed","message":error.to_string(),"scope":"transfer"})),
        );
        return Err(SshError::FileOperationFailed("无法启动文件任务".into()));
    }
    Ok(snapshot)
}
fn emit_task_event(state: &SshState, task_id: &str, event: &str, mut payload: serde_json::Value) {
    let handle = state.app_handle.lock().unwrap().clone();
    if let (Some(handle), Some(owner)) = (handle, state.tasks.owner(task_id)) {
        payload["generation"] = json!(state.tasks.generation(task_id));
        let _ = handle.emit_to(
            tauri::EventTarget::WebviewWindow { label: owner },
            event,
            payload,
        );
    }
}
fn invalidate_file_sessions(state: &SshState, id: &str) -> bool {
    // 与任务的配置/代次捕获使用同一把短锁，不能组合旧身份和新代次。
    let mut generations = state.connection_generations.lock().unwrap();
    let was_connected = state
        .connections
        .write()
        .unwrap()
        .get_mut(id)
        .map(|connection| {
            let connected = connection.connected;
            connection.connected = false;
            connected
        })
        .unwrap_or(false);
    *generations.entry(id.into()).or_default() += 1;
    state.connection_endpoints.lock().unwrap().remove(id);
    state.tasks.cancel_matching(None, Some(id));
    state
        .transfer_pool
        .lock()
        .unwrap()
        .retain(|entry| entry.connection_id() != id);
    state.directory_requests.cancel_matching(None, Some(id));
    drop(generations);
    cancel_sftp_previews_for_connection(state, id);
    was_connected
}
/// 原生维护线程不依赖窗口存活；退出时由 shutdown_background_tasks 停止。
pub fn start_background_maintenance(state: SshState) {
    thread::spawn(move || {
        while !state.runtime_stop.load(Ordering::Acquire) {
            state.tasks.expire_stalled();
            state.transfer_registry.prune();
            state
                .transfer_pool
                .lock()
                .unwrap()
                .retain(|entry| entry.is_fresh());
            thread::sleep(Duration::from_secs(1));
        }
    });
}
pub fn cleanup_window(state: &SshState, owner: &str) {
    *state
        .window_generations
        .lock()
        .unwrap()
        .entry(owner.into())
        .or_default() += 1;
    cancel_sftp_previews_for_window(state, owner);
    state.terminal_requests.cancel_matching(Some(owner), None);
    state
        .terminal_openings
        .lock()
        .unwrap()
        .retain(|_, entry| entry.0 != owner);
    let terminal_ids: Vec<_> = state
        .terminal_sessions
        .read()
        .unwrap()
        .iter()
        .filter(|(_, entry)| entry.owner == owner)
        .map(|(id, _)| id.clone())
        .collect();
    for id in terminal_ids {
        close_terminal_session(&state.terminal_sessions, &id);
    }
    state.tasks.cancel_matching(Some(owner), None);
    state.transfer_registry.clear_owner(owner);
    state.directory_requests.cancel_matching(Some(owner), None);
}
pub fn shutdown_background_tasks(state: &SshState) {
    state.runtime_stop.store(true, Ordering::Release);
    cancel_all_sftp_previews(state);
    state.tasks.cancel_matching(None, None);
    state.directory_requests.cancel_matching(None, None);
    state.terminal_requests.cancel_matching(None, None);
    state.transfer_pool.lock().unwrap().clear();
    let owners: Vec<_> = state
        .terminal_sessions
        .read()
        .unwrap()
        .values()
        .map(|entry| entry.owner.clone())
        .collect();
    for owner in owners {
        cleanup_window(state, &owner);
    }
}

fn uuid_fallback() -> String {
    use std::time::{SystemTime, UNIX_EPOCH};
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|duration| duration.as_nanos().to_string())
        .unwrap_or_else(|_| "0".to_string())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn preview_early_cancellation_is_scoped_to_the_owning_window() {
        let registry = Arc::new(PreviewRegistry::default());
        assert!(registry.cancel("window-a", "preview-1"));
        let other = registry
            .begin("window-b", "connection-a", "preview-1", 1)
            .unwrap();
        assert!(!other.cancelled());
        assert!(matches!(
            registry.begin("window-a", "connection-a", "preview-1", 1),
            Err(SshError::PreviewCancelled)
        ));
        drop(other);
        assert!(registry.entries.lock().unwrap().is_empty());
    }

    #[test]
    fn preview_slots_are_bounded_and_released_when_the_request_finishes() {
        let registry = Arc::new(PreviewRegistry::default());
        let first = registry.begin("a", "one", "first", 1).unwrap();
        let same_connection = registry.begin("a", "one", "same", 1).unwrap();
        let second = registry.begin("b", "two", "second", 1).unwrap();
        let third = registry.begin("c", "three", "third", 1).unwrap();
        assert!(registry.try_acquire(&first));
        assert!(!registry.try_acquire(&same_connection));
        assert!(registry.try_acquire(&second));
        assert!(!registry.try_acquire(&third));
        drop(first);
        assert!(registry.try_acquire(&same_connection));
        drop(second);
        assert!(registry.try_acquire(&third));
        drop((same_connection, third));
        assert!(registry.entries.lock().unwrap().is_empty());
    }

    #[test]
    fn queued_previews_do_not_exhaust_lifecycle_command_slots() {
        use std::future::Future;
        use std::task::{Context, Poll, Waker};

        let state = SshState::default();
        let connection = SshConnection {
            id: "preview-queue".into(),
            host: "example.invalid".into(),
            port: 22,
            username: "unit".into(),
            auth_method: "password".into(),
            host_key_fingerprint: Some("fingerprint".into()),
            password: String::new(),
            connected: true,
        };
        state
            .connections
            .write()
            .unwrap()
            .insert(connection.id.clone(), connection.clone());
        let occupying = state
            .preview_registry
            .begin("owner", &connection.id, "occupying", 0)
            .unwrap();
        assert!(state.preview_registry.try_acquire(&occupying));
        let endpoint = "127.0.0.1:1".parse().unwrap();
        let runtime = tauri::async_runtime::handle();
        let _entered = runtime.inner().enter();
        let mut previews = Vec::new();
        let mut context = Context::from_waker(Waker::noop());
        for index in 0..MAX_BLOCKING_COMMANDS {
            let lease = state
                .preview_registry
                .begin("owner", &connection.id, &format!("queued-{index}"), 0)
                .unwrap();
            let mut preview = Box::pin(run_sftp_preview(
                state.clone(),
                connection.clone(),
                endpoint,
                "/unused".into(),
                lease,
                0,
            ));
            assert!(matches!(preview.as_mut().poll(&mut context), Poll::Pending));
            previews.push(preview);
        }
        let lifecycle_slot_available = match blocking_command_slot() {
            Ok(slot) => {
                drop(slot);
                true
            }
            Err(_) => false,
        };
        state.preview_registry.cancel_matching(None, None);
        drop(occupying);
        for preview in previews {
            assert!(matches!(
                tauri::async_runtime::block_on(preview),
                Err(SshError::PreviewCancelled)
            ));
        }
        assert!(
            lifecycle_slot_available,
            "排队预览不能耗尽连接生命周期命令的阻塞名额"
        );
    }

    #[test]
    fn preview_cancellation_only_shuts_down_the_owners_socket() {
        let listener = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
        let client = TcpStream::connect(listener.local_addr().unwrap()).unwrap();
        let (mut peer, _) = listener.accept().unwrap();
        peer.set_read_timeout(Some(Duration::from_secs(1))).unwrap();
        let registry = Arc::new(PreviewRegistry::default());
        let lease = registry.begin("owner", "connection", "preview", 1).unwrap();
        assert!(registry.try_acquire(&lease));
        registry.attach_socket(&lease, client).unwrap();
        assert!(registry.cancel("other-window", "preview"));
        assert!(!lease.cancelled());
        assert!(registry.cancel("owner", "preview"));
        assert!(lease.cancelled());
        assert!(matches!(peer.read(&mut [0_u8]), Ok(0)));
        drop(lease);
        assert!(registry.entries.lock().unwrap().is_empty());
    }

    #[test]
    fn preview_cancel_racing_socket_attachment_always_interrupts_the_socket() {
        for _ in 0..16 {
            let listener = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
            let client = TcpStream::connect(listener.local_addr().unwrap()).unwrap();
            let (mut peer, _) = listener.accept().unwrap();
            peer.set_read_timeout(Some(Duration::from_secs(1))).unwrap();
            let registry = Arc::new(PreviewRegistry::default());
            let lease = Arc::new(registry.begin("owner", "connection", "preview", 1).unwrap());
            assert!(registry.try_acquire(&lease));
            let barrier = Arc::new(std::sync::Barrier::new(2));
            let attach_registry = Arc::clone(&registry);
            let attach_lease = Arc::clone(&lease);
            let attach_barrier = Arc::clone(&barrier);
            let attach = thread::spawn(move || {
                attach_barrier.wait();
                attach_registry.attach_socket(&attach_lease, client)
            });
            barrier.wait();
            assert!(registry.cancel("owner", "preview"));
            let result = attach.join().unwrap();
            assert!(result.is_ok() || matches!(result, Err(SshError::PreviewCancelled)));
            assert!(lease.cancelled());
            assert!(matches!(peer.read(&mut [0_u8]), Ok(0)));
            drop(lease);
            assert!(registry.entries.lock().unwrap().is_empty());
        }
    }

    #[test]
    fn preview_lifecycle_cancel_filters_owner_and_connection() {
        let registry = Arc::new(PreviewRegistry::default());
        let first = registry
            .begin("owner-a", "connection-a", "first", 1)
            .unwrap();
        let second = registry
            .begin("owner-a", "connection-b", "second", 1)
            .unwrap();
        let third = registry
            .begin("owner-b", "connection-a", "third", 1)
            .unwrap();
        registry.cancel_matching(Some("owner-a"), Some("connection-a"));
        assert!(first.cancelled());
        assert!(!second.cancelled());
        assert!(!third.cancelled());
        registry.cancel_matching(None, Some("connection-a"));
        assert!(third.cancelled());
        assert!(!second.cancelled());
    }

    #[test]
    fn stale_monitor_failure_cannot_remove_replacement_session() {
        let state = SshState::default();
        let old = Arc::new(Mutex::new(Session::new().unwrap()));
        let replacement = Arc::new(Mutex::new(Session::new().unwrap()));
        state
            .monitor_sessions
            .lock()
            .unwrap()
            .insert("monitor".into(), (2, Arc::clone(&replacement)));
        remove_monitor_session_if_same(&state, "monitor", 1, &old);
        let sessions = state.monitor_sessions.lock().unwrap();
        assert!(Arc::ptr_eq(&sessions["monitor"].1, &replacement));
    }

    #[test]
    fn monitor_removal_does_not_wait_for_an_active_session_lock() {
        let state = SshState::default();
        let session = Arc::new(Mutex::new(Session::new().unwrap()));
        state
            .monitor_sessions
            .lock()
            .unwrap()
            .insert("monitor".into(), (1, Arc::clone(&session)));
        let held = session.lock().unwrap();
        let (send, receive) = std::sync::mpsc::channel();
        let worker = thread::spawn(move || {
            remove_monitor_session(&state, "monitor");
            send.send(()).unwrap();
        });
        let completed = receive.recv_timeout(Duration::from_secs(1)).is_ok();
        drop(held);
        worker.join().unwrap();
        assert!(completed, "监控采样不能阻塞连接生命周期清理");
    }

    #[test]
    fn stale_monitor_sample_cannot_replace_a_new_generation_cache() {
        let state = SshState::default();
        state.connections.write().unwrap().insert(
            "monitor".into(),
            SshConnection {
                id: "monitor".into(),
                host: "example.invalid".into(),
                port: 22,
                username: "unit".into(),
                auth_method: "password".into(),
                host_key_fingerprint: Some("fingerprint".into()),
                password: String::new(),
                connected: true,
            },
        );
        state
            .connection_generations
            .lock()
            .unwrap()
            .insert("monitor".into(), 2);
        let sample = || RemoteMonitorSample {
            platform: "linux".into(),
            cpu_count: 1,
            cpu_percent: None,
            cpu_ticks: Some((100, 20)),
            memory_total_bytes: 10,
            memory_used_bytes: 4,
            processes: Vec::new(),
            process_count: 0,
            memory_processes: Vec::new(),
        };
        state
            .connection_generations
            .lock()
            .unwrap()
            .insert("monitor".into(), 1);
        assert!(commit_monitor_sample(&state, "monitor", 1, sample()).is_ok());
        state
            .connection_generations
            .lock()
            .unwrap()
            .insert("monitor".into(), 2);
        assert!(cached_monitor_snapshot(&state, "monitor", 2)
            .unwrap()
            .is_none());
        assert!(commit_monitor_sample(&state, "monitor", 2, sample()).is_ok());
        assert!(matches!(
            commit_monitor_sample(&state, "monitor", 1, sample()),
            Err(SshError::ConnectionGenerationChanged)
        ));
        assert_eq!(
            state.monitor_cpu_samples.lock().unwrap()["monitor"],
            (2, (100, 20))
        );
        assert!(state
            .monitor_snapshot_cache
            .lock()
            .unwrap()
            .contains_key("monitor"));
    }

    #[test]
    fn remote_commit_leaf_uses_posix_separators_and_keeps_root() {
        let name = std::ffi::OsStr::new(".portal-part-unit");
        assert_eq!(
            append_remote_leaf(Path::new("/home/user"), name).as_os_str(),
            std::ffi::OsStr::new("/home/user/.portal-part-unit")
        );
        assert_eq!(
            append_remote_leaf(Path::new("/"), name).as_os_str(),
            std::ffi::OsStr::new("/.portal-part-unit")
        );
        assert_eq!(
            append_remote_leaf(Path::new("/home/user/"), name).as_os_str(),
            std::ffi::OsStr::new("/home/user/.portal-part-unit")
        );
    }

    #[test]
    fn late_file_task_start_rejects_expired_or_changed_session_before_registration() {
        assert!(validate_file_task_start(3, 3, 1_030_000, 1_000_000).is_ok());
        assert!(matches!(
            validate_file_task_start(4, 3, 1_030_000, 1_000_000),
            Err(SshError::ConnectionGenerationChanged)
        ));
        assert!(matches!(
            validate_file_task_start(3, 3, 1_000_000, 1_000_000),
            Err(SshError::TransferStartExpired)
        ));
        assert!(matches!(
            validate_file_task_start(3, 3, 1_060_001, 1_000_000),
            Err(SshError::TransferStartExpired)
        ));
    }

    #[test]
    fn late_main_session_mutations_reject_the_previous_generation_without_network_io() {
        let state = SshState::default();
        state
            .connection_generations
            .lock()
            .unwrap()
            .insert("mutation".into(), 2);
        assert!(matches!(
            sftp_mkdir_blocking(state.clone(), "mutation".into(), "/unit".into(), 1),
            Err(SshError::ConnectionGenerationChanged)
        ));
        assert!(matches!(
            sftp_rename_blocking(
                state,
                "mutation".into(),
                "/old".into(),
                "/new".into(),
                Some(true),
                1
            ),
            Err(SshError::ConnectionGenerationChanged)
        ));
    }

    #[test]
    fn cleanup_deadline_closes_only_its_owned_socket_and_joins_promptly() {
        let listener = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
        let mut client = TcpStream::connect(listener.local_addr().unwrap()).unwrap();
        let (_peer, _) = listener.accept().unwrap();
        client
            .set_read_timeout(Some(Duration::from_secs(1)))
            .unwrap();
        let started = Instant::now();
        let guard = CleanupSocketGuard::new(
            client.try_clone().unwrap(),
            Duration::from_millis(30),
            || false,
        )
        .unwrap();
        let outcome = client.read(&mut [0]);
        assert!(matches!(outcome, Ok(0)) || outcome.is_err());
        drop(guard);
        assert!(started.elapsed() < Duration::from_secs(1));

        let client = TcpStream::connect(listener.local_addr().unwrap()).unwrap();
        let (_peer, _) = listener.accept().unwrap();
        let started = Instant::now();
        drop(CleanupSocketGuard::new(client, Duration::from_secs(5), || false).unwrap());
        assert!(started.elapsed() < Duration::from_secs(1));
    }

    #[test]
    fn cleanup_reconnect_requires_the_same_live_identity_but_not_an_uncancelled_task() {
        let state = SshState::default();
        let connection = SshConnection {
            id: "cleanup-unit".into(),
            host: "example.invalid".into(),
            port: 22,
            username: "unit".into(),
            auth_method: "password".into(),
            host_key_fingerprint: Some("unit-fingerprint".into()),
            password: String::new(),
            connected: true,
        };
        let endpoint: SocketAddr = "192.0.2.10:22".parse().unwrap();
        state
            .connections
            .write()
            .unwrap()
            .insert(connection.id.clone(), connection.clone());
        state
            .connection_endpoints
            .lock()
            .unwrap()
            .insert(connection.id.clone(), endpoint);
        state
            .tasks
            .register("window", "cleanup-task", &connection.id, 0, "unit-host")
            .unwrap();
        state.tasks.cancel("window", "cleanup-task");
        assert!(state.tasks.cancelled("cleanup-task"));
        assert_eq!(
            upload_cleanup_endpoint(&state, &connection, 0),
            Some(endpoint)
        );
        state
            .connections
            .write()
            .unwrap()
            .get_mut(&connection.id)
            .unwrap()
            .host = "changed.invalid".into();
        assert_eq!(upload_cleanup_endpoint(&state, &connection, 0), None);
        state
            .connections
            .write()
            .unwrap()
            .insert(connection.id.clone(), connection.clone());
        state
            .connection_generations
            .lock()
            .unwrap()
            .insert(connection.id.clone(), 1);
        assert_eq!(upload_cleanup_endpoint(&state, &connection, 0), None);
        state
            .connection_generations
            .lock()
            .unwrap()
            .insert(connection.id.clone(), 0);
        state.runtime_stop.store(true, Ordering::Release);
        assert_eq!(upload_cleanup_endpoint(&state, &connection, 0), None);
    }

    fn assert_unhealthy_cache_cleanup_completes(monitor: bool) {
        let listener = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
        listener.set_nonblocking(true).unwrap();
        let address = listener.local_addr().unwrap();
        let stop = Arc::new(AtomicBool::new(false));
        let server_stop = Arc::clone(&stop);
        let server = thread::spawn(move || {
            while !server_stop.load(Ordering::Acquire) {
                match listener.accept() {
                    Ok((socket, _)) => {
                        drop(socket);
                        break;
                    }
                    Err(error) if error.kind() == std::io::ErrorKind::WouldBlock => {
                        thread::sleep(Duration::from_millis(5))
                    }
                    Err(_) => break,
                }
            }
        });
        let state = SshState::default();
        state.connections.write().unwrap().insert(
            "cached".into(),
            SshConnection {
                id: "cached".into(),
                host: "127.0.0.1".into(),
                port: address.port(),
                username: "user".into(),
                auth_method: "password".into(),
                host_key_fingerprint: Some("unused".into()),
                password: String::new(),
                connected: true,
            },
        );
        let cached = Arc::new(Mutex::new(Session::new().unwrap()));
        let unhealthy = Arc::clone(&cached);
        let _ = thread::spawn(move || {
            let _guard = unhealthy.lock().unwrap();
            panic!("模拟不可复用的会话锁");
        })
        .join();
        if monitor {
            state
                .monitor_sessions
                .lock()
                .unwrap()
                .insert("cached".into(), (0, cached));
        } else {
            state
                .connection_pool
                .write()
                .unwrap()
                .insert("cached".into(), cached);
        }
        let (send, receive) = std::sync::mpsc::channel();
        let worker = thread::spawn(move || {
            let failed = if monitor {
                let connection = connection_info(&state, "cached", true).unwrap();
                monitor_session_for(&state, "cached", &connection, 0).is_err()
            } else {
                connect_ssh_blocking(state, "cached".into()).is_err()
            };
            let _ = send.send(failed);
        });
        let result = receive.recv_timeout(Duration::from_secs(2));
        stop.store(true, Ordering::Release);
        server.join().unwrap();
        assert_eq!(
            result.ok(),
            Some(true),
            "失效缓存清理不能再次等待自身持有的池锁"
        );
        worker.join().unwrap();
    }

    #[test]
    fn unhealthy_main_cache_cleanup_does_not_reenter_the_pool_read_lock() {
        assert_unhealthy_cache_cleanup_completes(false);
    }

    #[test]
    fn unhealthy_monitor_cache_cleanup_does_not_reenter_the_pool_mutex() {
        assert_unhealthy_cache_cleanup_completes(true);
    }

    #[test]
    fn invalidation_revokes_the_identity_generation_and_verified_endpoint_together() {
        let state = SshState::default();
        let connection = SshConnection {
            id: "revoked".into(),
            host: "example.invalid".into(),
            port: 22,
            username: "user".into(),
            auth_method: "password".into(),
            host_key_fingerprint: None,
            password: String::new(),
            connected: true,
        };
        state
            .connections
            .write()
            .unwrap()
            .insert(connection.id.clone(), connection);
        state
            .connection_generations
            .lock()
            .unwrap()
            .insert("revoked".into(), 7);
        state
            .connection_endpoints
            .lock()
            .unwrap()
            .insert("revoked".into(), "127.0.0.1:22".parse().unwrap());
        state
            .tasks
            .register("window", "old-task", "revoked", 7, "example.invalid:22")
            .unwrap();
        assert!(invalidate_file_sessions(&state, "revoked"));
        assert!(matches!(
            connection_info(&state, "revoked", true),
            Err(SshError::ConnectionNotFound)
        ));
        assert_eq!(state.connection_generations.lock().unwrap()["revoked"], 8);
        assert!(!state
            .connection_endpoints
            .lock()
            .unwrap()
            .contains_key("revoked"));
        assert!(state.tasks.cancelled("old-task"));
        assert!(!invalidate_file_sessions(&state, "revoked"));
    }

    #[test]
    fn window_cleanup_cancels_pending_terminal_open_and_advances_its_instance() {
        let state = SshState::default();
        let token = state
            .terminal_requests
            .begin("old-window", "terminal", "generation")
            .unwrap();
        cleanup_window(&state, "old-window");
        assert!(token.load(Ordering::Acquire));
        assert_eq!(state.window_generations.lock().unwrap()["old-window"], 1);
        state
            .terminal_requests
            .finish("old-window", "generation", &token);
        let next = state
            .terminal_requests
            .begin("old-window", "terminal", "new-generation")
            .unwrap();
        assert!(!next.load(Ordering::Acquire));
    }

    #[test]
    fn terminal_write_retries_would_block_without_matching_error_text() {
        let mut attempts = 0;
        let mut received = Vec::new();
        write_terminal_bytes(
            b"hello",
            || false,
            |bytes| {
                attempts += 1;
                if attempts == 1 {
                    return Err(std::io::Error::new(
                        std::io::ErrorKind::WouldBlock,
                        "Unable to send channel data",
                    ));
                }
                let size = bytes.len().min(2);
                received.extend_from_slice(&bytes[..size]);
                Ok(size)
            },
            |_| {},
            TERMINAL_WRITE_TIMEOUT,
        )
        .unwrap();
        assert_eq!(received, b"hello");
        assert_eq!(attempts, 4);
    }

    #[test]
    fn terminal_write_stops_on_cancellation_and_definitive_failure() {
        assert!(matches!(
            write_terminal_bytes(
                b"hello",
                || true,
                |_| panic!("取消后不能写入"),
                |_| {},
                TERMINAL_WRITE_TIMEOUT
            ),
            Err(SshError::TerminalNotFound)
        ));
        let error = write_terminal_bytes(
            b"hello",
            || false,
            |_| Err(std::io::Error::from(std::io::ErrorKind::BrokenPipe)),
            |_| {},
            TERMINAL_WRITE_TIMEOUT,
        )
        .unwrap_err();
        assert!(matches!(error, SshError::TerminalFailed(_)));
    }

    #[test]
    fn fingerprints_preserve_base64_case_and_allow_padding_only() {
        let original = format!("SHA256:{}", base64_encode(&[0u8; 32]));
        let changed = format!("SHA256:a{}", &original[8..]);
        assert!(fingerprint_matches(&original, &original));
        assert!(fingerprint_matches(&format!("{original}="), &original));
        assert!(!fingerprint_matches(&changed, &original));
        assert!(!fingerprint_matches("sha256:AAAA", &original));
        assert!(!fingerprint_matches("SHA256:!", &original));
        assert!(!fingerprint_matches(&format!("{original}=="), &original));
    }

    #[test]
    fn removes_monitor_session_when_connection_is_marked_disconnected() {
        let state = SshState::default();
        let connection_id = "connection-a".to_string();
        state.connections.write().unwrap().insert(
            connection_id.clone(),
            SshConnection {
                id: connection_id.clone(),
                host: "example.test".to_string(),
                port: 22,
                username: "operator".to_string(),
                auth_method: "password".to_string(),
                host_key_fingerprint: None,
                password: String::new(),
                connected: true,
            },
        );
        let monitor_session = Arc::new(Mutex::new(Session::new().expect("应创建测试会话")));
        state
            .monitor_sessions
            .lock()
            .unwrap()
            .insert(connection_id.clone(), (0, monitor_session));

        mark_connection_disconnected(&state, &connection_id, "测试断线".to_string());

        assert!(!state
            .monitor_sessions
            .lock()
            .unwrap()
            .contains_key(&connection_id));
        assert!(
            !state
                .connections
                .read()
                .unwrap()
                .get(&connection_id)
                .expect("连接配置应保留")
                .connected
        );
    }

    #[test]
    fn monitor_commands_report_logical_cpu_count() {
        for command in [
            LINUX_MONITOR_COMMAND,
            MACOS_MONITOR_COMMAND,
            FREEBSD_MONITOR_COMMAND,
            DRAGONFLY_MONITOR_COMMAND,
            OPENBSD_MONITOR_COMMAND,
            NETBSD_MONITOR_COMMAND,
        ] {
            assert!(command.contains("CPUCOUNT"));
        }
        assert!(WINDOWS_MONITOR_SCRIPT.contains("cpuCount="));
    }

    #[test]
    fn parses_bounded_server_monitor_output() {
        let output = concat!(
            "OS\tlinux\n",
            "CPUCOUNT\t8\n",
            "CPUSTAT\t1000\t250\n",
            "MEM\t8192\t4096\n",
            "PROC\t42\t12.5\t2048\tworker\n",
            "PROC\t7\t0.5\t1024\tinit\n"
        );

        let sample = parse_remote_monitor_output(output.as_bytes()).expect("采集结果应可解析");

        assert_eq!(sample.platform, "linux");
        assert_eq!(sample.cpu_count, 8);
        assert_eq!(sample.cpu_ticks, Some((1000, 250)));
        assert_eq!(sample.cpu_percent, None);
        assert_eq!(sample.memory_total_bytes, 8192);
        assert_eq!(sample.memory_used_bytes, 4096);
        assert_eq!(sample.processes.len(), 2);
        assert_eq!(sample.processes[0].pid, 42);
        assert_eq!(sample.processes[0].name, "worker");
        assert_eq!(sample.processes[0].memory_bytes, 2048);
    }

    #[test]
    fn deduplicates_monitor_processes_by_pid_using_highest_cpu_sample() {
        let output = concat!(
            "OS\tlinux\n",
            "CPUCOUNT\t4\n",
            "CPU\t12.0\n",
            "MEM\t8192\t4096\n",
            "PROC\t42\t2.0\t8192\tworker\n",
            "PROC\t42\t8.0\t4096\tworker\n",
            "PROC\t7\t1.0\t1024\tinit\n"
        );

        let sample = parse_remote_monitor_output(output.as_bytes()).expect("采集结果应可解析");

        assert_eq!(sample.processes.len(), 2);
        assert_eq!(sample.processes[0].pid, 42);
        assert_eq!(sample.processes[0].cpu_percent, 8.0);
        assert_eq!(sample.processes[0].memory_bytes, 8192);
    }

    #[test]
    fn keeps_up_to_five_hundred_processes_in_monitor_snapshot() {
        let mut output = String::from("OS\tlinux\nCPUCOUNT\t4\nCPU\t12.0\nMEM\t8192\t4096\n");
        for pid in 1..=505 {
            output.push_str(&format!(
                "PROC\t{pid}\t{}.0\t1024\tprocess-{pid}\n",
                pid % 100
            ));
        }

        let sample = parse_remote_monitor_output(output.as_bytes()).expect("监控结果应可解析");

        assert_eq!(sample.processes.len(), 500);
    }

    #[test]
    fn reports_visible_process_count_before_limiting_monitor_rows() {
        let mut output = String::from("OS\tlinux\nCPUCOUNT\t4\nCPU\t12.0\nMEM\t8192\t4096\n");
        for pid in 1..=505 {
            output.push_str(&format!("PROC\t{pid}\t1.0\t1024\tworker-{pid}\n"));
        }
        // 同一 PID 的重复采样不应增加可见进程总数。
        output.push_str("PROC\t1\t2.0\t2048\tworker-1\n");
        let sample = parse_remote_monitor_output(output.as_bytes()).unwrap();
        let snapshot = ServerMonitorSnapshot {
            platform: sample.platform,
            cpu_count: sample.cpu_count,
            cpu_percent: sample.cpu_percent,
            memory_total_bytes: sample.memory_total_bytes,
            memory_used_bytes: sample.memory_used_bytes,
            processes: sample.processes,
            process_count: sample.process_count,
            memory_processes: sample.memory_processes,
            collected_at: 0,
        };
        let payload = serde_json::to_value(snapshot).unwrap();

        assert_eq!(payload["processCount"], 505);
        assert_eq!(payload["processes"].as_array().unwrap().len(), 500);
        assert_eq!(payload["cpuCount"], 4);
    }

    #[test]
    fn keeps_high_memory_processes_outside_the_cpu_ranked_limit() {
        let mut output = String::from("OS\tlinux\nCPUCOUNT\t4\nCPU\t12.0\nMEM\t8192\t4096\n");
        for pid in 1..=500 {
            output.push_str(&format!("PROC\t{pid}\t1.0\t1024\tcpu-worker-{pid}\n"));
        }
        output.push_str("PROC\t900\t0.0\t4096\tmemory-worker\n");
        let sample = parse_remote_monitor_output(output.as_bytes()).unwrap();
        let snapshot = ServerMonitorSnapshot {
            platform: sample.platform,
            cpu_count: sample.cpu_count,
            cpu_percent: sample.cpu_percent,
            memory_total_bytes: sample.memory_total_bytes,
            memory_used_bytes: sample.memory_used_bytes,
            processes: sample.processes,
            process_count: sample.process_count,
            memory_processes: sample.memory_processes,
            collected_at: 0,
        };
        let payload = serde_json::to_value(snapshot).unwrap();

        assert_eq!(payload["memoryProcesses"][0]["pid"], 900);
        assert_eq!(payload["processes"][0]["pid"], 1);
    }

    #[test]
    fn selects_a_platform_specific_monitor_for_each_bsd_family() {
        let freebsd = monitor_command_for_platform("freebsd").expect("FreeBSD 应受支持");
        let dragonfly = monitor_command_for_platform("dragonfly").expect("DragonFly 应受支持");
        let openbsd = monitor_command_for_platform("openbsd").expect("OpenBSD 应受支持");
        let netbsd = monitor_command_for_platform("netbsd").expect("NetBSD 应受支持");

        assert!(freebsd.contains("vm.stats.vm.v_inactive_count"));
        assert!(dragonfly.contains("vmstat | awk"));
        assert!(openbsd.contains("sysctl -n hw.physmem)"));
        assert!(netbsd.contains("hw.physmem64"));
        assert_ne!(freebsd, dragonfly);
        assert_ne!(openbsd, netbsd);
        assert!(monitor_command_for_platform("unknown").is_none());
    }

    #[test]
    fn identifies_unchanged_connection_configuration_for_session_reuse() {
        let connection = SshConnection {
            id: "server-1".to_string(),
            host: "example.test".to_string(),
            port: 22,
            username: "operator".to_string(),
            auth_method: "password".to_string(),
            host_key_fingerprint: Some("SHA256:fingerprint".to_string()),
            password: "secret".to_string(),
            connected: true,
        };
        let mut same_connection = connection.clone();
        same_connection.connected = false;

        assert!(same_connection_configuration(&connection, &same_connection));

        same_connection.password = "changed".to_string();
        assert!(!same_connection_configuration(
            &connection,
            &same_connection
        ));
    }

    #[test]
    fn rejects_incomplete_or_out_of_range_server_monitor_output() {
        let missing_memory = b"OS\tlinux\nCPU\t15.0\n";
        assert!(parse_remote_monitor_output(missing_memory).is_err());

        let missing_cpu_count = b"OS\tlinux\nCPU\t15.0\nMEM\t100\t50\n";
        assert!(parse_remote_monitor_output(missing_cpu_count).is_err());

        let invalid_cpu_count = b"OS\tlinux\nCPUCOUNT\t0\nCPU\t15.0\nMEM\t100\t50\n";
        assert!(parse_remote_monitor_output(invalid_cpu_count).is_err());

        let invalid_memory = b"OS\tlinux\nCPUCOUNT\t2\nCPU\t15.0\nMEM\t100\t101\n";
        assert!(parse_remote_monitor_output(invalid_memory).is_err());

        let invalid_process =
            b"OS\tlinux\nCPUCOUNT\t2\nCPU\t15.0\nMEM\t100\t50\nPROC\tbad\t2\t3\tworker\n";
        assert!(parse_remote_monitor_output(invalid_process).is_err());
    }

    #[test]
    fn calculates_cpu_usage_from_monotonic_counter_deltas() {
        assert_eq!(calculate_cpu_percent((100, 30), (200, 80)), Some(50.0));
        assert_eq!(calculate_cpu_percent((100, 30), (100, 30)), None);
        assert_eq!(calculate_cpu_percent((200, 80), (100, 30)), None);
    }

    #[test]
    fn parses_windows_json_monitor_output_and_sorts_processes_by_cpu() {
        let output = br#"{"platform":"windows","cpuCount":8,"cpuPercent":22.5,"memoryTotalBytes":8000,"memoryUsedBytes":3000,"processes":[{"pid":9,"name":"idle-worker","cpuPercent":1.5,"memoryBytes":600},{"pid":4,"name":"busy-worker","cpuPercent":8.25,"memoryBytes":1200}]}"#;

        let sample = parse_remote_monitor_output(output).expect("Windows 监控结果应可解析");

        assert_eq!(sample.platform, "windows");
        assert_eq!(sample.cpu_count, 8);
        assert_eq!(sample.cpu_percent, Some(22.5));
        assert_eq!(sample.processes[0].pid, 4);
        assert_eq!(sample.processes[0].name, "busy-worker");
    }

    #[test]
    fn encodes_sha256_fingerprint_bytes_as_base64() {
        assert_eq!(base64_encode(b"hello"), "aGVsbG8");
        assert_eq!(base64_encode(&[]), "");
    }

    #[test]
    fn shell_quotes_remote_paths_without_allowing_command_injection() {
        let quoted = shell_quote_remote_path("/srv/O'Reilly; touch /tmp/unsafe").unwrap();
        assert_eq!(quoted, "'/srv/O'\\''Reilly; touch /tmp/unsafe'");
        assert!(shell_quote_remote_path("/srv/unsafe\0path").is_none());
    }

    #[test]
    fn parses_only_numeric_du_output() {
        assert_eq!(parse_remote_du_size(b"12345\t/srv/data\n"), Some(12345));
        assert_eq!(parse_remote_du_size(b"du: invalid option -- b\n"), None);
        assert_eq!(parse_remote_du_size(b"notice\n12345\t/srv/data\n"), None);
    }

    #[test]
    fn uses_du_only_for_absolute_posix_sftp_paths() {
        assert!(is_absolute_posix_remote_path("/srv/data"));
        assert!(!is_absolute_posix_remote_path("relative/path"));
        assert!(!is_absolute_posix_remote_path("C:/data"));
    }

    #[test]
    fn recognizes_unavailable_remote_du_messages() {
        assert!(remote_du_is_unavailable(
            b"du: illegal option -- b\nusage: du ..."
        ));
        assert!(remote_du_is_unavailable(b"sh: du: command not found\n"));
        assert!(!remote_du_is_unavailable(
            b"du: cannot read directory '/srv/private': Permission denied\n"
        ));
    }

    #[test]
    fn rejects_invalid_connection_configuration() {
        let connection = SshConnection {
            id: "test".to_string(),
            host: "".to_string(),
            port: 22,
            username: "user".to_string(),
            auth_method: "password".to_string(),
            host_key_fingerprint: None,
            password: "secret".to_string(),
            connected: false,
        };
        assert!(validate_connection(&connection).is_err());
    }

    #[test]
    fn rejects_non_password_authentication() {
        let connection = SshConnection {
            id: "test".to_string(),
            host: "example.com".to_string(),
            port: 22,
            username: "user".to_string(),
            auth_method: "key".to_string(),
            host_key_fingerprint: None,
            password: "secret".to_string(),
            connected: false,
        };
        let error = validate_connection(&connection).expect_err("应拒绝非密码认证");
        assert!(
            matches!(error, SshError::UnsupportedAuth(message) if message == "当前版本仅支持账户密码认证")
        );
    }

    #[test]
    fn distinguishes_transport_loss_from_sftp_path_errors() {
        assert!(is_connection_loss(&ssh2::Error::new(
            ErrorCode::Session(-13),
            "socket disconnected"
        )));
        assert!(is_connection_loss(&ssh2::Error::new(
            ErrorCode::SFTP(7),
            "connection lost"
        )));
        assert!(!is_connection_loss(&ssh2::Error::new(
            ErrorCode::SFTP(2),
            "no such file"
        )));
    }

    #[test]
    fn keeps_partial_directory_size_for_child_path_errors() {
        assert!(is_recoverable_directory_size_error(&ssh2::Error::new(
            ErrorCode::SFTP(3),
            "permission denied"
        )));
        assert!(is_recoverable_directory_size_error(&ssh2::Error::new(
            ErrorCode::SFTP(LIBSSH2_FX_NO_SUCH_FILE),
            "no such file"
        )));
        assert!(!is_recoverable_directory_size_error(&ssh2::Error::new(
            ErrorCode::SFTP(LIBSSH2_FX_CONNECTION_LOST),
            "connection lost"
        )));
    }

    #[test]
    fn limits_independent_directory_size_workers() {
        let state = SshState::default();
        let first = try_directory_size_worker_slot(&state).expect("应获得第一个统计工作者");
        let second = try_directory_size_worker_slot(&state).expect("应获得第二个统计工作者");
        let third = try_directory_size_worker_slot(&state).expect("应获得第三个统计工作者");
        let fourth = try_directory_size_worker_slot(&state).expect("应获得第四个统计工作者");
        assert!(matches!(
            try_directory_size_worker_slot(&state),
            Err(SshError::DirectorySizeLimitReached)
        ));

        drop(first);
        let fifth = try_directory_size_worker_slot(&state).expect("释放后应可重新获取工作者");
        drop(fifth);
        drop(fourth);
        drop(third);
        drop(second);
        assert_eq!(
            state.active_directory_size_workers.load(Ordering::Acquire),
            0
        );
    }

    #[test]
    fn dynamically_shares_directory_jobs_between_workers() {
        let state = SshState::default();
        let cancellation = Arc::new(AtomicBool::new(false));
        let scan = DirectorySizeScan::new(
            "/workspace",
            Arc::clone(&cancellation),
            Arc::new(Condvar::new()),
        );

        let (root_slot, root_path, is_root) = next_directory_size_job(&state, &scan)
            .expect("应领取根目录任务")
            .expect("根目录任务不应为空");
        assert!(is_root);
        assert_eq!(root_path, PathBuf::from("/workspace"));
        scan.complete_directory(
            vec![
                PathBuf::from("/workspace/a"),
                PathBuf::from("/workspace/b"),
                PathBuf::from("/workspace/c"),
            ],
            10,
            1,
            0,
        );
        drop(root_slot);

        let mut child_slots = Vec::new();
        for _ in 0..3 {
            let (slot, _, is_root) = next_directory_size_job(&state, &scan)
                .expect("子目录任务应可领取")
                .expect("子目录任务不应为空");
            assert!(!is_root);
            child_slots.push(slot);
        }
        assert_eq!(
            state.active_directory_size_workers.load(Ordering::Acquire),
            3
        );

        scan.complete_directory(Vec::new(), 1, 1, 0);
        scan.complete_directory(Vec::new(), 2, 1, 0);
        scan.complete_directory(Vec::new(), 3, 1, 0);
        drop(child_slots);

        let result = scan.result().expect("动态队列应完成统计");
        assert_eq!(result.size, 16);
        assert_eq!(result.scanned_entries, 4);
        assert!(result.complete);
    }

    #[test]
    fn yields_ready_directory_to_waiting_worker() {
        let scan = DirectorySizeScan::new(
            "/workspace",
            Arc::new(AtomicBool::new(false)),
            Arc::new(Condvar::new()),
        );
        scan.state.lock().unwrap().waiting_workers = 1;
        assert!(take_ready_directory_size_job(&scan)
            .expect("等待状态应可读取")
            .is_none());

        scan.state.lock().unwrap().waiting_workers = 0;
        let (_, is_root) = take_ready_directory_size_job(&scan)
            .expect("任务应可领取")
            .expect("根目录任务不应为空");
        assert!(is_root);
    }

    #[test]
    fn clears_directory_worker_pool_after_last_task() {
        let state = SshState::default();
        let first_pool =
            begin_directory_size_task(&state, "connection-a").expect("应创建第一个统计任务");
        let second_pool =
            begin_directory_size_task(&state, "connection-a").expect("应复用同一连接的会话池");
        assert!(Arc::ptr_eq(&first_pool, &second_pool));

        end_directory_size_task(&state, "connection-a", &first_pool);
        assert!(state
            .directory_size_worker_pools
            .read()
            .unwrap()
            .contains_key("connection-a"));

        end_directory_size_task(&state, "connection-a", &second_pool);
        assert!(!state
            .directory_size_worker_pools
            .read()
            .unwrap()
            .contains_key("connection-a"));
    }

    #[test]
    fn identifies_sftp_rename_capability_failures() {
        assert!(is_rename_compatibility_error(&ssh2::Error::new(
            ErrorCode::SFTP(LIBSSH2_FX_FAILURE),
            "failure"
        )));
        assert!(is_rename_compatibility_error(&ssh2::Error::new(
            ErrorCode::SFTP(LIBSSH2_FX_OP_UNSUPPORTED),
            "operation unsupported"
        )));
        assert!(!is_rename_compatibility_error(&ssh2::Error::new(
            ErrorCode::SFTP(3),
            "permission denied"
        )));
    }

    #[test]
    fn joins_folder_upload_paths_without_parent_components() {
        assert_eq!(
            join_remote_path("/", Path::new("nested/file.txt")).unwrap(),
            "/nested/file.txt"
        );
        assert_eq!(
            join_remote_path("C:/upload/", Path::new("nested/file.txt")).unwrap(),
            "C:/upload/nested/file.txt"
        );
        assert!(join_remote_path("/upload", Path::new("../escape")).is_err());
    }

    #[test]
    fn joins_remote_download_children_with_portable_separators() {
        assert_eq!(
            join_remote_child_path("/remote/", "nested").unwrap(),
            "/remote/nested"
        );
        assert_eq!(
            join_remote_child_path("C:\\remote\\", "nested").unwrap(),
            "C:/remote/nested"
        );
        assert!(join_remote_child_path("/remote", "../escape").is_err());
        assert!(join_remote_child_path("/remote", "nested/file.txt").is_err());
    }

    #[test]
    fn collects_nested_files_and_empty_directories_for_folder_upload() {
        let root = std::env::temp_dir().join(format!(
            "portal-folder-upload-plan-{}-{}",
            std::process::id(),
            uuid_fallback()
        ));
        fs::create_dir_all(root.join("nested")).unwrap();
        fs::create_dir_all(root.join("empty")).unwrap();
        fs::write(root.join("root.txt"), b"abc").unwrap();
        fs::write(root.join("nested").join("child.txt"), b"hello").unwrap();

        let plan =
            collect_folder_upload_plan(&LocalTransferRoot::open(&root).unwrap(), || false, || {})
                .unwrap();
        let directories = plan
            .directories
            .iter()
            .map(|path| display_relative_path(path))
            .collect::<Vec<_>>();
        let files = plan
            .files
            .iter()
            .map(|file| display_relative_path(&file.relative_path))
            .collect::<Vec<_>>();

        let _ = fs::remove_dir_all(&root);

        assert_eq!(directories, vec!["empty", "nested"]);
        assert_eq!(files, vec!["nested/child.txt", "root.txt"]);
        assert_eq!(plan.total_bytes, 8);
        assert_eq!(plan.skipped_entries, 0);
    }
}
