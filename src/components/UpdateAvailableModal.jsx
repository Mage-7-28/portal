/**
 * 新版本提示弹窗。
 * 启动检查支持跳过版本，手动检查始终直接进入下载页。
 */
import { useEffect, useState } from 'react'
import { Button, Checkbox, Modal } from 'antd'
import AppIcon from './AppIcon'

/**
 * 显示新版本信息，并提供跳过版本和打开发行页操作。
 *
 * @param {Object} props - 更新弹窗属性。
 * @param {boolean} props.open - 是否显示弹窗。
 * @param {{currentVersion: string, latestVersion: string, releaseUrl: string}|null} props.update - 新版本信息。
 * @param {boolean} [props.canSkipVersion=true] - 是否显示并允许使用“跳过此版本”。
 * @param {(options: {skipVersion: boolean, version: string}) => void} props.onCancel - 关闭弹窗回调。
 * @param {(options: {skipVersion: boolean, version: string, releaseUrl: string}) => Promise<void>} props.onDownload - 打开发行版页面回调。
 * @returns {JSX.Element|null} 更新弹窗；没有更新数据时返回 null。
 */
const UpdateAvailableModal = ({ open, update, canSkipVersion = true, onCancel, onDownload }) => {
  // 启动静默检查时用户是否选择跳过当前版本。
  const [ skipVersion, setSkipVersion ] = useState(false)
  // 发布页正在打开时锁定关闭和重复点击操作。
  const [ opening, setOpening ] = useState(false)

  // 每次展示新的版本数据都清除上一次的选择和 loading 状态。
  useEffect(() => {
    if (open) {
      setSkipVersion(false)
      setOpening(false)
    }
  }, [ canSkipVersion, open, update?.latestVersion ])

  if (!update) return null

  /**
   * 关闭更新弹窗，并将用户选择的跳过版本状态交给父组件持久化。
   *
   * @returns {void}
   */
  const handleCancel = () => {
    if (opening) return
    void onCancel({
      skipVersion: canSkipVersion && skipVersion,
      version: update.latestVersion
    })
  }

  /**
   * 打开发行版页面，并在启动检查场景下保存跳过版本设置。
   *
   * @returns {Promise<void>} 页面打开和父组件回调完成后的 Promise。
   */
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
