/**
 * SSH 凭据持久化适配层。
 * 明文密码只在调用 Rust 加密/解密命令和当前连接内存中短暂存在，不写入前端 Store。
 */
import { invoke } from '@tauri-apps/api/core'

/**
 * 加密账户密码。
 *
 * @param {string} password - 待加密的明文密码。
 * @returns {Promise<string>} 由 Rust 返回的密文。
 */
export const encryptPassword = password => invoke('encrypt_password', { password: password || '' })

/**
 * 解密已保存的账户密码。
 *
 * @param {string} encryptedPassword - Rust 生成的密码密文。
 * @returns {Promise<string>} 当前进程使用的明文密码。
 */
export const decryptPassword = encryptedPassword => invoke('decrypt_password', { encrypted: encryptedPassword })

