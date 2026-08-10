//! Portal 的 SSH/SFTP 后端实现。
//!
//! 本模块负责维护连接和主机指纹，提供远程目录/文件操作、递归目录大小统计、
//! 文件传输以及交互式 PTY 终端。耗时的扫描和传输会放到独立线程或 Tauri
//! blocking runtime 中执行，并通过事件把进度和状态返回给前端。

use std::collections::{HashMap, HashSet, VecDeque};
use std::fs::{self, File};
use std::io::{BufReader, BufWriter, Read, Write};
use std::net::{SocketAddr, TcpStream, ToSocketAddrs};
use std::path::{Component, Path, PathBuf};
use std::sync::atomic::{AtomicBool, AtomicUsize, Ordering};
use std::sync::{Arc, Condvar, Mutex, RwLock};
use std::thread;
use std::time::{Duration, Instant};

use serde::Serialize;
use serde_json::json;
use ssh2::{Channel, ErrorCode, ExtendedData, HashType, RenameFlags, Session, Sftp};
use tauri::{AppHandle, Emitter, State};
use thiserror::Error;

// SSH 建连默认超时、文件传输缓冲、保活间隔和并发传输上限。
const DEFAULT_TIMEOUT_MS: u64 = 30_000;
const TRANSFER_BUFFER_SIZE: usize = 64 * 1024;
const KEEPALIVE_INTERVAL_SECS: u32 = 30;
const MAX_CONCURRENT_TRANSFERS: usize = 4;
// 目录大小统计最多同时使用 4 个独立工作会话，兼顾速度与远端 SSH 会话压力。
const MAX_CONCURRENT_DIRECTORY_SIZE_WORKERS: usize = 4;
// 同一工作会话连续处理少量子目录，降低反复创建 SFTP 子会话的开销，同时保留调度公平性。
const DIRECTORY_SIZE_WORKER_BATCH_SIZE: usize = 8;
// GNU/Linux 的远端 `du` 只返回一行汇总结果；限制输出大小，避免异常远端命令占满内存。
const MAX_DIRECTORY_SIZE_COMMAND_OUTPUT_BYTES: usize = 64 * 1024;
// 目录命令轮询、预览大小和终端输入/控制/尺寸的安全边界。
const DIRECTORY_SIZE_COMMAND_POLL_INTERVAL: Duration = Duration::from_millis(20);
const MAX_PREVIEW_BYTES: u64 = 5 * 1024 * 1024;
const MAX_TERMINAL_INPUT_BYTES: usize = 64 * 1024;
const TERMINAL_WRITE_TIMEOUT: Duration = Duration::from_secs(10);
const TERMINAL_CONTROL_TIMEOUT: Duration = Duration::from_secs(2);
const TERMINAL_POLL_INTERVAL: Duration = Duration::from_millis(12);
const DEFAULT_TERMINAL_COLUMNS: u32 = 100;
const DEFAULT_TERMINAL_ROWS: u32 = 30;

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
#[derive(Error, Debug, Serialize)]
#[serde(tag = "code", content = "message")]
pub enum SshError {
    /// 请求的连接不存在，或尚未建立可用会话。
    #[error("连接不存在或未连接")]
    ConnectionNotFound,
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
    /// 读取远程目录或目录统计状态失败。
    #[error("读取目录失败: {0}")]
    ReadDirFailed(String),
    /// 并发文件传输数量已达到保护上限。
    #[error("传输任务数量已达到上限")]
    TransferLimitReached,
    /// 文件传输在安全检查点收到取消请求。
    #[error("传输已取消")]
    TransferCancelled,
    /// 递归目录大小统计收到取消请求。
    #[error("目录大小统计已取消")]
    DirectorySizeCancelled,
    /// 目录统计工作会话数量达到保护上限。
    #[error("目录大小统计任务数量已达到上限")]
    DirectorySizeLimitReached,
    /// 请求预览的远程文件超过内存安全上限。
    #[error("预览文件超过大小限制")]
    PreviewTooLarge,
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
        SshError::FileOperationFailed(error.to_string())
    }
}

impl From<ssh2::Error> for SshError {
    fn from(error: ssh2::Error) -> Self {
        SshError::ConnectionFailed(error.to_string())
    }
}

/// Tauri 管理的全局 SSH 状态。
///
/// 连接、会话池和异步任务表均使用共享锁，保证文件操作、目录统计与终端
/// 可以并行运行，同时在断线时集中清理关联资源。
#[derive(Clone, Default)]
pub struct SshState {
    /// 已保存的连接配置及其连接标记。
    pub connections: Arc<RwLock<HashMap<String, SshConnection>>>,
    /// 已认证的 SSH 会话池，按连接 ID 复用。
    pub connection_pool: Arc<RwLock<HashMap<String, Arc<Mutex<Session>>>>>,
    /// 用于向前端发送 Tauri 事件的应用句柄。
    pub app_handle: Arc<Mutex<Option<AppHandle>>>,
    /// 已请求取消的文件传输 ID 集合。
    pub cancelled_transfers: Arc<Mutex<HashSet<String>>>,
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
    /// 当前占用传输并发名额的任务数。
    pub active_transfers: Arc<AtomicUsize>,
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
}

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
    /// 本机文件的绝对路径。
    local_path: PathBuf,
    /// 相对于上传根目录的远程目标路径。
    relative_path: PathBuf,
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
}

/// 预扫描得到的文件夹下载目录、文件和总字节数。
struct FolderDownloadPlan {
    /// 需要创建的本地目录列表。
    directories: Vec<PathBuf>,
    /// 待下载的远程普通文件及相对路径。
    files: Vec<FolderDownloadFile>,
    /// 计划中所有文件的总字节数。
    total_bytes: u64,
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
    transfer_id: &'a str,
    overwrite: bool,
}

// 文件夹传输进度的完整快照，统一承载事件所需的数据字段。
struct FolderTransferProgress<'a> {
    event: &'a str,
    transfer_id: &'a str,
    connection_id: &'a str,
    file_name: &'a str,
    file_index: usize,
    file_total: usize,
    current: u64,
    total: u64,
    completed_bytes: u64,
    total_bytes: u64,
}

/// 完成 TCP/SSH 握手后等待主机指纹确认的会话结果。
struct OpenSession {
    session: Session,
    host_key: HostKeyInfo,
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
    write_lock: Mutex<()>,
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

impl DirectorySizeScan {
    /// 创建包含根目录的初始扫描任务。
    fn new(remote_path: &str, cancellation: Arc<AtomicBool>, wake: Arc<Condvar>) -> Self {
        let mut pending = VecDeque::new();
        pending.push_back((PathBuf::from(remote_path), true));
        Self {
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
    let mut session =
        Session::new().map_err(|error| SshError::ConnectionFailed(error.to_string()))?;
    session.set_tcp_stream(tcp);
    session
        .handshake()
        .map_err(|error| SshError::HandshakeFailed(error.to_string()))?;
    session.set_keepalive(true, KEEPALIVE_INTERVAL_SECS);
    let host_key = host_key_info(&session)?;
    Ok(OpenSession { session, host_key })
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
        Some(expected) if expected.eq_ignore_ascii_case(&host_key.fingerprint) => Ok(()),
        Some(expected) => Err(SshError::HostKeyMismatch {
            expected: expected.to_string(),
            actual: host_key.fingerprint.clone(),
        }),
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
    let columns = if columns == 0 {
        DEFAULT_TERMINAL_COLUMNS
    } else {
        columns.clamp(40, 240)
    };
    let rows = if rows == 0 {
        DEFAULT_TERMINAL_ROWS
    } else {
        rows.clamp(10, 100)
    };
    (columns, rows)
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
        if let Ok(mut channel) = session.channel.lock() {
            let _ = channel.close();
        }
    }
}

/// 关闭某条连接下的全部 PTY，通常在断线或断开连接时调用。
fn close_terminals_for_connection(state: &SshState, connection_id: &str) {
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

/// 为终端事件补充终端 ID 后发送到前端。
fn emit_terminal_event(
    app_handle: &Arc<Mutex<Option<AppHandle>>>,
    event: &str,
    terminal_id: &str,
    payload: serde_json::Value,
) {
    let mut payload = payload;
    if let Some(object) = payload.as_object_mut() {
        object.insert(
            "terminalId".to_string(),
            serde_json::Value::String(terminal_id.to_string()),
        );
    }
    emit_event(app_handle, event, payload);
}

/// 合并可能跨读取边界的 UTF-8 字节，并发送终端输出事件。
fn emit_terminal_bytes(
    app_handle: &Arc<Mutex<Option<AppHandle>>>,
    terminal_id: &str,
    pending: &mut Vec<u8>,
    bytes: &[u8],
) {
    pending.extend_from_slice(bytes);
    let bytes = std::mem::take(pending);
    match String::from_utf8(bytes) {
        Ok(data) => emit_terminal_event(
            app_handle,
            "ssh-terminal-data",
            terminal_id,
            json!({ "data": data }),
        ),
        Err(error) => {
            let utf8_error = error.utf8_error();
            let bytes = error.into_bytes();
            let valid_up_to = utf8_error.valid_up_to();
            if valid_up_to > 0 {
                let data = String::from_utf8_lossy(&bytes[..valid_up_to]).into_owned();
                emit_terminal_event(
                    app_handle,
                    "ssh-terminal-data",
                    terminal_id,
                    json!({ "data": data }),
                );
            }
            if utf8_error.error_len().is_some() {
                // 非 UTF-8 输出通常来自二进制命令，使用替换字符避免卡住后续终端输出。
                let data = String::from_utf8_lossy(&bytes[valid_up_to..]).into_owned();
                emit_terminal_event(
                    app_handle,
                    "ssh-terminal-data",
                    terminal_id,
                    json!({ "data": data }),
                );
            } else {
                pending.extend_from_slice(&bytes[valid_up_to..]);
            }
        }
    }
}

/// 为终端启动后台读线程，转发输出并处理远程 Shell 退出。
fn spawn_terminal_reader(state: SshState, terminal_id: String, session: Arc<TerminalSession>) {
    let app_handle = Arc::clone(&state.app_handle);
    let terminal_sessions = Arc::clone(&state.terminal_sessions);
    thread::spawn(move || {
        let mut buffer = vec![0_u8; TRANSFER_BUFFER_SIZE];
        let mut pending_utf8 = Vec::new();
        let mut close_reason = "远程 Shell 已退出".to_string();
        let mut connection_error = None;

        loop {
            if session.stop.load(Ordering::Acquire) {
                break;
            }
            let result = session
                .channel
                .lock()
                .map_err(|_| SshError::TerminalFailed("终端会话锁已损坏".to_string()))
                .and_then(|mut channel| {
                    channel
                        .read(&mut buffer)
                        .map_err(|error| SshError::TerminalFailed(error.to_string()))
                });
            match result {
                Ok(0) => {
                    close_reason = "远程 Shell 已退出".to_string();
                    break;
                }
                Ok(size) => {
                    emit_terminal_bytes(
                        &app_handle,
                        &terminal_id,
                        &mut pending_utf8,
                        &buffer[..size],
                    );
                }
                Err(error) => {
                    let message = error.to_string();
                    if message.to_ascii_lowercase().contains("would block") {
                        thread::sleep(TERMINAL_POLL_INTERVAL);
                        continue;
                    }
                    close_reason = "终端连接已断开".to_string();
                    connection_error = Some(message);
                    break;
                }
            }
        }

        if !pending_utf8.is_empty() {
            let data = String::from_utf8_lossy(&pending_utf8).into_owned();
            emit_terminal_event(
                &app_handle,
                "ssh-terminal-data",
                &terminal_id,
                json!({ "data": data }),
            );
        }
        let was_stopped = session.stop.load(Ordering::Acquire);
        if let Some(message) = connection_error {
            emit_terminal_event(
                &app_handle,
                "ssh-terminal-error",
                &terminal_id,
                json!({ "message": message.clone() }),
            );
            if !was_stopped && is_terminal_connection_loss(&message) {
                mark_connection_disconnected(&state, &session.connection_id, close_reason.clone());
            }
        }
        emit_terminal_event(
            &app_handle,
            "ssh-terminal-closed",
            &terminal_id,
            json!({ "reason": close_reason, "expected": was_stopped }),
        );

        let mut sessions = terminal_sessions.write().unwrap();
        if sessions
            .get(&terminal_id)
            .is_some_and(|current| Arc::ptr_eq(current, &session))
        {
            sessions.remove(&terminal_id);
        }
    });
}

/// 在非阻塞 channel 上可靠写入终端输入，带有取消和超时保护。
fn write_terminal_input(session: &Arc<TerminalSession>, data: &[u8]) -> Result<(), SshError> {
    let _write_guard = session
        .write_lock
        .lock()
        .map_err(|_| SshError::TerminalFailed("终端输入锁已损坏".to_string()))?;
    let started_at = Instant::now();
    let mut offset = 0;
    while offset < data.len() {
        if session.stop.load(Ordering::Acquire) {
            return Err(SshError::TerminalNotFound);
        }
        let result = session
            .channel
            .lock()
            .map_err(|_| SshError::TerminalFailed("终端会话锁已损坏".to_string()))
            .and_then(|mut channel| {
                channel
                    .write(&data[offset..])
                    .map_err(|error| SshError::TerminalFailed(error.to_string()))
            });
        match result {
            Ok(0) => return Err(SshError::TerminalFailed("终端输入通道已关闭".to_string())),
            Ok(size) => offset += size,
            Err(error)
                if error
                    .to_string()
                    .to_ascii_lowercase()
                    .contains("would block") =>
            {
                if started_at.elapsed() >= TERMINAL_WRITE_TIMEOUT {
                    return Err(SshError::TerminalFailed("终端输入发送超时".to_string()));
                }
                thread::sleep(TERMINAL_POLL_INTERVAL);
            }
            Err(error) => return Err(error),
        }
    }
    Ok(())
}

/// 判断终端输出错误文本是否表示底层 SSH 连接已经失效。
///
/// # Arguments
///
/// * `message` - 终端读写路径返回的错误文本。
///
/// # Returns
///
/// 若文本匹配连接关闭、网络或超时关键词则返回 `true`。
fn is_terminal_connection_loss(message: &str) -> bool {
    let message = message.to_ascii_lowercase();
    message.contains("socket")
        || message.contains("connection")
        || message.contains("network")
        || message.contains("timed out")
}

/// 向远程 PTY 发送尺寸更新，在 libssh2 EAGAIN 时短暂重试。
fn resize_terminal(
    session: &Arc<TerminalSession>,
    columns: u32,
    rows: u32,
) -> Result<(), SshError> {
    let started_at = Instant::now();
    loop {
        if session.stop.load(Ordering::Acquire) {
            return Err(SshError::TerminalNotFound);
        }
        let result = session
            .channel
            .lock()
            .map_err(|_| SshError::TerminalFailed("终端会话锁已损坏".to_string()))?
            .request_pty_size(columns, rows, None, None);
        match result {
            Ok(()) => return Ok(()),
            Err(error)
                if matches!(error.code(), ErrorCode::Session(LIBSSH2_ERROR_EAGAIN))
                    && started_at.elapsed() < TERMINAL_CONTROL_TIMEOUT =>
            {
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
    let was_connected = state
        .connections
        .write()
        .unwrap()
        .get_mut(id)
        .map(|connection| {
            let was_connected = connection.connected;
            connection.connected = false;
            was_connected
        })
        .unwrap_or(false);

    // 丢弃缓存会话即可关闭已损坏的传输连接；正在进行的传输任务可能仍会持有
    // 自己的 Arc，直到任务结束。
    state.connection_pool.write().unwrap().remove(id);
    cancel_directory_size_tasks_for_connection(state, id);
    remove_directory_size_worker_pool(state, id);
    close_terminals_for_connection(state, id);
    if was_connected {
        emit_event(
            &state.app_handle,
            "ssh-disconnected",
            json!({ "id": id, "reason": reason }),
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
    if is_connection_loss(error) {
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
    if is_io_connection_loss(error) {
        mark_connection_disconnected(state, id, error.to_string());
    }
}

/// 判断重命名错误是否允许回退到删除后重建策略。
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
fn collect_folder_upload_plan(local_root: &Path) -> Result<FolderUploadPlan, SshError> {
    let root_metadata = fs::symlink_metadata(local_root)
        .map_err(|error| SshError::FileOperationFailed(format!("无法读取本地文件夹: {error}")))?;
    if root_metadata.file_type().is_symlink() || !root_metadata.is_dir() {
        return Err(SshError::FileOperationFailed(
            "请选择一个普通本地文件夹，符号链接不支持直接上传".to_string(),
        ));
    }

    let mut plan = FolderUploadPlan {
        directories: Vec::new(),
        files: Vec::new(),
        total_bytes: 0,
        skipped_entries: 0,
    };
    let mut pending_directories = vec![local_root.to_path_buf()];

    while let Some(directory) = pending_directories.pop() {
        let mut entries = fs::read_dir(&directory)
            .map_err(|error| {
                SshError::FileOperationFailed(format!(
                    "无法读取本地文件夹“{}”: {error}",
                    directory.display()
                ))
            })?
            .collect::<Result<Vec<_>, _>>()
            .map_err(|error| {
                SshError::FileOperationFailed(format!(
                    "无法读取本地文件夹“{}”: {error}",
                    directory.display()
                ))
            })?;
        entries.sort_by_key(|entry| entry.file_name());

        for entry in entries {
            let local_path = entry.path();
            let relative_path = local_path
                .strip_prefix(local_root)
                .map_err(|error| {
                    SshError::FileOperationFailed(format!("无法计算本地相对路径: {error}"))
                })?
                .to_path_buf();
            let metadata = fs::symlink_metadata(&local_path).map_err(|error| {
                SshError::FileOperationFailed(format!(
                    "无法读取本地文件“{}”: {error}",
                    local_path.display()
                ))
            })?;

            if metadata.file_type().is_symlink() {
                plan.skipped_entries += 1;
            } else if metadata.is_dir() {
                plan.directories.push(relative_path);
                pending_directories.push(local_path);
            } else if metadata.is_file() {
                let size = metadata.len();
                plan.total_bytes = plan.total_bytes.saturating_add(size);
                plan.files.push(FolderUploadFile {
                    local_path,
                    relative_path,
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
fn collect_folder_download_plan(
    state: &SshState,
    connection_id: &str,
    sftp: &Sftp,
    remote_path: &str,
    transfer_id: &str,
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
        skipped_entries: 0,
    };
    let mut pending = vec![(normalized_root, PathBuf::new())];

    while let Some((directory, relative_directory)) = pending.pop() {
        if is_cancelled(&state.cancelled_transfers, transfer_id) {
            return Err(SshError::TransferCancelled);
        }
        let entries = sftp.readdir(Path::new(&directory)).map_err(|error| {
            mark_ssh_error_if_connection_lost(state, connection_id, &error);
            SshError::FileOperationFailed(format!("读取远程文件夹“{directory}”失败: {error}"))
        })?;

        for (listed_path, _) in entries {
            if is_cancelled(&state.cancelled_transfers, transfer_id) {
                return Err(SshError::TransferCancelled);
            }
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
            let child_stat = match sftp.lstat(Path::new(&child_remote_path)) {
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
            if child_stat.file_type() == ssh2::FileType::Symlink {
                // 创建本地路径时绝不跟随远程链接；即使链接指向目录树外，
                // 也能保证处理计划的安全性。
                plan.skipped_entries = plan.skipped_entries.saturating_add(1);
                continue;
            }

            let relative_path = relative_directory.join(name);
            if child_stat.is_dir() {
                plan.directories.push(relative_path.clone());
                pending.push((child_remote_path, relative_path));
            } else if child_stat.is_file() {
                let size = child_stat.size.unwrap_or(0);
                plan.total_bytes = plan.total_bytes.saturating_add(size);
                plan.files.push(FolderDownloadFile {
                    remote_path: child_remote_path,
                    relative_path,
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

/// 使用兼容性回退策略原子地重命名远程文件。
fn rename_remote_file(
    sftp: &Sftp,
    source_path: &Path,
    target_path: &Path,
    overwrite: bool,
) -> Result<(), ssh2::Error> {
    let preferred_flags = if overwrite {
        RenameFlags::ATOMIC | RenameFlags::OVERWRITE | RenameFlags::NATIVE
    } else {
        RenameFlags::ATOMIC | RenameFlags::NATIVE
    };

    match sftp.rename(source_path, target_path, Some(preferred_flags)) {
        Ok(()) => Ok(()),
        Err(error) if !is_rename_compatibility_error(&error) => Err(error),
        // 某些 SFTP 服务器虽然支持普通覆盖重命名，却会拒绝 ATOMIC/NATIVE 标志。
        // 先仅使用必要标志重试。
        Err(error) if !overwrite => sftp
            .rename(source_path, target_path, Some(RenameFlags::empty()))
            .map_err(|fallback_error| {
                if is_rename_compatibility_error(&fallback_error) {
                    error
                } else {
                    fallback_error
                }
            }),
        Err(error) => match sftp.rename(source_path, target_path, Some(RenameFlags::OVERWRITE)) {
            Ok(()) => Ok(()),
            Err(fallback_error) if !is_rename_compatibility_error(&fallback_error) => {
                Err(fallback_error)
            }
            Err(fallback_error) => {
                if sftp
                    .stat(target_path)
                    .map(|stat| stat.is_dir())
                    .unwrap_or(true)
                {
                    return Err(fallback_error);
                }
                // 较旧的服务器有时完全不支持通过重命名覆盖文件。只有在用户明确要求
                // 覆盖非目录项目时，才使用这个最后的降级方案。
                sftp.unlink(target_path)
                    .and_then(|_| sftp.rename(source_path, target_path, Some(RenameFlags::empty())))
                    .map_err(|fallback_error| {
                        if is_rename_compatibility_error(&fallback_error) {
                            error
                        } else {
                            fallback_error
                        }
                    })
            }
        },
    }
}

/// 获取指定连接的已认证 SSH 会话。
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
    loop {
        if cancellation.load(Ordering::Acquire) {
            let _ = channel.close();
            return Err(SshError::DirectorySizeCancelled);
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
    remote_path: &Path,
) -> Result<Vec<RemoteDeleteTarget>, SshError> {
    // 使用 lstat 构建处理计划，这样指向目录的符号链接会作为链接删除，
    // 不会跟随到用户选择目录之外。
    let mut pending = vec![(
        remote_path.to_path_buf(),
        remote_delete_display_path(remote_path),
    )];
    let mut files = Vec::new();
    let mut directories = Vec::new();

    while let Some((path, display_path)) = pending.pop() {
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

        if !stat.is_dir() {
            files.push(RemoteDeleteTarget {
                path,
                display_path,
                is_directory: false,
            });
            continue;
        }

        directories.push(RemoteDeleteTarget {
            path: path.clone(),
            display_path: display_path.clone(),
            is_directory: true,
        });
        let entries = sftp.readdir(&path).map_err(|error| {
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
    } else if item_total == 0 {
        0
    } else {
        (((item_index.saturating_add(1)).saturating_mul(100)) / item_total).min(100)
    };
    emit_event(
        &state.app_handle,
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
    let plan = collect_remote_delete_plan(state, connection_id, sftp, remote_path)?;
    let file_total = plan.iter().filter(|target| !target.is_directory).count();
    let mut file_index = 0usize;
    let mut cleaning_started = false;

    for target in plan.iter() {
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
        Path::new(remote_path),
        Some(operation_id),
    )
}

/// 确认远程目录存在；根据覆盖策略处理同名项目。
fn ensure_remote_directory(
    state: &SshState,
    connection_id: &str,
    sftp: &Sftp,
    remote_path: &str,
    allow_existing: bool,
) -> Result<(), SshError> {
    match sftp.stat(Path::new(remote_path)) {
        Ok(stat) if stat.is_dir() && allow_existing => Ok(()),
        Ok(stat) if stat.is_dir() => Err(SshError::FileOperationFailed(format!(
            "远程文件夹已存在: {remote_path}"
        ))),
        Ok(_) => Err(SshError::FileOperationFailed(format!(
            "远程路径存在同名文件: {remote_path}"
        ))),
        Err(error) if is_sftp_missing_path(&error) => {
            match sftp.mkdir(Path::new(remote_path), 0o755) {
                Ok(()) => Ok(()),
                Err(mkdir_error) => match sftp.stat(Path::new(remote_path)) {
                    // 其他客户端可能在 stat 和 mkdir 之间创建了目录；
                    // 在已确认合并的情况下可以安全继续。
                    Ok(stat) if stat.is_dir() && allow_existing => Ok(()),
                    Ok(stat) if stat.is_dir() => Err(SshError::FileOperationFailed(format!(
                        "远程文件夹已存在: {remote_path}"
                    ))),
                    Ok(_) => Err(SshError::FileOperationFailed(format!(
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

/// 原子申请文件传输并发名额。
fn transfer_slot(state: &SshState) -> Result<(), SshError> {
    loop {
        let current = state.active_transfers.load(Ordering::Acquire);
        if current >= MAX_CONCURRENT_TRANSFERS {
            return Err(SshError::TransferLimitReached);
        }
        if state
            .active_transfers
            .compare_exchange(current, current + 1, Ordering::AcqRel, Ordering::Relaxed)
            .is_ok()
        {
            return Ok(());
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

/// 查询传输任务是否已收到前端取消请求。
fn is_cancelled(cancelled: &Arc<Mutex<HashSet<String>>>, transfer_id: &str) -> bool {
    cancelled.lock().unwrap().contains(transfer_id)
}

/// 清理传输取消标记并归还并发名额。
fn finish_transfer(state: &SshState, transfer_id: &str) {
    state
        .cancelled_transfers
        .lock()
        .unwrap()
        .remove(transfer_id);
    state.active_transfers.fetch_sub(1, Ordering::AcqRel);
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
pub fn test_sftp_connection(
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

/// 保存或覆盖一条连接配置，并清理同 ID 的旧会话。
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
pub fn add_ssh_connection(
    state: State<SshState>,
    id: String,
    host: String,
    port: u16,
    username: String,
    password: String,
    auth_method: Option<String>,
    host_key_fingerprint: Option<String>,
) -> Result<String, SshError> {
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

    validate_connection(&connection)?;
    close_terminals_for_connection(&state, &id);
    remove_cached_session(&state, &id);
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
pub fn set_ssh_host_key(
    state: State<SshState>,
    id: String,
    fingerprint: String,
) -> Result<bool, SshError> {
    if fingerprint.trim().is_empty() {
        return Err(SshError::HandshakeFailed("主机指纹不能为空".to_string()));
    }
    let mut connections = state.connections.write().unwrap();
    let connection = connections
        .get_mut(&id)
        .ok_or(SshError::ConnectionNotFound)?;
    connection.host_key_fingerprint = Some(fingerprint);
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
pub fn connect_ssh(state: State<SshState>, id: String) -> Result<ConnectResult, SshError> {
    let connection = connection_info(&state, &id, false)?;
    validate_connection(&connection)?;
    close_terminals_for_connection(&state, &id);
    remove_cached_session(&state, &id);
    if let Some(item) = state.connections.write().unwrap().get_mut(&id) {
        item.connected = false;
    }
    let opened = open_session(&connection)?;
    if connection.host_key_fingerprint.is_none() {
        return Ok(ConnectResult {
            connected: false,
            requires_host_key_confirmation: true,
            host_key: opened.host_key,
        });
    }
    verify_host_key(&connection, &opened.host_key)?;
    authenticate(&opened.session, &connection)?;

    state
        .connection_pool
        .write()
        .unwrap()
        .insert(id.clone(), Arc::new(Mutex::new(opened.session)));
    if let Some(item) = state.connections.write().unwrap().get_mut(&id) {
        item.connected = true;
    }

    Ok(ConnectResult {
        connected: true,
        requires_host_key_confirmation: false,
        host_key: opened.host_key,
    })
}

fn remove_cached_session(state: &SshState, id: &str) {
    cancel_directory_size_tasks_for_connection(state, id);
    remove_directory_size_worker_pool(state, id);
    if let Some(session) = state.connection_pool.write().unwrap().remove(id) {
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
pub fn disconnect_ssh(state: State<SshState>, id: String) -> Result<bool, SshError> {
    let _ = connection_info(&state, &id, false)?;
    close_terminals_for_connection(&state, &id);
    remove_cached_session(&state, &id);
    if let Some(connection) = state.connections.write().unwrap().get_mut(&id) {
        connection.connected = false;
    }
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
pub fn check_ssh_connection(state: State<SshState>, id: String) -> Result<bool, SshError> {
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
pub fn remove_ssh_connection(state: State<SshState>, id: String) -> Result<bool, SshError> {
    close_terminals_for_connection(&state, &id);
    remove_cached_session(&state, &id);
    state
        .directory_size_fast_path_support
        .lock()
        .unwrap()
        .remove(&id);
    Ok(state.connections.write().unwrap().remove(&id).is_some())
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
pub fn list_sftp_directory(
    state: State<SshState>,
    id: String,
    remote_path: String,
    show_hidden_files: bool,
) -> Result<Vec<RemoteEntry>, SshError> {
    let sftp = sftp_for(&state, &id)?;
    let entries = sftp.readdir(Path::new(&remote_path)).map_err(|error| {
        mark_ssh_error_if_connection_lost(&state, &id, &error);
        SshError::ReadDirFailed(error.to_string())
    })?;

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
    let entries = sftp.readdir(&directory);
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
    state: SshState,
    id: String,
    connection: SshConnection,
    remote_path: String,
    cancellation: Arc<AtomicBool>,
    wake: Arc<Condvar>,
    pool: Arc<Mutex<DirectorySizeWorkerPool>>,
    show_hidden_files: bool,
) -> Result<RemoteDirectorySize, SshError> {
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

    let state = state.inner().clone();
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
        calculate_sftp_directory_size(
            state_for_task,
            id_for_task,
            connection,
            remote_path_for_task,
            cancellation_for_task,
            wake_for_task,
            worker_pool_for_task,
            show_hidden_files,
        )
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

/// 在文件预览读取过程中向前端发送进度事件。
fn preview_progress(
    state: &SshState,
    connection_id: &str,
    preview_id: Option<&str>,
    current: u64,
    total: u64,
) {
    let Some(preview_id) = preview_id else {
        return;
    };
    let progress = if total == 0 {
        100
    } else {
        ((current.saturating_mul(100)) / total).min(100)
    };
    emit_event(
        &state.app_handle,
        "preview-progress",
        json!({
            "id": connection_id,
            "previewId": preview_id,
            "progress": progress,
            "current": current,
            "total": total
        }),
    );
}

/// 同步分块读取远程预览文件，并限制最大内容大小。
fn read_sftp_file_content(
    state: &SshState,
    id: String,
    remote_path: String,
    preview_id: Option<String>,
) -> Result<Vec<u8>, SshError> {
    let sftp = sftp_for(state, &id)?;
    let mut file = sftp.open(Path::new(&remote_path)).map_err(|error| {
        mark_ssh_error_if_connection_lost(state, &id, &error);
        SshError::FileOperationFailed(error.to_string())
    })?;
    let size = file
        .stat()
        .map_err(|error| {
            mark_ssh_error_if_connection_lost(state, &id, &error);
            SshError::FileOperationFailed(error.to_string())
        })?
        .size
        .unwrap_or(0);
    if size > MAX_PREVIEW_BYTES {
        return Err(SshError::PreviewTooLarge);
    }
    let mut content = Vec::with_capacity(size.min(MAX_PREVIEW_BYTES) as usize);
    let mut reader = file.take(MAX_PREVIEW_BYTES.saturating_add(1));
    let mut buffer = vec![0_u8; TRANSFER_BUFFER_SIZE];
    let mut current = 0_u64;
    preview_progress(state, &id, preview_id.as_deref(), current, size);
    // 分块读取，让界面在 SFTP 读取较慢时仍能持续接收进度事件。
    loop {
        let read = reader.read(&mut buffer).map_err(|error| {
            mark_io_error_if_connection_lost(state, &id, &error);
            SshError::ReadFailed(error.to_string())
        })?;
        if read == 0 {
            break;
        }
        content.extend_from_slice(&buffer[..read]);
        current = current.saturating_add(read as u64);
        if current > MAX_PREVIEW_BYTES {
            return Err(SshError::PreviewTooLarge);
        }
        preview_progress(state, &id, preview_id.as_deref(), current, size);
    }
    preview_progress(state, &id, preview_id.as_deref(), current, size);
    Ok(content)
}

/// 分块读取远程文件内容，供前端预览并发送读取进度事件。
///
/// # Arguments
///
/// * `state` - Tauri 管理的共享 SSH 状态。
/// * `id` - 已建立会话的连接 ID。
/// * `remote_path` - 要读取的远程文件路径。
/// * `preview_id` - 可选的前端预览任务 ID，用于关联进度事件。
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
    id: String,
    remote_path: String,
    preview_id: Option<String>,
) -> Result<Vec<u8>, SshError> {
    let state = state.inner().clone();
    tauri::async_runtime::spawn_blocking(move || {
        read_sftp_file_content(&state, id, remote_path, preview_id)
    })
    .await
    .map_err(|error| SshError::ReadFailed(format!("预览任务失败: {error}")))?
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
pub fn sftp_mkdir(
    state: State<SshState>,
    id: String,
    remote_path: String,
) -> Result<bool, SshError> {
    let sftp = sftp_for(&state, &id)?;
    sftp.mkdir(Path::new(&remote_path), 0o755)
        .map_err(|error| {
            mark_ssh_error_if_connection_lost(&state, &id, &error);
            SshError::FileOperationFailed(error.to_string())
        })?;
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
/// 删除线程成功启动时返回 `Ok(true)`；最终结果通过 `delete-complete` 事件报告。
///
/// # Errors
///
/// 当连接不存在、会话不可用或后台删除任务无法启动时返回错误。
#[tauri::command]
pub fn sftp_delete(
    state: State<SshState>,
    id: String,
    remote_path: String,
    is_directory: bool,
    operation_id: Option<String>,
) -> Result<bool, SshError> {
    let _ = is_directory;
    let session = session_for(&state, &id)?;
    let operation_id = operation_id.unwrap_or_else(|| format!("delete-{}", uuid_fallback()));
    let state_handle = state.inner().clone();
    let connection_id = id.clone();
    let operation_id_for_thread = operation_id.clone();
    thread::spawn(move || {
        let result = run_delete(
            &state_handle,
            &session,
            &connection_id,
            &remote_path,
            &operation_id_for_thread,
        );
        let (success, message) = match result {
            Ok(()) => (true, "删除成功".to_string()),
            Err(error) => (false, error.to_string()),
        };
        emit_event(
            &state_handle.app_handle,
            "delete-complete",
            json!({
                "id": connection_id,
                "operationId": operation_id_for_thread,
                "success": success,
                "message": message
            }),
        );
    });
    Ok(true)
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
pub fn sftp_rename(
    state: State<SshState>,
    id: String,
    source_path: String,
    target_path: String,
    overwrite: Option<bool>,
) -> Result<bool, SshError> {
    let sftp = sftp_for(&state, &id)?;
    rename_remote_file(
        &sftp,
        Path::new(&source_path),
        Path::new(&target_path),
        overwrite.unwrap_or(false),
    )
    .map_err(|error| {
        mark_ssh_error_if_connection_lost(&state, &id, &error);
        SshError::FileOperationFailed(error.to_string())
    })?;
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
pub fn get_sftp_user_home(state: State<SshState>, id: String) -> Result<String, SshError> {
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
/// PTY 创建并开始读取时返回 `Ok(true)`。
///
/// # Errors
///
/// 当终端 ID 为空、连接不可用、PTY 创建失败或后台启动任务失败时返回错误。
#[tauri::command]
pub async fn open_ssh_terminal(
    state: State<'_, SshState>,
    id: String,
    terminal_id: String,
    columns: u32,
    rows: u32,
) -> Result<bool, SshError> {
    if terminal_id.trim().is_empty() {
        return Err(SshError::TerminalFailed("终端标识不能为空".to_string()));
    }
    let connection = connection_info(state.inner(), &id, true)?;
    close_terminal_session(&state.terminal_sessions, &terminal_id);
    let channel = tauri::async_runtime::spawn_blocking(move || {
        open_terminal_channel(&connection, columns, rows)
    })
    .await
    .map_err(|error| SshError::TerminalFailed(format!("终端启动任务失败: {error}")))??;
    let terminal = Arc::new(TerminalSession {
        connection_id: id,
        channel: Arc::new(Mutex::new(channel)),
        stop: Arc::new(AtomicBool::new(false)),
        write_lock: Mutex::new(()),
    });
    state
        .terminal_sessions
        .write()
        .unwrap()
        .insert(terminal_id.clone(), Arc::clone(&terminal));
    spawn_terminal_reader(state.inner().clone(), terminal_id, terminal);
    Ok(true)
}

/// 向远程 PTY 写入用户输入，超过单次上限时拒绝请求。
///
/// # Arguments
///
/// * `state` - Tauri 管理的共享 SSH 状态。
/// * `terminal_id` - 目标终端会话 ID。
/// * `data` - 要写入远程 PTY 的用户输入文本。
///
/// # Returns
///
/// 输入写入成功时返回 `Ok(true)`。
///
/// # Errors
///
/// 当输入超过大小限制、终端不存在或远程写入失败时返回错误。
#[tauri::command]
pub async fn write_ssh_terminal(
    state: State<'_, SshState>,
    terminal_id: String,
    data: String,
) -> Result<bool, SshError> {
    if data.len() > MAX_TERMINAL_INPUT_BYTES {
        return Err(SshError::TerminalInputTooLong);
    }
    let terminal = terminal_session_for(state.inner(), &terminal_id)?;
    tauri::async_runtime::spawn_blocking(move || write_terminal_input(&terminal, data.as_bytes()))
        .await
        .map_err(|error| SshError::TerminalFailed(format!("终端输入任务失败: {error}")))??;
    Ok(true)
}

/// 调整远程 PTY 的行列尺寸。
///
/// # Arguments
///
/// * `state` - Tauri 管理的共享 SSH 状态。
/// * `terminal_id` - 目标终端会话 ID。
/// * `columns` - 请求的终端列数。
/// * `rows` - 请求的终端行数。
///
/// # Returns
///
/// 尺寸调整成功时返回 `Ok(true)`。
///
/// # Errors
///
/// 当终端不存在或远程 PTY 控制请求失败时返回错误。
#[tauri::command]
pub async fn resize_ssh_terminal(
    state: State<'_, SshState>,
    terminal_id: String,
    columns: u32,
    rows: u32,
) -> Result<bool, SshError> {
    let terminal = terminal_session_for(state.inner(), &terminal_id)?;
    let (columns, rows) = normalize_terminal_dimensions(columns, rows);
    tauri::async_runtime::spawn_blocking(move || resize_terminal(&terminal, columns, rows))
        .await
        .map_err(|error| SshError::TerminalFailed(format!("终端调整任务失败: {error}")))??;
    Ok(true)
}

/// 关闭远程 PTY 会话；重复关闭保持成功。
///
/// # Arguments
///
/// * `state` - Tauri 管理的共享 SSH 状态。
/// * `terminal_id` - 要关闭的终端会话 ID。
///
/// # Returns
///
/// 始终返回 `Ok(true)`，保证关闭操作幂等。
///
/// # Errors
///
/// 当终端会话表锁不可用时返回错误。
#[tauri::command]
pub fn close_ssh_terminal(state: State<SshState>, terminal_id: String) -> Result<bool, SshError> {
    close_terminal_session(&state.terminal_sessions, &terminal_id);
    Ok(true)
}

/// 发送单文件上传或下载的进度事件。
fn transfer_progress(
    state: &SshState,
    event: &str,
    transfer_id: &str,
    connection_id: &str,
    current: u64,
    total: u64,
) {
    let progress = if total == 0 {
        100
    } else {
        ((current.saturating_mul(100)) / total).min(100)
    };
    emit_event(
        &state.app_handle,
        event,
        json!({
            "id": connection_id,
            "transferId": transfer_id,
            "progress": progress,
            "current": current,
            "total": total
        }),
    );
}

/// 发送文件夹传输的当前文件和整体进度事件。
fn folder_transfer_progress(state: &SshState, details: &FolderTransferProgress<'_>) {
    let progress = if details.total == 0 {
        100
    } else {
        ((details.current.saturating_mul(100)) / details.total).min(100)
    };
    let overall_progress = if details.total_bytes == 0 {
        if details.file_total == 0 {
            100
        } else {
            ((details.file_index.saturating_add(1).saturating_mul(100)) / details.file_total)
                .min(100) as u64
        }
    } else {
        (((details.completed_bytes.saturating_add(details.current)).saturating_mul(100))
            / details.total_bytes)
            .min(100)
    };
    emit_event(
        &state.app_handle,
        details.event,
        json!({
            "id": details.connection_id,
            "transferId": details.transfer_id,
            "progress": progress,
            "current": details.current,
            "total": details.total,
            "fileName": details.file_name,
            "fileIndex": details.file_index,
            "fileTotal": details.file_total,
            "overallProgress": overall_progress,
            "completedBytes": details.completed_bytes.saturating_add(details.current),
            "totalBytes": details.total_bytes
        }),
    );
}

/// 以临时远程文件写入单个本地文件，成功后再重命名到目标路径。
fn upload_file_to_sftp<F>(
    context: &FileTransferContext<'_>,
    local_path: &Path,
    remote_path: &str,
    mut report_progress: F,
) -> Result<u64, SshError>
where
    F: FnMut(u64, u64),
{
    let state = context.state;
    let connection = context.connection;
    let sftp = context.sftp;
    let transfer_id = context.transfer_id;
    let overwrite = context.overwrite;
    let local_file = File::open(local_path)
        .map_err(|error| SshError::FileOperationFailed(format!("无法打开本地文件: {error}")))?;
    let total = local_file
        .metadata()
        .map_err(|error| SshError::FileOperationFailed(error.to_string()))?
        .len();
    let temporary_path = format!("{remote_path}.portal-part-{transfer_id}");
    let mut remote_file = sftp.create(Path::new(&temporary_path)).map_err(|error| {
        mark_ssh_error_if_connection_lost(state, &connection.id, &error);
        SshError::FileOperationFailed(error.to_string())
    })?;
    let mut reader = BufReader::new(local_file);
    let mut buffer = vec![0u8; TRANSFER_BUFFER_SIZE];
    let mut current = 0u64;
    report_progress(current, total);

    let write_result = (|| -> Result<(), SshError> {
        loop {
            if is_cancelled(&state.cancelled_transfers, transfer_id) {
                return Err(SshError::TransferCancelled);
            }
            let count = reader
                .read(&mut buffer)
                .map_err(|error| SshError::FileOperationFailed(error.to_string()))?;
            if count == 0 {
                break;
            }
            remote_file.write_all(&buffer[..count]).map_err(|error| {
                mark_io_error_if_connection_lost(state, &connection.id, &error);
                SshError::FileOperationFailed(error.to_string())
            })?;
            current += count as u64;
            report_progress(current, total);
        }
        remote_file.flush().map_err(|error| {
            mark_io_error_if_connection_lost(state, &connection.id, &error);
            SshError::FileOperationFailed(error.to_string())
        })?;
        Ok(())
    })();
    drop(remote_file);

    let result = write_result.and_then(|_| {
        rename_remote_file(
            sftp,
            Path::new(&temporary_path),
            Path::new(remote_path),
            overwrite,
        )
        .map_err(|error| {
            mark_ssh_error_if_connection_lost(state, &connection.id, &error);
            SshError::FileOperationFailed(error.to_string())
        })
    });

    if result.is_err() {
        let _ = sftp.unlink(Path::new(&temporary_path));
    }
    result.map(|_| total)
}

/// 创建 SFTP 会话并执行单文件上传。
fn run_upload(
    state: &SshState,
    connection: &SshConnection,
    session: &Arc<Mutex<Session>>,
    transfer_id: &str,
    local_path: &str,
    remote_path: &str,
    overwrite: bool,
) -> Result<String, SshError> {
    let session = session
        .lock()
        .map_err(|_| SshError::SftpFailed("会话锁已损坏".to_string()))?;
    let sftp = session.sftp().map_err(|error| {
        mark_ssh_error_if_connection_lost(state, &connection.id, &error);
        SshError::SftpFailed(error.to_string())
    })?;
    drop(session);

    let transfer_context = FileTransferContext {
        state,
        connection,
        sftp: &sftp,
        transfer_id,
        overwrite,
    };
    upload_file_to_sftp(
        &transfer_context,
        Path::new(local_path),
        remote_path,
        |current, total| {
            transfer_progress(
                state,
                "upload-progress",
                transfer_id,
                &connection.id,
                current,
                total,
            );
        },
    )
    .map(|_| "上传成功".to_string())
}

/// 按预扫描计划创建远程目录并递归上传本地文件夹。
fn run_upload_directory(
    state: &SshState,
    connection: &SshConnection,
    session: &Arc<Mutex<Session>>,
    transfer_id: &str,
    local_path: &str,
    remote_path: &str,
    overwrite: bool,
) -> Result<String, SshError> {
    let plan = collect_folder_upload_plan(Path::new(local_path))?;
    if is_cancelled(&state.cancelled_transfers, transfer_id) {
        return Err(SshError::TransferCancelled);
    }

    let session = session
        .lock()
        .map_err(|_| SshError::SftpFailed("会话锁已损坏".to_string()))?;
    let sftp = session.sftp().map_err(|error| {
        mark_ssh_error_if_connection_lost(state, &connection.id, &error);
        SshError::SftpFailed(error.to_string())
    })?;
    drop(session);

    ensure_remote_directory(state, &connection.id, &sftp, remote_path, overwrite)?;
    let transfer_context = FileTransferContext {
        state,
        connection,
        sftp: &sftp,
        transfer_id,
        overwrite,
    };
    for relative_path in &plan.directories {
        if is_cancelled(&state.cancelled_transfers, transfer_id) {
            return Err(SshError::TransferCancelled);
        }
        let remote_directory = join_remote_path(remote_path, relative_path)?;
        ensure_remote_directory(state, &connection.id, &sftp, &remote_directory, true).map_err(
            |error| {
                SshError::FileOperationFailed(format!(
                    "创建远程文件夹“{}”失败: {error}",
                    display_relative_path(relative_path)
                ))
            },
        )?;
    }

    let file_total = plan.files.len();
    let mut completed_bytes = 0u64;
    for (file_index, file) in plan.files.iter().enumerate() {
        if is_cancelled(&state.cancelled_transfers, transfer_id) {
            return Err(SshError::TransferCancelled);
        }
        let remote_file_path = join_remote_path(remote_path, &file.relative_path)?;
        let display_path = display_relative_path(&file.relative_path);
        let uploaded_size = upload_file_to_sftp(
            &transfer_context,
            &file.local_path,
            &remote_file_path,
            |current, total| {
                folder_transfer_progress(
                    state,
                    &FolderTransferProgress {
                        event: "upload-progress",
                        transfer_id,
                        connection_id: &connection.id,
                        file_name: &display_path,
                        file_index,
                        file_total,
                        current,
                        total,
                        completed_bytes,
                        total_bytes: plan.total_bytes,
                    },
                );
            },
        )
        .map_err(|error| {
            if matches!(&error, SshError::TransferCancelled) {
                error
            } else {
                SshError::FileOperationFailed(format!("上传“{display_path}”失败: {error}"))
            }
        })?;
        completed_bytes = completed_bytes.saturating_add(uploaded_size);
    }

    let skipped_note = if plan.skipped_entries == 0 {
        String::new()
    } else {
        format!("，已跳过 {} 个符号链接或特殊文件", plan.skipped_entries)
    };
    if file_total == 0 {
        Ok(format!(
            "文件夹上传成功：已创建 {} 个文件夹{}",
            plan.directories.len().saturating_add(1),
            skipped_note
        ))
    } else {
        Ok(format!(
            "文件夹上传成功：{} 个文件{}",
            file_total, skipped_note
        ))
    }
}

/// 下载单个远程文件到本地临时文件，成功后原子替换目标。
fn download_file_to_local<F>(
    context: &FileTransferContext<'_>,
    remote_path: &str,
    target: &Path,
    mut report_progress: F,
) -> Result<u64, SshError>
where
    F: FnMut(u64, u64),
{
    let state = context.state;
    let connection = context.connection;
    let sftp = context.sftp;
    let transfer_id = context.transfer_id;
    let overwrite = context.overwrite;
    if let Ok(metadata) = fs::symlink_metadata(target) {
        if metadata.file_type().is_symlink() {
            return Err(SshError::FileOperationFailed(
                "本地目标路径是符号链接，不支持直接覆盖".to_string(),
            ));
        }
        if metadata.is_dir() {
            return Err(SshError::FileOperationFailed(
                "本地目标路径是文件夹，无法保存文件".to_string(),
            ));
        }
        if !overwrite {
            return Err(SshError::FileOperationFailed(
                "本地目标文件已存在".to_string(),
            ));
        }
    }

    let mut remote_file = sftp.open(Path::new(remote_path)).map_err(|error| {
        mark_ssh_error_if_connection_lost(state, &connection.id, &error);
        SshError::FileOperationFailed(error.to_string())
    })?;
    let total = remote_file
        .stat()
        .map_err(|error| {
            mark_ssh_error_if_connection_lost(state, &connection.id, &error);
            SshError::FileOperationFailed(error.to_string())
        })?
        .size
        .unwrap_or(0);
    if let Some(parent) = target.parent() {
        fs::create_dir_all(parent)
            .map_err(|error| SshError::FileOperationFailed(error.to_string()))?;
    }
    let target_name = target
        .file_name()
        .map(|name| name.to_string_lossy().to_string())
        .unwrap_or_else(|| "download".to_string());
    let temporary_path = target.with_file_name(format!("{target_name}.portal-part-{transfer_id}"));
    let local_file = File::create(&temporary_path)
        .map_err(|error| SshError::FileOperationFailed(format!("无法创建本地临时文件: {error}")))?;
    let mut writer = BufWriter::new(local_file);
    let mut buffer = vec![0u8; TRANSFER_BUFFER_SIZE];
    let mut current = 0u64;
    report_progress(current, total);

    let result = (|| -> Result<(), SshError> {
        loop {
            if is_cancelled(&state.cancelled_transfers, transfer_id) {
                return Err(SshError::TransferCancelled);
            }
            let count = remote_file.read(&mut buffer).map_err(|error| {
                mark_io_error_if_connection_lost(state, &connection.id, &error);
                SshError::FileOperationFailed(error.to_string())
            })?;
            if count == 0 {
                break;
            }
            writer
                .write_all(&buffer[..count])
                .map_err(|error| SshError::FileOperationFailed(error.to_string()))?;
            current = current.saturating_add(count as u64);
            report_progress(current, total);
        }
        writer
            .flush()
            .map_err(|error| SshError::FileOperationFailed(error.to_string()))?;
        drop(writer);
        if overwrite && target.exists() {
            fs::remove_file(target)
                .map_err(|error| SshError::FileOperationFailed(error.to_string()))?;
        }
        fs::rename(&temporary_path, target)
            .map_err(|error| SshError::FileOperationFailed(error.to_string()))?;
        Ok(())
    })();

    if result.is_err() {
        let _ = fs::remove_file(&temporary_path);
    }
    result.map(|_| total)
}

/// 创建 SFTP 会话并执行单文件下载。
fn run_download(
    state: &SshState,
    connection: &SshConnection,
    session: &Arc<Mutex<Session>>,
    transfer_id: &str,
    remote_path: &str,
    local_path: &str,
    overwrite: bool,
) -> Result<String, SshError> {
    let session = session
        .lock()
        .map_err(|_| SshError::SftpFailed("会话锁已损坏".to_string()))?;
    let sftp = session.sftp().map_err(|error| {
        mark_ssh_error_if_connection_lost(state, &connection.id, &error);
        SshError::SftpFailed(error.to_string())
    })?;
    drop(session);
    let transfer_context = FileTransferContext {
        state,
        connection,
        sftp: &sftp,
        transfer_id,
        overwrite,
    };
    download_file_to_local(
        &transfer_context,
        remote_path,
        Path::new(local_path),
        |current, total| {
            transfer_progress(
                state,
                "download-progress",
                transfer_id,
                &connection.id,
                current,
                total,
            );
        },
    )
    .map(|_| "下载成功".to_string())
}

/// 按预扫描计划创建本地目录并递归下载远程文件夹。
fn run_download_directory(
    state: &SshState,
    connection: &SshConnection,
    session: &Arc<Mutex<Session>>,
    transfer_id: &str,
    remote_path: &str,
    local_path: &str,
    overwrite: bool,
) -> Result<String, SshError> {
    let target_root = PathBuf::from(local_path);
    if let Ok(metadata) = fs::symlink_metadata(&target_root) {
        if metadata.file_type().is_symlink() {
            return Err(SshError::FileOperationFailed(
                "本地目标文件夹是符号链接，不支持直接覆盖".to_string(),
            ));
        }
        if !metadata.is_dir() {
            return Err(SshError::FileOperationFailed(
                "本地目标路径已存在且不是文件夹".to_string(),
            ));
        }
        if !overwrite {
            return Err(SshError::FileOperationFailed(
                "本地目标文件夹已存在".to_string(),
            ));
        }
    }

    let session = session
        .lock()
        .map_err(|_| SshError::SftpFailed("会话锁已损坏".to_string()))?;
    let sftp = session.sftp().map_err(|error| {
        mark_ssh_error_if_connection_lost(state, &connection.id, &error);
        SshError::SftpFailed(error.to_string())
    })?;
    drop(session);

    let plan =
        collect_folder_download_plan(state, &connection.id, &sftp, remote_path, transfer_id)?;
    if is_cancelled(&state.cancelled_transfers, transfer_id) {
        return Err(SshError::TransferCancelled);
    }
    fs::create_dir_all(&target_root)
        .map_err(|error| SshError::FileOperationFailed(format!("无法创建本地文件夹: {error}")))?;
    let transfer_context = FileTransferContext {
        state,
        connection,
        sftp: &sftp,
        transfer_id,
        overwrite,
    };
    for relative_path in &plan.directories {
        if is_cancelled(&state.cancelled_transfers, transfer_id) {
            return Err(SshError::TransferCancelled);
        }
        fs::create_dir_all(target_root.join(relative_path)).map_err(|error| {
            SshError::FileOperationFailed(format!(
                "无法创建本地文件夹“{}”: {error}",
                display_relative_path(relative_path)
            ))
        })?;
    }

    let file_total = plan.files.len();
    let mut completed_bytes = 0u64;
    for (file_index, file) in plan.files.iter().enumerate() {
        if is_cancelled(&state.cancelled_transfers, transfer_id) {
            return Err(SshError::TransferCancelled);
        }
        let display_path = display_relative_path(&file.relative_path);
        let target = target_root.join(&file.relative_path);
        let downloaded_size = download_file_to_local(
            &transfer_context,
            &file.remote_path,
            &target,
            |current, total| {
                folder_transfer_progress(
                    state,
                    &FolderTransferProgress {
                        event: "download-progress",
                        transfer_id,
                        connection_id: &connection.id,
                        file_name: &display_path,
                        file_index,
                        file_total,
                        current,
                        total,
                        completed_bytes,
                        total_bytes: plan.total_bytes,
                    },
                );
            },
        )
        .map_err(|error| {
            if matches!(&error, SshError::TransferCancelled) {
                error
            } else {
                SshError::FileOperationFailed(format!("下载“{display_path}”失败: {error}"))
            }
        })?;
        completed_bytes = completed_bytes.saturating_add(downloaded_size);
    }

    let skipped_note = if plan.skipped_entries == 0 {
        String::new()
    } else {
        format!("，已跳过 {} 个符号链接或特殊文件", plan.skipped_entries)
    };
    if file_total == 0 {
        Ok(format!(
            "文件夹下载成功：已创建 {} 个文件夹{}",
            plan.directories.len().saturating_add(1),
            skipped_note
        ))
    } else {
        Ok(format!(
            "文件夹下载成功：{} 个文件{}",
            file_total, skipped_note
        ))
    }
}

/// 后台上传单个文件，并通过 `upload-progress`/`upload-complete` 事件报告状态。
///
/// # Arguments
///
/// * `state` - Tauri 管理的共享 SSH 状态。
/// * `id` - 已建立会话的连接 ID。
/// * `local_path` - 要上传的本地文件路径。
/// * `remote_path` - 目标远程文件路径。
/// * `transfer_id` - 可选的传输任务 ID；省略时由后端生成。
/// * `overwrite` - 是否覆盖已有远程文件；省略时为 `false`。
///
/// # Returns
///
/// 返回表示后台任务已经启动的消息；实际结果通过传输事件报告。
///
/// # Errors
///
/// 当连接不可用、传输并发达到上限或后台上传任务无法启动时返回错误。
#[tauri::command]
pub fn scp_upload(
    state: State<SshState>,
    id: String,
    local_path: String,
    remote_path: String,
    transfer_id: Option<String>,
    overwrite: Option<bool>,
) -> Result<String, SshError> {
    let transfer_id = transfer_id.unwrap_or_else(|| format!("upload-{}", uuid_fallback()));
    let connection = connection_info(&state, &id, true)?;
    let session = session_for(&state, &id)?;
    transfer_slot(&state)?;
    let state_handle = state.inner().clone();
    let transfer_id_for_thread = transfer_id.clone();
    thread::spawn(move || {
        let result = run_upload(
            &state_handle,
            &connection,
            &session,
            &transfer_id_for_thread,
            &local_path,
            &remote_path,
            overwrite.unwrap_or(false),
        );
        let cancelled = matches!(result, Err(SshError::TransferCancelled));
        emit_event(
            &state_handle.app_handle,
            "upload-complete",
            json!({
                "id": connection.id,
                "transferId": transfer_id_for_thread,
                "success": result.is_ok(),
                "cancelled": cancelled,
                "message": result.unwrap_or_else(|error| error.to_string())
            }),
        );
        finish_transfer(&state_handle, &transfer_id_for_thread);
    });
    Ok("上传已开始".to_string())
}

/// 后台递归上传目录，按文件和总字节数报告进度。
///
/// # Arguments
///
/// * `state` - Tauri 管理的共享 SSH 状态。
/// * `id` - 已建立会话的连接 ID。
/// * `local_path` - 要上传的本地目录路径。
/// * `remote_path` - 目标远程目录路径。
/// * `transfer_id` - 可选的传输任务 ID；省略时由后端生成。
/// * `overwrite` - 是否覆盖已有远程文件；省略时为 `false`。
///
/// # Returns
///
/// 返回表示后台任务已经启动的消息；实际结果通过传输事件报告。
///
/// # Errors
///
/// 当连接不可用、本地目录无法读取、传输并发达到上限或后台任务无法启动时返回错误。
#[tauri::command]
pub fn sftp_upload_directory(
    state: State<SshState>,
    id: String,
    local_path: String,
    remote_path: String,
    transfer_id: Option<String>,
    overwrite: Option<bool>,
) -> Result<String, SshError> {
    let transfer_id = transfer_id.unwrap_or_else(|| format!("folder-upload-{}", uuid_fallback()));
    let connection = connection_info(&state, &id, true)?;
    let session = session_for(&state, &id)?;
    transfer_slot(&state)?;
    let state_handle = state.inner().clone();
    let transfer_id_for_thread = transfer_id.clone();
    let overwrite = overwrite.unwrap_or(false);
    thread::spawn(move || {
        let result = run_upload_directory(
            &state_handle,
            &connection,
            &session,
            &transfer_id_for_thread,
            &local_path,
            &remote_path,
            overwrite,
        );
        let cancelled = matches!(result, Err(SshError::TransferCancelled));
        emit_event(
            &state_handle.app_handle,
            "upload-complete",
            json!({
                "id": connection.id,
                "transferId": transfer_id_for_thread,
                "success": result.is_ok(),
                "cancelled": cancelled,
                "message": result.unwrap_or_else(|error| error.to_string())
            }),
        );
        finish_transfer(&state_handle, &transfer_id_for_thread);
    });
    Ok("文件夹上传已开始".to_string())
}

/// 后台下载单个文件，并通过 `download-progress`/`download-complete` 事件报告状态。
///
/// # Arguments
///
/// * `state` - Tauri 管理的共享 SSH 状态。
/// * `id` - 已建立会话的连接 ID。
/// * `remote_path` - 要下载的远程文件路径。
/// * `local_path` - 目标本地文件路径。
/// * `transfer_id` - 可选的传输任务 ID；省略时由后端生成。
/// * `overwrite` - 是否覆盖已有本地文件；省略时为 `false`。
///
/// # Returns
///
/// 返回表示后台任务已经启动的消息；实际结果通过传输事件报告。
///
/// # Errors
///
/// 当连接不可用、传输并发达到上限或后台下载任务无法启动时返回错误。
#[tauri::command]
pub fn scp_download(
    state: State<SshState>,
    id: String,
    remote_path: String,
    local_path: String,
    transfer_id: Option<String>,
    overwrite: Option<bool>,
) -> Result<String, SshError> {
    let transfer_id = transfer_id.unwrap_or_else(|| format!("download-{}", uuid_fallback()));
    let connection = connection_info(&state, &id, true)?;
    let session = session_for(&state, &id)?;
    transfer_slot(&state)?;
    let state_handle = state.inner().clone();
    let transfer_id_for_thread = transfer_id.clone();
    let overwrite = overwrite.unwrap_or(false);
    thread::spawn(move || {
        let result = run_download(
            &state_handle,
            &connection,
            &session,
            &transfer_id_for_thread,
            &remote_path,
            &local_path,
            overwrite,
        );
        let cancelled = matches!(result, Err(SshError::TransferCancelled));
        emit_event(
            &state_handle.app_handle,
            "download-complete",
            json!({
                "id": connection.id,
                "transferId": transfer_id_for_thread,
                "success": result.is_ok(),
                "cancelled": cancelled,
                "message": result.unwrap_or_else(|error| error.to_string())
            }),
        );
        finish_transfer(&state_handle, &transfer_id_for_thread);
    });
    Ok("下载已开始".to_string())
}

/// 后台递归下载远程目录，必要时创建本地目录结构。
///
/// # Arguments
///
/// * `state` - Tauri 管理的共享 SSH 状态。
/// * `id` - 已建立会话的连接 ID。
/// * `remote_path` - 要下载的远程目录路径。
/// * `local_path` - 目标本地目录路径。
/// * `transfer_id` - 可选的传输任务 ID；省略时由后端生成。
/// * `overwrite` - 是否覆盖已有本地文件；省略时为 `false`。
///
/// # Returns
///
/// 返回表示后台任务已经启动的消息；实际结果通过传输事件报告。
///
/// # Errors
///
/// 当连接不可用、远程目录无法读取、本地目录无法创建、传输并发达到上限或后台任务无法启动时返回错误。
#[tauri::command]
pub fn sftp_download_directory(
    state: State<SshState>,
    id: String,
    remote_path: String,
    local_path: String,
    transfer_id: Option<String>,
    overwrite: Option<bool>,
) -> Result<String, SshError> {
    let transfer_id = transfer_id.unwrap_or_else(|| format!("folder-download-{}", uuid_fallback()));
    let connection = connection_info(&state, &id, true)?;
    let session = session_for(&state, &id)?;
    transfer_slot(&state)?;
    let state_handle = state.inner().clone();
    let transfer_id_for_thread = transfer_id.clone();
    let overwrite = overwrite.unwrap_or(false);
    thread::spawn(move || {
        let result = run_download_directory(
            &state_handle,
            &connection,
            &session,
            &transfer_id_for_thread,
            &remote_path,
            &local_path,
            overwrite,
        );
        let cancelled = matches!(result, Err(SshError::TransferCancelled));
        emit_event(
            &state_handle.app_handle,
            "download-complete",
            json!({
                "id": connection.id,
                "transferId": transfer_id_for_thread,
                "success": result.is_ok(),
                "cancelled": cancelled,
                "message": result.unwrap_or_else(|error| error.to_string())
            }),
        );
        finish_transfer(&state_handle, &transfer_id_for_thread);
    });
    Ok("文件夹下载已开始".to_string())
}

/// 标记传输任务取消；实际线程在下一个安全检查点退出。
///
/// # Arguments
///
/// * `state` - Tauri 管理的共享 SSH 状态。
/// * `transfer_id` - 要取消的上传或下载任务 ID。
///
/// # Returns
///
/// 取消标记写入成功时返回 `Ok(true)`；任务是否已经结束由传输完成事件决定。
///
/// # Errors
///
/// 当取消状态锁不可用时返回错误。
#[tauri::command]
pub fn cancel_transfer(state: State<SshState>, transfer_id: String) -> Result<bool, SshError> {
    state
        .cancelled_transfers
        .lock()
        .unwrap()
        .insert(transfer_id);
    Ok(true)
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

        let plan = collect_folder_upload_plan(&root).unwrap();
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
