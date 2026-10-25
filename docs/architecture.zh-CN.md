# 架构说明

GrokChan 通过一个小型 Cloudflare Worker **桥（bridge）**，把浏览器或 M5Stack 类设备接到上游 **Agent**。

默认文档是英文：[architecture.md](architecture.md)。本文是中文版。

## 总览

```text
浏览器 / 固件  ──HTTPS──▶  Bridge Worker (+ Durable Object)
                              │
                              │  agent.deliver() + 一次性 reply.url
                              ▼
                         Agent 适配层（grokbot / muse…）
                              │
                              │  POST /api/reply/<token>
                              ▼
                         会话写入，客户端轮询拿到回复
```

## 多 Agent 设计

HTTP 路由和 `ChatHub` **不绑定**某一家上游。上游实现 `AgentProvider`（见 `bridge/src/agents/`）：

| Provider | 作用 |
| --- | --- |
| `grokbot` | 向 Grok Bot webhook 投递 `grokbot-web.inbound.v1` 事件（含 `reply.url`），routine 再 POST 回文本 |
| `muse` | 占位，预留给 Meta Muse / 第三方 Muse API |

用环境变量 `AGENT_PROVIDER` 选择（默认 `grokbot`）。新增 Agent = 新模块 + registry 分支，不必改聊天路由。

## 组件

| 目录 | 作用 |
| --- | --- |
| `bridge/` | 可部署的 Worker、DO、聊天页、Agent 适配器 |
| `firmware/` | ESP32 / M5Stack 占位 |
| Grok Bot routine | Webhook 触发，向 `reply.url` 回帖 |

## 密钥

不要提交密钥。只用 `wrangler secret put` 写入：

- `GROK_WEBHOOK_URL`、`GROK_WEBHOOK_KEY`、`SITE_PASSCODE`

`PUBLIC_ORIGIN`、`AGENT_PROVIDER` 放在 `wrangler.toml` 的 `[vars]`。

**注意：** 部分 Cloudflare MCP / API 工具写 secret 时会把真实值**打成占位符**。请用交互式 `wrangler secret put`；否则 webhook 常表现为 **401**。

详见 [bridge/README.md](../bridge/README.md)。
