# WorkBuddy 语音大脑接入计划（方案②，暂未开工）

状态：只有计划，还没写代码。目标是让语音大脑可以在 `grokbot` 和腾讯 WorkBuddy 之间切换，固件和 `mediasession-rpc/1` 协议都不用改。

## 1. 思路

现有语音回合是 `thinking → AgentProvider.deliver(inbound, reply.url) → 回帖 → speaking`。
新增 `agents/workbuddy.ts`，契约和 `grokbot.ts` 一样。它的流程：

1. 校验 Durable Object 里的 OAuth token，快过期就 refresh，401 时标记为需要重新授权。
2. 确保有一个 cloud assistant（用 `WORKBUDDY_ASST_ID`，或第一次时自动创建）。
3. 调 `POST /openapi/v2/tasks`，把 `turn_id` 作为 `Idempotency-Key`。
4. MVP 版本用轮询 `GET /tasks/{id}` 取回复，超时和 `AGENT_REPLY_TIMEOUT_MS` 对齐。
5. 回复按 `VOICE_REPLY_MAX_CHARS` 裁剪后，`POST reply.url {"text"}`，后面的 hub/voice 流程不变。

`deliver()` 要尽快返回已受理，重的工作放到 `waitUntil` 或 alarm 里做。

## 2. 接口映射

| GrokChan | WorkBuddy | 说明 |
|---|---|---|
| `InboundChat.message`（ASR 定稿） | tasks 的 input / prompt | `execution_target=cloud` |
| `InboundChat.device` | prompt 前缀或 assistant instruction | 要求一两句、适合 TTS 的口语回复 |
| `InboundChat.history` | 第一版不逐条转发 | 由 WorkBuddy 的 assistant/session 自己维护记忆 |
| `session_id`（`dev_<deviceId>`） | 一个 `asst_id`，或 ACP `session/load` | 推荐一个用户对应一个 assistant |
| `ReplyTarget.url` | provider 拿到文本后回帖 | 和 grokbot 走同一个回帖接口 |
| 流式（可选） | ACP SSE + `session/prompt` | 作为后续阶段 P2.1 |
| MCP 控机 | 不属于 AgentProvider | 见第 5 节「双脑问题」 |

## 3. 切换与密钥

- `AGENT_PROVIDER=workbuddy|grokbot`，默认是 `grokbot`。按会话切换（`session.agent_override`）放到以后再做。
- OAuth 回调地址：`https://grokchan-bridge.leeoxiang.workers.dev/oauth/workbuddy/callback`。本地另登记 `http://127.0.0.1:8787/...`，必须和开放平台上登记的逐字一致。

| 名称 | 类型 | 用途 |
|---|---|---|
| `WORKBUDDY_CLIENT_ID` / `WORKBUDDY_CLIENT_SECRET` | secret | OAuth |
| `WORKBUDDY_REDIRECT_URI` | var | 回调地址 |
| `WORKBUDDY_BASE_URL` | var | 默认 `https://open.workbuddy.cn`，以控制台文档为准 |
| `WORKBUDDY_ASST_ID` | var，可选 | 预先建好的 cloud assistant |
| `WORKBUDDY_MOCK` | var | 设为 1 时使用 mock，给 `/sim` 和 CI 用 |

用户的 `access_token`、`refresh_token`、`openid` 只存在 Durable Object（`WorkBuddyAuth`）里。不能进固件、浏览器存储或仓库。

## 4. Leo 需要准备的

1. 在 https://open.workbuddy.cn/ 建应用，拿到 `client_id` 和 `client_secret`。
2. 登记上面的回调地址。
3. 勾选建任务和读任务需要的 scope。白皮书写的是 `assistant.*` 和 `task.*`，SDK 里常见的是 `user.task.*`，以控制台为准。不要勾 `local.*`。
4. 确认控制台里正式的 Base URL 和 scope 名称。
5. 部署后在浏览器里做一次「绑定 WorkBuddy」授权。

自用联调用个人账号的 OpenAPI 就可以。硬件专区审核需要企业实名，不是这个方案的前提。

## 5. 风险

- **双脑问题**：切到 WorkBuddy 后，如果 Grok 还挂着有完整权限的 MCP，就会变成「嘴是 WB、手是 Grok」。解决办法是 MCP 也改挂到 WB，或者给 Grok 一把只读 key。
- **延迟**：任务可能要好几秒。prompt 里要求短答，用超时兜底，后续用流式降低首句延迟。
- **Workers 上的 SSE**：DO 休眠可能掐断连接。所以 MVP 只用轮询，最终结果写进 storage。
- **回合中 token 过期**：deliver 前先 refresh，401 时重试一次，还失败就提示重新绑定。
- **限流**：已有 `VOICE_TURNS_PER_MIN`，遇到 429 退避。
- **不要用逆向网关**（比如 WorkBuddy2API），有违反服务条款和封号的风险。

## 6. 排期（约 5–8 人日）

| 日 | 交付 | 验收 |
|---|---|---|
| D1 | OAuth 骨架、`/oauth/workbuddy/start` 和 `/callback`、registry 加 `workbuddy`、mock | 校验 state 防 CSRF，密钥不进日志 |
| D2 | `WorkBuddyAuth` DO，加 refresh | 重启后 refresh 还在，过期能自动续期 |
| D3 | assistants + tasks 轮询 MVP | 在 `/sim` 上能走完 thinking → WB 回复 → speaking |
| D4 | 超时、打断、幂等、裁剪 | 迟到的回复按 stale 处理，超时会 abort |
| D5 | 用真实账号联调，并写文档 | 延迟和错误码记录进文档 |
| D6（可选） | ACP 流式 | 拼出整句后提前开始 TTS，断流时退回轮询 |
| D7 | 双脑和开关文档 | 能一键切回 `grokbot` |
| D8 | 回归测试 | grokbot 路径没有回归，WB 路径连续 10 轮稳定 |

这个阶段不做的：固件改动、把生产环境的默认大脑切到 WB、硬件入驻材料。

## 7. 开工前要确认

- 是否已经有能换到 token 的开放平台应用。
- MVP 是否接受先轮询、后做 ACP 流式（推荐接受）。

## 参考

- https://open.workbuddy.cn/
- https://cloud.tencent.com/product/workbuddy
- https://www.workbuddy.ai/docs/workbuddy/From-Beginner-to-Expert-Guide/Function-Description/MCP-Guide
- https://2aran.com/resources/workbuddy-smart-hardware-whitepaper
- https://2aran.com/articles/research/topics/workbuddy-acp-vs-mcp-hardware-bridge
- 代码：`bridge/src/agents/{types,grokbot,registry}.ts`、`bridge/src/device/hub.ts`
