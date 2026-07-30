# 依赖与许可证

Portal 本身采用 MIT 许可证。依赖清单由 `license-checker` 生成并记录在
[`license-report.csv`](./license-report.csv) 中；发布包时应同时保留各依赖的版权和许可证声明。

## 前端运行时

- React、React DOM、Ant Design、Ant Design Icons、Vite、Valtio、PubSubJS、react-hot-toast：MIT
- Tauri API 与 Tauri 官方插件：MIT OR Apache-2.0

## Rust 运行时

- Tauri、serde、serde_json、dirs、thiserror、ssh2：均为 MIT、Apache-2.0 或双许可证选项
- ssh2 使用的 libssh2/OpenSSL 等系统库须按照目标平台的发行包和构建链要求提供对应声明

MIT 允许将这些宽松许可证依赖用于 MIT 项目。Apache-2.0 和 BSD-3-Clause
并不等同于 MIT，但属于与 MIT 项目兼容的宽松许可证；不得移除其版权、许可证和免责声明。
新增依赖必须先确认许可证、NOTICE 要求和目标平台可用性，并更新本文件及
`license-report.csv`，禁止引入 GPL/AGPL 等强传染性许可证。

## 凭据处理

连接配置只保存主机、端口、用户名、认证方式和已确认的 SSH 主机指纹。密码、私钥口令
只保存在当前进程内存中，不写入 Tauri Store，也不应提交到 Gitee 或其他代码仓库。
