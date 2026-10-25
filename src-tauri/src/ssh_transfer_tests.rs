//! 可选的 loopback SSH/SFTP 集成回归测试；不连接任何真实服务器。

use super::*;
use std::io::BufRead;
use std::process::{Child, Command, Stdio};

struct Fixture {
    root: PathBuf,
    server: Child,
    session: Arc<Mutex<Session>>,
    state: SshState,
    connection: SshConnection,
}

impl Fixture {
    fn new() -> Self {
        let python =
            std::env::var("PORTAL_SFTP_TEST_PYTHON").expect("请指定安装了 Paramiko 的 Python");
        let root =
            std::env::temp_dir().join(format!("portal-sftp-{:032x}", rand::random::<u128>()));
        fs::create_dir(&root).unwrap();
        let script = Path::new(env!("CARGO_MANIFEST_DIR")).join("../tests/sftp_fixture.py");
        let mut server = Command::new(python)
            .arg(script)
            .arg(&root)
            .stdout(Stdio::piped())
            .spawn()
            .unwrap();
        let mut port = String::new();
        BufReader::new(server.stdout.take().unwrap())
            .read_line(&mut port)
            .unwrap();
        let port = port.trim().parse::<u16>().expect("夹具必须输出监听端口");
        let mut session = Session::new().unwrap();
        session.set_timeout(5_000);
        session.set_tcp_stream(TcpStream::connect(("127.0.0.1", port)).unwrap());
        session.handshake().unwrap();
        session.userauth_password("portal-test", "fixture").unwrap();
        let connection = SshConnection {
            id: "test".to_string(),
            host: "127.0.0.1".to_string(),
            port,
            username: "portal-test".to_string(),
            password: "fixture".to_string(),
            auth_method: "password".to_string(),
            host_key_fingerprint: None,
            connected: true,
        };
        Self {
            root,
            server,
            session: Arc::new(Mutex::new(session)),
            state: SshState::default(),
            connection,
        }
    }

    fn local(&self, name: &str) -> String {
        self.root.join(name).to_str().unwrap().to_string()
    }
}

impl Drop for Fixture {
    fn drop(&mut self) {
        let _ = self.server.kill();
        let _ = self.server.wait();
        let _ = fs::remove_dir_all(&self.root);
    }
}

#[test]
#[ignore = "需要 PORTAL_SFTP_TEST_PYTHON 指向安装了 Paramiko 的 Python"]
fn transfers_files_and_folders_through_real_sftp() {
    let fixture = Fixture::new();
    fs::create_dir(fixture.root.join("private")).unwrap();
    fs::write(fixture.root.join("source"), b"contents").unwrap();
    run_upload(
        &fixture.state,
        &fixture.connection,
        &fixture.session,
        "upload",
        &fixture.local("source"),
        "/private/file",
        false,
    )
    .unwrap();
    assert_eq!(
        fs::read(fixture.root.join("private/file")).unwrap(),
        b"contents"
    );
    run_download(
        &fixture.state,
        &fixture.connection,
        &fixture.session,
        "download",
        "/private/file",
        &fixture.local("download"),
        false,
    )
    .unwrap();
    assert_eq!(
        fs::read(fixture.root.join("download")).unwrap(),
        b"contents"
    );
    fs::create_dir_all(fixture.root.join("folder/empty")).unwrap();
    fs::write(fixture.root.join("folder/data"), b"nested").unwrap();
    run_upload_directory(
        &fixture.state,
        &fixture.connection,
        &fixture.session,
        "upload-folder",
        &fixture.local("folder"),
        "/private/folder",
        false,
    )
    .unwrap();
    run_download_directory(
        &fixture.state,
        &fixture.connection,
        &fixture.session,
        "download-folder",
        "/private/folder",
        &fixture.local("copied"),
        false,
    )
    .unwrap();
    assert!(fixture.root.join("copied/empty").is_dir());
    assert_eq!(
        fs::read(fixture.root.join("copied/data")).unwrap(),
        b"nested"
    );
    // 原文件名接近 NAME_MAX 时，独立的临时名仍应可以创建。
    let remote = format!("/private/{}", "a".repeat(230));
    run_upload(
        &fixture.state,
        &fixture.connection,
        &fixture.session,
        "long",
        &fixture.local("source"),
        &remote,
        false,
    )
    .unwrap();
}

#[test]
#[ignore = "需要 PORTAL_SFTP_TEST_PYTHON 指向安装了 Paramiko 的 Python"]
fn preserves_old_targets_on_conflicts_and_cancellation() {
    let fixture = Fixture::new();
    fs::write(fixture.root.join("source"), b"new").unwrap();
    fs::write(fixture.root.join("target"), b"old").unwrap();
    for overwrite in [false, true] {
        assert!(run_upload(
            &fixture.state,
            &fixture.connection,
            &fixture.session,
            "conflict",
            &fixture.local("source"),
            "/target",
            overwrite
        )
        .is_err());
        assert_eq!(fs::read(fixture.root.join("target")).unwrap(), b"old");
    }
    fs::write(
        fixture.root.join("target.portal-part-cancelled"),
        b"unrelated",
    )
    .unwrap();
    fixture
        .state
        .cancelled_transfers
        .lock()
        .unwrap()
        .insert("cancelled".to_string());
    assert!(matches!(
        run_upload(
            &fixture.state,
            &fixture.connection,
            &fixture.session,
            "cancelled",
            &fixture.local("source"),
            "/target",
            true
        ),
        Err(SshError::TransferCancelled)
    ));
    assert!(matches!(
        run_download(
            &fixture.state,
            &fixture.connection,
            &fixture.session,
            "cancelled",
            "/source",
            &fixture.local("target"),
            true
        ),
        Err(SshError::TransferCancelled)
    ));
    assert_eq!(fs::read(fixture.root.join("target")).unwrap(), b"old");
    assert_eq!(
        fs::read(fixture.root.join("target.portal-part-cancelled")).unwrap(),
        b"unrelated"
    );
    assert!(!fs::read_dir(&fixture.root).unwrap().any(|entry| entry
        .unwrap()
        .file_name()
        .to_string_lossy()
        .starts_with(".portal-part-")));
}

#[cfg(unix)]
#[test]
#[ignore = "需要 PORTAL_SFTP_TEST_PYTHON 指向安装了 Paramiko 的 Python"]
fn rejects_shared_and_linked_remote_mutation_paths() {
    use std::os::unix::fs::{symlink, PermissionsExt};
    let fixture = Fixture::new();
    fs::create_dir(fixture.root.join("shared")).unwrap();
    fs::set_permissions(
        fixture.root.join("shared"),
        fs::Permissions::from_mode(0o777),
    )
    .unwrap();
    fs::write(fixture.root.join("shared/keep"), b"keep").unwrap();
    fs::write(fixture.root.join("source"), b"new").unwrap();
    symlink(fixture.root.join("shared"), fixture.root.join("linked")).unwrap();
    let policy = remote_mutation_policy(&fixture.state, "test", &fixture.session).unwrap();
    let sftp = fixture.session.lock().unwrap().sftp().unwrap();
    for path in ["/shared/new", "/linked/new"] {
        assert!(run_upload(
            &fixture.state,
            &fixture.connection,
            &fixture.session,
            "blocked",
            &fixture.local("source"),
            path,
            false
        )
        .is_err());
    }
    assert!(delete_remote_path(
        &fixture.state,
        "test",
        &sftp,
        &policy,
        Path::new("/shared"),
        None
    )
    .is_err());
    assert_eq!(fs::read(fixture.root.join("shared/keep")).unwrap(), b"keep");
    // 私有树可正常删除，叶子链接只删除链接本身。
    fs::create_dir(fixture.root.join("private")).unwrap();
    symlink(
        fixture.root.join("shared/keep"),
        fixture.root.join("private/link"),
    )
    .unwrap();
    delete_remote_path(
        &fixture.state,
        "test",
        &sftp,
        &policy,
        Path::new("/private"),
        None,
    )
    .unwrap();
    assert!(!fixture.root.join("private").exists());
    assert_eq!(fs::read(fixture.root.join("shared/keep")).unwrap(), b"keep");
    // 反斜杠是合法的 POSIX 叶子，不应使整个目录枚举失败。
    fs::write(fixture.root.join("back\\slash"), b"backslash").unwrap();
    let entries = bounded_remote_entries(
        &sftp,
        Path::new("/"),
        &Mutex::new(ScanBudget::default()),
        || false,
    )
    .unwrap();
    assert!(entries
        .iter()
        .any(|(path, _)| path.file_name() == Some(std::ffi::OsStr::new("back\\slash"))));
    delete_remote_path(
        &fixture.state,
        "test",
        &sftp,
        &policy,
        Path::new("/back\\slash"),
        None,
    )
    .unwrap();
    assert!(!fixture.root.join("back\\slash").exists());
}
