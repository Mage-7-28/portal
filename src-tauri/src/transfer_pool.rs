//! 文件任务独占的 SSH 会话。调度名额由任务状态机负责，空闲资源按身份隔离。
use super::*;
use std::io::ErrorKind;
use std::net::{IpAddr, Shutdown, SocketAddr};
use std::path::Path;

const IDLE_TTL: Duration = Duration::from_secs(60);
const MAX_IDLE_TOTAL: usize = 4;
const MAX_IDLE_PER_HOST: usize = 2;
const REUSE_PROBE_TIMEOUT_MS: u32 = 2_000;

pub(super) struct IdleTransferSession {
    connection: SshConnection,
    generation: u64,
    host: String,
    session: Arc<Mutex<Session>>,
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
}
pub(super) struct TransferSessionLease {
    state: SshState,
    entry: Option<IdleTransferSession>,
    reusable: bool,
    task_id: String,
}
pub(super) fn server_key(endpoint: SocketAddr) -> String {
    match endpoint {
        SocketAddr::V6(address) => match address.ip().to_ipv4_mapped() {
            Some(ip) => SocketAddr::new(IpAddr::V4(ip), address.port()).to_string(),
            None => endpoint.to_string(),
        },
        SocketAddr::V4(_) => endpoint.to_string(),
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

impl TransferSessionLease {
    pub(super) fn checkout(
        state: &SshState,
        connection: &SshConnection,
        task_id: &str,
    ) -> Result<Self, SshError> {
        let (generation, endpoint) = capture_checkout_endpoint(state, &connection.id, task_id)?;
        let host = server_key(endpoint);
        if state.tasks.cancelled(task_id) {
            return Err(SshError::TransferCancelled);
        }
        let candidate = {
            let mut pool = state.transfer_pool.lock().unwrap();
            pool.retain(IdleTransferSession::is_fresh);
            let found = pool.iter().position(|entry| {
                entry.host == host
                    && same_pool_identity(
                        &entry.connection,
                        entry.generation,
                        connection,
                        generation,
                    )
            });
            if let Some(index) = found {
                Some(pool.swap_remove(index))
            } else {
                // 新建前释放本主机的空闲旧身份，避免与活动会话共同占用主机名额。
                pool.retain(|entry| entry.host != host);
                None
            }
        };
        let entry = match candidate {
            Some(entry) => {
                let reusable = checkout_cached_candidate_with(
                    || {
                        state
                            .tasks
                            .attach_socket(task_id, entry.socket.try_clone()?);
                        Ok(())
                    },
                    || state.tasks.cancelled(task_id),
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
                            || {
                                session
                                    .sftp()
                                    .and_then(|sftp| sftp.stat(Path::new(".")))
                                    .is_ok()
                            },
                        )
                    },
                    || state.tasks.detach_socket(task_id),
                );
                match reusable {
                    Ok(true) => Some(entry),
                    result => {
                        // 失效会话的析构也可能执行协议关闭，先中断其独占 socket。
                        let _ = entry.socket.shutdown(Shutdown::Both);
                        drop(entry);
                        result?;
                        state
                            .transfer_pool
                            .lock()
                            .unwrap()
                            .retain(|idle| idle.host != host);
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
                        state.tasks.cancelled(task_id)
                    })
                    .map_err(|error| {
                        if error.kind() == ErrorKind::Interrupted {
                            SshError::TransferCancelled
                        } else {
                            SshError::ConnectionFailed(error.to_string())
                        }
                    })?;
                let socket = tcp.try_clone()?;
                state.tasks.attach_socket(task_id, socket.try_clone()?);
                if state.tasks.cancelled(task_id) {
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
                    session: Arc::new(Mutex::new(session)),
                    socket,
                    last_used: Instant::now(),
                }
            }
        };
        if state.tasks.cancelled(task_id) {
            state.tasks.detach_socket(task_id);
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
            state.tasks.detach_socket(task_id);
            let _ = entry.socket.shutdown(Shutdown::Both);
            return Err(SshError::TransferCancelled);
        }
        Ok(Self {
            state: state.clone(),
            entry: Some(entry),
            reusable: false,
            task_id: task_id.into(),
        })
    }
    pub(super) fn session(&self) -> Arc<Mutex<Session>> {
        self.entry.as_ref().unwrap().session.clone()
    }
    pub(super) fn reuse_on_success(&mut self) {
        self.reusable = true;
    }
}
impl Drop for TransferSessionLease {
    fn drop(&mut self) {
        if let Some(mut entry) = self.entry.take() {
            let cancelled = self.state.tasks.detach_socket(&self.task_id);
            let generations = self.state.connection_generations.lock().unwrap();
            let generation = generations.get(&entry.connection.id).copied().unwrap_or(0);
            if self.reusable
                && !cancelled
                && generation == entry.generation
                && !self.state.runtime_stop.load(Ordering::Acquire)
            {
                entry.last_used = Instant::now();
                let mut pool = self.state.transfer_pool.lock().unwrap();
                pool.retain(IdleTransferSession::is_fresh);
                if idle_capacity_available(pool.iter().map(|idle| idle.host.as_str()), &entry.host)
                {
                    pool.push(entry);
                }
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::cell::{Cell, RefCell};

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

    #[test]
    fn host_key_groups_verified_peer_and_preserves_port_and_ipv6_scope() {
        assert_eq!(
            server_key("[2001:db8::1]:22".parse().unwrap()),
            server_key("[2001:0DB8:0:0:0:0:0:1]:22".parse().unwrap())
        );
        assert_ne!(
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
        assert!(idle_capacity_available(["a", "b", "c"].into_iter(), "d"));
        assert!(!idle_capacity_available(
            ["a", "b", "c", "d"].into_iter(),
            "e"
        ));
        assert!(idle_capacity_available(["a", "b", "c"].into_iter(), "a"));
        assert!(!idle_capacity_available(["a", "a"].into_iter(), "a"));
        assert!(idle_capacity_available(["a", "a"].into_iter(), "b"));
    }
}
