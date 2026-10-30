/** 当前平台和窗口可用的快捷键参考。 */
import { Modal } from 'antd'
import { getShortcutKeys, isMacPlatform, SHORTCUT_GROUPS } from '../utils/keyboardShortcuts.js'

/**
 * 展示按使用场景分组的快捷键，按当前平台生成键帽。
 *
 * @param {{open: boolean, onCancel: () => void, afterClose: () => void}} props - 弹窗状态和关闭回调。
 * @returns {JSX.Element} 快捷键参考弹窗。
 */
const KeyboardShortcutsModal = ({ open, onCancel, afterClose }) => (
  <Modal
    rootClassName="compact-modal shortcuts-modal"
    open={open}
    title={(
      <div className="shortcuts-heading">
        <span className="shortcuts-heading-icon" aria-hidden="true">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
            <rect x="2.75" y="5.5" width="18.5" height="13" rx="2.2" />
            <path d="M6.5 9h.01M10 9h.01M13.5 9h.01M17 9h.01M6.5 12h.01M10 12h.01M13.5 12h.01M17 12h.01M8 15h8" />
          </svg>
        </span>
        <span className="shortcuts-heading-copy">
          <span className="shortcuts-heading-title">快捷键</span>
          <span className="shortcuts-heading-subtitle">熟悉常用操作，让工作更流畅</span>
        </span>
      </div>
    )}
    centered
    width="min(680px, calc(100vw - 24px))"
    onCancel={onCancel}
    afterClose={afterClose}
    footer={null}
    destroyOnHidden
  >
    <div className="shortcuts-scroll">
      <div className="shortcuts-intro">
        <p>按使用场景查找快捷键</p>
        <span className="shortcuts-platform">{isMacPlatform() ? 'macOS' : 'Windows / Linux'}</span>
      </div>
      <div className="shortcuts-groups">
        {SHORTCUT_GROUPS.map(group => (
          <section className="shortcuts-group" key={group.id} aria-labelledby={`shortcuts-group-${ group.id }`}>
            <div className="shortcuts-group-heading">
              <h2 id={`shortcuts-group-${ group.id }`}>{group.title}</h2>
              {group.description && <p>{group.description}</p>}
            </div>
            <dl className="shortcuts-list">
              {group.items.map(item => (
                <div className="shortcuts-row" key={item.id}>
                  <dt>{item.title}</dt>
                  <dd className="shortcuts-keys">
                    {getShortcutKeys(item.id).map((key, index) => (
                      <span className="shortcuts-key-part" key={`${ item.id }-${ index }`}>
                        {index > 0 && <span className="shortcuts-key-plus" aria-hidden="true">+</span>}
                        <kbd>{key}</kbd>
                      </span>
                    ))}
                  </dd>
                </div>
              ))}
            </dl>
          </section>
        ))}
      </div>
      <p className="shortcuts-scope-note">快捷键仅在对应窗口和操作区域生效；输入或使用弹窗时，部分快捷键不会触发。</p>
    </div>
  </Modal>
)

export default KeyboardShortcutsModal
