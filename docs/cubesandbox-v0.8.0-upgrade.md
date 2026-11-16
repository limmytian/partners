# 现有 Kubernetes CubeSandbox v0.7.2 → v0.8.0 升级方案

> 执行更新：已实际升级到正式 v0.8.0，Helm revision 6。以下方案及只读基线保留；实际记录、digest、回归与回退入口见 [实施记录](iteration-v0.1.5-execution.md) 和 [部署证据](evidence/v0.1.5/deployment.json)。

日期：2026-11-16（Asia/Shanghai）。状态：已纳入 Partners v0.1.5；本次仅完成只读盘点，未执行升级。

## 授权与交付范围

用户已明确要求本轮迭代更新 Kubernetes 集群内的 CubeSandbox。目标为官方正式 v0.8.0，执行对象为 context `default`、namespace `cube-system`、Helm release `cube`。原计划中仅验证兼容性的范围扩大为实际集群升级与验收。现有 Partners 应用仍为 v0.1.4，升级后的兼容回归需覆盖它及本轮交付的修复。

升级沿用现有存储后端和网络模式。JuiceFS 切换、数据库/缓存主版本变更及主机内核切换属于独立变更，不包含在这次运行时版本更新中。

## 只读基线

| 项目 | 2026-11-16 观测结果 |
| --- | --- |
| Helm | release cube，revision 1，状态 deployed，chart cube-0.7.2，app_version 0.7.2 |
| 控制面 | cube-api、cube-master、cube-ops、cube-proxy、cube-templatecenter、cube-lifecycle-manager、cube-webui、cube-cubemastercli 的镜像标签均为 v0.7.2 |
| 计算面 | cube-node 的 cubelet、cube-egress、cube-egress-net 均为 v0.7.2 |
| 节点制品安装器 | cube-node-installer 的 cube-shim、cube-kernel、cube-guest、cube-agent 镜像标签均为 v0.7.2；宿主机实际安装版本待核对 |
| Bootstrap | cube-node-bootstrap 使用 cube-wait-node-prep:v0.7.2 |
| 网络与节点 | cube-node hostNetwork=true；nodeSelector 为 cube.tencent.com/cube-node=true；当前只在 dell-r730 运行 |
| Kubernetes 节点 | dell-r730、ser7 均 Ready；只有 dell-r730 当前运行 Cube 计算面 |
| 健康快照 | 所列 Cube Pod 全部 Ready；这不替代 API 和实际执行健康测试 |
| 沙箱列表 | 使用显式 cube-master 地址只读查询，返回 2 个沙箱 ID；归属、运行/暂停状态及恢复要求待 G 逐项核对 |
| 依赖 | 存在 cube-mysql、cube-redis、cube-minio StatefulSet；备份/恢复与 schema 兼容尚待核验 |
| Partners | Gateway 和 Console 使用固定 digest 的 v0.1.4 镜像，均有 1 个 Ready 副本 |

镜像标签是本次观测信息；执行前必须记录运行中 imageID/digest、Helm values 和主机制品，不能把标签当成完整制品证明。当前 template/backend、活跃/暂停沙箱及用户工作区状态尚待 G 盘点。

## 升级路径

1. **G：盘点与恢复准备。** 固化配置和制品基线；盘点现有沙箱/工作区；生成和校验数据备份；确认回退是否涉及 schema 与主机文件；准备维护窗口中的接单暂停及工作区保存方案。
2. **D：兼容适配。** 对比正式 v0.8.0 的 Chart、控制面地址、API/Proxy/envd 协议与运行时制品，完成所需 Partners 适配和回归脚本。可用时优先独立环境试验；单节点维护试升级由 H 承担。
3. **H：实际升级。** 暂停接单，保存用户工作区，按官方节点操作流程隔离计算节点并等待至少 60 秒，确认排空后升级。依据配置迁移核对 CubeOps → CubeMaster → 计算面依赖，保持控制面可达；更新必要 Installer/Bootstrap 制品并核实宿主机实际版本。
4. **H：恢复与回归。** 确认节点注册、Pod Ready、模板恢复、沙箱创建和执行，再恢复接单。核心用例覆盖文件、UTF-8 输出、非零退出、取消、超时与产物；只清理本次创建的测试资源。
5. **E/F：版本验收。** 在已升级实例调查进程取消，完成标准 MCP Agent 三轮工作区运行，固化版本、回退和验收证据。

## 必须核对的官方升级行为

官方 v0.8.0 文档说明：计算面 DaemonSet 模板变化会重建 cube-node。hostNetwork 下主机网络设备可以存活，但在官方实机验证 cubelet 重启后的沙箱存活之前，支持的路径仍是排空升级；Pod 网络下则必须排空。当前只有一个计算节点，因此应按执行服务维护中断安排，不承诺零中断。

升级需保留显式 hostNetwork=true 和原始 values 分层，不能直接套新 Chart 默认值覆盖现有配置。CubeOps、CubeMaster 与 cubelet 的注册地址迁移必须按实际版本差异确认；不以全局替换镜像标签代替 Chart/配置迁移。回退同时考虑 Helm revision、节点安装制品和数据库状态，不能仅执行 helm rollback 就宣称已恢复。

来源：[v0.8.0 官方 Kubernetes 升级文档](https://github.com/TencentCloud/CubeSandbox/blob/v0.8.0/docs/guide/kubernetes/upgrade.md)。

## 完成条件

- 现有集群运行目标 v0.8.0 控制面/计算面，必要节点制品版本经核实且可追溯。
- 原有模板和存储配置仍可用，既有工作区按盘点方案保存或恢复。
- Partners REST/MCP 对升级后实例的功能回归通过，重新接单后无持续错误。
- 升级前备份、版本清单、实际操作与回退入口形成脱敏证据。
- 本轮不以启用 JuiceFS、切换内核或引入 master 未发布修复为升级完成条件。
