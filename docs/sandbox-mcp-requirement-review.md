# Partners Sandbox MCP：需求评估与实施边界

评估日期：2026-10-14。对应需求：0b1b70d7-4eb1-4a08-8b97-1a6c43206499。

## 结论与原需求问题

需求有价值：让 标准 MCP 客户端 通过标准工具调用复用 Partners 的沙箱算力和工作区，无需理解底层 provider。建议保留 high 优先级，但把“增加 SSE / Stream over HTTP 并直接对接 CubeSandbox”改为“在 Gateway 上提供有版本边界、可鉴权、可恢复的 MCP 适配层”。本次完成需求优化，不代表 MCP 已实现或线上验证通过。

原描述缺少协议版本、会话获取方式、完整工具 schema、权限矩阵、重复提交处理、并发策略和验收标准；三个任务均为 todo、描述为空，需求未关联仓库。没有这些约束，容易交付一个能执行命令却无法安全复用和稳定接入的端点。

## 仓库证据与复用边界

- `src/gateway/http-agent-execution-gateway.js` 已提供 session 创建/查询/删除、job 提交/查询/取消、工作区 tree/file/sync、事件 SSE 和 artifact 下载。`/v1/jobs` 返回 202，作业后台执行。现有 job SSE 不是 MCP 协议端点。
- `src/gateway/in-memory-agent-execution-gateway.js`、`src/core/provider-contract.js` 是公共执行边界；已有 Local、Kubernetes、CubeSandbox provider。MCP handler 不直接调用 CubeSandbox SDK、宿主机 shell 或 Kubernetes exec。
- `src/security/gateway-service-auth.js` 已有 token scope、租户/项目范围、撤销/过期检查。但无 token 配置时会放行；MCP 开启时必须默认要求鉴权。
- 文件接口已有 `sessions:read`/`sessions:write` scope；`src/security/workspace-security.js` 与文件服务已有路径/符号链接/敏感文件策略。MCP 不暴露 allowSensitive、redact=false 等绕过参数；仍需测试远端 provider 是否等价执行策略。
- job 幂等存储可复用，但当前 HTTP 路径是“读 replay → 启动作业 → 保存 replay”；仅凭这个流程不能证明跨副本并发原子性。MCP 的重复命令保护需要持久化原子占位和故障恢复。
- Kubernetes provider 当前未实现与 Local/CubeSandbox 相同的工作区浏览方法；不能宣称所有 provider 都支持 file_ops。须进行 capability 检查，明确返回不支持，禁止退回宿主文件系统。
- session TTL、工作区写操作互斥和网关重启后的运行中作业恢复，不能仅凭现有文档视为完成，纳入交付测试。

## 产品范围

P0：一个远程 `/mcp` 端点；工具发现与调用；显式 workspace session 管理；异步命令提交/结果查询/取消；有限制的目录列表、文本读取、单文件写入；鉴权、幂等、TTL、输出限制；可运行的客户端示例和 CubeSandbox 真实环境验收。

P1：有实证需求后增加旧 HTTP+SSE、stdio 代理、批量/二进制文件工具、快照/模板、PTY、preview、MCP resources/prompts、OAuth 用户接入及 2026-07-28 协议支持。若目标客户端明确要求其中一项，先调整范围再实施。P0 为受信任服务客户端使用 scoped bearer 的部署契约，不宣称实现面向任意用户客户端的完整 MCP OAuth 授权规范。

不在本需求中自动安装 TW registry 配置、修改 Pia/TW 源码或推进 TW 任务状态；提供无密钥接入说明，外部消费方代码变更另建需求。

## 协议版本与兼容性决策

- 名称统一为 Streamable HTTP。SSE 是响应编码选项，不与旧 HTTP+SSE 作为两个默认必做协议。
- 建议 P0 固定 2025-11-25 兼容基线，使用与该版本匹配且锁定版本的官方 SDK。这是兼容性选择，不是“最新版”声明。本次以 Partners 官方 SDK 与 TW 参考客户端验证；不要求外部产品接入；若客户端只支持 2026-07-28，先修订基线和测试矩阵，不可假定兼容。
- 2025-11-25 分支覆盖 initialize、initialized、ping、tools/list、tools/call、版本协商、通知、请求 ID 和 MIME/Accept；不支持的方法/版本明确报错。GET 可按规范返回 405；是否启用协议 session 由锁定 SDK 决定，协议 session 永远不充当授权凭据。
- 2026-07-28 移除了 GET stream 和协议 session，并调整请求元数据与取消语义；不可混用两个版本的握手和取消逻辑。P0 不宣称支持该版本。
- 长任务不依赖 MCP 长连接：bash_exec 仅提交并迅速返回 jobId；job_get 查询；job_cancel 显式取消。连接断开不取消已接受的后台 job。取消一个查询/提交请求与取消沙箱 job 是不同操作；“接受前断线、接受后丢响应”都通过相同 requestId 重试定位原 job。

## P0 工具契约（设计任务需固化 JSON Schema）

所有输入 schema 禁止未知字段；租户/项目来源必须由服务端对鉴权上下文验证。客户端 resource ID 不构成授权。默认输出为 structuredContent 加短文本摘要，包含 requestId/traceId、相关 sessionId/jobId 与稳定错误 code。协议错误与工具业务错误分别处理；非零退出码必须保留，不能显示成功。

| 工具 | 输入概要 | 输出/权限 |
| --- | --- | --- |
| session_create | requestId、已授权 tenantId/projectId、可选受控 profile、ttlSeconds | sessionId、state、expiresAt、有效限额与能力；sessions:create |
| session_get | sessionId | 状态、有效能力、过期时间；sessions:read |
| session_delete | sessionId | 删除/回收状态；sessions:delete；有活跃 job 返回 SESSION_BUSY，先显式 cancel |
| bash_exec | sessionId、command 字符串、cwd 相对工作区、timeoutSeconds、requestId | accepted jobId、state；jobs:create + 对目标 session 的授权；映射沙箱内 bash -lc，禁止宿主执行 |
| job_get | jobId、可选日志 cursor、maxOutputBytes | state、exitCode、stdout/stderr 有界片段、nextCursor、truncated、artifactRefs；jobs:read，artifact 内容另需 artifacts:read |
| job_cancel | jobId、可选 reason | 当前/取消请求状态；jobs:cancel；终态重复取消返回终态，不重复副作用 |
| file_ops | sessionId、action=list/read/write 的判别联合 | list/read 要 sessions:read；write 要 sessions:write；不同 action 参数不可混用 |

file_ops.list：path、depth、cursor、limit → 有界 entries 与 nextCursor。
file_ops.read：path、offsetBytes、maxBytes → UTF-8 预览、截断/大小信息；二进制返回 BINARY_UNSUPPORTED。
file_ops.write：path、UTF-8 content、requestId、expectedHash 或明确 create-only 条件 → 新内容 hash/字节数。单文件原子替换、覆盖冲突可检测；P0 不支持删除、移动、目录归档或通用 shell 文件操作。

bash_exec 保留原需求工具名。file_ops 保留名称，但必须用判别联合清楚区分只读/写操作；混合工具的 MCP annotation 不得标为整体 readOnly，权限按 action 检查。如果目标客户端支持细粒度工具更好，可在契约冻结前选择拆成 file_list/file_read/file_write，禁止同时提供两套重复工具。

## 安全与执行语义

1. 每个请求认证，按工具/action 校验 scope，加载真实 session/job/artifact 记录验证 tenant/project 与 caller 授权。创建时强制明确范围；查询/执行时不得用调用者传入的范围覆盖资源范围。鉴权失败无 provider 副作用。验证 Origin allowlist、请求体上限；非浏览器缺少 Origin 可在认证后接受。TLS 在部署入口终止，禁止 URL/query 携带 token。
2. sessionId 指 Partners 持久工作区，协议连接重建不能隐式创建或销毁它。默认服务身份权限与 Gateway tenant/project scope 一致；不承诺同项目内按用户隔离。需要用户隔离时必须另加可信 owner ACL，不能靠 conversationId。共享服务 token 不构成用户隔离。
3. shell 权限等价于该沙箱内任意命令执行。敏感文件预览限制不能阻止有 exec 权限者读取沙箱内可见密钥；真正的保护来自沙箱隔离、最小化凭据挂载、短期授权、网络策略和输出脱敏。不得把文件过滤描述为 exec 的安全边界。
4. 工作区路径使用同一规范化策略，拒绝 traversal、NUL、越界绝对路径和 symlink escape；写入需考虑 symlink/父目录替换竞态。远端文件操作必须发生在目标沙箱侧，不能仅在网关本机检查路径后信任远端结果。
5. 同 session 的 job 与写文件默认单写者；忙时返回 SESSION_BUSY，不做无限队列。读操作定义为实时预览，可能反映执行中状态；需要一致读取应等 job 终态。锁须跨进程有效、可恢复，不能仅用内存 mutex。
6. session_create/bash_exec/file_ops.write 的 requestId 使用与现有 Idempotency-Key 相同的 8–200 字符约束。key 作用域包含可信 tenant/project、工具、session（适用时）；不使用 MCP JSON-RPC id。相同 key/相同请求返回原结果；不同请求返回 IDEMPOTENCY_CONFLICT。默认保存 24h，并发跨副本只允许一次提交。24h 后不承诺去重；不能用原 key 再自动重试不可判定的旧副作用。
7. 幂等占位、job 持久接受、provider 启动顺序需形成可恢复契约；失败/重启不能悄悄重跑未判定执行。运行中恢复失败标为明确诊断状态，保留 jobId，不把丢失进程自动当作新执行。结果存储与审计不含明文凭据。
8. TTL 区分空闲 TTL、绝对最大生命期和 job 超时。活跃 job 不被空闲回收误删；超过绝对生命期先请求取消，再按有界 grace period 回收；artifact 按独立 retention 保留。连接断开不刷新/清除 session 生命周期。

## 建议默认限额（产品建议，非现有实现事实）

job timeout 默认 120s、上限 900s；session 空闲 TTL 30min、绝对生命期 8h；取消/清理 grace period 30s；每租户活跃 session 10、job 20；每 session 一个写者。

MCP 请求体上限 1MiB；stdout+stderr 每次查询默认合计 16KiB、上限 64KiB，UTF-8 安全截断；写文件上限 256KiB，读取默认 16KiB、上限 64KiB；目录深度默认 3、上限 5，分页默认 100、上限 500。均由服务端配置约束，用户只能降低不能越权提高。完整日志走有权限与 retention 的 artifact 路径，不能在 MCP 返回无限内容。提交通知/轮询不得因大输出令网关内存无界增长。

错误至少区分 INVALID_ARGUMENT、UNAUTHENTICATED、FORBIDDEN、NOT_FOUND、UNSUPPORTED_CAPABILITY、SESSION_BUSY、SESSION_EXPIRED、QUOTA_EXCEEDED、IDEMPOTENCY_CONFLICT、WRITE_CONFLICT、PROVIDER_UNAVAILABLE。是否 retryable 必须与副作用是否已接受一起返回；command failed/timed_out/cancelled 保留 job 终态。

## 分阶段交付与验收

A. 契约与客户端矩阵：冻结版本、schema、权限、错误、默认值；形成客户端实测记录。
B. 公共安全/幂等边界 + MCP transport/provider 映射：复用同一鉴权/服务层，REST 与 MCP 行为一致；不把网络接通等同完成。
C. 生命周期/并发/输出控制：Postgres 多副本及重启验证，明确 provider 能力不足。
D. 端到端交付：Local 自动化 + 真实 CubeSandbox 环境，文档与客户端配置示例；缺真实环境时记录阻塞与证据，不宣称生产可用。

验收闭环：连接 → tools/list → create → write hello.py → bash_exec → job_get 得到输出/exitCode → file read/list → timeout/cancel → delete。必须另覆盖：无/过期/撤销 token、跨租户/项目访问、只读 token 写入、非法 Origin、路径与 symlink 逃逸、敏感文件、并发同 key 唯一 job、key 冲突、断线后复用、重启后定位、busy 写冲突、超大 UTF-8 输出/请求、TTL 清理与 artifact 保留、provider 不支持能力、取消权限不足、SDK 不支持版本。

发布开关默认关闭；开启必须有 token/限额/Origin 配置。health/readiness 能表示 MCP 与 provider readiness，指标至少包含 tool 调用耗时/错误、accepted job、幂等 replay/conflict、busy/quota 拒绝与回收结果。审计记录可信主体、scope、tool/action、资源 ID、traceId、结果和耗时；禁止默认记录命令/文件全文与原始 token。验收报告注明 SDK/协议/镜像版本与真实环境，并提供回滚关闭开关步骤。

原三个任务保留，补充三个任务覆盖权限幂等、文件安全与交付验证，建立 blocks 依赖。原定 2026-10-21 日期保留为原计划目标，不因补充范围默认为已验证可交付；完成契约后据环境可用性与实现估算复核。

## 协议参考

- [MCP 2025-11-25 Transports](https://modelcontextprotocol.io/specification/2025-11-25/basic/transports)
- [MCP 2026-07-28 Streamable HTTP](https://modelcontextprotocol.io/specification/2026-07-28/basic/transports/streamable-http)
- [官方 TypeScript SDK v1 Server](https://ts.sdk.modelcontextprotocol.io/server)

以上用于版本/transport 对照；Partners 服务端与标准 SDK 客户端兼容性由实现测试验证。


## 实施记录（2026-10-14）

已在 codex/sandbox-mcp 完成五项实现任务与七项工具。固定官方 SDK 1.31.0、2025-11-25；新增部署开关、测试与 smoke 脚本。全量测试 144 项：143 通过、1 项 MinIO 条件测试跳过；真实 PostgreSQL 两个 Gateway 实例仅启动一个作业；实际本地服务 smoke 通过。用户已明确：仅交付 Partners MCP，不依赖外部 Agent 产品接入。

CubeSandbox 取消/超时以销毁工作区确认停止；目录枚举、日志捕获和不确定操作保留的边界详见 docs/sandbox-mcp.md。当前 cube-api 无可用端点、端口转发 kubelet 返回 502；真实远程验收仍在 in_review，不宣称生产验证通过。详见 docs/sandbox-mcp-validation.md。
