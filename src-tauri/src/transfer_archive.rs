//! 批量引擎与归档数据流的桥接：私有暂存、源复核和逐项安全提交。
use super::*;
use crate::archive_transfer::{
    self as archive, ArchiveManifest, ArchiveTransferError, ManifestBlock, ManifestEntry,
};
use crate::local_transfer::LocalDownload;
use crate::transfer_validation::{validate_transfer, validate_upload_target, UploadTargetStamp};
use std::io::{self, Write};

pub(super) fn archive_error(error: ArchiveTransferError) -> SshError {
    match error {
        ArchiveTransferError::Unsupported(message) => SshError::ArchiveUnsupported(message),
        ArchiveTransferError::Cancelled => SshError::TransferCancelled,
        ArchiveTransferError::SourceChanged(message) => SshError::SourceChanged(message),
        ArchiveTransferError::Io(error) => error.into(),
        other => SshError::FileOperationFailed(other.to_string()),
    }
}

pub(super) fn manifest(files: &[PlannedFile]) -> Result<ArchiveManifest, SshError> {
    ArchiveManifest::new(
        files
            .iter()
            .map(|file| ManifestEntry {
                source_path: file.source_relative.clone(),
                relative_path: file.relative.clone(),
                internal_id: file.item_id.clone(),
                size: file.size.unwrap_or(0),
                stamp: file.stamp,
            })
            .collect(),
    )
    .map_err(archive_error)
}

/// 自动压缩只覆盖明确的文本格式；已压缩媒体和未知内容保留原始数据流。
pub(super) fn gzip_for(
    files: &[PlannedFile],
    compression: &str,
    supported: bool,
) -> Result<bool, SshError> {
    if compression == "gzip" && !supported {
        return Err(SshError::ArchiveUnsupported("远端没有 gzip".into()));
    }
    if !supported || compression == "none" {
        return Ok(false);
    }
    if compression == "gzip" {
        return Ok(true);
    }
    let text = files.iter().filter(|file| {
        matches!(
            file.relative
                .extension()
                .and_then(|s| s.to_str())
                .unwrap_or("")
                .to_ascii_lowercase()
                .as_str(),
            "txt"
                | "log"
                | "csv"
                | "json"
                | "xml"
                | "html"
                | "css"
                | "js"
                | "jsx"
                | "ts"
                | "tsx"
                | "rs"
                | "java"
                | "kt"
                | "py"
                | "md"
                | "yaml"
                | "yml"
                | "sql"
                | "toml"
        )
    });
    let text_bytes: u64 = text.map(|file| file.size.unwrap_or(0)).sum();
    let bytes: u64 = files.iter().map(|file| file.size.unwrap_or(0)).sum();
    Ok(bytes > 4096 && text_bytes >= bytes.saturating_sub(text_bytes))
}

struct ArchiveWriter(Option<LocalDownload>);
impl Write for ArchiveWriter {
    fn write(&mut self, bytes: &[u8]) -> io::Result<usize> {
        self.0.as_mut().unwrap().file_mut().write(bytes)
    }
    fn flush(&mut self) -> io::Result<()> {
        self.0.as_mut().unwrap().file_mut().flush()
    }
}

type FileOutcome = (PlannedFile, Result<u64, SshError>);

pub(super) fn download(
    context: &FileTransferContext<'_>,
    files: Vec<PlannedFile>,
    block: &ManifestBlock,
    gzip: bool,
) -> Result<Vec<FileOutcome>, (Vec<PlannedFile>, SshError)> {
    let work = (|| -> Result<Vec<Result<u64, SshError>>, SshError> {
        let stage = files[0].root.private_staging()?;
        for file in &files {
            validate_remote(context.sftp, file)?;
        }
        let session = context.session.lock().unwrap().clone();
        let cancel = || {
            context.state.tasks.heartbeat(context.transfer_id);
            context.cancelled()
        };
        let staged = archive::download_block(
            &session,
            block,
            &files[0].remote_root,
            gzip,
            &cancel,
            &mut |entry| {
                Ok(ArchiveWriter(Some(
                    stage
                        .root()
                        .prepare_download(Path::new(&entry.internal_id), false)?,
                )))
            },
        )
        .map_err(archive_error)?;
        let mut staged: HashMap<_, _> = staged
            .into_iter()
            .map(|staged| (staged.entry.internal_id, staged.writer))
            .collect();
        let mut results = Vec::with_capacity(files.len());
        for file in &files {
            let result = (|| {
                if context.cancelled() {
                    return Err(SshError::TransferCancelled);
                }
                // 单项在归档读取后发生变化只影响该项，其余已验证文件仍可安全发布。
                validate_remote(context.sftp, file)?;
                let mut writer = staged.remove(&file.item_id).ok_or_else(|| {
                    SshError::FileOperationFailed("归档缺少已验证的暂存项".into())
                })?;
                writer.0.take().unwrap().commit()?;
                context.begin_commit()?;
                file.root.publish_from(
                    stage.root(),
                    Path::new(&file.item_id),
                    &file.relative,
                    context.overwrite,
                )?;
                Ok(file.size.unwrap_or(0))
            })();
            if let Some(worker) = context.worker_id {
                context.state.tasks.end_commit(context.transfer_id, worker);
            }
            results.push(result);
        }
        Ok(results)
    })();
    match work {
        Ok(results) => Ok(files.into_iter().zip(results).collect()),
        Err(error) => Err((files, error)),
    }
}

pub(super) fn validate_remote(sftp: &ssh2::Sftp, file: &PlannedFile) -> Result<(), SshError> {
    let stat = sftp
        .lstat(Path::new(&file.remote_path))
        .map_err(|error| SshError::FileOperationFailed(error.to_string()))?;
    if !stat.is_file() {
        return Err(SshError::SourceChanged("远端归档源不再是普通文件".into()));
    }
    let after = super::super::remote_source_stamp(&stat)?;
    validate_transfer(&file.stamp, &after, file.size.unwrap_or(0))
        .map_err(|error| SshError::SourceChanged(error.to_string()))
}

pub(super) fn preflight(
    context: &FileTransferContext<'_>,
    file: &PlannedFile,
    upload: bool,
) -> Result<(), SshError> {
    if context.cancelled() {
        return Err(SshError::TransferCancelled);
    }
    if upload {
        let source = file.root.open_source(&file.relative)?;
        let now =
            crate::transfer_validation::SourceStamp::from_local_metadata(&source.metadata()?)?;
        validate_transfer(&file.stamp, &now, file.size.unwrap_or(0))
            .map_err(|error| SshError::SourceChanged(error.to_string()))
    } else {
        validate_remote(context.sftp, file)
    }
}

/// 暂存区内只允许已知内部 ID；清理绝不执行递归 shell 删除或使用用户文件名。
struct RemoteStage<'a> {
    sftp: &'a ssh2::Sftp,
    path: String,
    ids: Vec<String>,
}
impl Drop for RemoteStage<'_> {
    fn drop(&mut self) {
        for id in &self.ids {
            let _ = self.sftp.unlink(Path::new(&format!("{}/{id}", self.path)));
        }
        let _ = self.sftp.rmdir(Path::new(&self.path));
    }
}

pub(super) fn upload(
    context: &FileTransferContext<'_>,
    policy: &super::super::RemoteMutationPolicy,
    files: Vec<PlannedFile>,
    block: &ManifestBlock,
    gzip: bool,
) -> Result<Vec<FileOutcome>, (Vec<PlannedFile>, SshError)> {
    let work = (|| -> Result<Vec<Result<u64, SshError>>, SshError> {
        let stage_path = format!(
            "{}/.portal-stage-{:032x}",
            files[0].remote_root.trim_end_matches('/'),
            rand::random::<u128>()
        );
        policy
            .validate_parent(context.sftp, Path::new(&stage_path))
            .map_err(SshError::FileOperationFailed)?;
        context
            .sftp
            .mkdir(Path::new(&stage_path), 0o700)
            .map_err(|error| SshError::FileOperationFailed(error.to_string()))?;
        let stage = RemoteStage {
            sftp: context.sftp,
            path: stage_path,
            ids: files.iter().map(|file| file.item_id.clone()).collect(),
        };
        policy
            .validate_directory(context.sftp, Path::new(&stage.path))
            .map_err(SshError::FileOperationFailed)?;
        let before: Vec<Result<Option<UploadTargetStamp>, SshError>> = files
            .iter()
            .map(|file| {
                policy
                    .validate_parent(context.sftp, Path::new(&file.remote_path))
                    .map_err(SshError::FileOperationFailed)?;
                let target =
                    super::super::upload_target_stamp(context.sftp, Path::new(&file.remote_path))?;
                if target.is_some() && !context.overwrite {
                    return Err(SshError::TargetExists(file.remote_path.clone()));
                }
                Ok(target)
            })
            .collect();
        let session = context.session.lock().unwrap().clone();
        let cancel = || {
            context.state.tasks.heartbeat(context.transfer_id);
            context.cancelled()
        };
        let by_id: HashMap<_, _> = files
            .iter()
            .map(|file| (file.item_id.as_str(), file))
            .collect();
        archive::upload_block(&session, block, &stage.path, gzip, &cancel, &|entry| {
            by_id
                .get(entry.internal_id.as_str())
                .ok_or_else(|| io::Error::new(io::ErrorKind::InvalidInput, "归档内部 ID 无效"))?
                .root
                .open_source(&entry.relative_path)
        })
        .map_err(archive_error)?;
        let mut results = Vec::with_capacity(files.len());
        for (file, before) in files.iter().zip(before) {
            let result = before.and_then(|before| {
                if context.cancelled() {
                    return Err(SshError::TransferCancelled);
                }
                let temporary = format!("{}/{}", stage.path, file.item_id);
                let stat = context
                    .sftp
                    .lstat(Path::new(&temporary))
                    .map_err(|error| SshError::FileOperationFailed(error.to_string()))?;
                if !stat.is_file() || stat.size != file.size {
                    return Err(SshError::SourceChanged(
                        "上传归档暂存文件类型或长度不匹配".into(),
                    ));
                }
                policy
                    .validate_parent(context.sftp, Path::new(&file.remote_path))
                    .map_err(SshError::FileOperationFailed)?;
                let current =
                    super::super::upload_target_stamp(context.sftp, Path::new(&file.remote_path))?;
                let mode = validate_upload_target(before, current)
                    .map_err(|error| SshError::SourceChanged(error.into()))?;
                context
                    .sftp
                    .setstat(
                        Path::new(&temporary),
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
                super::super::rename_remote_file_cached(
                    context.sftp,
                    &session,
                    Path::new(&temporary),
                    Path::new(&file.remote_path),
                    context.overwrite,
                    context.rename_client,
                    || context.cancelled(),
                    || {
                        let now = super::super::upload_target_stamp(
                            context.sftp,
                            Path::new(&file.remote_path),
                        )
                        .map_err(|error| {
                            crate::sftp_commit::CommitError::Protocol(error.to_string())
                        })?;
                        validate_upload_target(before, now).map_err(|error| {
                            crate::sftp_commit::CommitError::Protocol(error.into())
                        })?;
                        context
                            .begin_commit()
                            .map_err(|_| crate::sftp_commit::CommitError::Cancelled)
                    },
                )?;
                Ok(file.size.unwrap_or(0))
            });
            if let Some(worker) = context.worker_id {
                context.state.tasks.end_commit(context.transfer_id, worker);
            }
            results.push(result);
        }
        Ok(results)
    })();
    match work {
        Ok(results) => Ok(files.into_iter().zip(results).collect()),
        Err(error) => Err((files, error)),
    }
}
