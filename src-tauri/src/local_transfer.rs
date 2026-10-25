//! 本地传输的根目录、文件句柄和提交边界。

use cap_fs_ext::{DirExt, FollowSymlinks, OpenOptionsFollowExt};
use cap_std::fs::{Dir, OpenOptions};
use std::ffi::OsString;
use std::fs::File;
use std::io;
use std::path::{Component, Path};

/// 只在用户选定目录内解析相对路径；后代组件逐级拒绝链接。
///
/// 根目录的祖先由用户选择的环境决定。打开后所有子项操作都相对于目录句柄，
/// 不再通过环境绝对路径重新进入目录。目录被改名时句柄仍指向原对象。
pub(crate) struct LocalTransferRoot {
    directory: Dir,
}

impl LocalTransferRoot {
    pub(crate) fn open(path: &Path) -> io::Result<Self> {
        // 当前目录和文件系统根没有叶子文件名，仍是合法的用户选定根。
        if !path.as_os_str().is_empty() && path.file_name().is_none() {
            return Ok(Self {
                directory: Dir::open_ambient_dir(path, cap_std::ambient_authority())?,
            });
        }
        let name = path
            .file_name()
            .ok_or_else(|| invalid_path("请选择具体的传输目录"))?;
        let parent = path
            .parent()
            .filter(|p| !p.as_os_str().is_empty())
            .unwrap_or(Path::new("."));
        let parent = Dir::open_ambient_dir(parent, cap_std::ambient_authority())?;
        Ok(Self {
            directory: parent.open_dir_nofollow(name)?,
        })
    }

    /// 根目标不存在时由已打开的父目录创建；只允许合并普通目录。
    pub(crate) fn download_root(path: &Path, overwrite: bool) -> io::Result<Self> {
        let name = path
            .file_name()
            .ok_or_else(|| invalid_path("请选择具体的下载目录"))?;
        let parent = path
            .parent()
            .filter(|p| !p.as_os_str().is_empty())
            .unwrap_or(Path::new("."));
        let parent = Dir::open_ambient_dir(parent, cap_std::ambient_authority())?;
        match parent.create_dir(name) {
            Ok(()) => {}
            Err(error) if error.kind() == io::ErrorKind::AlreadyExists && overwrite => {}
            Err(error) => return Err(error),
        }
        Ok(Self {
            directory: parent.open_dir_nofollow(name)?,
        })
    }

    fn directory(&self, relative: &Path, create: bool) -> io::Result<Dir> {
        let mut directory = self.directory.try_clone()?;
        for component in relative.components() {
            let Component::Normal(name) = component else {
                return Err(invalid_path("传输路径必须是根目录内的普通相对路径"));
            };
            if create {
                match directory.create_dir(name) {
                    Ok(()) => {}
                    Err(error) if error.kind() == io::ErrorKind::AlreadyExists => {}
                    Err(error) => return Err(error),
                }
            }
            directory = directory.open_dir_nofollow(name)?;
        }
        Ok(directory)
    }

    pub(crate) fn create_dir_all(&self, relative: &Path) -> io::Result<()> {
        self.directory(relative, true).map(|_| ())
    }

    /// 实际打开时校验所有父目录及叶子；扫描结果不能代替这里的校验。
    pub(crate) fn open_source(&self, relative: &Path) -> io::Result<File> {
        let (parent, name) = split_relative(relative)?;
        let parent = self.directory(parent, false)?;
        let mut options = OpenOptions::new();
        options.read(true).follow(FollowSymlinks::No);
        // FIFO 等特殊文件不能让打开动作无限等待；打开后仍要检查句柄类型。
        #[cfg(unix)]
        {
            use cap_fs_ext::OpenOptionsSyncExt;
            options.nonblock(true);
        }
        let file = parent.open_with(name, &options)?.into_std();
        if !file.metadata()?.is_file() {
            return Err(invalid_path("上传源必须是普通文件"));
        }
        Ok(file)
    }

    pub(crate) fn entries(&self, relative: &Path) -> io::Result<cap_std::fs::ReadDir> {
        self.directory(relative, false)?.entries()
    }

    pub(crate) fn metadata(&self, relative: &Path) -> io::Result<cap_std::fs::Metadata> {
        let (parent, name) = split_relative(relative)?;
        self.directory(parent, false)?.symlink_metadata(name)
    }

    pub(crate) fn prepare_download(
        &self,
        relative: &Path,
        overwrite: bool,
    ) -> io::Result<LocalDownload> {
        let (parent, name) = split_relative(relative)?;
        let parent = self.directory(parent, true)?;
        match parent.symlink_metadata(name) {
            Ok(metadata) => {
                if !metadata.is_file() || metadata.file_type().is_symlink() {
                    return Err(invalid_path("本地目标必须是普通文件，不能覆盖目录或链接"));
                }
                if !overwrite {
                    return Err(io::Error::new(
                        io::ErrorKind::AlreadyExists,
                        "本地目标文件已存在",
                    ));
                }
            }
            Err(error) if error.kind() == io::ErrorKind::NotFound => {}
            Err(error) => return Err(error),
        }
        let temporary = OsString::from(format!(".portal-part-{:032x}", rand::random::<u128>()));
        let mut options = OpenOptions::new();
        options
            .write(true)
            .create_new(true)
            .follow(FollowSymlinks::No);
        #[cfg(unix)]
        {
            use cap_std::fs::OpenOptionsExt;
            options.mode(0o600);
        }
        let file = parent.open_with(&temporary, &options)?.into_std();
        Ok(LocalDownload {
            parent,
            temporary,
            target: name.to_os_string(),
            file,
            overwrite,
            committed: false,
        })
    }
}

/// 独占临时文件及其父目录；失败和取消只清理本任务创建的名字。
pub(crate) struct LocalDownload {
    parent: Dir,
    temporary: OsString,
    target: OsString,
    file: File,
    overwrite: bool,
    committed: bool,
}

impl LocalDownload {
    pub(crate) fn file_mut(&mut self) -> &mut File {
        &mut self.file
    }

    pub(crate) fn commit(mut self) -> io::Result<()> {
        self.file.sync_all()?;
        // rename 替换的是目标目录项，不会跟随叶子链接。失败时保留旧目标。
        if self.overwrite {
            self.parent
                .rename(&self.temporary, &self.parent, &self.target)?;
        } else {
            // hard_link 的目标必须不存在，避免 exists + rename 的检查使用竞态。
            // 不支持硬链接的文件系统明确失败，不能退回会覆盖并发目标的 rename。
            self.parent
                .hard_link(&self.temporary, &self.parent, &self.target)?;
            self.parent.remove_file(&self.temporary)?;
        }
        self.committed = true;
        Ok(())
    }
}

impl Drop for LocalDownload {
    fn drop(&mut self) {
        if !self.committed {
            let _ = self.parent.remove_file(&self.temporary);
        }
    }
}

fn invalid_path(message: &str) -> io::Error {
    io::Error::new(io::ErrorKind::InvalidInput, message)
}

fn split_relative(path: &Path) -> io::Result<(&Path, &std::ffi::OsStr)> {
    if path
        .components()
        .any(|c| !matches!(c, Component::Normal(_)))
    {
        return Err(invalid_path("传输路径必须是根目录内的普通相对路径"));
    }
    let name = path
        .file_name()
        .ok_or_else(|| invalid_path("传输路径缺少文件名"))?;
    Ok((path.parent().unwrap_or(Path::new("")), name))
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;
    use std::io::{Read, Write};
    use std::path::{Path, PathBuf};

    struct Fixture(PathBuf);

    impl Fixture {
        fn new() -> Self {
            let path =
                std::env::temp_dir().join(format!("portal-local-{:032x}", rand::random::<u128>()));
            fs::create_dir(&path).unwrap();
            Self(path)
        }
    }

    impl Drop for Fixture {
        fn drop(&mut self) {
            let _ = fs::remove_dir_all(&self.0);
        }
    }

    #[test]
    fn opens_current_directory_and_filesystem_root() {
        assert!(LocalTransferRoot::open(Path::new(".")).is_ok());
        let current = std::env::current_dir().unwrap();
        let root = current.ancestors().last().unwrap();
        assert!(LocalTransferRoot::open(root).is_ok());
    }

    #[test]
    fn commits_nested_download_and_replaces_without_removing_old_target() {
        let fixture = Fixture::new();
        let root = LocalTransferRoot::open(&fixture.0).unwrap();
        root.create_dir_all(Path::new("nested/empty")).unwrap();
        fs::write(fixture.0.join("nested/file"), b"old").unwrap();
        let mut target = root
            .prepare_download(Path::new("nested/file"), true)
            .unwrap();
        target.file_mut().write_all(b"new").unwrap();
        assert_eq!(fs::read(fixture.0.join("nested/file")).unwrap(), b"old");
        target.commit().unwrap();
        assert_eq!(fs::read(fixture.0.join("nested/file")).unwrap(), b"new");
    }

    #[test]
    fn no_overwrite_preserves_a_concurrently_created_target() {
        let fixture = Fixture::new();
        let root = LocalTransferRoot::open(&fixture.0).unwrap();
        let mut target = root.prepare_download(Path::new("file"), false).unwrap();
        target.file_mut().write_all(b"download").unwrap();
        fs::write(fixture.0.join("file"), b"concurrent").unwrap();
        assert!(target.commit().is_err());
        assert_eq!(fs::read(fixture.0.join("file")).unwrap(), b"concurrent");
        assert_eq!(fs::read_dir(&fixture.0).unwrap().count(), 1);
    }

    #[test]
    fn cancellation_removes_only_the_owned_temporary_file() {
        let fixture = Fixture::new();
        let root = LocalTransferRoot::open(&fixture.0).unwrap();
        fs::write(fixture.0.join("keep"), b"keep").unwrap();
        let target = root.prepare_download(Path::new("file"), false).unwrap();
        assert_eq!(fs::read_dir(&fixture.0).unwrap().count(), 2);
        drop(target);
        assert_eq!(fs::read_dir(&fixture.0).unwrap().count(), 1);
        assert_eq!(fs::read(fixture.0.join("keep")).unwrap(), b"keep");
    }

    #[test]
    fn rejects_parent_and_absolute_relative_paths() {
        let fixture = Fixture::new();
        let root = LocalTransferRoot::open(&fixture.0).unwrap();
        assert!(root
            .prepare_download(Path::new("../escape"), false)
            .is_err());
        assert!(root.create_dir_all(Path::new("../escape")).is_err());
        assert!(root.open_source(&fixture.0.join("file")).is_err());
    }

    #[cfg(unix)]
    #[test]
    fn rejects_download_intermediate_and_leaf_symlinks() {
        use std::os::unix::fs::symlink;
        let fixture = Fixture::new();
        let outside = Fixture::new();
        symlink(&outside.0, fixture.0.join("linked")).unwrap();
        symlink(outside.0.join("secret"), fixture.0.join("leaf")).unwrap();
        let root = LocalTransferRoot::open(&fixture.0).unwrap();
        assert!(root.create_dir_all(Path::new("linked/child")).is_err());
        assert!(root
            .prepare_download(Path::new("linked/file"), true)
            .is_err());
        assert!(root.prepare_download(Path::new("leaf"), true).is_err());
        assert_eq!(fs::read_dir(&outside.0).unwrap().count(), 0);
    }

    #[cfg(unix)]
    #[test]
    fn upload_rejects_leaf_and_parent_replaced_by_symlinks() {
        use std::os::unix::fs::symlink;
        let fixture = Fixture::new();
        let outside = Fixture::new();
        fs::write(outside.0.join("secret"), b"private").unwrap();
        fs::write(fixture.0.join("source"), b"allowed").unwrap();
        fs::create_dir(fixture.0.join("nested")).unwrap();
        let root = LocalTransferRoot::open(&fixture.0).unwrap();
        let mut control = String::new();
        root.open_source(Path::new("source"))
            .unwrap()
            .read_to_string(&mut control)
            .unwrap();
        assert_eq!(control, "allowed");
        fs::remove_file(fixture.0.join("source")).unwrap();
        symlink(outside.0.join("secret"), fixture.0.join("source")).unwrap();
        fs::remove_dir(fixture.0.join("nested")).unwrap();
        symlink(&outside.0, fixture.0.join("nested")).unwrap();
        assert!(root.open_source(Path::new("source")).is_err());
        assert!(root.open_source(Path::new("nested/secret")).is_err());
    }

    #[cfg(unix)]
    #[test]
    fn commit_replaces_a_late_leaf_symlink_without_writing_its_target() {
        use std::os::unix::fs::symlink;
        let fixture = Fixture::new();
        let outside = Fixture::new();
        fs::write(outside.0.join("secret"), b"private").unwrap();
        let root = LocalTransferRoot::open(&fixture.0).unwrap();
        let mut target = root.prepare_download(Path::new("file"), true).unwrap();
        symlink(outside.0.join("secret"), fixture.0.join("file")).unwrap();
        target.file_mut().write_all(b"download").unwrap();
        target.commit().unwrap();
        assert_eq!(fs::read(outside.0.join("secret")).unwrap(), b"private");
        assert_eq!(fs::read(fixture.0.join("file")).unwrap(), b"download");
        assert!(!fs::symlink_metadata(fixture.0.join("file"))
            .unwrap()
            .file_type()
            .is_symlink());
    }

    #[cfg(unix)]
    #[test]
    fn prepared_download_keeps_parent_handle_when_path_is_replaced() {
        use std::os::unix::fs::symlink;
        let fixture = Fixture::new();
        let outside = Fixture::new();
        fs::create_dir(fixture.0.join("nested")).unwrap();
        let root = LocalTransferRoot::open(&fixture.0).unwrap();
        let mut target = root
            .prepare_download(Path::new("nested/file"), false)
            .unwrap();
        fs::rename(fixture.0.join("nested"), fixture.0.join("original")).unwrap();
        symlink(&outside.0, fixture.0.join("nested")).unwrap();
        target.file_mut().write_all(b"download").unwrap();
        target.commit().unwrap();
        assert!(!outside.0.join("file").exists());
        assert_eq!(
            fs::read(fixture.0.join("original/file")).unwrap(),
            b"download"
        );
    }

    #[cfg(unix)]
    #[test]
    fn temporary_and_replaced_files_keep_private_permissions() {
        use std::os::unix::fs::PermissionsExt;
        let fixture = Fixture::new();
        fs::write(fixture.0.join("file"), b"private").unwrap();
        fs::set_permissions(fixture.0.join("file"), fs::Permissions::from_mode(0o600)).unwrap();
        let root = LocalTransferRoot::open(&fixture.0).unwrap();
        let mut target = root.prepare_download(Path::new("file"), true).unwrap();
        assert_eq!(
            target.file_mut().metadata().unwrap().permissions().mode() & 0o077,
            0
        );
        target.file_mut().write_all(b"new").unwrap();
        target.commit().unwrap();
        assert_eq!(
            fs::metadata(fixture.0.join("file"))
                .unwrap()
                .permissions()
                .mode()
                & 0o777,
            0o600
        );
    }
}
