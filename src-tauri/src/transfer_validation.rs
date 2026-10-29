//! 传输结束时校验字节数和源文件元数据。

use std::fmt;
use std::fs::Metadata;
use std::io;
use std::time::SystemTime;

/// 从同一个源文件句柄获取的可用大小和修改时间。
///
/// `None` 表示服务器未提供该字段，而不是零。缺失字段无法证明源文件未变。
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) struct SourceStamp {
    pub(crate) size: Option<u64>,
    pub(crate) modified: Option<SystemTime>,
}

impl SourceStamp {
    pub(crate) fn new(size: Option<u64>, modified: Option<SystemTime>) -> Self {
        Self { size, modified }
    }

    /// 本地文件的修改时间不可读时返回错误，避免把检查失败当作未知时间。
    pub(crate) fn from_local_metadata(metadata: &Metadata) -> io::Result<Self> {
        Ok(Self::new(Some(metadata.len()), Some(metadata.modified()?)))
    }
}

/// 覆盖目标的可观察身份；读取时间不参与比较，避免正常读操作造成误报。
///
/// SFTP v3 不提供 inode 或原子条件替换，无法检测同大小、同时间的远端并发
/// 替换；调用方还须在提交前尽可能晚地复核，并维持私有父目录的权限边界。
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) struct UploadTargetStamp {
    size: Option<u64>,
    uid: Option<u32>,
    gid: Option<u32>,
    mode: u32,
    modified: Option<u64>,
}

impl UploadTargetStamp {
    pub(crate) fn from_stat(stat: &ssh2::FileStat) -> Result<Self, &'static str> {
        if !stat.is_file() {
            return Err("覆盖目标不是普通文件");
        }
        Ok(Self {
            size: stat.size,
            uid: stat.uid,
            gid: stat.gid,
            mode: stat.perm.ok_or("服务器缺少覆盖目标的权限元数据")?,
            modified: stat.mtime,
        })
    }
}

/// 目标在传输期间出现、消失或元数据变化时不提交，也不恢复已经收紧的权限。
pub(crate) fn validate_upload_target(
    before: Option<UploadTargetStamp>,
    current: Option<UploadTargetStamp>,
) -> Result<u32, &'static str> {
    if before != current {
        return Err("覆盖目标在上传期间发生变化，已保留当前目标；不会自动重试");
    }
    match current {
        Some(stamp) => {
            normal_permissions(Some(stamp.mode)).map_err(|_| "服务器缺少覆盖目标的权限元数据")
        }
        None => Ok(0o600),
    }
}

/// 导致传输结果不能安全提交的校验错误。
#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) enum TransferValidationError {
    LengthMismatch { expected: u64, actual: u64 },
    SourceChanged { field: &'static str },
    MetadataUnavailable { field: &'static str },
}

impl fmt::Display for TransferValidationError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::LengthMismatch { expected, actual } => {
                write!(
                    formatter,
                    "传输字节数不匹配：预期 {expected}，实际 {actual}"
                )
            }
            Self::SourceChanged { field } => {
                write!(formatter, "源文件的 {field} 在传输期间发生变化")
            }
            Self::MetadataUnavailable { field } => {
                write!(formatter, "无法获取所需的 {field} 元数据")
            }
        }
    }
}

impl std::error::Error for TransferValidationError {}

/// 仅保留普通 rwx 权限；缺失权限元数据时不能推测默认值。
///
/// 文件类型、所有权、ACL 和父目录授权须由调用方另行校验。
pub(crate) fn normal_permissions(mode: Option<u32>) -> Result<u32, TransferValidationError> {
    mode.map(|value| value & 0o777)
        .ok_or(TransferValidationError::MetadataUnavailable {
            field: "permissions",
        })
}

/// 使用源句柄在传输前后的元数据和实际写入字节数验证结果。
///
/// 未知字段不会作为零处理；已知字段在事后丢失时拒绝提交。即使校验通过，
/// 不提供大小或时间的服务器以及同大小、同时间的内容修改仍可能无法检出。
pub(crate) fn validate_transfer(
    before: &SourceStamp,
    after: &SourceStamp,
    actual_bytes: u64,
) -> Result<(), TransferValidationError> {
    validate_field(&before.size, &after.size, "size")?;
    validate_field(&before.modified, &after.modified, "modified")?;
    for expected in [before.size, after.size].into_iter().flatten() {
        if expected != actual_bytes {
            return Err(TransferValidationError::LengthMismatch {
                expected,
                actual: actual_bytes,
            });
        }
    }
    Ok(())
}

fn validate_field<T: PartialEq>(
    before: &Option<T>,
    after: &Option<T>,
    field: &'static str,
) -> Result<(), TransferValidationError> {
    match (before, after) {
        (Some(_), None) => Err(TransferValidationError::MetadataUnavailable { field }),
        (Some(before), Some(after)) if before != after => {
            Err(TransferValidationError::SourceChanged { field })
        }
        _ => Ok(()),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::time::{Duration, UNIX_EPOCH};

    #[test]
    fn upload_target_changes_cannot_restore_old_permissions_or_replace_a_new_leaf() {
        let original = ssh2::FileStat {
            size: Some(3),
            uid: Some(1000),
            gid: Some(1000),
            perm: Some(0o100666),
            atime: Some(1),
            mtime: Some(1),
        };
        let before = UploadTargetStamp::from_stat(&original).unwrap();
        assert_eq!(
            validate_upload_target(Some(before), Some(before)).unwrap(),
            0o666
        );
        let mut tightened = original.clone();
        tightened.perm = Some(0o100600);
        assert!(validate_upload_target(
            Some(before),
            Some(UploadTargetStamp::from_stat(&tightened).unwrap())
        )
        .is_err());
        assert!(validate_upload_target(None, Some(before)).is_err());
        assert!(validate_upload_target(Some(before), None).is_err());
        assert_eq!(validate_upload_target(None, None).unwrap(), 0o600);
        let mut changed = original.clone();
        changed.size = Some(4);
        assert!(validate_upload_target(
            Some(before),
            Some(UploadTargetStamp::from_stat(&changed).unwrap())
        )
        .is_err());
        changed = original.clone();
        changed.uid = Some(1001);
        assert!(validate_upload_target(
            Some(before),
            Some(UploadTargetStamp::from_stat(&changed).unwrap())
        )
        .is_err());
    }

    #[test]
    fn unknown_length_is_not_treated_as_an_empty_file() {
        let unknown = SourceStamp::new(None, None);
        assert!(validate_transfer(&unknown, &unknown, 7).is_ok());

        let empty = SourceStamp::new(Some(0), None);
        assert_eq!(
            validate_transfer(&empty, &empty, 7),
            Err(TransferValidationError::LengthMismatch {
                expected: 0,
                actual: 7,
            })
        );
        assert!(validate_transfer(&empty, &empty, 0).is_ok());
    }

    #[test]
    fn requires_the_byte_count_to_match_every_available_size() {
        let before = SourceStamp::new(Some(3), None);
        let after = SourceStamp::new(Some(3), None);
        assert_eq!(
            validate_transfer(&before, &after, 2),
            Err(TransferValidationError::LengthMismatch {
                expected: 3,
                actual: 2,
            })
        );
        let unknown_before = SourceStamp::new(None, None);
        assert_eq!(
            validate_transfer(&unknown_before, &after, 2),
            Err(TransferValidationError::LengthMismatch {
                expected: 3,
                actual: 2,
            })
        );
    }

    #[test]
    fn detects_changed_size_and_nanosecond_timestamp() {
        let modified = UNIX_EPOCH + Duration::from_secs(42);
        let before = SourceStamp::new(Some(3), Some(modified));
        let resized = SourceStamp::new(Some(4), Some(modified));
        let retimed = SourceStamp::new(Some(3), Some(modified + Duration::from_nanos(1)));
        assert_eq!(
            validate_transfer(&before, &resized, 3),
            Err(TransferValidationError::SourceChanged { field: "size" })
        );
        assert_eq!(
            validate_transfer(&before, &retimed, 3),
            Err(TransferValidationError::SourceChanged { field: "modified" })
        );
    }

    #[test]
    fn rejects_losing_a_previously_known_size_or_timestamp() {
        let modified = UNIX_EPOCH + Duration::from_secs(42);
        let before = SourceStamp::new(Some(3), Some(modified));
        assert_eq!(
            validate_transfer(&before, &SourceStamp::new(None, Some(modified)), 3),
            Err(TransferValidationError::MetadataUnavailable { field: "size" })
        );
        assert_eq!(
            validate_transfer(&before, &SourceStamp::new(Some(3), None), 3),
            Err(TransferValidationError::MetadataUnavailable { field: "modified" })
        );
    }

    #[test]
    fn local_stamp_preserves_file_size_and_full_modified_time() {
        let metadata = std::fs::metadata(file!()).unwrap();
        let stamp = SourceStamp::from_local_metadata(&metadata).unwrap();
        assert_eq!(stamp.size, Some(metadata.len()));
        assert_eq!(stamp.modified, Some(metadata.modified().unwrap()));
    }

    #[test]
    fn normal_permissions_keep_only_rwx_bits_and_preserve_zero() {
        assert_eq!(normal_permissions(Some(0o107640)), Ok(0o640));
        assert_eq!(normal_permissions(Some(0o100777)), Ok(0o777));
        assert_eq!(normal_permissions(Some(0)), Ok(0));
    }

    #[test]
    fn normal_permissions_require_the_mode_to_be_available() {
        assert_eq!(
            normal_permissions(None),
            Err(TransferValidationError::MetadataUnavailable {
                field: "permissions"
            })
        );
    }
}
