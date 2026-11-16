# Partners v0.1.5 发布准备

代码通过 PR [#2](https://github.com/limmytian/partners/pull/2) 交付；本文件不代表稳定版本已发布或 Partners 镜像已部署。CubeSandbox 已实际升级，Partners Gateway/Console 仍为固定 digest 的 v0.1.4。

## 变更

- 快照、模板和派生工作区按可信 tenant/project 隔离；列表在分页前过滤。受限 token 的 admin 查询、统计和操作也保持同样边界。
- REST `Idempotency-Key` 提交复用持久 MCP coordinator；先占位已知 jobId 和接受意图，再启动 Provider。重试/重启不重复执行，冲突或过期返回 409；未知接受窗口有诊断。
- PostgreSQL 持久化快照/模板；CI 实际启动 PostgreSQL 16 与固定 digest 的 MinIO，缺配置或任何 skip 都失败。
- Cube 远端适配不再把 PTY 回显、快照假成功、空沙箱回退或虚构运行时版本当作能力；文件代理使用真实 provider ID。
- 标准 MCP Agent 接入使用官方 SDK 版本协商，修复原先初始化硬拒绝其他版本的问题；后续不支持的版本头仍返回 400。
- 现有集群 CubeSandbox 从 revision 1 / v0.7.2 升级至 revision 6 / 正式 v0.8.0，完整部署证据见 [部署清单](evidence/v0.1.5/deployment.json)。没有迁移 JuiceFS、更换主机内核或升级数据库/缓存主版本。
- 保留工作区进程取消调查结论为 [NO-GO](cubesandbox-v0.8.0-cancellation.md)，维持销毁 sandbox 确认停止。

## 数据与兼容边界

新增 `gateway_workspace_sources` 表，REST 占位使用原有 `gateway_mcp_operations` 的 `rest:` namespace。迁移为增量建表/索引；旧版应用回退可保留附加表。不要删除协调意图来“修复”未知执行。

新 REST 占位保留 24 小时有效期，过期 tombstone 不自动删除，过期 key 返回 409；旧 replay 表仍遵循原保留策略。当前没有自动回收 tombstone 的任务；安全回收设计留待后续，不能假定旧清理任务覆盖新占位。

带 key 的 202 表示持久接受意图，返回最初接受响应；最新状态须 GET job。`Idempotency-Status: acceptance-uncertain` 表示存在意图但找不到 job 行，需要结合已知 jobId/远端证据人工协调，禁止盲目换 key 重跑。

远端 PTY 明确 501；远端快照/fork/rollback 未完成真实适配，不声明支持。既有模板仍使用原 envd/guest-image，实测内核与节点安装制品分别记录，不能用宿主安装版本代替 guest 版本。

## 验证与放行

完整集成命令 `npm run test:integration`：152 项通过、0 失败、0 skip。PR CI 包含 Node 20、22 快速测试和 PostgreSQL/MinIO 集成。真实 REST 验收使用两个独立 Gateway 进程、40 次并发、1 次 Provider 启动；重启 replay 与 S3 下载通过。真实 MCP smoke 覆盖 UTF-8 分页、文件边界、非零退出、取消/超时、重启与未知执行隔离，测试资源零残留。生产 v0.1.4 对升级后实例的 MCP/S3 探针通过。

标准 Codex MCP Agent 三轮复用同一真实沙箱，最终 7 项测试通过，diff 和测试日志已从 S3 下载复核。验证结束后 CubeMaster 列表为 0。见 [实施记录](iteration-v0.1.5-execution.md)。合入遵循需求 workflow 的手动 integration；不自动 merge。稳定 tag、镜像发布与 Partners rollout 应使用审阅后的源 SHA，沿用 [发布边界](release-packaging-deployment-boundary.md) 和 [部署流程](gateway-release.md)，部署必须使用配对固定 digest、显式 context/namespace 与现有 Secret。
