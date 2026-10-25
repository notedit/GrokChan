# GrokChan

**开源：Grok Bot + M5Stack 桌面伙伴（Stack-chan 风格）。**

用 Cloudflare Worker 把浏览器或 ESP32 设备接到你自己的 [Grok Bot](https://grok.com)。架构上预留了更多 Agent（例如 Muse）的适配位。**Phone-use**（远程控机）已列入路线图，作为 Agent 能力推进。

> **文档默认英文。** 英文总览：[README.md](README.md)。

## 状态

- [x] 仓库、MIT、贡献指南
- [x] **Bridge Worker**（网页聊天 ↔ Grok Bot webhook，多 Agent 适配层）
- [ ] **Phone-use**（Agent 驱动的远程控机 — 云手机 MCP 和/或自有 Android）
- [ ] M5Stack 固件最小可对话
- [ ] TTS / 表情 / 唤醒词

## 架构

```text
浏览器 / M5Stack / 手机（phone-use 路径）
        ←→  bridge/（Cloudflare Worker + DO）  ←→  Agent（grokbot | muse…）
                                                      │
                                                      └── 手机工具（MCP / ADB 投屏）
                                                          → 真机或云手机
```

当前客户端：**浏览器**（聊天页），后续还有 **M5Stack** 固件。**手机**有两种角色：

1. **Phone-use（主路径）：** Agent 操控手机（点击 / 滑动 / 输入 / 截图）——不是新的 `AGENT_PROVIDER`；见 [docs/phone-use.zh-CN.md](docs/phone-use.zh-CN.md)。
2. **可选后续：** 手机作为 bridge 的**客户端**做语音/聊天（类似 M5Stack）。

说明：[docs/architecture.zh-CN.md](docs/architecture.zh-CN.md) · English：[docs/architecture.md](docs/architecture.md)

| 目录 | 内容 |
| --- | --- |
| [`bridge/`](bridge/) | 可部署 Worker、聊天页、`agents/grokbot` 与 `agents/muse` 占位 |
| [`firmware/`](firmware/) | ESP32 / M5Stack 占位 |
| [`phone-use/`](phone-use/) | Phone-use 路线图占位（指向文档；尚无自动化实现） |
| [`docs/`](docs/) | 架构 + phone-use（中英） |

## 快速开始（bridge）

```bash
cd bridge
npm install
cp .dev.vars.example .dev.vars
npm run dev
```

上线：设置 `PUBLIC_ORIGIN`，再用 `wrangler secret put` 写入 `GROK_WEBHOOK_URL`、`GROK_WEBHOOK_KEY`、`SITE_PASSCODE`。完整步骤与 **MCP 写 secret 被打成占位符** 的注意点见 [bridge/README.md](bridge/README.md)。

发给 Grok Bot routine 的事件 schema 仍为 `grokbot-web.inbound.v1`，与现有网页桥兼容。

## 参与贡献

见 [CONTRIBUTING.md](CONTRIBUTING.md)。不要把密钥提交进 git。

## License

[MIT](LICENSE) © notedit
