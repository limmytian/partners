# 保留工作区取消：NO-GO

在正式 v0.8.0 集群、原有 sandbox-code-probe 模板上，envd `process.Process/SendSignal` 只能证明所寻址进程退出，不能证明整个作业停止。v0.1.5 保留当前策略：确认销毁 sandbox 后才确认取消/超时，不启用保留工作区取消。

调查采用半日上限，源码/协议检查后实测获得明确反例即提前结束，没有声称持续测试满半日。升级镜像来自正式 tag `41748bb...`；模板中的 envd 为 0.5.11，结论针对这组实际部署制品，不能推广到所有未来模板。

只创建一个自有测试沙箱。父进程与通过 `setsid` 脱离进程组的子、孙进程都忽略 TERM，并分别写心跳：

| 操作 | 实测结果 |
| --- | --- |
| Start | 返回可寻址 PID 14 |
| TERM | HTTP 200，父进程心跳继续增长 |
| KILL | HTTP 200，父进程消失；子 PID 15、孙 PID 16 心跳继续增长 |
| 重复 KILL | HTTP 404，不代表后代停止 |
| 断开执行流 | 父、子、孙仍继续运行 |
| Connect 1 秒 deadline | 父进程退出并返回 deadline_exceeded；子、孙仍运行 |
| 随后工作区读写 | 原工作区可继续写入和读取 UTF-8 文件，但并不安全复用给下一作业 |
| 清理 | 删除该自有 sandbox，确认后续 GET 为 404 |

[原始脱敏协议/心跳证据](evidence/v0.1.5/cancellation.json)；可重跑脚本 `node scripts/cube-cancellation-investigation.mjs`，要求显式设置 API/Proxy endpoint。SDK 的 kill 方法、仅杀父进程、断线、暂停或重启均不能代替进程树确认。

后续若实施保留工作区取消，需要隔离每个作业的 cgroup/进程树，处理 daemonize/setsid、PID 重用、重复取消、断线和确认退出，再做独立设计与实机回归。
