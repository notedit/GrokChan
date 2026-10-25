# GrokChan

**Open-source Grok Bot + M5Stack voice companion (Stack-chan style).**  
开源：把 [Grok Bot](https://grok.com) 接到 M5Stack 桌面伙伴上 —— 麦克风进、喇叭出，中间用 Cloudflare Worker 做桥。

> Status / 状态：**scaffold（脚手架）** — 文档与目录已就位，固件与 Worker 实现陆续补齐。

## 这是什么

GrokChan 想做一个可自己编译、自己部署的「桌上小人」：

- **硬件**：M5Stack / ESP32（参考 [Stack-chan](https://github.com/stack-chan/stack-chan) 的桌面机器人形态）
- **大脑**：你自己的 Grok Bot（Webhook routine 触发）
- **桥**：Cloudflare Worker，负责会话、一次性 `reply.url`、密钥不进固件

网页聊天用的「Worker ↔ Grok Bot webhook」模式可以直接复用到设备端；本仓库把那套思路产品化成开源项目，而不是绑定某个闭源 SDK。

## Architecture / 架构

```text
M5Stack firmware  ←→  Bridge Worker (Cloudflare)  ←→  Grok Bot webhook routine
     mic / speaker         secrets + reply.url              generate reply
```

更细的说明见 [docs/architecture.md](docs/architecture.md)。

| 目录 | 内容 |
| --- | --- |
| [`firmware/`](firmware/) | ESP32 / M5Stack 固件占位（Arduino / PlatformIO 稍后） |
| [`bridge/`](bridge/) | Worker 桥接说明与环境变量约定（无密钥） |
| [`docs/`](docs/) | 架构与设计文档 |

## 快速了解配置（无密钥）

桥接侧典型环境变量（真实值用 `wrangler secret put`，不要提交到 git）：

- `GROK_WEBHOOK_URL` / `GROK_WEBHOOK_KEY` — Grok Bot routine 的 webhook
- `PUBLIC_ORIGIN` — 公网 HTTPS 源，用来拼 `reply.url`
- `GROK_WEBHOOK_HEADER` / `GROK_WEBHOOK_SCHEME` — 认证头写法

细节见 [bridge/README.md](bridge/README.md)。

## 当前状态

- [x] 仓库、MIT 许可、贡献指南
- [x] 架构说明与目录骨架
- [ ] Bridge Worker 可部署实现
- [ ] M5Stack 固件最小可对话版本
- [ ] TTS / 表情 / 唤醒词

## Contributing / 如何参与

欢迎提 Issue 和 PR。请先读 [CONTRIBUTING.md](CONTRIBUTING.md)。

优先需要：固件录音播放、Worker 会话桥、硬件 BOM 与组装说明。

## License

[MIT](LICENSE) © notedit
