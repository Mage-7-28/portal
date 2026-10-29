//! 文件任务独占的 SSH 会话。调度名额由任务状态机负责，空闲资源按身份隔离。
use super::{
    authenticate, host_key_info, same_connection_configuration, verify_host_key, SshConnection,
    SshError, SshState, DEFAULT_TIMEOUT_MS, KEEPALIVE_INTERVAL_SECS,
};
use crate::sftp_commit::PosixRenameClient;
use ssh2::{Session, Sftp};
use std::io::ErrorKind;
use std::net::{Shutdown, SocketAddr, TcpStream};
use std::path::Path;
use std::sync::atomic::Ordering;
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

const IDLE_TTL: Duration = Duration::from_secs(60);
const MAX_IDLE_TOTAL: usize = 8;
const MAX_IDLE_PER_HOST: usize = 4;
const REUSE_PROBE_TIMEOUT_MS: u32 = 2_000;

pub(super) struct IdleTransferSession {
    connection: SshConnection,
    generation: u64,
    host: String,
    endpoint: SocketAddr,
    worker_id: String,
    session: Arc<Mutex<Session>>,
    sftp: Option<Arc<Sftp>>,
    rename_client: Arc<Mutex<Option<PosixRenameClient>>>,
    socket: TcpStream,
    last_used: Instant,
}
impl IdleTransferSession {
    pub(super) fn connection_id(&self) -> &str {
        &self.connection.id
    }
    pub(super) fn is_fresh(&self) -> bool {
        self.last_used.elapsed() < IDLE_TTL
    }
    fn matches(
        &self,
        connection: &SshConnection,
        generation: u64,
        endpoint: SocketAddr,
        worker_id: &str,
    ) -> bool {
        self.endpoint == endpoint
            && self.worker_id == worker_id
            && same_pool_identity(&self.connection, self.generation, connection, generation)
    }

    fn resources_are_exclusive(&self) -> bool {
        Arc::strong_count(&self.session) == 1
            && self
                .sftp
                .as_ref()
                .is_none_or(|sftp| Arc::strong_count(sftp) == 1)
            && Arc::strong_count(&self.rename_client) == 1
    }
}
pub(super) struct TransferSessionLease {
    state: SshState,
    entry: Option<IdleTransferSession>,
    reusable: bool,
    task_id: String,
    worker_id: String,
}
pub(super) fn server_key(endpoint: SocketAddr) -> String {
    match endpoint {
        SocketAddr::V6(address) => match address.ip().to_ipv4_mapped() {
            Some(ip) => ip.to_string(),
            None if address.scope_id() == 0 => address.ip().to_string(),
            None => format!("{}%{}", address.ip(), address.scope_id()),
        },
        SocketAddr::V4(address) => address.ip().to_string(),
    }
}

fn same_pool_identity(
    idle: &SshConnection,
    idle_generation: u64,
    requested: &SshConnection,
    generation: u64,
) -> bool {
    idle.id == requested.id
        && idle_generation == generation
        && same_connection_configuration(idle, requested)
}

fn idle_capacity_available<'a>(hosts: impl Iterator<Item = &'a str>, host: &str) -> bool {
    let mut total = 0;
    let mut same_host = 0;
    for idle_host in hosts {
        total += 1;
        if idle_host == host {
            same_host += 1;
        }
    }
    total < MAX_IDLE_TOTAL && same_host < MAX_IDLE_PER_HOST
}

/// 在连接失效流程的代次锁下，同时读取任务代次和已验证对端。
fn capture_checkout_endpoint(
    state: &SshState,
    connection_id: &str,
    task_id: &str,
) -> Result<(u64, SocketAddr), SshError> {
    let generations = state.connection_generations.lock().unwrap();
    let endpoints = state.connection_endpoints.lock().unwrap();
    let generation = state
        .tasks
        .generation(task_id)
        .ok_or(SshError::TransferCancelled)?;
    if generations.get(connection_id).copied().unwrap_or(0) != generation
        || state.tasks.cancelled(task_id)
    {
        return Err(SshError::TransferCancelled);
    }
    let endpoint = endpoints
        .get(connection_id)
        .copied()
        .ok_or(SshError::ConnectionNotFound)?;
    Ok((generation, endpoint))
}

/// 只在候选会话完成只读往返后交付；失败或取消时先解除取消句柄。
fn checkout_cached_candidate_with(
    attach: impl FnOnce() -> Result<(), SshError>,
    cancelled: impl Fn() -> bool,
    roundtrip: impl FnOnce() -> bool,
    detach: impl FnOnce() -> bool,
) -> Result<bool, SshError> {
    attach()?;
    if !cancelled() && roundtrip() && !cancelled() {
        return Ok(true);
    }
    if detach() || cancelled() {
        Err(SshError::TransferCancelled)
    } else {
        Ok(false)
    }
}

/// 包含 SFTP 子会话关闭在内均使用短超时，退出时恢复文件传输超时。
fn with_reuse_probe_timeout<T>(mut set_timeout: impl FnMut(u32), probe: impl FnOnce() -> T) -> T {
    struct RestoreTimeout<F: FnMut(u32)>(F);
    impl<F: FnMut(u32)> Drop for RestoreTimeout<F> {
        fn drop(&mut self) {
            (self.0)(DEFAULT_TIMEOUT_MS as u32);
        }
    }

    set_timeout(REUSE_PROBE_TIMEOUT_MS);
    let _restore = RestoreTimeout(set_timeout);
    probe()
}

struct CheckoutAttachment<'a> {
    state: &'a SshState,
    task_id: &'a str,
    worker_id: &'a str,
    attached: bool,
}

impl Drop for CheckoutAttachment<'_> {
    fn drop(&mut self) {
        if self.attached {
            self.state
                .tasks
                .detach_worker_socket(self.task_id, self.worker_id);
        }
    }
}

impl TransferSessionLease {
    pub(super) fn checkout(
        state: &SshState,
        connection: &SshConnection,
        task_id: &str,
    ) -> Result<Self, SshError> {
        Self::checkout_for(state, connection, task_id, "")
    }

    pub(super) fn checkout_worker(
        state: &SshState,
        connection: &SshConnection,
        task_id: &str,
        worker_id: &str,
    ) -> Result<Self, SshError> {
        Self::checkout_for(state, connection, task_id, worker_id)
    }

    fn checkout_for(
        state: &SshState,
        connection: &SshConnection,
        task_id: &str,
        worker_id: &str,
    ) -> Result<Self, SshError> {
        let (generation, endpoint) = capture_checkout_endpoint(state, &connection.id, task_id)?;
        let host = server_key(endpoint);
        if state.tasks.cancelled_worker(task_id, worker_id) {
            return Err(SshError::TransferCancelled);
        }
        let mut attachment = CheckoutAttachment {
            state,
            task_id,
            worker_id,
            attached: false,
        };
        let candidate = {
            let mut pool = state.transfer_pool.lock().unwrap();
            pool.retain(IdleTransferSession::is_fresh);
            let found = pool
                .iter()
                .position(|entry| entry.matches(connection, generation, endpoint, worker_id));
            found.map(|index| pool.swap_remove(index))
        };
        let entry = match candidate {
            Some(entry) => {
                let reusable = checkout_cached_candidate_with(
                    || {
                        if !state.tasks.attach_worker_socket(
                            task_id,
                            worker_id,
                            entry.socket.try_clone()?,
                        ) {
                            return Err(SshError::TransferCancelled);
                        }
                        attachment.attached = true;
                        Ok(())
                    },
                    || state.tasks.cancelled_worker(task_id, worker_id),
                    || {
                        // libssh2 的阻塞 API 依靠非阻塞 socket 和自身超时等待。
                        if entry.socket.set_nonblocking(true).is_err() {
                            return false;
                        }
                        let Ok(session) = entry.session.lock() else {
                            return false;
                        };
                        with_reuse_probe_timeout(
                            |timeout| session.set_timeout(timeout),
                            || match entry.sftp.as_ref() {
                                Some(sftp) => sftp.stat(Path::new(".")).is_ok(),
                                None => session
                                    .sftp()
                                    .and_then(|sftp| sftp.stat(Path::new(".")))
                                    .is_ok(),
                            },
                        )
                    },
                    || state.tasks.detach_worker_socket(task_id, worker_id),
                );
                match reusable {
                    Ok(true) => Some(entry),
                    result => {
                        attachment.attached = false;
                        // 失效会话的析构也可能执行协议关闭，先中断其独占 socket。
                        let _ = entry.socket.shutdown(Shutdown::Both);
                        drop(entry);
                        result?;
                        None
                    }
                }
            }
            None => None,
        };
        let entry = match entry {
            Some(entry) => entry,
            None => {
                let tcp =
                    crate::transfer_connect::connect(endpoint, Duration::from_secs(30), || {
                        state.tasks.cancelled_worker(task_id, worker_id)
                    })
                    .map_err(|error| {
                        if error.kind() == ErrorKind::Interrupted {
                            SshError::TransferCancelled
                        } else {
                            SshError::ConnectionFailed(error.to_string())
                        }
                    })?;
                let socket = tcp.try_clone()?;
                if !state
                    .tasks
                    .attach_worker_socket(task_id, worker_id, socket.try_clone()?)
                {
                    return Err(SshError::TransferCancelled);
                }
                attachment.attached = true;
                if state.tasks.cancelled_worker(task_id, worker_id) {
                    return Err(SshError::TransferCancelled);
                }
                // API 仍使用阻塞模式；底层非阻塞以确保各平台应用 libssh2 超时。
                tcp.set_nonblocking(true)?;
                let mut session =
                    Session::new().map_err(|e| SshError::ConnectionFailed(e.to_string()))?;
                session.set_tcp_stream(tcp);
                session.set_timeout(30_000);
                session
                    .handshake()
                    .map_err(|e| SshError::HandshakeFailed(e.to_string()))?;
                verify_host_key(connection, &host_key_info(&session)?)?;
                authenticate(&session, connection)?;
                session.set_keepalive(true, KEEPALIVE_INTERVAL_SECS);
                IdleTransferSession {
                    connection: connection.clone(),
                    generation,
                    host,
                    endpoint,
                    worker_id: worker_id.into(),
                    session: Arc::new(Mutex::new(session)),
                    sftp: None,
                    rename_client: Arc::new(Mutex::new(None)),
                    socket,
                    last_used: Instant::now(),
                }
            }
        };
        if state.tasks.cancelled_worker(task_id, worker_id) {
            let _ = entry.socket.shutdown(Shutdown::Both);
            return Err(SshError::TransferCancelled);
        }
        if state
            .connection_generations
            .lock()
            .unwrap()
            .get(&connection.id)
            .copied()
            .unwrap_or(0)
            != generation
        {
            let _ = entry.socket.shutdown(Shutdown::Both);
            return Err(SshError::TransferCancelled);
        }
        if state
            .connection_endpoints
            .lock()
            .unwrap()
            .get(&connection.id)
            .copied()
            != Some(endpoint)
        {
            let _ = entry.socket.shutdown(Shutdown::Both);
            return Err(SshError::TransferCancelled);
        }
        attachment.attached = false;
        state.tasks.worker_connected(task_id);
        Ok(Self {
            state: state.clone(),
            entry: Some(entry),
            reusable: false,
            task_id: task_id.into(),
            worker_id: worker_id.into(),
        })
    }
    pub(super) fn session(&self) -> Arc<Mutex<Session>> {
        self.entry.as_ref().unwrap().session.clone()
    }
    /// 只在独占会话首次使用时初始化 SFTP，之后跨同 worker 的文件复用。
    pub(super) fn sftp(&mut self) -> Result<Arc<Sftp>, SshError> {
        let entry = self.entry.as_mut().unwrap();
        if let Some(sftp) = &entry.sftp {
            return Ok(sftp.clone());
        }
        let session = entry
            .session
            .lock()
            .map_err(|_| SshError::SftpFailed("会话锁已损坏".into()))?;
        let sftp = Arc::new(
            session
                .sftp()
                .map_err(|error| SshError::SftpFailed(error.to_string()))?,
        );
        entry.sftp = Some(sftp.clone());
        Ok(sftp)
    }

    pub(super) fn rename_client(&self) -> Arc<Mutex<Option<PosixRenameClient>>> {
        self.entry.as_ref().unwrap().rename_client.clone()
    }
    pub(super) fn reuse_on_success(&mut self) {
        self.reusable = true;
    }
}
impl Drop for TransferSessionLease {
    fn drop(&mut self) {
        if let Some(mut entry) = self.entry.take() {
            let cancelled = self
                .state
                .tasks
                .detach_worker_socket(&self.task_id, &self.worker_id);
            let generations = self.state.connection_generations.lock().unwrap();
            let generation = generations.get(&entry.connection.id).copied().unwrap_or(0);
            let endpoint = self
                .state
                .connection_endpoints
                .lock()
                .unwrap()
                .get(&entry.connection.id)
                .copied();
            if self.reusable
                && !cancelled
                && generation == entry.generation
                && endpoint == Some(entry.endpoint)
                && entry.resources_are_exclusive()
                && !self.state.runtime_stop.load(Ordering::Acquire)
            {
                entry.last_used = Instant::now();
                let mut pool = self.state.transfer_pool.lock().unwrap();
                pool.retain(IdleTransferSession::is_fresh);
                let duplicate = pool.iter().any(|idle| {
                    idle.matches(
                        &entry.connection,
                        entry.generation,
                        entry.endpoint,
                        &entry.worker_id,
                    )
                });
                if !duplicate
                    && idle_capacity_available(
                        pool.iter().map(|idle| idle.host.as_str()),
                        &entry.host,
                    )
                {
                    pool.push(entry);
                    return;
                }
            }
            // 有外部引用或其他失效条件时不能交给下一个任务，及时中断残留引用。
            let _ = entry.socket.shutdown(Shutdown::Both);
        }
    }
}

#[cfg(test)]
mod tests {
    use super::{
        capture_checkout_endpoint, checkout_cached_candidate_with, idle_capacity_available,
        same_pool_identity, server_key, with_reuse_probe_timeout, IdleTransferSession,
        SshConnection, SshError, SshState, TransferSessionLease,
    };
    use crate::transfer_tasks::TransferTasks;
    use ssh2::Session;
    use std::cell::{Cell, RefCell};
    use std::io::Read;
    use std::net::{SocketAddr, TcpListener, TcpStream};
    use std::sync::{Arc, Mutex};
    use std::time::{Duration, Instant};

    fn connection(host: &str) -> SshConnection {
        SshConnection {
            id: "connection".into(),
            host: host.into(),
            port: 22,
            username: "user".into(),
            auth_method: "password".into(),
            host_key_fingerprint: Some("fingerprint".into()),
            password: "password".into(),
            connected: true,
        }
    }

    fn idle_session(endpoint: SocketAddr, worker_id: &str) -> (IdleTransferSession, TcpStream) {
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let peer = TcpStream::connect(listener.local_addr().unwrap()).unwrap();
        let (socket, _) = listener.accept().unwrap();
        let entry = IdleTransferSession {
            connection: connection("example.com"),
            generation: 7,
            host: server_key(endpoint),
            endpoint,
            worker_id: worker_id.into(),
            session: Arc::new(Mutex::new(Session::new().unwrap())),
            sftp: None,
            rename_client: Arc::new(Mutex::new(None)),
            socket,
            last_used: Instant::now(),
        };
        (entry, peer)
    }

    fn lease_with_entry(
        state: &SshState,
        task_id: &str,
        entry: IdleTransferSession,
    ) -> TransferSessionLease {
        assert!(state.tasks.attach_worker_socket(
            task_id,
            &entry.worker_id,
            entry.socket.try_clone().unwrap()
        ));
        TransferSessionLease {
            state: state.clone(),
            worker_id: entry.worker_id.clone(),
            task_id: task_id.into(),
            entry: Some(entry),
            reusable: true,
        }
    }

    #[test]
    fn cross_batch_reuse_detaches_old_task_before_attaching_new_task() {
        let state = SshState::default();
        let endpoint = "192.0.2.10:22".parse().unwrap();
        state
            .connection_generations
            .lock()
            .unwrap()
            .insert("connection".into(), 7);
        state
            .connection_endpoints
            .lock()
            .unwrap()
            .insert("connection".into(), endpoint);
        state
            .tasks
            .register("window", "old-batch", "connection", 7, "host")
            .unwrap();
        state
            .tasks
            .register("window", "new-batch", "connection", 7, "host")
            .unwrap();
        let old_slot = state.tasks.acquire_worker("old-batch", "w0").unwrap();
        let (entry, mut peer) = idle_session(endpoint, "w0");
        drop(lease_with_entry(&state, "old-batch", entry));
        drop(old_slot);

        let new_slot = state.tasks.acquire_worker("new-batch", "w0").unwrap();
        let entry = {
            let mut pool = state.transfer_pool.lock().unwrap();
            assert_eq!(pool.len(), 1);
            assert!(pool[0].matches(&connection("example.com"), 7, endpoint, "w0"));
            assert!(!pool[0].matches(&connection("example.com"), 8, endpoint, "w0"));
            assert!(!pool[0].matches(
                &connection("example.com"),
                7,
                "192.0.2.11:22".parse().unwrap(),
                "w0"
            ));
            assert!(!pool[0].matches(&connection("example.com"), 7, endpoint, "w1"));
            let mut changed = connection("example.com");
            changed.host_key_fingerprint = Some("changed".into());
            assert!(!pool[0].matches(&changed, 7, endpoint, "w0"));
            pool.swap_remove(0)
        };
        let lease = lease_with_entry(&state, "new-batch", entry);
        state.tasks.cancel("window", "old-batch");
        peer.set_read_timeout(Some(Duration::from_millis(50)))
            .unwrap();
        let mut byte = [0];
        assert!(
            peer.read(&mut byte).is_err(),
            "旧任务的取消不得关闭新任务使用的 socket"
        );
        state.tasks.cancel("window", "new-batch");
        peer.set_read_timeout(Some(Duration::from_secs(1))).unwrap();
        assert_eq!(peer.read(&mut byte).unwrap(), 0);
        drop(lease);
        drop(new_slot);
        assert!(state.transfer_pool.lock().unwrap().is_empty());
    }

    #[test]
    fn escaped_session_or_rename_client_is_never_returned_to_the_pool() {
        for escape_session in [true, false] {
            let state = SshState::default();
            let endpoint = "192.0.2.10:22".parse().unwrap();
            state
                .connection_generations
                .lock()
                .unwrap()
                .insert("connection".into(), 7);
            state
                .connection_endpoints
                .lock()
                .unwrap()
                .insert("connection".into(), endpoint);
            state
                .tasks
                .register("window", "batch", "connection", 7, "host")
                .unwrap();
            let slot = state.tasks.acquire_worker("batch", "w0").unwrap();
            let (entry, mut peer) = idle_session(endpoint, "w0");
            let lease = lease_with_entry(&state, "batch", entry);
            let session = escape_session.then(|| lease.session());
            let rename_client = (!escape_session).then(|| lease.rename_client());
            drop(lease);
            assert!(state.transfer_pool.lock().unwrap().is_empty());
            peer.set_read_timeout(Some(Duration::from_secs(1))).unwrap();
            assert_eq!(peer.read(&mut [0]).unwrap(), 0);
            drop((session, rename_client, slot));
        }
    }

    #[test]
    fn concurrent_batches_do_not_cache_duplicate_stable_worker_keys() {
        let state = SshState::default();
        let endpoint = "192.0.2.10:22".parse().unwrap();
        state
            .connection_generations
            .lock()
            .unwrap()
            .insert("connection".into(), 7);
        state
            .connection_endpoints
            .lock()
            .unwrap()
            .insert("connection".into(), endpoint);
        state
            .tasks
            .register("window", "first", "connection", 7, "host")
            .unwrap();
        state
            .tasks
            .register("window", "second", "connection", 7, "host")
            .unwrap();
        let first_slot = state.tasks.acquire_worker("first", "w0").unwrap();
        let second_slot = state.tasks.acquire_worker("second", "w0").unwrap();
        let (first, _peer1) = idle_session(endpoint, "w0");
        let (second, mut peer2) = idle_session(endpoint, "w0");
        let first_lease = lease_with_entry(&state, "first", first);
        let second_lease = lease_with_entry(&state, "second", second);
        drop(first_lease);
        drop(second_lease);
        assert_eq!(state.transfer_pool.lock().unwrap().len(), 1);
        peer2
            .set_read_timeout(Some(Duration::from_secs(1)))
            .unwrap();
        assert_eq!(peer2.read(&mut [0]).unwrap(), 0);
        drop((first_slot, second_slot));
    }

    #[test]
    fn host_key_groups_verified_peer_across_ports_and_preserves_ipv6_scope() {
        assert_eq!(
            server_key("[2001:db8::1]:22".parse().unwrap()),
            server_key("[2001:0DB8:0:0:0:0:0:1]:22".parse().unwrap())
        );
        assert_eq!(
            server_key("[::1]:22".parse().unwrap()),
            server_key("[::1]:23".parse().unwrap())
        );
        assert_ne!(
            server_key("192.0.2.10:22".parse().unwrap()),
            server_key("192.0.2.11:22".parse().unwrap())
        );
        let address: std::net::Ipv6Addr = "fe80::1".parse().unwrap();
        assert_ne!(
            server_key(SocketAddr::V6(std::net::SocketAddrV6::new(
                address, 22, 0, 1
            ))),
            server_key(SocketAddr::V6(std::net::SocketAddrV6::new(
                address, 22, 0, 2
            )))
        );
    }

    #[test]
    fn physical_host_key_groups_all_ssh_ports() {
        assert_eq!(
            server_key("192.0.2.10:22".parse().unwrap()),
            server_key("192.0.2.10:2222".parse().unwrap())
        );
    }

    #[test]
    fn host_key_unifies_ipv4_and_ipv4_mapped_ipv6_peers() {
        assert_eq!(
            server_key("192.0.2.10:22".parse().unwrap()),
            server_key("[::ffff:192.0.2.10]:22".parse().unwrap())
        );
    }

    #[test]
    fn checkout_rejects_a_failed_protocol_roundtrip_after_attaching_socket() {
        let calls = RefCell::new(Vec::new());
        let result = checkout_cached_candidate_with(
            || {
                calls.borrow_mut().push("attach");
                Ok(())
            },
            || false,
            || {
                calls.borrow_mut().push("roundtrip");
                false
            },
            || {
                calls.borrow_mut().push("detach");
                false
            },
        );
        assert!(matches!(result, Ok(false)));
        assert_eq!(*calls.borrow(), ["attach", "roundtrip", "detach"]);
    }

    #[test]
    fn cancellation_after_attach_skips_roundtrip_and_detaches() {
        let calls = RefCell::new(Vec::new());
        let cancelled = Cell::new(false);
        let result = checkout_cached_candidate_with(
            || {
                calls.borrow_mut().push("attach");
                cancelled.set(true);
                Ok(())
            },
            || cancelled.get(),
            || {
                calls.borrow_mut().push("roundtrip");
                true
            },
            || {
                calls.borrow_mut().push("detach");
                true
            },
        );
        assert!(matches!(result, Err(SshError::TransferCancelled)));
        assert_eq!(*calls.borrow(), ["attach", "detach"]);
    }

    #[test]
    fn successful_roundtrip_keeps_its_attached_socket() {
        let calls = RefCell::new(Vec::new());
        let result = checkout_cached_candidate_with(
            || {
                calls.borrow_mut().push("attach");
                Ok(())
            },
            || false,
            || {
                calls.borrow_mut().push("roundtrip");
                true
            },
            || {
                calls.borrow_mut().push("detach");
                false
            },
        );
        assert!(matches!(result, Ok(true)));
        assert_eq!(*calls.borrow(), ["attach", "roundtrip"]);
    }

    #[test]
    fn cancellation_during_the_roundtrip_detaches_and_returns_cancelled() {
        let calls = RefCell::new(Vec::new());
        let cancelled = Cell::new(false);
        let result = checkout_cached_candidate_with(
            || {
                calls.borrow_mut().push("attach");
                Ok(())
            },
            || cancelled.get(),
            || {
                calls.borrow_mut().push("roundtrip");
                cancelled.set(true);
                false
            },
            || {
                calls.borrow_mut().push("detach");
                cancelled.get()
            },
        );
        assert!(matches!(result, Err(SshError::TransferCancelled)));
        assert_eq!(*calls.borrow(), ["attach", "roundtrip", "detach"]);
    }

    #[test]
    fn cancellation_while_detaching_a_failed_probe_does_not_fall_back() {
        let calls = RefCell::new(Vec::new());
        let result = checkout_cached_candidate_with(
            || {
                calls.borrow_mut().push("attach");
                Ok(())
            },
            || false,
            || {
                calls.borrow_mut().push("roundtrip");
                false
            },
            || {
                calls.borrow_mut().push("detach");
                true
            },
        );
        assert!(matches!(result, Err(SshError::TransferCancelled)));
        assert_eq!(*calls.borrow(), ["attach", "roundtrip", "detach"]);
    }

    #[test]
    fn failed_attachment_never_runs_a_protocol_roundtrip() {
        let calls = RefCell::new(Vec::new());
        let result = checkout_cached_candidate_with(
            || {
                calls.borrow_mut().push("attach");
                Err(SshError::ConnectionNotFound)
            },
            || false,
            || {
                calls.borrow_mut().push("roundtrip");
                true
            },
            || {
                calls.borrow_mut().push("detach");
                false
            },
        );
        assert!(matches!(result, Err(SshError::ConnectionNotFound)));
        assert_eq!(*calls.borrow(), ["attach"]);
    }

    #[test]
    fn reuse_probe_restores_timeout_on_success_failure_and_unwind() {
        for succeeds in [true, false] {
            let calls = RefCell::new(Vec::new());
            let result =
                with_reuse_probe_timeout(|timeout| calls.borrow_mut().push(timeout), || succeeds);
            assert_eq!(result, succeeds);
            assert_eq!(*calls.borrow(), [2_000, 30_000]);
        }

        let calls = RefCell::new(Vec::new());
        let result = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
            with_reuse_probe_timeout(
                |timeout| calls.borrow_mut().push(timeout),
                || panic!("probe failed"),
            );
        }));
        assert!(result.is_err());
        assert_eq!(*calls.borrow(), [2_000, 30_000]);
    }

    #[test]
    fn reuse_probe_restores_the_actual_ssh_session_timeout() {
        let session = Session::new().unwrap();
        session.set_timeout(30_000);
        for succeeds in [true, false] {
            let result = with_reuse_probe_timeout(
                |timeout| session.set_timeout(timeout),
                || {
                    assert_eq!(session.timeout(), 2_000);
                    succeeds
                },
            );
            assert_eq!(result, succeeds);
            assert_eq!(session.timeout(), 30_000);
        }
    }

    #[test]
    fn checkout_rejects_endpoint_from_another_generation() {
        let state = SshState::default();
        state
            .tasks
            .register("window", "task", "connection", 7, "old-host")
            .unwrap();
        state
            .connection_generations
            .lock()
            .unwrap()
            .insert("connection".into(), 8);
        state
            .connection_endpoints
            .lock()
            .unwrap()
            .insert("connection".into(), "192.0.2.20:22".parse().unwrap());
        assert!(matches!(
            capture_checkout_endpoint(&state, "connection", "task"),
            Err(SshError::TransferCancelled)
        ));
    }

    #[test]
    fn checkout_captures_the_verified_endpoint_for_the_matching_generation() {
        let state = SshState::default();
        state
            .tasks
            .register("window", "task", "connection", 7, "host")
            .unwrap();
        state
            .connection_generations
            .lock()
            .unwrap()
            .insert("connection".into(), 7);
        let endpoint = "192.0.2.10:2222".parse().unwrap();
        state
            .connection_endpoints
            .lock()
            .unwrap()
            .insert("connection".into(), endpoint);
        assert!(matches!(
            capture_checkout_endpoint(&state, "connection", "task"),
            Ok((7, actual)) if actual == endpoint
        ));
    }

    #[test]
    fn checkout_endpoint_capture_waits_for_the_generation_lock() {
        let state = SshState::default();
        state
            .tasks
            .register("window", "task", "connection", 7, "old-host")
            .unwrap();
        let mut generations = state.connection_generations.lock().unwrap();
        generations.insert("connection".into(), 7);
        state
            .connection_endpoints
            .lock()
            .unwrap()
            .insert("connection".into(), "192.0.2.10:22".parse().unwrap());

        let (started_tx, started_rx) = std::sync::mpsc::channel();
        let (result_tx, result_rx) = std::sync::mpsc::channel();
        let worker_state = state.clone();
        let worker = std::thread::spawn(move || {
            started_tx.send(()).unwrap();
            let result = capture_checkout_endpoint(&worker_state, "connection", "task");
            result_tx.send(result).unwrap();
        });
        started_rx.recv().unwrap();
        let early = result_rx.recv_timeout(Duration::from_millis(100));
        generations.insert("connection".into(), 8);
        state
            .connection_endpoints
            .lock()
            .unwrap()
            .insert("connection".into(), "192.0.2.20:22".parse().unwrap());
        drop(generations);
        let result = match early {
            Ok(result) => Some(result),
            Err(_) => result_rx.recv_timeout(Duration::from_secs(2)).ok(),
        };
        worker.join().unwrap();
        assert!(matches!(result, Some(Err(SshError::TransferCancelled))));
    }

    #[test]
    fn aliases_of_one_peer_share_the_two_task_limit() {
        let tasks = Arc::new(TransferTasks::default());
        let ipv4 = server_key("192.0.2.10:22".parse().unwrap());
        let mapped = server_key("[::ffff:192.0.2.10]:22".parse().unwrap());
        for (id, host) in [("a", &ipv4), ("b", &mapped), ("c", &ipv4)] {
            tasks.register("window", id, id, 1, host).unwrap();
        }
        let first = tasks.acquire("a").unwrap();
        let second = tasks.acquire("b").unwrap();
        let (sender, receiver) = std::sync::mpsc::channel();
        let worker_tasks = tasks.clone();
        let worker = std::thread::spawn(move || {
            let lease = worker_tasks.acquire("c").unwrap();
            sender.send(()).unwrap();
            drop(lease);
        });
        let early = receiver.recv_timeout(Duration::from_millis(100));
        drop(first);
        let eventually_acquired =
            early.is_ok() || receiver.recv_timeout(Duration::from_secs(2)).is_ok();
        drop(second);
        worker.join().unwrap();
        assert!(early.is_err(), "同一对端不能同时执行三个任务");
        assert!(eventually_acquired);
    }

    #[test]
    fn pool_reuse_requires_connection_id_identity_and_generation() {
        let original = connection("example.com");
        assert!(same_pool_identity(&original, 7, &original, 7));
        assert!(!same_pool_identity(&original, 6, &original, 7));
        let mut changed = original.clone();
        changed.id = "other".into();
        assert!(!same_pool_identity(&original, 7, &changed, 7));
        changed = original.clone();
        changed.host = "other.example.com".into();
        assert!(!same_pool_identity(&original, 7, &changed, 7));
        changed = original.clone();
        changed.port = 23;
        assert!(!same_pool_identity(&original, 7, &changed, 7));
        changed = original.clone();
        changed.username = "other".into();
        assert!(!same_pool_identity(&original, 7, &changed, 7));
        changed = original.clone();
        changed.auth_method = "other".into();
        assert!(!same_pool_identity(&original, 7, &changed, 7));
        changed = original.clone();
        changed.password = "other".into();
        assert!(!same_pool_identity(&original, 7, &changed, 7));
        changed = original.clone();
        changed.host_key_fingerprint = Some("other".into());
        assert!(!same_pool_identity(&original, 7, &changed, 7));
    }

    #[test]
    fn idle_pool_limits_each_host_and_total_across_hosts() {
        assert!(idle_capacity_available(
            ["a", "b", "c", "d", "e", "f", "g"].into_iter(),
            "h"
        ));
        assert!(!idle_capacity_available(
            ["a", "b", "c", "d", "e", "f", "g", "h"].into_iter(),
            "i"
        ));
        assert!(idle_capacity_available(["a", "b", "c"].into_iter(), "a"));
        assert!(idle_capacity_available(["a", "a", "a"].into_iter(), "a"));
        assert!(!idle_capacity_available(
            ["a", "a", "a", "a"].into_iter(),
            "a"
        ));
        assert!(idle_capacity_available(
            ["a", "a", "a", "a"].into_iter(),
            "b"
        ));
    }
}
