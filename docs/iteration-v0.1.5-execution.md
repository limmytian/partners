# Partners v0.1.5 实施记录

本文件持续更新；状态不能替代下方逐项证据。执行分支 `codex/v0.1.5-reliability`，源基线 `de02905`，工作区适用路径未发现 AGENTS.md。用户已授权按原需求进入执行；Task Weaver 需求已按 draft → approved → in_progress 转换，复用八个任务与十条依赖。

## 已实现与本地验证

- A：快照/模板列表把 token tenant/project 集合与显式查询求交，在分页前过滤。派生会话及模板先按可信源归属鉴权，再验证目标范围；快照 body 不能覆盖源会话归属。REST workspace job 从持久会话加载可信范围；Provider-only 快照拒绝作为可信源。PostgreSQL 新增 `gateway_workspace_sources` 持久化快照/模板。
- B：REST 带幂等键提交复用 GatewayStore 的 MCP coordinator 原子 claim；先持久化接受意图和 jobId，再启动 Provider。独立 PostgreSQL 连接、两个 HTTP Gateway、40 并发仅一个共享测试 Provider 调用。冲突、重启 replay、启动前死亡及执行后丢响应均有测试。此项证明持久协调语义，真实远端验收另记。
- C：保留 Node 20/22 快速 CI，新增 PostgreSQL 16 / MinIO 隔离集成 job。`npm run test:integration` 缺变量或任何 skip 都失败。本机临时 PostgreSQL 17 / K8s 独立 MinIO 下完整运行 152 项，152 通过、0 失败、0 skip。
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

实际升级、功能回归与清理见下文。

## 实际升级与回归

- 19:15（上海时间）暂停 Partners Gateway 接单并隔离唯一计算节点，等待超过 60 秒。用户确认后只删除已盘点的两个 exited 沙箱，清空前保留完整原卷。旧的无归属 ready 记录在确认远端删除后标记 deleted，保留审计。
- 正式 tag Chart 分阶段升级：先 CubeOps，再 CubeMaster/TemplateCenter，再其余控制面，最后 Installer/Bootstrap/计算面和新增 OpsAgent。最终 Helm **revision 6 / cube-0.8.0**。
- revision 2 暴露 Helm 4 SSA 的 `NODE_IP`、`CUBE_PROXY_NODE_IP` value→fieldRef 迁移冲突；用精确 JSON patch 迁移这两个字段后，revision 3 发现 field manager 冲突，随后用 `--force-conflicts` 交回 Helm 管理。维护期间持续关闭 Gateway，没有在半升级状态接单。
- CubeOps 首次升级已迁移数据库，重启旧 Master/TemplateCenter 出现迁移树不匹配；立即按依赖升级为同 tag，未放开流量。由此确认旧数据库恢复是完整回退的一部分。MySQL/Redis/MinIO StatefulSet 镜像与 PVC 保持原值。
- 控制面和计算面全部使用固定 v0.8.0 digest，cubelet 二进制报告 tag 对应 commit `41748bb78d6384962b4e417ff9215720ea7472fd`。shim/runtime/agent/cubelet 均实装 v0.8.0，guest-image 仍为 `guest-image-260820-1`；节点 guest kernel bm 制品 digest 更新，宿主内核仍 `7.0.0-38-generic`。既有模板启动的 guest 实测为 `6.6.1199-0009-03_2.0.1`，两者不能混为同一个版本。
- 节点重新注册且健康，模板 alias `sandbox-code-probe` 和 `alpine-base` 仍 READY。恢复 Gateway v0.1.4 一副本，真实 MCP 执行输出和现有 S3 后端下载均通过。
- [真实 MCP smoke](evidence/v0.1.5/mcp-live.json)：文件读写/条件更新/边界、60001 字节 UTF-8 分页、非零退出、确认取消/超时、完成作业与工作区跨 Gateway 重启、失联 worker 隔离、TTL 清理全部通过；自有沙箱残留 0。
- [真实 REST 双进程](evidence/v0.1.5/rest-live.json)：两个独立 OS 进程，40 次相同键并发，1 次 Provider 启动、同一 jobId；冲突 409、S3 产物下载和重启 replay 通过。第一次验收脚本未声明 artifactPolicy，已修正脚本并重跑通过，没有把缺少产物误记为成功。
- 生产 v0.1.4 探针首次在终态到产物发布的短窗口尝试清理收到 SESSION_BUSY；脚本等待 artifactRefs/锁释放后重跑通过并清理。此记录保留其真实异步边界。
- [取消调查](cubesandbox-v0.8.0-cancellation.md) 得到 NO-GO，完成自有沙箱清理；继续使用销毁 VM 确认停止。

实际私有部署 inputs/outputs 留在 `/Users/mini/.local/state/partners-v015/`：`phase1-values.json`、`phase2-values.json`、`phase3-values.json`、`final-values.json`、`deployed-values.yaml`、`deployed-manifest.yaml`、Chart 包及分阶段日志。仓库只保存 [脱敏 values](evidence/v0.1.5/deployed-values-redacted.json)，不能直接用脱敏凭据部署。

回退入口：暂停 Gateway、在 CubeOps 隔离节点并确认排空，停止控制面和计算面；在隔离恢复 helper 挂载原 PVC 后还原 Redis/MinIO/Master archive，恢复节点 toolbox/cubelet archive，再恢复 `mysql-maintenance.sql`（业务库先清空，恢复后 FLUSH PRIVILEGES），最后用 revision 1 Chart/原始 values 和旧固定镜像恢复组件、验证旧节点/模板/功能后接单。只有 Helm rollback 不足以回退新增 schema 和节点文件。全量恢复前必须保留失败版本的额外备份，禁止运行中的新旧进程共用正在覆盖的目录。

数据库还原及 v0.8.0 迁移/回退演练均只在 `partners-v015-test/mysql-restore` 进行，未对生产执行回退。节点 archive 已完整解包并校验关键二进制，但没有在生产演练停机全量宿主恢复；此为回退验证的明确边界。

## 三轮标准 MCP Agent 验收

Codex CLI 0.169.0 通过标准 Streamable HTTP 连接隔离 Gateway，并在同一个 CubeSandbox v0.8.0 工作区完成三轮。工作区为 `ses_a42b1866-2cbe-4d97-bcc4-dd60c59000a4`。

| 轮次 | 实际结果 |
| --- | --- |
| 1 | 建立 Python fixture，基线 2 项通过。新增重复空白回归后观测到退出码 1，并定位实现问题。 |
| 2 | 修复首尾空白与连续空白，覆盖空输入和混合空白，6 项测试通过。 |
| 3 | 新增全角输入回归并观测到退出码 1，实现 NFKC 归一化后 7 项通过，输出 unified diff 和测试日志。 |

独立验证器在同一工作区重跑 7 项测试，验证差异和日志，下载 S3 stdout/stderr 均得到 HTTP 200。会话创建 133 ms。五个 Agent 作业的首段输出 181–505 ms，总耗时 403–530 ms。已删除沙箱，CubeMaster 列表为 0。见 [三轮记录](evidence/v0.1.5/mcp-agent.json) 与 [复核的 diff 和测试日志](evidence/v0.1.5/mcp-agent-verification.txt)。

第一次三轮运行在第三轮的 `bash_exec` 自动审批阶段遇到工作区额度耗尽，审批未执行，运行未计入验收。恢复额度后，从新工作区完整重跑并通过。集成测试复跑时曾继承实机地址，由模拟测试创建 4 个临时沙箱。已按创建记录确认并逐个删除，集成入口剥离真实 CubeSandbox 地址，模拟测试也显式选择模拟模式。

同一版本的 REST 验证用真实 Gateway 和隔离 PostgreSQL 测试跨租户、跨项目的快照/模板直读及伪造范围恢复，六次请求全部返回 HTTP 403，未创建工作区。此处用可信归属记录验证授权拒绝，同范围快照文件恢复由本地 Provider 集成回归覆盖。见 [REST 实机记录](evidence/v0.1.5/rest-live.json)。
