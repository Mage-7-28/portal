import { useEffect, useState } from 'react'
import { Button, Checkbox, Modal } from 'antd'
import AppIcon from './AppIcon'

const UpdateAvailableModal = ({ open, update, canSkipVersion = true, onCancel, onDownload }) => {
  const [ skipVersion, setSkipVersion ] = useState(false)
  const [ opening, setOpening ] = useState(false)

  useEffect(() => {
    if (open) {
      setSkipVersion(false)
      setOpening(false)
    }
  }, [ canSkipVersion, open, update?.latestVersion ])

  if (!update) return null

  const handleCancel = () => {
    if (opening) return
    void onCancel({
      skipVersion: canSkipVersion && skipVersion,
      version: update.latestVersion
    })
  }

  const handleDownload = async () => {
    if (opening) return

    setOpening(true)
    try {
      await onDownload({
        skipVersion: canSkipVersion && skipVersion,
        version: update.latestVersion,
        releaseUrl: update.releaseUrl
      })
    } finally {
      setOpening(false)
    }
  }

  return (
    <Modal
      rootClassName="compact-modal update-modal"
      open={open}
      title={null}
      centered
      width="min(380px, calc(100vw - 24px))"
      closable={!opening}
      maskClosable={!opening}
      onCancel={handleCancel}
      footer={(
        <div className="modal-actions">
          <Button onClick={handleCancel} disabled={opening}>稍后再说</Button>
          <Button
            type="primary"
            icon={<AppIcon name="download" />}
            loading={opening}
            onClick={handleDownload}
          >
            前往下载
          </Button>
        </div>
      )}
      destroyOnHidden
    >
      <section className="update-available-content" aria-label="发现新版本">
        <div className="update-available-heading">
          <AppIcon className="update-available-icon" name="download" size="30" />
          <div>
            <h2 className="update-available-title">发现新版本</h2>
            <p className="update-available-summary">Portal 有新的版本可供下载</p>
          </div>
        </div>

        <div className="update-available-versions" aria-label="版本信息">
          <div className="update-available-version">
            <span className="update-available-version-label">当前版本</span>
            <strong>{update.currentVersion}</strong>
          </div>
          <div className="update-available-version update-available-version-new">
            <span className="update-available-version-label">最新版本</span>
            <strong>{update.latestVersion}</strong>
          </div>
        </div>

        <p className="update-available-note">
          确认后将打开 Gitee 发布页面，请选择与你的系统匹配的安装包手动更新。
        </p>

        {canSkipVersion && (
          <Checkbox checked={skipVersion} onChange={event => setSkipVersion(event.target.checked)}>
            跳过此版本
          </Checkbox>
        )}
      </section>
    </Modal>
  )
}

export default UpdateAvailableModal
