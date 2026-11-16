# CubeSandbox v0.8.0 兼容矩阵

目标固定为正式 tag `41748bb78d6384962b4e417ff9215720ea7472fd`。基线为 v0.7.2；正式 tag 与后续 master 修复分开。官方参考：[升级流程](https://github.com/TencentCloud/CubeSandbox/blob/v0.8.0/docs/guide/kubernetes/upgrade.md)、[CubeAPI 路由](https://github.com/TencentCloud/CubeSandbox/blob/v0.8.0/CubeAPI/src/routes.rs)、[envd 命令客户端](https://github.com/TencentCloud/CubeSandbox/blob/v0.8.0/sdk/node/src/commands.ts)。

| 功能 | 正式 tag / Partners 路径 | 升级前证据 | 升级后实机证据 |
| --- | --- | --- | --- |
| create/get/delete | 保留 `/sandboxes`，v0.8.0 新增 `/v2/sandboxes`；自研客户端仅在 404/405 fallback | 源码、HTTP fixture | 待 H/F |
| 执行与 UTF-8 stdout/stderr | CubeProxy 49983 envd `process.Process/Start`，Connect JSON framing，独立 UTF-8 decoder | 协议 fixture、流式/非零退出测试 | 待 H/F |
| 文件 | MCP 的 sandbox 内隔离 Python；REST 文件代理使用 providerSessionId | fixture、路径与权限测试 | 待 H/F |
| 作业取消/超时 | 确认删除整个 sandbox 后才确认停止 | fixture、MCP 回归 | 待 H/F |
| 保留工作区进程取消 | envd signal 是待调查协议，SDK 方法存在不能证明进程树停止 | 未承诺 | 待 E |
| 远端 PTY | 现有适配器没有真实连接，现明确 501，能力 false | 回归测试 | 不支持 |
| 快照/fork/rollback | 上游有接口，但当前 Partners 远端协议未完成适配，不能伪成功或用空 VM 替代 | 错误路径回归 | 未验收/不声明支持 |
| S3 产物 | Gateway ArtifactStore，不依赖 Cube 的模板存储迁移 | 隔离 MinIO PUT/GET/DELETE 全通过 | 待 H/F |
| 性能/内核信息 | 报告测量时延；无实际版本即 unknown，不编造版本或 45ms | 回归测试 | 待 H/F |

本次 Chart 保持 hostNetwork、placement、PVC、Secret 引用、现有模板和存储。CubeOps → CubeMaster → 计算面分阶段升级；单节点按维护中断执行。数据库存在新增 quota/status/snapshot mode/variant 与 charset 迁移，回退使用已还原验证的旧数据库备份；不假设所有 down migration 无损。不启用 JuiceFS、不升级 MySQL/Redis 主版本、不切换 PVM host kernel。

运行回归入口：`npm run mcp:validate-live`（标准 SDK 脚本 smoke，不能等同真实 Agent 三轮验收）；完整 Agent 验收另记录客户端、三轮命令、diff、测试与日志。
