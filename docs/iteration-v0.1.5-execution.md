# Partners v0.1.5 实施记录

本文件持续更新；状态不能替代下方逐项证据。执行分支 `codex/v0.1.5-reliability`，源基线 `de02905`，工作区适用路径未发现 AGENTS.md。用户已授权按原需求进入执行；Task Weaver 需求已按 draft → approved → in_progress 转换，复用八个任务与十条依赖。

## 已实现与本地验证

- A：快照/模板列表把 token tenant/project 集合与显式查询求交，在分页前过滤。派生会话及模板先按可信源归属鉴权，再验证目标范围；快照 body 不能覆盖源会话归属。REST workspace job 从持久会话加载可信范围；Provider-only 快照拒绝作为可信源。PostgreSQL 新增 `gateway_workspace_sources` 持久化快照/模板。
- B：REST 带幂等键提交复用 GatewayStore 的 MCP coordinator 原子 claim；先持久化接受意图和 jobId，再启动 Provider。独立 PostgreSQL 连接、两个 HTTP Gateway、40 并发仅一个共享测试 Provider 调用。冲突、重启 replay、启动前死亡及执行后丢响应均有测试。此项证明持久协调语义，真实远端验收另记。
- C：保留 Node 20/22 快速 CI，新增 PostgreSQL 16 / MinIO 隔离集成 job。`npm run test:integration` 缺变量或任何 skip 都失败。本机临时 PostgreSQL 17 / K8s 独立 MinIO 下完整运行 153 项，153 通过、0 失败、0 skip。CI 结果待 PR 后补充。
- D（实现准备）：修正远端文件代理使用 logical/provider ID 混淆；取消虚假的 PTY 输入回显、快照失败伪成功及 fork 失败创建空替代沙箱；缺少运行时版本信息返回 unknown。远端能力与模拟能力的证据分开；远端 PTY、保留工作区进程取消、快照/fork/rollback、60ms 承诺不作为已支持能力。

测试入口：`test/reliability-isolation.test.js`、`test/rest-idempotency-postgres.test.js`、`test/cubesandbox-v080-compat.test.js`；完整集成入口 `npm run test:integration`。日志原件在本机 `/tmp/partners-integration-results.log`；交付以提交后的 CI 记录与版本化摘要为准。

## 集群准备与恢复演练

2026-11-16 重新核验 `default / cube-system`：Helm cube revision 1 / chart 0.7.2，Cube 控制面及计算面标签 v0.7.2，hostNetwork=true，唯一计算节点 dell-r730。Partners Gateway/Console 均为固定 digest 的 v0.1.4。运行内核 `7.0.0-38-generic`，本轮不切换。

现有两个沙箱 `e0ee5886c82c494489c41be02a47d86d`、`73dbcaf2d3f14857a1efc1681ba507a3` 均为 exited；第一个在 Partners 保留无 tenant/project 的旧 ready 记录，未发现运行作业。用户确认“没用的就删了吧。当前没有啥实际重要的任务在上面跑。”清理只限这两个明确记录。

受限备份根目录：`/Users/mini/.local/state/partners-v015/backup`，不进入 Git。含 Helm 原始与合并 values、渲染资源、Secret/PVC 引用、Partners 资源、节点清单、MySQL 全量逻辑备份（含 routines/events/triggers）、Redis RDB、MinIO、Master PVC、节点 toolbox 和 cubelet 存储（含两个原始 rootfs）。完整 SHA-256 清单位于同级 `backup-checksums.json`。

- MySQL 备份已还原到 `partners-v015-test/mysql-restore` 隔离实例，原始业务库 36 张表。恢复后必须 `FLUSH PRIVILEGES` 才能让已恢复的 DEFINER 用户进入权限缓存。
- 使用正式 v0.8.0 tag `41748bb78d6384962b4e417ff9215720ea7472fd` 的实际 migrator 对还原库升级成功，schema version `20261112035937`，模板 definition/replica 各 3 条。
- 节点 archive 与 Master archive 已实际解包到隔离目录；`cube-runtime` 与 `containerd-shim-cube-rs` 的还原 SHA-256 与现网文件完全一致。完整 rootfs/元数据库已保留，socket 不归档。
- 回退必须暂停接单与计算面，恢复 MySQL 备份并刷新权限、Redis/对象存储/Master PVC、节点 toolbox/存储/就绪标记，再恢复 revision 1 的 Chart 和固定旧制品。不能只执行 Helm rollback；不得在新旧运行时同时使用同一目录时覆盖文件。

当前升级与最终验收尚未完成，下方会补记实际 revision、digest、功能回归和清理结果。
