---
name: partners-gateway-integration
description: Partners Gateway 接入引导及基础功能介绍。包含网关架构、安全沙箱执行环境、鉴权方式、短任务执行、持久化 Session 会话、日志事件流及 S3 产物收集等核心接口调用规范与示例。
keywords: ["partners", "partners-gateway", "sandbox", "remote-execution", "k8s", "code-runner", "gvisor"]
tags: ["integration", "gateway", "sandbox", "execution", "partners"]
---

# Partners Gateway 接入与基础功能指南

Partners Gateway 是部署于 Kubernetes 集群内的轻量级、安全的远程代码与任务沙箱执行网关服务。
它为 Task Weaver 智能体、自动化工作流及外部第三方微服务提供受控容器沙箱（支持 gVisor 隔离运行时）中的命令执行、持久会话（REPL）、实时 SSE 事件流推送以及对象存储（RustFS / S3）构建产物归档功能。

---

## 1. 基础服务信息与环境接入

### 1.1 服务地址 (Endpoint)
- **K8s 集群内访问**：
  `http://partners-gateway.partners.svc.cluster.local:8080` 或 `http://partners-gateway.partners:8080`
- **局域网/跨主机访问**：
  可通过配置的 NodePort 或 Ingress 访问（默认容器端口为 `8080`）。

### 1.2 认证与鉴权 (Authentication)
网关支持基于服务令牌（Bearer Token）认证：
- **请求头规范**：
  ```http
  Authorization: Bearer <GATEWAY_SERVICE_TOKEN>
  X-Tenant-Id: <TENANT_ID>
  Content-Type: application/json
  ```
- **Token 获取方式**：
  从集群 Secret 或环境变量 `GATEWAY_SERVICE_TOKEN` 获取。
- **支持的租户 (Tenant IDs)**：
  `partners`, `task-weaver`, `tw`, `default`, `local`

---

## 2. 基础健康检查与监控

在发起执行任务前，可通过以下健康探针接口确认网关就绪状态：

```bash
# 服务存活探针 (无需鉴权)
curl -fsS http://partners-gateway.partners:8080/health

# 服务就绪探针 (校验 DB/S3 连通性)
curl -fsS http://partners-gateway.partners:8080/ready

# Prometheus 监控指标
curl -fsS http://partners-gateway.partners:8080/metrics
```

---

## 3. 核心功能一：短任务执行 (Ephemeral Jobs)

单次瞬态任务适用于跑测试用例、执行脚本、编译构建或分析代码。

### 3.1 发起任务 (`POST /v1/jobs`)
支持注入内存文件输入、运行指定命令，并按 glob 规则自动将生成产物上传至 S3。

```bash
curl -X POST http://partners-gateway.partners:8080/v1/jobs \
  -H "Authorization: Bearer <GATEWAY_SERVICE_TOKEN>" \
  -H "X-Tenant-Id: task-weaver" \
  -H "Content-Type: application/json" \
  -d '{
    "command": {
      "argv": ["python3", "main.py"],
      "cwd": "/workspace"
    },
    "inputs": {
      "files": [
        {
          "path": "/workspace/main.py",
          "content": "with open(\"output.txt\", \"w\") as f:\n    f.write(\"Task completed successfully\")\nprint(\"Hello from Partners Sandbox!\")"
        }
      ]
    },
    "artifactPolicy": {
      "collect": ["output.txt"]
    },
    "timeoutMs": 60000
  }'
```

**响应示例**：
```json
{
  "jobId": "job-87fc0b0e-bdf1-4a1d-8422-921d7b1a134d",
  "status": "pending",
  "createdAt": "2026-09-08T09:12:00Z"
}
```

### 3.2 监听实时执行日志 (`GET /v1/jobs/{jobId}/events`)
接口提供 Server-Sent Events (SSE) 协议的实时流式输出，涵盖任务阶段（调度、拉取、执行中、完成、失败）及标准输出/错误流（stdout/stderr）：

```bash
curl -N http://partners-gateway.partners:8080/v1/jobs/<JOB_ID>/events \
  -H "Authorization: Bearer <GATEWAY_SERVICE_TOKEN>" \
  -H "X-Tenant-Id: task-weaver"
```

### 3.3 取消任务 (`POST /v1/jobs/{jobId}/cancel`)
如需终止长时间挂起或超时的任务：
```bash
curl -X POST http://partners-gateway.partners:8080/v1/jobs/<JOB_ID>/cancel \
  -H "Authorization: Bearer <GATEWAY_SERVICE_TOKEN>" \
  -H "X-Tenant-Id: task-weaver"
```

---

## 4. 核心功能二：持久会话 (Stateful Sessions)

适用于多轮交互式分析、连续执行状态保持（例如类似 Jupyter / REPL 会话、持续排障）。

### 4.1 创建 Session (`POST /v1/sessions`)
```bash
curl -X POST http://partners-gateway.partners:8080/v1/sessions \
  -H "Authorization: Bearer <GATEWAY_SERVICE_TOKEN>" \
  -H "X-Tenant-Id: task-weaver" \
  -H "Content-Type: application/json" \
  -d '{
    "ttlSeconds": 1800,
    "environment": {
      "WORKSPACE": "/workspace"
    }
  }'
```

**响应**：返回 `sessionId`。后续调用可在同一容器环境下多次执行命令。

### 4.2 销毁 Session (`DELETE /v1/sessions/{sessionId}`)
完成交互后及时释放资源：
```bash
curl -X DELETE http://partners-gateway.partners:8080/v1/sessions/<SESSION_ID> \
  -H "Authorization: Bearer <GATEWAY_SERVICE_TOKEN>" \
  -H "X-Tenant-Id: task-weaver"
```

---

## 5. 核心功能三：构建产物下载 (Artifacts)

当任务中配置了 `artifactPolicy.collect`，网关会在沙箱退出前将匹配的文件压缩或独立同步至 RustFS S3 存储桶（`partners` 桶）。

### 5.1 获取产物列表与下载
从任务完成事件或查询接口获取 `artifactId`，直接通过 HTTP 流式下载：
```bash
curl -O -J -L http://partners-gateway.partners:8080/v1/artifacts/<ARTIFACT_ID>/download \
  -H "Authorization: Bearer <GATEWAY_SERVICE_TOKEN>" \
  -H "X-Tenant-Id: task-weaver"
```

---

## 6. 在 Task Weaver 中的典型接入模式

1. **作为 Executor 执行引擎**：
   Task Weaver Agent 在处理代码生成、测试与编译时，将任务提交给 Partners Gateway 沙箱运行，实现安全沙盒隔离。
2. **安全隔离保障**：
   底层使用 Linux 安全容器与 gVisor 运行时隔离，避免母机逃逸与网络滥用。
3. **状态追溯与审计**：
   所有任务元数据、执行日志、产物摘要均被持久化在 PostgreSQL `partners` schema 中，支持审计与状态溯源。
