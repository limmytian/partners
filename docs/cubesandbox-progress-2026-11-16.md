# CubeSandbox 进展与 Partners 接入判断

核查时间：2026-11-16（Asia/Shanghai）。来源：TencentCloud/CubeSandbox 官方 GitHub releases、tag 和提交记录。结论针对上游公开代码与发布说明；本次未升级或验证现有集群。

## 发布状态

- 最新正式产品版本：**v0.8.0**，2026-11-12 13:23 UTC 发布；tag 对应提交 `41748bb78d6384962b4e417ff9215720ea7472fd`。来源：[正式 release](https://github.com/TencentCloud/CubeSandbox/releases/tag/v0.8.0)。
- 本次读取到的 master 最新提交：`23387ef15785f41ad2b9d47d2d8e337582bdbe5c`，2026-11-16 08:50 UTC。来源：[提交](https://github.com/TencentCloud/CubeSandbox/commit/23387ef15785f41ad2b9d47d2d8e337582bdbe5c)。这是查询时快照，后续可能变化。
- `kernel-release-261116-test1` 是测试内核预发布，发布说明明确不作为产品固定版本。来源：[内核测试 release](https://github.com/TencentCloud/CubeSandbox/releases/tag/kernel-release-261116-test1)。
- 2026-11-16 集群只读盘点确认现有 default / cube-system 的 Helm release cube 为 chart cube-0.7.2，所列控制面与计算面镜像标签为 v0.7.2。envd、模板和宿主机安装制品仍待升级前盘点。用户已要求本轮实际升级至正式 v0.8.0，见 [集群升级方案](cubesandbox-v0.8.0-upgrade.md)。

## 与 Partners 相关的正式版变化

以下事实均来自 [v0.8.0 发布说明](https://github.com/TencentCloud/CubeSandbox/releases/tag/v0.8.0)，收益判断是本项目的接入推断。

| 上游变化 | 对 Partners 的意义 | 本轮处理 |
| --- | --- | --- |
| FS-only 快照，可由文件系统快照冷启动 | 可探索低成本代码与依赖 checkpoint；不能等同恢复内存或已有进程 | 列为下一版候选 |
| JuiceFS COW 后端处于 preview，支持跨节点模板共享和恢复 | 有助于节点迁移与工作区恢复；区别于 Partners 现有 PVC/工作区存储用法 | 不迁移生产存储，另做实验 |
| 支持 E2B SDK 2.51.0+ 的 `/v2/sandboxes` 与 connect；SDK fork、is_running 等补齐 | 要检查现有自研 HTTP 客户端与 envd 数据通道，不能只升级 SDK 版本 | 纳入兼容性验收 |
| sandbox 资源指标、日志采集和默认 dashboard；模板级网络/磁盘 QoS | 能复用底层可观测性和资源治理，Partners 侧补作业/租户关联 | 先形成指标与能力映射 |
| 服务故障后的 sandbox restart policy | 可改善服务恢复，但自动重启不代表作业成功或可安全重跑 | 核对默认配置与结果语义 |
| SDK 文件读取、超时与 sandbox 状态判断等修复 | 与现有文件、超时、终态链路直接相关 | 加入真实回归场景 |

## 正式版之后值得关注的修复

这些修复已在所查 master 中，但不属于 v0.8.0 tag；采用前需要固定具体版本并重新验证。

- 2026-11-16，CLM 超时清理识别 sandbox 不存在的返回码，避免保留失效注册并重复清理；仍不包含持久 Redis orphan 清理。来源：[PR #2266 对应提交](https://github.com/TencentCloud/CubeSandbox/commit/baa9251c3b5ac3200c0d4cfd6ed2fb3c8cc8d343)。与 Partners TTL/销毁确认回归相关。
- 2026-11-16，就绪探测超时保留最后一次探测错误，使创建失败的诊断更具体。来源：[PR #2285 对应提交](https://github.com/TencentCloud/CubeSandbox/commit/458a6b91cb8789317cb2352dc5bfc38d9046ce36)。与模板初始化与服务就绪排障相关。

## 对进程取消的判断

v0.8.0 release 没有为 Partners 当前命令执行路径提供“整个进程树已停止且工作区可复用”的验收证明。上游生命周期 timeout kill、sandbox pause/resume、自动重启和进程取消是不同语义；不能据此撤掉 Partners 当前的 VM 销毁确认策略。

安排半日核验部署中的 envd process 标识、信号、进程组、结束确认和断线行为。调查有明确结论即可关闭调查任务；正式实现仍需独立设计与实机测试。已有 [Partners 取消边界](sandbox-mcp.md) 继续有效。

## 采用顺序

1. 在隔离环境固定正式 v0.8.0，核验控制面、代理、envd、模板与关键执行链路。
2. 观察与 TTL/创建失败相关的正式版后修复，遇到对应问题时单独评估 backport 或下一正式版。
3. 得到真实使用数据后再实验 FS-only checkpoint 与 JuiceFS 跨节点恢复。

这是一份截至核查日期的调研记录；本轮已纳入现有集群升级，但本次只读盘点不代表部署已经更新。JuiceFS 后端仍单独实验和排期。
