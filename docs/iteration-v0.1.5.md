# Partners v0.1.5 迭代计划

规划日期：2026-11-16（Asia/Shanghai）。基线：本地 main / de02905，package 0.1.4。

目标：修复已复现的租户隔离和 REST 并发幂等问题，建立持续集成中的持久化验证，将现有 Kubernetes CubeSandbox 从 v0.7.2 升级到正式 v0.8.0，并完成标准 MCP Agent 对升级后实例的多轮工作区验收。维持现有 REST/MCP 公共接口；这是一次可靠性补丁与运行时升级迭代。

本文件是规划和验收约定，不代表功能已实现或版本已发布。Task Weaver 需求保持 draft、任务保持 todo。本轮用户已明确授权将现有集群 CubeSandbox 升级纳入交付；按 G → D → H 的前置条件实施，授权不包含 JuiceFS 存储迁移、主机内核切换或其他应用升级。本次范围更新只进行了集群只读盘点，尚未执行 rollout。

## 现状与证据

- 本次 npm test：147 项，143 通过、0 失败、4 跳过。跳过项为两个 MCP PostgreSQL 测试、Gateway PostgreSQL 测试和 MinIO 测试。
- 本地临时环境复现：仅授权 tenant-a / project-a 的服务 token 可列出 tenant-b 的快照与模板，并从 tenant-b 模板创建 tenant-a 工作区、读到原文件。测试使用合成文件并清理临时目录。
- 本地并发复现：12 个相同 REST Idempotency-Key 和请求体的请求启动了 2 个 Provider 作业，返回 2 个 jobId。现有流程先读取 replay、启动作业、再保存 replay。
- MCP 已有持久化原子占位、工作区锁、取消意图和未知执行隔离；本轮复用这些机制，避免再增加一套协议专属协调机制。
- CubeSandbox 上游最新正式版为 2026-11-12 发布的 v0.8.0。2026-11-16 只读盘点确认：context default，namespace cube-system，Helm release cube / revision 1 / chart cube-0.7.2；控制面与计算面镜像标签均为 v0.7.2。cube-node 使用 hostNetwork=true，当前只运行在 dell-r730；全部现有 Cube Pod Ready。上游进展见 [调研记录](cubesandbox-progress-2026-11-16.md)，升级边界见 [升级方案](cubesandbox-v0.8.0-upgrade.md)。
- 只读 sandbox 列表当前返回 2 个 ID；状态、归属与工作区恢复要求待 G 核对，不能按空集群直接重建计算面。

## 本轮任务

### A. 修复快照、模板及派生工作区的租户/项目隔离（P0）

核对 snapshots/templates 的 list/get/create、基于 snapshotId/templateId 的 session 创建，以及 REST workspace job 的真实资源授权。先加载被引用资源，再按其可信 tenant/project 鉴权，不能以请求 body 的范围替代源资源归属。列表必须在存储查询和分页前应用可信范围；无范围不能退化为全局读取。对无可信归属的 Provider 回退资源默认拒绝；确有共享需求时另设计显式共享契约。

验收：两个租户、同租户不同项目、缺省/伪造范围、直接 ID 引用和分页均覆盖；跨范围调用无 Provider 副作用。合法同范围创建、恢复和 MCP 回归通过。

### B. 将持久化原子提交机制用于 REST 作业幂等（P0）

复用并适度下沉 MCP operation reservation 的公共机制，按可信 tenant/project/tool 作用域原子占位。先记录可恢复的 jobId 和接受意图，再启动 Provider。相同 key/相同请求返回同一个作业；不同请求返回 409。对启动后丢响应、重启和未知副作用保留明确诊断，禁止盲目重跑。保留现有 REST 无 key 调用行为，记录幂等兼容性变化。

验收：独立数据库连接、两个 HTTP Gateway 实例并发提交 40 次只启动一个 Provider 作业；冲突拒绝、失败窗口和重启后 replay 有回归。测试中的共享模拟 Provider 只能证明协调语义，真实远端行为另由 F 验收。

### C. 把 PostgreSQL / MinIO 验证纳入 CI（P1）

保留现有 Node 20/22 快速测试，新增隔离的 PostgreSQL 和 MinIO 集成任务；显式配置 MCP_TEST_POSTGRES_URL、POSTGRES_URL 和现有 S3 测试参数。只使用 CI 临时资源。

验收：当前四项环境测试在集成任务中实际运行且通过；所需变量/服务缺失时该任务失败，不能绿色跳过；持久化并发和重启用例进入集成任务。

### D. CubeSandbox v0.8.0 升级前兼容适配（P1）

依赖 G。根据实际 v0.7.2 配置与正式 v0.8.0 的源码、Chart、协议及升级说明完成兼容检查；准备所需 Partners 适配和自动化回归。沿用公共 Provider 接口，按实际需要修正 CubeAPI / CubeProxy / envd 调用，不因上游 SDK 宣称兼容而整体替换客户端。有独立试验环境时优先验证；单计算节点场景使用 H 中已备份、已排空的维护窗口完成受控试升级，真实协议回归由 H/F 验收，避免前置任务互相等待。

覆盖 create/get/delete、增量 UTF-8 stdout/stderr、非零退出、沙箱侧文件操作、取消/超时、作业结果和产物下载。REST 及 MCP 的 Provider 能力声明必须区分模拟、远端已验证和不支持；尤其核对远端 PTY，不能把输入回显当作真实终端执行。

验收：形成版本化兼容矩阵、可运行的回归脚本和必要适配。明确哪些项目只有源码/fixture 证据、哪些已实机验证；目标集群实机证据在 H/F 补齐前保持待验收。主分支修复与正式 tag 分别记录，不默认使用 master 或测试内核。

### E. 限时核验保留工作区的进程取消（P1，调查结论为交付物）

依赖 D、H。以半个有效工作日为时间盒，检查升级后部署中的 envd/SDK 是否能寻址进程、终止进程树并确认退出。试验只操作自行创建的沙箱，测试 TERM-resistant 子孙进程、断线、重复取消及超时后继续读写原工作区。

验收：提交 go/no-go 结论、协议证据与测试记录。仅杀父进程、仅存在 SDK kill 方法、暂停 VM 或自动重启均不能证明安全停止整个作业。v0.1.5 不承诺上线保留工作区取消；未获得证据时保留现有销毁工作区确认停止的策略，后续实现另排迭代。

### F. 标准 MCP Agent 多轮工作区验收与 v0.1.5 发布准备（P1）

依赖 A、B、C、D、E、H。使用一个标准 MCP Agent 客户端对现有集群升级后的 CubeSandbox v0.8.0 完成：创建工作区 → 准备小型仓库/fixture → 修改与运行测试 → 根据失败再次修改 → 三轮执行复用同一工作区 → 返回 diff、测试结果和日志产物 → 人工审阅。

验收应同时记录非零退出、当前取消/超时行为、Gateway 重启后的定位与 replay、跨范围拒绝和资源清理。记录会话就绪、首段输出、总耗时及错误原因，作为后续性能投入基线；脚本 smoke 与真实 Agent 运行分别标记。

完成 changelog、API/运维说明和升级回退说明，明确数据库改动、幂等保留策略与未实现能力。准备可审阅的 v0.1.5 交付；实际镜像发布和生产 rollout 在实施阶段按明确授权执行。

### G. CubeSandbox 集群升级前盘点、备份与回退准备（P1）

核对 default / cube-system 的 Helm cube release、原始 values、渲染资源、实际镜像 digest、主机安装的 shim/kernel/guest/agent、网络模式和节点选择条件。列出现有 template/backend、活跃/暂停沙箱及 Partners 工作区映射，区分用户工作区与测试资源。备份恢复所需的 MySQL、Redis、对象存储、模板元数据与节点文件，原始配置中的敏感值仅保存在受限备份路径，不进入仓库或日志。确认升级前后 schema 与节点制品的回退兼容性。

验收：交付脱敏的版本/依赖清单、备份位置及校验记录、维护窗口中的流量暂停/工作区保存/排空/恢复步骤、具体回退命令与触发条件。对运行中的用户工作区先保存并与调用方协调，不直接批量销毁；只有可恢复或已确认可结束的沙箱才进入排空。单计算节点需明确执行服务的维护中断。不得把 helm rollback 视为数据库与主机运行时的完整回退。

### H. 将现有 Kubernetes CubeSandbox 升级至正式 v0.8.0 并回归（P1）

依赖 D，且 D 已依赖 G。在已完成备份和排空的维护窗口，使用 tag v0.8.0 对应 Chart 及固定制品版本升级 Helm release cube。依据实际 Chart 差异分批完成 CubeOps、CubeMaster、API/Proxy/生命周期组件和计算面更新；逐项判断 Installer/Bootstrap 中必要的制品更新，记录宿主机实际版本。沿用已核验的 hostNetwork、节点选择、存储、PVC、Secret 引用和模板；不附带升级 MySQL/Redis/MinIO 主版本、启用 JuiceFS 或切换 PVM 主机内核。

验收：目标控制面和计算面运行固定的 v0.8.0 制品，Pod Ready、Cube 节点重新注册、既有模板可用；通过 Partners REST/MCP 完成创建、文件读写、增量 UTF-8 执行、非零退出、取消/超时、S3 产物下载和清理。恢复接单并记录升级后镜像 digest、Chart revision、运行时/模板版本、实测结果与回退入口。失败时保持接单关闭并按 G 的已验证路径恢复，避免半升级状态继续接单。只有镜像标签更新而宿主机运行时或功能验收未通过，不算完成。

## 顺序与预算

A 与 B 优先，C 可独立推进；运行时升级路径为 G → D → H → E，F 依赖 A、B、C、D、E、H。G 完成升级前盘点，H 必须实际更新现有集群；兼容性报告不能代替部署交付。任务依赖只表达逻辑关系，不自动分配或启动执行。

增加集群升级后，建议预算调整为约 8–10 个有效开发/运维工作日，业务维护窗口等待和外部排障另计；这是范围估算，不设未经确认的发布日期。若 D 暴露较大协议迁移，只处理维持现有功能所需的兼容修复，新增能力单独规划。

## 版本放行门槛

1. 已复现的租户/项目隔离和 REST 并发幂等问题修复并有回归。
2. 隔离 PostgreSQL / MinIO CI 实际执行，关键环境测试无跳过。
3. default / cube-system 中的现有 CubeSandbox 已实际完成 v0.7.2 → 正式 v0.8.0 升级，核心兼容测试有该实例的实机证据；组件、宿主机运行时、envd、模板版本及备份回退路径可追溯。
4. 标准 MCP Agent 的三轮工作区链路通过，产物可下载、失败可诊断、测试资源已清理。
5. 取消能力有明确 go/no-go 记录；文档与实际行为一致。

## 后续候选

保留工作区取消的正式实现、FS-only checkpoint、pause/resume、JuiceFS COW 跨节点恢复、预热池服务化，以及真实消费者的 Task Weaver 工程接入，留待本轮证据明确后独立排期。v0.1.5 不扩展 OAuth、自助多租户产品、新 Provider 或调度系统。
