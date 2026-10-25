//! SFTP 路径变更的保守权限边界。
//!
//! 服务器必须提供可信的 POSIX 类型、UID 与权限。此策略不替代目录句柄，
//! 也不能判断额外 ACL 或防御同 UID 的恶意并发操作。

use ssh2::{FileStat, Sftp};
use std::path::Path;

/// UID 必须来自认证会话的 `id -u`，不能从目录所有者推断。
pub(crate) struct RemoteMutationPolicy {
    uid: u32,
}

impl RemoteMutationPolicy {
    pub(crate) fn new(uid: u32) -> Self {
        Self { uid }
    }

    /// 逐级检查原始路径，不先通过 realpath 隐藏其中的符号链接。
    pub(crate) fn validate_directory(&self, sftp: &Sftp, path: &Path) -> Result<(), String> {
        let path = path.to_str().ok_or("远端变更路径必须是 UTF-8")?;
        let current = if path.starts_with('/') {
            String::new()
        } else {
            sftp.realpath(Path::new("."))
                .map_err(|error| format!("无法验证远端工作目录: {error}"))?
                .to_str()
                .ok_or("远端工作目录必须是 UTF-8")?
                .to_string()
        };
        let absolute = absolute_directory(path, &current)?;
        self.validate_components(&absolute, |component| {
            sftp.lstat(Path::new(component))
                .map_err(|error| format!("无法验证远端目录“{component}”: {error}"))
        })?;
        let canonical = sftp
            .realpath(Path::new(&absolute))
            .map_err(|error| format!("无法验证远端目录: {error}"))?;
        if canonical.to_str() != Some(absolute.as_str()) {
            return Err("远端目录在验证期间发生变化，已拒绝变更".to_string());
        }
        Ok(())
    }

    /// 文件的叶子由排他创建或重命名保护；这里校验所有父目录。
    pub(crate) fn validate_parent(&self, sftp: &Sftp, path: &Path) -> Result<(), String> {
        // 非 UTF-8 的 POSIX 叶子可原样删除，校验其可表示的父目录即可。
        #[cfg(unix)]
        if path.to_str().is_none() {
            let name = path.file_name().ok_or("请选择具体的远端项目")?;
            use std::os::unix::ffi::OsStrExt;
            if name.as_bytes().contains(&0) {
                return Err("远端项目名称不能包含 NUL".to_string());
            }
            let parent = path
                .parent()
                .filter(|parent| !parent.as_os_str().is_empty())
                .unwrap_or(Path::new("."));
            return self.validate_directory(sftp, parent);
        }
        let path = path.to_str().ok_or("远端变更路径必须是 UTF-8")?;
        let path = path.trim_end_matches('/');
        let (parent, name) = path.rsplit_once('/').unwrap_or((".", path));
        if name.is_empty() || name == "." || name == ".." || name.contains('\0') {
            return Err("请选择具体且不含链接或父目录跳转的远端项目".to_string());
        }
        self.validate_directory(
            sftp,
            Path::new(if parent.is_empty() { "/" } else { parent }),
        )
    }

    fn validate_components(
        &self,
        absolute: &str,
        mut stat: impl FnMut(&str) -> Result<FileStat, String>,
    ) -> Result<(), String> {
        let mut prefix = String::from("/");
        self.validate_stat(&stat(&prefix)?, absolute == "/")?;
        let parts: Vec<_> = absolute
            .split('/')
            .filter(|part| !part.is_empty())
            .collect();
        for (index, part) in parts.iter().enumerate() {
            if prefix != "/" {
                prefix.push('/');
            }
            prefix.push_str(part);
            self.validate_stat(&stat(&prefix)?, index + 1 == parts.len())?;
        }
        Ok(())
    }

    fn validate_stat(&self, stat: &FileStat, mutation_root: bool) -> Result<(), String> {
        let uid = stat
            .uid
            .ok_or("服务器缺少可信 UID 元数据，已拒绝远端变更")?;
        let mode = stat
            .perm
            .ok_or("服务器缺少可信 POSIX 权限，已拒绝远端变更")?;
        if !stat.is_dir() || (uid != self.uid && uid != 0) {
            return Err("远端变更路径包含链接、非目录或其他用户拥有的目录".to_string());
        }
        let shared = mode & 0o022 != 0;
        // sticky 位只保护祖先中当前用户/root 拥有的后代；不能直接在共享目录变更。
        if shared && (mutation_root || mode & 0o1000 == 0) {
            return Err("远端目录允许组或其他用户写入，已拒绝不安全的变更".to_string());
        }
        Ok(())
    }
}

fn absolute_directory(path: &str, current: &str) -> Result<String, String> {
    let path = if path == "." { current } else { path };
    let full = if path.starts_with('/') {
        path.to_string()
    } else if current.starts_with('/') {
        format!("{current}/{path}")
    } else {
        return Err("远端缺少可信的 POSIX 绝对路径，已拒绝变更".to_string());
    };
    if full.contains(['\\', '\0']) || full.split('/').any(|part| matches!(part, "." | "..")) {
        return Err("远端变更路径包含不安全的分隔符或目录跳转".to_string());
    }
    Ok(format!(
        "/{}",
        full.split('/')
            .filter(|part| !part.is_empty())
            .collect::<Vec<_>>()
            .join("/")
    ))
}

/// 仅接受 ASCII UID 和一个可选末尾换行，拒绝启动脚本噪声与截断输出。
pub(crate) fn parse_remote_uid(output: &[u8]) -> Result<u32, String> {
    let output = output.strip_suffix(b"\n").unwrap_or(output);
    if output.is_empty() || output.len() > 10 || !output.iter().all(u8::is_ascii_digit) {
        return Err("远端无法提供可信 UID，已拒绝变更".to_string());
    }
    std::str::from_utf8(output)
        .unwrap()
        .parse()
        .map_err(|_| "远端 UID 超出有效范围，已拒绝变更".to_string())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn directory(uid: Option<u32>, mode: Option<u32>) -> FileStat {
        FileStat {
            size: None,
            uid,
            gid: None,
            perm: mode,
            atime: None,
            mtime: None,
        }
    }

    #[test]
    fn accepts_only_private_directories_owned_by_authenticated_user_or_root() {
        let policy = RemoteMutationPolicy::new(1000);
        assert!(policy
            .validate_stat(&directory(Some(1000), Some(0o40700)), true)
            .is_ok());
        assert!(policy
            .validate_stat(&directory(Some(0), Some(0o40755)), false)
            .is_ok());
        for (uid, mode) in [
            (Some(2000), Some(0o40700)),
            (Some(1000), Some(0o40770)),
            (Some(1000), Some(0o40702)),
            (Some(1000), Some(0o120777)),
            (None, Some(0o40700)),
            (Some(1000), None),
            (Some(1000), Some(0o700)),
        ] {
            assert!(policy.validate_stat(&directory(uid, mode), true).is_err());
        }
    }

    #[test]
    fn allows_sticky_ancestors_but_rejects_shared_mutation_roots() {
        let policy = RemoteMutationPolicy::new(1000);
        assert!(policy
            .validate_components("/tmp/private", |path| Ok(match path {
                "/tmp" => directory(Some(0), Some(0o41777)),
                "/tmp/private" => directory(Some(1000), Some(0o40700)),
                _ => directory(Some(0), Some(0o40755)),
            }))
            .is_ok());
        assert!(policy
            .validate_stat(&directory(Some(0), Some(0o41777)), true)
            .is_err());
        assert!(policy
            .validate_components("/shared/private", |path| Ok(directory(
                Some(1000),
                Some(if path == "/shared" { 0o40777 } else { 0o40700 })
            )))
            .is_err());
    }

    #[test]
    fn rejects_unsafe_paths_and_uid_output() {
        assert_eq!(
            absolute_directory("child", "/home/user").unwrap(),
            "/home/user/child"
        );
        assert_eq!(absolute_directory(".", "/home/user").unwrap(), "/home/user");
        for path in ["../other", "/home/../other", "C:\\home", "/home\0bad"] {
            assert!(absolute_directory(path, "/home/user").is_err());
        }
        assert_eq!(parse_remote_uid(b"1000\n").unwrap(), 1000);
        assert_eq!(parse_remote_uid(b"0").unwrap(), 0);
        for output in [
            b"".as_slice(),
            b"-1",
            b" 1",
            b"1\n2\n",
            b"1\r\n",
            b"4294967296",
            b"banner\n1000\n",
        ] {
            assert!(parse_remote_uid(output).is_err());
        }
    }
}
