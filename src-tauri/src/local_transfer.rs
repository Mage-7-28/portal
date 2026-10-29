//! 本地传输的根目录、文件句柄和提交边界。

use cap_fs_ext::{DirExt, FollowSymlinks, OpenOptionsFollowExt};
#[cfg(unix)]
use cap_std::fs::DirBuilderExt;
use cap_std::fs::{Dir, DirBuilder, OpenOptions};
use std::collections::BTreeMap;
use std::error::Error;
use std::ffi::{OsStr, OsString};
use std::fmt;
use std::fs::File;
use std::io;
use std::path::{Component, Path, PathBuf};

#[cfg(unix)]
use std::os::fd::AsRawFd;
#[cfg(unix)]
use std::os::unix::ffi::OsStrExt;
#[cfg(windows)]
use std::os::windows::ffi::OsStrExt;

/// 清单中的实体类型；清单预检不依赖路径字符串的大小写或 Unicode 规则。
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub(crate) enum LocalManifestEntryKind {
    Directory,
    File,
}

/// 文件系统实际把两个清单项映射为同一个目录项时返回的冲突。
#[derive(Debug, Eq, PartialEq)]
pub(crate) struct LocalNameCollision {
    pub(crate) path: PathBuf,
    pub(crate) kind: LocalManifestEntryKind,
}

impl fmt::Display for LocalNameCollision {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        let kind = match self.kind {
            LocalManifestEntryKind::Directory => "目录",
            LocalManifestEntryKind::File => "文件",
        };
        write!(
            formatter,
            "清单中的{kind}名称与另一个目录项冲突：{}",
            self.path.display()
        )
    }
}

impl Error for LocalNameCollision {}

/// 已存在锚点及其祖先的文件系统身份快照；未解析名称采用保守冲突判定。
#[derive(Clone, Debug)]
pub(crate) struct LocalReservationKey {
    identities: Vec<(u64, u64)>,
    resolved: bool,
}

impl LocalReservationKey {
    /// 两个现有对象相同、互为祖先，或其中一方的未解析部分可能重叠时返回 true。
    pub(crate) fn conflicts(&self, other: &Self) -> bool {
        self.identities.contains(&other.identities[0])
            || other.identities.contains(&self.identities[0])
    }

    /// 只有两个完整路径都存在且指向同一文件系统对象时才返回 true。
    /// 缺失的目标须另做同目录清单预检，不能据此断言名称不同。
    pub(crate) fn same_resolved_target(&self, other: &Self) -> bool {
        self.is_resolved() && other.is_resolved() && self.identities[0] == other.identities[0]
    }

    pub(crate) fn is_resolved(&self) -> bool {
        self.resolved
    }
}

/// 只在用户选定目录内解析相对路径；后代组件逐级拒绝链接。
///
/// 根目录的祖先由用户选择的环境决定。打开后所有子项操作都相对于目录句柄，
/// 不再通过环境绝对路径重新进入目录。目录被改名时句柄仍指向原对象。
pub(crate) struct LocalTransferRoot {
    directory: Dir,
    private: bool,
}

impl LocalTransferRoot {
    /// 为任务注册表获取本地目标身份；注册与冲突检查须在同一把锁内完成。
    /// 外部进程移动或替换目录不受此应用内预占约束。
    pub(crate) fn reservation_key(path: &Path) -> io::Result<LocalReservationKey> {
        reservation_key(path)
    }

    pub(crate) fn open(path: &Path) -> io::Result<Self> {
        // 当前目录和文件系统根没有叶子文件名，仍是合法的用户选定根。
        if !path.as_os_str().is_empty() && path.file_name().is_none() {
            return Ok(Self {
                directory: Dir::open_ambient_dir(path, cap_std::ambient_authority())?,
                private: false,
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
            private: false,
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
            private: false,
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

    /// 在持有的目标目录下创建同卷、仅本用户可访问的暂存区。
    /// 暂存区在所有借用结束后随 `LocalStaging` 删除，清理不沿绝对路径重开目录。
    pub(crate) fn private_staging(&self) -> io::Result<LocalStaging> {
        private_staging_in(&self.directory)
    }

    /// 在任何最终文件写入前检查整个清单。冲突错误的 payload 为 `LocalNameCollision`。
    /// 调用方必须保留跨任务目标预占；外部进程仍可在预检后更改目标。
    pub(crate) fn validate_manifest(
        &self,
        directories: &[PathBuf],
        files: &[PathBuf],
    ) -> io::Result<()> {
        const MAX_ENTRIES: usize = 100_000;
        const MAX_BYTES: usize = 32 * 1024 * 1024;
        const MAX_DEPTH: usize = 128;
        if directories.len().saturating_add(files.len()) > MAX_ENTRIES {
            return Err(invalid_path("清单超过条目数量预算"));
        }
        let mut bytes = 0usize;
        for path in directories.iter().chain(files) {
            bytes = bytes.saturating_add(path.as_os_str().as_encoded_bytes().len());
            if bytes > MAX_BYTES || path.components().count() > MAX_DEPTH {
                return Err(invalid_path("清单超过路径内存或深度预算"));
            }
        }
        let mut tree = ManifestNode::default();
        for path in directories {
            tree.insert(path, LocalManifestEntryKind::Directory)?;
        }
        for path in files {
            tree.insert(path, LocalManifestEntryKind::File)?;
        }
        #[cfg(not(windows))]
        return validate_manifest_node(&tree, Some(&self.directory), None, Path::new(""));
        #[cfg(windows)]
        return validate_windows_manifest_node(&tree, Some(&self.directory), Path::new(""));
    }

    /// 将已完成同步的暂存普通文件发布到目标；源必须位于私有暂存根的直接子项。
    /// 不覆盖模式使用原子 no-replace；覆盖模式不能阻止外部进程在检查后替换目标。
    pub(crate) fn publish_from(
        &self,
        staging: &Self,
        staged_relative: &Path,
        target_relative: &Path,
        overwrite: bool,
    ) -> io::Result<()> {
        if !staging.private {
            return Err(invalid_path("发布源必须是任务私有暂存区"));
        }
        let (staged_parent, staged_name) = split_relative(staged_relative)?;
        if !staged_parent.as_os_str().is_empty() {
            return Err(invalid_path("暂存文件必须是暂存区的直接子项"));
        }
        verify_private_directory(&staging.directory)?;
        let source = staging.open_source(staged_relative)?;
        source.sync_all()?;
        let (target_parent, target_name) = split_relative(target_relative)?;
        let target_parent = self.directory(target_parent, true)?;
        check_target(&target_parent, target_name, overwrite)?;
        if overwrite {
            staging
                .directory
                .rename(staged_name, &target_parent, target_name)
                .map_err(|error| {
                    if cross_device(&error) {
                        io::Error::new(io::ErrorKind::Unsupported, "暂存区与目标不在同一文件系统")
                    } else {
                        error
                    }
                })?;
        } else {
            rename_noreplace(&staging.directory, staged_name, &target_parent, target_name)?;
        }
        Ok(())
    }

    pub(crate) fn prepare_download(
        &self,
        relative: &Path,
        overwrite: bool,
    ) -> io::Result<LocalDownload> {
        let (parent, name) = split_relative(relative)?;
        let parent = self.directory(parent, true)?;
        check_target(&parent, name, overwrite)?;
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
            rename_noreplace(&self.parent, &self.temporary, &self.parent, &self.target)?;
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

/// 独占暂存目录及其清理责任。文件发布或取消后，释放此值即可清理残留文件。
pub(crate) struct LocalStaging {
    root: Option<LocalTransferRoot>,
}

impl LocalStaging {
    pub(crate) fn root(&self) -> &LocalTransferRoot {
        self.root.as_ref().expect("暂存区在释放前始终有效")
    }
}

impl Drop for LocalStaging {
    fn drop(&mut self) {
        if let Some(root) = self.root.take() {
            // Windows 的 cap-std 实现会关闭句柄并重新解析路径，不能安全清理；
            // 因此该平台在建立暂存区时直接拒绝，绝不走到这里。
            #[cfg(unix)]
            let _ = root.directory.remove_open_dir_all();
            #[cfg(not(unix))]
            drop(root);
        }
    }
}

#[cfg(unix)]
fn private_staging_in(parent: &Dir) -> io::Result<LocalStaging> {
    verify_no_extended_acl(parent)?;
    let mut builder = DirBuilder::new();
    builder.mode(0o700);
    for _ in 0..16 {
        let name = format!(".portal-stage-{:032x}", rand::random::<u128>());
        match parent.create_dir_with(&name, &builder) {
            Ok(()) => {
                let directory = parent.open_dir_nofollow(&name)?;
                if let Err(error) = verify_private_directory(&directory) {
                    // 未能证明目录的所有权时，不能递归删除其内容。
                    let _ = directory.remove_open_dir();
                    return Err(error);
                }
                return Ok(LocalStaging {
                    root: Some(LocalTransferRoot {
                        directory,
                        private: true,
                    }),
                });
            }
            Err(error) if error.kind() == io::ErrorKind::AlreadyExists => continue,
            Err(error) => return Err(error),
        }
    }
    Err(io::Error::new(
        io::ErrorKind::AlreadyExists,
        "无法分配唯一暂存目录",
    ))
}

#[cfg(not(unix))]
fn private_staging_in(_parent: &Dir) -> io::Result<LocalStaging> {
    Err(io::Error::new(
        io::ErrorKind::Unsupported,
        "此平台尚不能安全建立私有暂存目录",
    ))
}

#[cfg(unix)]
fn verify_private_directory(directory: &Dir) -> io::Result<()> {
    use cap_std::fs::MetadataExt;
    let metadata = directory.dir_metadata()?;
    // SAFETY: geteuid 不要求任何指针或其他前置条件。
    if metadata.uid() != unsafe { libc::geteuid() } || metadata.mode() & 0o077 != 0 {
        return Err(io::Error::new(
            io::ErrorKind::PermissionDenied,
            "暂存目录不是本用户的私有目录",
        ));
    }
    verify_no_extended_acl(directory)
}

#[cfg(not(unix))]
fn verify_private_directory(_directory: &Dir) -> io::Result<()> {
    Err(io::Error::new(
        io::ErrorKind::Unsupported,
        "无法验证私有暂存目录",
    ))
}

// macOS 扩展 ACL 的 allow 可以绕过 mode 0700；只接受纯 deny ACL。
#[cfg(target_os = "macos")]
fn verify_no_extended_acl(directory: &Dir) -> io::Result<()> {
    use std::ffi::c_void;
    unsafe extern "C" {
        fn acl_get_fd_np(fd: libc::c_int, kind: libc::c_int) -> *mut c_void;
        fn acl_get_entry(
            acl: *mut c_void,
            entry_id: libc::c_int,
            entry: *mut *mut c_void,
        ) -> libc::c_int;
        fn acl_get_tag_type(entry: *mut c_void, tag: *mut libc::c_int) -> libc::c_int;
        fn acl_free(value: *mut c_void) -> libc::c_int;
    }
    // SAFETY: fd 来自仍持有的目录，成功返回的 ACL 由 acl_free 释放。
    let acl = unsafe { acl_get_fd_np(directory.as_raw_fd(), 0x100) };
    if acl.is_null() {
        let error = io::Error::last_os_error();
        return match error.raw_os_error() {
            Some(libc::ENOENT) | Some(libc::ENOTSUP) => Ok(()),
            _ => Err(error),
        };
    }
    let result = (|| {
        // Darwin 的 acl_get_entry 成功返回 0，越过最后一项返回 EINVAL。
        // ACL_TYPE_EXTENDED 最多 169 项；未知 tag 一律拒绝。
        for index in 0..=169 {
            let mut entry = std::ptr::null_mut();
            // SAFETY: acl 是有效对象，entry 指向可写的指针空间。
            if unsafe { acl_get_entry(acl, index, &mut entry) } != 0 {
                let error = io::Error::last_os_error();
                return if error.raw_os_error() == Some(libc::EINVAL) {
                    Ok(())
                } else {
                    Err(error)
                };
            }
            let mut tag = 0;
            // SAFETY: entry 由 acl_get_entry 提供且 ACL 尚未释放。
            if unsafe { acl_get_tag_type(entry, &mut tag) } != 0 {
                return Err(io::Error::last_os_error());
            }
            if tag != 2 {
                return Err(io::Error::new(
                    io::ErrorKind::Unsupported,
                    "目录有可能扩大访问权限的 ACL",
                ));
            }
        }
        Err(io::Error::new(
            io::ErrorKind::Unsupported,
            "目录 ACL 项数异常",
        ))
    })();
    // SAFETY: acl_get_fd_np 返回的对象只能释放一次。
    unsafe { acl_free(acl) };
    result
}

#[cfg(all(unix, not(target_os = "macos")))]
fn verify_no_extended_acl(_directory: &Dir) -> io::Result<()> {
    Ok(())
}

fn check_target(parent: &Dir, name: &OsStr, overwrite: bool) -> io::Result<()> {
    match parent.symlink_metadata(name) {
        Ok(metadata) if !metadata.is_file() || metadata.file_type().is_symlink() => {
            Err(invalid_path("本地目标必须是普通文件，不能覆盖目录或链接"))
        }
        Ok(_) if !overwrite => Err(io::Error::new(
            io::ErrorKind::AlreadyExists,
            "本地目标文件已存在",
        )),
        Ok(_) => Ok(()),
        Err(error) if error.kind() == io::ErrorKind::NotFound => Ok(()),
        Err(error) => Err(error),
    }
}

#[cfg(unix)]
fn reservation_key(path: &Path) -> io::Result<LocalReservationKey> {
    use std::os::unix::fs::MetadataExt;
    if path.as_os_str().is_empty()
        || path
            .components()
            .any(|part| matches!(part, Component::ParentDir))
    {
        return Err(invalid_path("预占目标不能为空或包含父目录组件"));
    }
    let absolute = if path.is_absolute() {
        path.to_path_buf()
    } else {
        std::env::current_dir()?.join(path)
    };
    let mut existing = absolute.as_path();
    let mut missing = false;
    loop {
        match std::fs::symlink_metadata(existing) {
            Ok(metadata) => {
                if !missing && metadata.file_type().is_symlink() {
                    return Err(invalid_path("预占目标不能是链接"));
                }
                break;
            }
            Err(error) if error.kind() == io::ErrorKind::NotFound => {
                missing = true;
                existing = existing
                    .parent()
                    .ok_or_else(|| invalid_path("无法定位预占目标的祖先"))?;
            }
            Err(error) => return Err(error),
        }
    }
    let canonical = std::fs::canonicalize(existing)?;
    if missing && !std::fs::metadata(&canonical)?.is_dir() {
        return Err(invalid_path("预占目标的祖先不是目录"));
    }
    let mut identities = Vec::new();
    for ancestor in canonical.ancestors() {
        let metadata = std::fs::metadata(ancestor)?;
        identities.push((metadata.dev(), metadata.ino()));
    }
    if identities.is_empty() {
        return Err(io::Error::new(
            io::ErrorKind::Unsupported,
            "无法确定预占目标身份",
        ));
    }
    Ok(LocalReservationKey {
        identities,
        resolved: !missing,
    })
}

#[cfg(not(unix))]
fn reservation_key(path: &Path) -> io::Result<LocalReservationKey> {
    if path.as_os_str().is_empty()
        || path
            .components()
            .any(|part| matches!(part, Component::ParentDir))
    {
        return Err(invalid_path("预占目标不能为空或包含父目录组件"));
    }
    // 不能可靠取得文件系统身份时，所有本地目标保守互斥。
    Ok(LocalReservationKey {
        identities: vec![(0, 0)],
        resolved: false,
    })
}

#[derive(Default)]
struct ManifestNode {
    explicit: Option<LocalManifestEntryKind>,
    children: BTreeMap<OsString, ManifestNode>,
}

fn manifest_collision(path: &Path, kind: LocalManifestEntryKind) -> io::Error {
    io::Error::new(
        io::ErrorKind::AlreadyExists,
        LocalNameCollision {
            path: path.to_owned(),
            kind,
        },
    )
}

impl ManifestNode {
    fn insert(&mut self, path: &Path, kind: LocalManifestEntryKind) -> io::Result<()> {
        let (_, _) = split_relative(path)?;
        let mut node = self;
        for component in path.components() {
            let Component::Normal(name) = component else {
                return Err(invalid_path("清单路径必须是普通相对路径"));
            };
            if node.explicit == Some(LocalManifestEntryKind::File) {
                return Err(manifest_collision(path, kind));
            }
            node = node.children.entry(name.to_os_string()).or_default();
        }
        if node.explicit.is_some()
            || (kind == LocalManifestEntryKind::File && !node.children.is_empty())
        {
            return Err(manifest_collision(path, kind));
        }
        node.explicit = Some(kind);
        Ok(())
    }
}

#[cfg(not(windows))]
fn validate_manifest_node(
    node: &ManifestNode,
    real: Option<&Dir>,
    shadow: Option<&Dir>,
    path: &Path,
) -> io::Result<()> {
    if node.children.is_empty() {
        return Ok(());
    }
    // 已存在的真实父目录可能是挂载点或采用不同规则，必须在它内部探测。
    let stage = match real {
        Some(real) => Some(private_staging_in(real)?),
        None => None,
    };
    let probe = match &stage {
        Some(stage) => &stage.root().directory,
        None => shadow.expect("缺失的父目录具有同卷影子目录"),
    };
    if let Some(real) = real {
        verify_shadow_namespace(real, probe)?;
    }
    for (name, child) in &node.children {
        match probe.create_dir(name) {
            Ok(()) => {}
            Err(error) if error.kind() == io::ErrorKind::AlreadyExists => {
                return Err(manifest_collision(
                    &path.join(name),
                    child.explicit.unwrap_or(LocalManifestEntryKind::Directory),
                ));
            }
            Err(error) => return Err(error),
        }
    }
    for (name, child) in &node.children {
        let is_dir = child.explicit != Some(LocalManifestEntryKind::File);
        let existing = if let Some(real) = real {
            match real.symlink_metadata(name) {
                Ok(metadata) => {
                    if metadata.file_type().is_symlink()
                        || (is_dir && !metadata.is_dir())
                        || (!is_dir && !metadata.is_file())
                    {
                        return Err(invalid_path("清单目标与已有目录项类型冲突，或包含链接"));
                    }
                    if is_dir {
                        Some(real.open_dir_nofollow(name)?)
                    } else {
                        None
                    }
                }
                Err(error) if error.kind() == io::ErrorKind::NotFound => None,
                Err(error) => return Err(error),
            }
        } else {
            None
        };
        if is_dir && !child.children.is_empty() {
            let child_shadow = probe.open_dir_nofollow(name)?;
            verify_shadow_namespace(probe, &child_shadow)?;
            validate_manifest_node(
                child,
                existing.as_ref(),
                Some(&child_shadow),
                &path.join(name),
            )?;
        }
    }
    Ok(())
}

// 对不能证明目录规则会传递到新建子目录的文件系统拒绝预检，不能用影子目录猜测。
#[cfg(target_os = "macos")]
fn verify_shadow_namespace(parent: &Dir, shadow: &Dir) -> io::Result<()> {
    use std::ffi::CStr;
    fn filesystem(directory: &Dir) -> io::Result<String> {
        // SAFETY: fstatfs 初始化 statfs，并只读使用仍持有的目录 fd。
        let mut stat: libc::statfs = unsafe { std::mem::zeroed() };
        if unsafe { libc::fstatfs(directory.as_raw_fd(), &mut stat) } != 0 {
            return Err(io::Error::last_os_error());
        }
        // SAFETY: f_fstypename 是由内核提供的 NUL 结尾固定长度字符串。
        Ok(unsafe { CStr::from_ptr(stat.f_fstypename.as_ptr()) }
            .to_string_lossy()
            .into_owned())
    }
    let kind = filesystem(parent)?;
    if !matches!(kind.as_str(), "apfs" | "hfs" | "exfat" | "msdos") || filesystem(shadow)? != kind {
        return Err(io::Error::new(
            io::ErrorKind::Unsupported,
            "无法证明此文件系统的目录名称规则可由影子目录继承",
        ));
    }
    Ok(())
}

#[cfg(target_os = "linux")]
fn verify_shadow_namespace(parent: &Dir, shadow: &Dir) -> io::Result<()> {
    #[cfg(not(any(
        target_arch = "x86",
        target_arch = "x86_64",
        target_arch = "arm",
        target_arch = "aarch64",
        target_arch = "riscv64"
    )))]
    {
        let _ = (parent, shadow);
        return Err(io::Error::new(
            io::ErrorKind::Unsupported,
            "无法验证此架构的目录名称规则",
        ));
    }
    #[cfg(any(
        target_arch = "x86",
        target_arch = "x86_64",
        target_arch = "arm",
        target_arch = "aarch64",
        target_arch = "riscv64"
    ))]
    {
        fn filesystem(directory: &Dir) -> io::Result<u32> {
            // SAFETY: fstatfs 只读取持有的 fd 并填充 stat。
            let mut stat: libc::statfs = unsafe { std::mem::zeroed() };
            if unsafe { libc::fstatfs(directory.as_raw_fd(), &mut stat) } != 0 {
                return Err(io::Error::last_os_error());
            }
            Ok(stat.f_type as u32)
        }
        fn casefold(directory: &Dir) -> io::Result<bool> {
            // Linux _IOR('f', 1, long)，这些架构使用通用 ioctl 编码。
            let request = 0x8000_6601u64 | ((std::mem::size_of::<libc::c_long>() as u64) << 16);
            let mut flags: libc::c_int = 0;
            // SAFETY: fd 有效，指针指向可写的 inode flags 值。
            if unsafe { libc::ioctl(directory.as_raw_fd(), request as _, &mut flags) } != 0 {
                return Err(io::Error::new(
                    io::ErrorKind::Unsupported,
                    "无法读取文件系统的目录大小写属性",
                ));
            }
            Ok((flags as u32 & 0x4000_0000) != 0)
        }
        let kind = filesystem(parent)?;
        // ext4、f2fs、tmpfs、xfs、btrfs；未知网络或用户态文件系统不能推测规则。
        if !matches!(
            kind,
            0xef53 | 0xf2f5_2010 | 0x0102_1994 | 0x5846_5342 | 0x9123_683e
        ) || filesystem(shadow)? != kind
            || casefold(parent)? != casefold(shadow)?
        {
            return Err(io::Error::new(
                io::ErrorKind::Unsupported,
                "无法证明影子目录与目标具有相同的名称规则",
            ));
        }
        Ok(())
    }
}

#[cfg(not(any(target_os = "macos", target_os = "linux", windows)))]
fn verify_shadow_namespace(_parent: &Dir, _shadow: &Dir) -> io::Result<()> {
    Err(io::Error::new(
        io::ErrorKind::Unsupported,
        "无法验证此平台的目录名称规则",
    ))
}

// 不假定非 ASCII Unicode 的大小写、规范化或特定卷的短文件名规则。
// Windows 暂存 ACL 尚未能验证时，普通 SFTP 可使用严格 ASCII 子集安全预检。
#[cfg(any(windows, test))]
fn windows_safe_key(name: &OsStr) -> io::Result<Vec<u8>> {
    let name = name.to_str().ok_or_else(|| {
        io::Error::new(
            io::ErrorKind::Unsupported,
            "Windows 清单名称不是可验证的 ASCII",
        )
    })?;
    if !name.is_ascii() {
        return Err(io::Error::new(
            io::ErrorKind::Unsupported,
            "Windows 非 ASCII 名称需要文件系统实际预检",
        ));
    }
    let bytes = name.as_bytes();
    if bytes.is_empty()
        || matches!(bytes.last(), Some(b'.' | b' '))
        || bytes.iter().any(|byte| {
            *byte < 32
                || matches!(
                    byte,
                    b'<' | b'>' | b':' | b'"' | b'/' | b'\\' | b'|' | b'?' | b'*' | b'~'
                )
        })
    {
        return Err(invalid_path(
            "Windows 清单名称包含保留字符或不安全的短文件名",
        ));
    }
    let key: Vec<u8> = bytes.iter().map(u8::to_ascii_lowercase).collect();
    let stem = key.split(|byte| *byte == b'.').next().unwrap();
    let stem = stem.trim_ascii_end();
    if matches!(
        stem,
        b"con" | b"prn" | b"aux" | b"nul" | b"conin$" | b"conout$" | b"clock$"
    ) || (stem.len() == 4 && matches!(&stem[..3], b"com" | b"lpt") && stem[3].is_ascii_digit())
    {
        return Err(invalid_path("Windows 清单名称是保留设备名"));
    }
    Ok(key)
}

#[cfg(any(windows, test))]
fn validate_windows_manifest_node(
    node: &ManifestNode,
    real: Option<&Dir>,
    path: &Path,
) -> io::Result<()> {
    let mut names = std::collections::HashSet::new();
    for (name, child) in &node.children {
        if !names.insert(windows_safe_key(name)?) {
            return Err(manifest_collision(
                &path.join(name),
                child.explicit.unwrap_or(LocalManifestEntryKind::Directory),
            ));
        }
    }
    for (name, child) in &node.children {
        let is_dir = child.explicit != Some(LocalManifestEntryKind::File);
        let existing = if let Some(real) = real {
            match real.symlink_metadata(name) {
                Ok(metadata) => {
                    if metadata.file_type().is_symlink()
                        || (is_dir && !metadata.is_dir())
                        || (!is_dir && !metadata.is_file())
                    {
                        return Err(invalid_path("清单目标与已有目录项类型冲突，或包含链接"));
                    }
                    if is_dir {
                        Some(real.open_dir_nofollow(name)?)
                    } else {
                        None
                    }
                }
                Err(error) if error.kind() == io::ErrorKind::NotFound => None,
                Err(error) => return Err(error),
            }
        } else {
            None
        };
        if is_dir {
            validate_windows_manifest_node(child, existing.as_ref(), &path.join(name))?;
        }
    }
    Ok(())
}

fn rename_noreplace(source: &Dir, from: &OsStr, target: &Dir, to: &OsStr) -> io::Result<()> {
    match native_rename_noreplace(source, from, target, to) {
        Ok(()) => return Ok(()),
        Err(error) if cross_device(&error) => {
            return Err(io::Error::new(
                io::ErrorKind::Unsupported,
                "暂存区与目标不在同一文件系统",
            ));
        }
        Err(error) if error.kind() == io::ErrorKind::Unsupported => {}
        Err(error) => return Err(error),
    }
    // 只有原生原子操作不可用才退回同样不覆盖目标的 hard_link。
    match source.hard_link(from, target, to) {
        Ok(()) => source.remove_file(from),
        Err(error) if unsupported_link(&error) => {
            Err(io::Error::new(io::ErrorKind::Unsupported, error))
        }
        Err(error) => Err(error),
    }
}

fn cross_device(error: &io::Error) -> bool {
    #[cfg(unix)]
    return error.raw_os_error() == Some(libc::EXDEV);
    #[cfg(windows)]
    return error.raw_os_error() == Some(17);
    #[cfg(not(any(unix, windows)))]
    {
        let _ = error;
        false
    }
}

fn unsupported_link(error: &io::Error) -> bool {
    if error.kind() == io::ErrorKind::Unsupported {
        return true;
    }
    #[cfg(unix)]
    return matches!(
        error.raw_os_error(),
        Some(libc::ENOSYS) | Some(libc::ENOTSUP) | Some(libc::EXDEV)
    );
    #[cfg(windows)]
    return matches!(error.raw_os_error(), Some(1 | 17 | 50 | 120));
    #[cfg(not(any(unix, windows)))]
    false
}

#[cfg(any(target_os = "macos", target_os = "linux"))]
fn native_rename_noreplace(source: &Dir, from: &OsStr, target: &Dir, to: &OsStr) -> io::Result<()> {
    use std::ffi::CString;
    let from = CString::new(from.as_bytes()).map_err(|_| invalid_path("文件名包含 NUL"))?;
    let to = CString::new(to.as_bytes()).map_err(|_| invalid_path("文件名包含 NUL"))?;
    // SAFETY: 两个 fd 在调用期间持有，名称为已验证的单组件 NUL 结尾字符串。
    #[cfg(target_os = "macos")]
    let result = unsafe {
        libc::renameatx_np(
            source.as_raw_fd(),
            from.as_ptr(),
            target.as_raw_fd(),
            to.as_ptr(),
            libc::RENAME_EXCL,
        )
    };
    // SAFETY: renameat2 的参数是有效目录 fd 和单组件名称，不依赖 glibc 包装版本。
    #[cfg(target_os = "linux")]
    let result = unsafe {
        libc::syscall(
            libc::SYS_renameat2,
            source.as_raw_fd(),
            from.as_ptr(),
            target.as_raw_fd(),
            to.as_ptr(),
            libc::RENAME_NOREPLACE,
        )
    };
    if result == 0 {
        return Ok(());
    }
    let error = io::Error::last_os_error();
    match error.raw_os_error() {
        Some(libc::ENOSYS) | Some(libc::ENOTSUP) | Some(libc::EINVAL) => {
            Err(io::Error::new(io::ErrorKind::Unsupported, error))
        }
        _ => Err(error),
    }
}

#[cfg(windows)]
fn native_rename_noreplace(source: &Dir, from: &OsStr, target: &Dir, to: &OsStr) -> io::Result<()> {
    use cap_std::fs::OpenOptionsExt;
    use std::ffi::c_void;
    use std::os::windows::io::AsRawHandle;
    #[repr(C)]
    struct RenameInfo {
        flags: u32,
        root: *mut c_void,
        name_bytes: u32,
        name: [u16; 1],
    }
    #[link(name = "kernel32")]
    unsafe extern "system" {
        fn SetFileInformationByHandle(
            file: *mut c_void,
            class: i32,
            info: *const c_void,
            size: u32,
        ) -> i32;
    }
    let mut options = OpenOptions::new();
    // DELETE + FILE_READ_ATTRIBUTES，仅为按句柄重命名和核对文件类型所需。
    options
        .read(true)
        .access_mode(0x0001_0080)
        .follow(FollowSymlinks::No);
    let file = source.open_with(from, &options)?.into_std();
    if !file.metadata()?.is_file() {
        return Err(invalid_path("暂存源必须是普通文件"));
    }
    let name: Vec<u16> = to.encode_wide().collect();
    if name.is_empty() || name.contains(&0) {
        return Err(invalid_path("目标名称无效"));
    }
    let bytes = name
        .len()
        .checked_mul(2)
        .ok_or_else(|| invalid_path("目标名称过长"))?;
    let offset = std::mem::offset_of!(RenameInfo, name);
    let size = offset
        .checked_add(bytes)
        .ok_or_else(|| invalid_path("目标名称过长"))?;
    let size_u32 = u32::try_from(size).map_err(|_| invalid_path("目标名称过长"))?;
    let mut storage = vec![0u64; size.div_ceil(std::mem::size_of::<u64>())];
    let info = storage.as_mut_ptr().cast::<RenameInfo>();
    // SAFETY: storage 按 u64 对齐且长度足够；结构和名称都在缓冲区范围内。
    unsafe {
        (*info).root = target.as_raw_handle();
        (*info).name_bytes = u32::try_from(bytes).map_err(|_| invalid_path("目标名称过长"))?;
        std::ptr::copy_nonoverlapping(
            name.as_ptr(),
            std::ptr::addr_of_mut!((*info).name).cast::<u16>(),
            name.len(),
        );
        if SetFileInformationByHandle(file.as_raw_handle(), 3, info.cast(), size_u32) != 0 {
            return Ok(());
        }
    }
    let error = io::Error::last_os_error();
    match error.raw_os_error() {
        Some(1 | 50 | 120) => Err(io::Error::new(io::ErrorKind::Unsupported, error)),
        _ => Err(error),
    }
}

#[cfg(not(any(target_os = "macos", target_os = "linux", windows)))]
fn native_rename_noreplace(
    _source: &Dir,
    _from: &OsStr,
    _target: &Dir,
    _to: &OsStr,
) -> io::Result<()> {
    Err(io::Error::new(
        io::ErrorKind::Unsupported,
        "平台不支持原子 no-replace rename",
    ))
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

    #[cfg(unix)]
    #[test]
    fn case_insensitive_aliases_do_not_overwrite_each_other() {
        let fixture = Fixture::new();
        fs::write(fixture.0.join("A.txt"), b"first").unwrap();
        let aliases = fs::symlink_metadata(fixture.0.join("a.txt")).is_ok();
        fs::remove_file(fixture.0.join("A.txt")).unwrap();
        if !aliases {
            return;
        }

        let root = LocalTransferRoot::open(&fixture.0).unwrap();
        let error = root
            .validate_manifest(&[], &["A.txt".into(), "a.txt".into()])
            .unwrap_err();
        assert!(error.get_ref().unwrap().is::<LocalNameCollision>());
        assert_eq!(fs::read_dir(&fixture.0).unwrap().count(), 0);
    }

    #[cfg(unix)]
    #[test]
    fn private_staging_publish_and_cleanup() {
        let fixture = Fixture::new();
        let root = LocalTransferRoot::open(&fixture.0).unwrap();
        let stage = root.private_staging().unwrap();
        let mut file = stage
            .root()
            .prepare_download(Path::new("item-1"), false)
            .unwrap();
        file.file_mut().write_all(b"staged").unwrap();
        file.commit().unwrap();
        root.publish_from(
            stage.root(),
            Path::new("item-1"),
            Path::new("nested/file"),
            false,
        )
        .unwrap();
        assert_eq!(fs::read(fixture.0.join("nested/file")).unwrap(), b"staged");
        drop(stage);
        assert_eq!(fs::read_dir(&fixture.0).unwrap().count(), 1);
    }

    #[cfg(unix)]
    #[test]
    fn staging_cleanup_does_not_delete_a_replacement_directory() {
        let fixture = Fixture::new();
        let root = LocalTransferRoot::open(&fixture.0).unwrap();
        let stage = root.private_staging().unwrap();
        let original = fs::read_dir(&fixture.0)
            .unwrap()
            .next()
            .unwrap()
            .unwrap()
            .path();
        let moved = fixture.0.join("moved");
        fs::rename(&original, &moved).unwrap();
        fs::create_dir(&original).unwrap();
        fs::write(original.join("keep"), b"unrelated").unwrap();
        drop(stage);
        assert_eq!(fs::read(original.join("keep")).unwrap(), b"unrelated");
        assert!(!moved.exists());
    }

    #[cfg(unix)]
    #[test]
    fn manifest_detects_file_directory_and_duplicate_conflicts() {
        let fixture = Fixture::new();
        let root = LocalTransferRoot::open(&fixture.0).unwrap();
        for (directories, files) in [
            (vec!["a".into()], vec!["a".into()]),
            (vec![], vec!["a".into(), "a/child".into()]),
            (vec![], vec!["a".into(), "a".into()]),
        ] {
            let error = root.validate_manifest(&directories, &files).unwrap_err();
            assert!(error.get_ref().unwrap().is::<LocalNameCollision>());
        }
        assert_eq!(fs::read_dir(&fixture.0).unwrap().count(), 0);
    }

    #[cfg(unix)]
    #[test]
    fn manifest_rejects_excessive_depth_before_creating_probes() {
        let fixture = Fixture::new();
        let root = LocalTransferRoot::open(&fixture.0).unwrap();
        let deep = std::iter::repeat_n("x", 129).collect::<PathBuf>();
        assert_eq!(
            root.validate_manifest(&[], &[deep]).unwrap_err().kind(),
            io::ErrorKind::InvalidInput
        );
        assert_eq!(fs::read_dir(&fixture.0).unwrap().count(), 0);
    }

    #[cfg(target_os = "macos")]
    #[test]
    fn private_staging_accepts_deny_only_acl_but_rejects_allow_acl() {
        use std::process::Command;
        struct ClearAcl(PathBuf);
        impl Drop for ClearAcl {
            fn drop(&mut self) {
                let _ = Command::new("chmod").arg("-N").arg(&self.0).status();
            }
        }
        let fixture = Fixture::new();
        let _clear = ClearAcl(fixture.0.clone());
        assert!(Command::new("chmod")
            .args(["+a", "everyone deny delete"])
            .arg(&fixture.0)
            .status()
            .unwrap()
            .success());
        let root = LocalTransferRoot::open(&fixture.0).unwrap();
        drop(root.private_staging().unwrap());
        assert!(Command::new("chmod")
            .arg("-N")
            .arg(&fixture.0)
            .status()
            .unwrap()
            .success());
        assert!(Command::new("chmod")
            .args(["+a", "everyone allow read"])
            .arg(&fixture.0)
            .status()
            .unwrap()
            .success());
        assert_eq!(
            root.private_staging().err().unwrap().kind(),
            io::ErrorKind::Unsupported
        );
    }

    #[test]
    fn windows_conservative_names_reject_aliases_devices_and_unicode() {
        assert_eq!(
            windows_safe_key(OsStr::new("A.txt")).unwrap(),
            windows_safe_key(OsStr::new("a.TXT")).unwrap()
        );
        for name in [
            "CON.txt", "CON .txt", "LPT9", "bad:name", "foo.", "foo ", "FOO~1",
        ] {
            assert_eq!(
                windows_safe_key(OsStr::new(name)).unwrap_err().kind(),
                io::ErrorKind::InvalidInput
            );
        }
        assert_eq!(
            windows_safe_key(OsStr::new("é.txt")).unwrap_err().kind(),
            io::ErrorKind::Unsupported
        );
        let mut tree = ManifestNode::default();
        tree.insert(Path::new("A/item"), LocalManifestEntryKind::File)
            .unwrap();
        tree.insert(Path::new("a/other"), LocalManifestEntryKind::File)
            .unwrap();
        let error = validate_windows_manifest_node(&tree, None, Path::new("")).unwrap_err();
        assert!(error.get_ref().unwrap().is::<LocalNameCollision>());
    }

    #[cfg(unix)]
    #[test]
    fn manifest_uses_actual_unicode_and_implicit_parent_aliases() {
        let fixture = Fixture::new();
        let root = LocalTransferRoot::open(&fixture.0).unwrap();
        fs::create_dir(fixture.0.join("existing")).unwrap();
        fs::write(fixture.0.join("existing/é"), b"probe").unwrap();
        let unicode_alias = fixture.0.join("existing/e\u{301}").exists();
        fs::remove_file(fixture.0.join("existing/é")).unwrap();
        let result =
            root.validate_manifest(&[], &["existing/é".into(), "existing/e\u{301}".into()]);
        if unicode_alias {
            assert!(result
                .unwrap_err()
                .get_ref()
                .unwrap()
                .is::<LocalNameCollision>());
        } else {
            result.unwrap();
        }
        let case_alias = {
            fs::create_dir(fixture.0.join("Upper")).unwrap();
            let alias = fixture.0.join("upper").exists();
            fs::remove_dir(fixture.0.join("Upper")).unwrap();
            alias
        };
        let result = root.validate_manifest(&[], &["Upper/one".into(), "upper/two".into()]);
        if case_alias {
            assert!(result
                .unwrap_err()
                .get_ref()
                .unwrap()
                .is::<LocalNameCollision>());
        } else {
            result.unwrap();
        }
        assert_eq!(fs::read_dir(&fixture.0).unwrap().count(), 1);
    }

    #[cfg(unix)]
    #[test]
    fn stage_publish_preserves_late_target_and_rejects_nonprivate_sources() {
        let fixture = Fixture::new();
        let root = LocalTransferRoot::open(&fixture.0).unwrap();
        let stage = root.private_staging().unwrap();
        let mut file = stage
            .root()
            .prepare_download(Path::new("id"), false)
            .unwrap();
        file.file_mut().write_all(b"new").unwrap();
        file.commit().unwrap();
        fs::write(fixture.0.join("target"), b"late").unwrap();
        assert_eq!(
            root.publish_from(stage.root(), Path::new("id"), Path::new("target"), false)
                .unwrap_err()
                .kind(),
            io::ErrorKind::AlreadyExists
        );
        assert_eq!(fs::read(fixture.0.join("target")).unwrap(), b"late");
        assert!(root
            .publish_from(&root, Path::new("target"), Path::new("other"), false)
            .is_err());
        root.publish_from(stage.root(), Path::new("id"), Path::new("target"), true)
            .unwrap();
        assert_eq!(fs::read(fixture.0.join("target")).unwrap(), b"new");
        drop(stage);
        assert_eq!(fs::read_dir(&fixture.0).unwrap().count(), 1);
    }

    #[cfg(unix)]
    #[test]
    fn manifest_and_publish_reject_symlinks() {
        use std::os::unix::fs::symlink;
        let fixture = Fixture::new();
        let outside = Fixture::new();
        let root = LocalTransferRoot::open(&fixture.0).unwrap();
        symlink(&outside.0, fixture.0.join("linked")).unwrap();
        assert!(root
            .validate_manifest(&[], &["linked/file".into()])
            .is_err());
        let stage = root.private_staging().unwrap();
        let stage_path = fs::read_dir(&fixture.0)
            .unwrap()
            .map(|entry| entry.unwrap().path())
            .find(|path| {
                path.file_name()
                    .unwrap()
                    .to_string_lossy()
                    .starts_with(".portal-stage-")
            })
            .unwrap();
        symlink(outside.0.join("secret"), stage_path.join("bad")).unwrap();
        assert!(root
            .publish_from(stage.root(), Path::new("bad"), Path::new("target"), false)
            .is_err());
        drop(stage);
        assert!(!fixture.0.join("target").exists());
        assert_eq!(fs::read_dir(&outside.0).unwrap().count(), 0);
    }

    #[test]
    fn reservation_conflicts_for_aliases_ancestors_and_unresolved_siblings() {
        let fixture = Fixture::new();
        fs::create_dir(fixture.0.join("Existing")).unwrap();
        let existing = LocalTransferRoot::reservation_key(&fixture.0.join("Existing")).unwrap();
        let child = LocalTransferRoot::reservation_key(&fixture.0.join("Existing/child")).unwrap();
        let alias = LocalTransferRoot::reservation_key(&fixture.0.join("existing/child")).unwrap();
        assert!(existing.conflicts(&child));
        #[cfg(unix)]
        {
            assert!(existing.is_resolved());
            assert!(!child.is_resolved());
            assert!(!existing.same_resolved_target(&child));
        }
        if fixture.0.join("existing").exists() {
            assert!(existing.conflicts(&alias));
            assert!(child.conflicts(&alias));
            #[cfg(unix)]
            {
                let alias_root =
                    LocalTransferRoot::reservation_key(&fixture.0.join("existing")).unwrap();
                assert!(existing.same_resolved_target(&alias_root));
            }
        }
        let first = LocalTransferRoot::reservation_key(&fixture.0.join("MissingA/child")).unwrap();
        let second = LocalTransferRoot::reservation_key(&fixture.0.join("MissingB")).unwrap();
        assert!(first.conflicts(&second));
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
