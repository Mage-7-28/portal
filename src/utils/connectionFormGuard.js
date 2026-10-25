/**
 * 为连接表单的异步测试和保存操作提供会话、表单版本及并发守卫。
 *
 * @returns {Object} 管理弹窗会话、测试请求和保存互斥状态的方法。
 */
export const createConnectionFormGuard = () => {
  let session = 0
  let version = 0
  let request = 0
  let visible = false
  let saveSequence = 0
  let activeSave = null

  /**
   * 开始一个新的弹窗会话，并使之前的测试请求失效。
   *
   * @returns {number} 新会话的代次。
   */
  const openSession = () => {
    session += 1
    version = 0
    request += 1
    visible = true
    return session
  }

  /**
   * 结束当前弹窗会话，并使其所有异步测试失效。
   *
   * @returns {boolean} 当前有打开会话并已将其关闭时返回 true。
   */
  const closeSession = () => {
    if (!visible) return false
    visible = false
    session += 1
    version = 0
    request += 1
    return true
  }

  /**
   * 记录用户编辑并使旧版本的测试请求失效。
   *
   * @returns {number} 当前表单版本。
   */
  const changeForm = () => {
    version += 1
    request += 1
    return version
  }

  /**
   * 为当前表单版本启动一个新的测试请求。
   *
   * @returns {{session: number, version: number, request: number}|null} 请求票据；弹窗关闭时返回 null。
   */
  const beginTest = () => {
    if (!visible) return null
    request += 1
    return { session, version, request }
  }

  /**
   * 判断测试票据是否仍属于当前会话、表单版本和最新请求。
   *
   * @param {{session: number, version: number, request: number}|null} ticket - 测试请求票据。
   * @returns {boolean} 票据仍有效时返回 true。
   */
  const isCurrentTest = (ticket) => Boolean(
    visible
    && ticket
    && ticket.session === session
    && ticket.version === version
    && ticket.request === request
  )

  /**
   * 判断快照是否属于当前弹窗会话和表单版本。
   *
   * @param {{session: number, version: number}|null} snapshot - 会话和表单版本快照。
   * @returns {boolean} 快照仍有效时返回 true。
   */
  const isCurrentForm = (snapshot) => Boolean(
    visible
    && snapshot
    && snapshot.session === session
    && snapshot.version === version
  )

  /**
   * 同步占用保存通道，避免重复提交创建多个配置标识。
   *
   * @returns {{session: number, version: number, id: number}|null} 保存票据；已有保存进行中时返回 null。
   */
  const beginSave = () => {
    if (!visible || activeSave) return null
    activeSave = { session, version, id: ++saveSequence }
    return activeSave
  }

  /**
   * 判断保存完成后是否仍可影响当前会话。
   *
   * @param {{session: number, version: number, id: number}|null} ticket - 保存票据。
   * @returns {boolean} 保存仍属于当前表单且持有互斥通道时返回 true。
   */
  const isCurrentSave = (ticket) => Boolean(
    visible
    && ticket
    && activeSave === ticket
    && ticket.session === session
    && ticket.version === version
  )

  /**
   * 释放指定保存操作持有的互斥通道。
   *
   * @param {{session: number, version: number, id: number}|null} ticket - 保存票据。
   * @returns {boolean} 票据持有当前通道并已释放时返回 true。
   */
  const finishSave = (ticket) => {
    if (!ticket || activeSave !== ticket) return false
    activeSave = null
    return true
  }

  return {
    beginSave,
    beginTest,
    changeForm,
    closeSession,
    finishSave,
    isCurrentForm,
    isCurrentSave,
    isCurrentTest,
    openSession
  }
}
