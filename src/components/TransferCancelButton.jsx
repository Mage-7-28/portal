import { Button, Dropdown, Tooltip } from 'antd'
import AppIcon from './AppIcon.jsx'
import { useProgressContext } from '../utils/progressContext.js'
import { getProgressKey } from '../utils/progressState.js'
import { formatProgressTask } from '../utils/progressTitle.js'

/**
 * 在文件工具栏提供不增加布局行数的取消入口，并发时按任务选择取消。
 * 扫描或传输阶段只要已有取消回调就保留按钮，取消请求相互独立。
 *
 * @returns {JSX.Element|null} 活动任务的紧凑取消按钮；没有可取消任务时返回 null。
 */
const TransferCancelButton = () => {
  const { tasks, cancellingKeys, cancelTask } = useProgressContext()
  if (!tasks.some(task => typeof task.onCancel === 'function')) return null
  const multiple = tasks.length > 1
  const currentTask = tasks[0]
  const currentKey = getProgressKey(currentTask)
  const label = multiple ? '选择要取消的传输' : '取消传输'
  const button = (
    <Button
      className="transfer-cancel-action"
      size="small"
      danger
      icon={<AppIcon name="stop" />}
      loading={!multiple && cancellingKeys.has(currentKey)}
      aria-label={label}
      onClick={multiple ? undefined : () => void cancelTask(currentKey)}
    />
  )
  if (!multiple) return <Tooltip title={`${ label }：${ formatProgressTask(currentTask) }`}>{button}</Tooltip>
  const items = tasks.map(task => {
    const key = getProgressKey(task)
    return {
      key,
      label: `${ cancellingKeys.has(key) ? '正在取消 · ' : '取消 · ' }${ formatProgressTask(task) }`,
      disabled: typeof task.onCancel !== 'function' || cancellingKeys.has(key),
      danger: true
    }
  })
  return (
    <Dropdown
      menu={{ items, onClick: ({ key }) => void cancelTask(key) }}
      trigger={['click']}
      placement="bottomRight"
    >
      <span className="transfer-cancel-menu" title={`${ label }（${ tasks.length } 个任务）`}>{button}</span>
    </Dropdown>
  )
}

export default TransferCancelButton
