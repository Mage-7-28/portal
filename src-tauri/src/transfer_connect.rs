//! 对主 SSH 会话已验证的对端建立可取消 TCP 连接，不重复解析 DNS。

use socket2::{Domain, Protocol, Socket, Type};
use std::io;
use std::net::{SocketAddr, TcpStream};
use std::time::{Duration, Instant};

/// 非阻塞连接期间每 25ms 检查取消；失败时未交付的 socket 由 RAII 关闭。
pub(crate) fn connect(
    address: SocketAddr,
    timeout: Duration,
    cancelled: impl Fn() -> bool,
) -> io::Result<TcpStream> {
    if cancelled() {
        return Err(io::Error::new(io::ErrorKind::Interrupted, "TCP 连接已取消"));
    }
    if timeout.is_zero() {
        return Err(io::Error::from(io::ErrorKind::TimedOut));
    }
    let socket = Socket::new(
        Domain::for_address(address),
        Type::STREAM,
        Some(Protocol::TCP),
    )?;
    socket.set_nonblocking(true)?;
    match socket.connect(&address.into()) {
        Ok(()) => {}
        Err(error) if connect_is_pending(&error) => {
            wait_for_connect(
                timeout,
                &cancelled,
                || {
                    if let Some(error) = socket.take_error()? {
                        return Err(error);
                    }
                    match socket.peer_addr() {
                        Ok(_) => Ok(true),
                        Err(error) if error.kind() == io::ErrorKind::NotConnected => Ok(false),
                        Err(error) => Err(error),
                    }
                },
                std::thread::sleep,
            )?;
        }
        Err(error) => return Err(error),
    }
    if cancelled() {
        return Err(io::Error::new(io::ErrorKind::Interrupted, "TCP 连接已取消"));
    }
    socket.set_nonblocking(false)?;
    let stream: TcpStream = socket.into();
    stream.set_read_timeout(Some(timeout))?;
    stream.set_write_timeout(Some(timeout))?;
    Ok(stream)
}

fn connect_is_pending(error: &io::Error) -> bool {
    if error.kind() == io::ErrorKind::WouldBlock {
        return true;
    }
    #[cfg(unix)]
    if error.raw_os_error() == Some(libc::EINPROGRESS) {
        return true;
    }
    false
}

fn wait_for_connect(
    timeout: Duration,
    cancelled: impl Fn() -> bool,
    mut poll: impl FnMut() -> io::Result<bool>,
    mut pause: impl FnMut(Duration),
) -> io::Result<()> {
    let started = Instant::now();
    loop {
        if cancelled() {
            return Err(io::Error::new(io::ErrorKind::Interrupted, "TCP 连接已取消"));
        }
        let remaining = timeout
            .checked_sub(started.elapsed())
            .filter(|remaining| !remaining.is_zero())
            .ok_or_else(|| io::Error::from(io::ErrorKind::TimedOut))?;
        if poll()? {
            return Ok(());
        }
        pause(remaining.min(Duration::from_millis(25)));
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::net::TcpListener;

    #[test]
    fn cancelled_before_connect_does_not_contact_listener() {
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        listener.set_nonblocking(true).unwrap();

        let error = connect(
            listener.local_addr().unwrap(),
            Duration::from_secs(1),
            || true,
        )
        .unwrap_err();

        assert_eq!(error.kind(), io::ErrorKind::Interrupted);
        assert_eq!(
            listener.accept().unwrap_err().kind(),
            io::ErrorKind::WouldBlock
        );
    }

    #[test]
    fn successful_connect_restores_blocking_io_timeouts() {
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let timeout = Duration::from_secs(1);
        let stream = connect(listener.local_addr().unwrap(), timeout, || false).unwrap();
        assert_eq!(stream.peer_addr().unwrap(), listener.local_addr().unwrap());
        assert_eq!(stream.read_timeout().unwrap(), Some(timeout));
        assert_eq!(stream.write_timeout().unwrap(), Some(timeout));
        let _ = listener.accept().unwrap();
    }

    #[test]
    fn waiting_can_be_cancelled_without_waiting_for_the_connect_timeout() {
        let checks = std::cell::Cell::new(0);
        let error = wait_for_connect(
            Duration::from_secs(30),
            || {
                checks.set(checks.get() + 1);
                checks.get() == 3
            },
            || Ok(false),
            |_| {},
        )
        .unwrap_err();
        assert_eq!(error.kind(), io::ErrorKind::Interrupted);
        assert_eq!(checks.get(), 3);
    }

    #[test]
    fn deadline_and_definitive_socket_errors_are_not_success() {
        let error = wait_for_connect(Duration::ZERO, || false, || Ok(true), |_| {}).unwrap_err();
        assert_eq!(error.kind(), io::ErrorKind::TimedOut);
        let error = wait_for_connect(
            Duration::from_secs(1),
            || false,
            || Err(io::Error::from(io::ErrorKind::ConnectionRefused)),
            |_| {},
        )
        .unwrap_err();
        assert_eq!(error.kind(), io::ErrorKind::ConnectionRefused);
    }
}
