# Phone-use（远程控机）

由 Agent **远程操控手机** —— 点击、滑动、输入、截图 —— 思路类似 Grok Bot 的 **Phone Use**、Mobilerun 类云手机，或 Android 无线调试 + 投屏。

默认英文：[phone-use.md](phone-use.md)。本文是中文版。

> **不是** Grok Bot 的手机聊天 App。Phone-use 指 Agent **驱动**设备界面。

## 目标

让 **GrokChan**（经 **Grok Bot** 作为 Agent）驱动真机或云端的 **Android / iOS**，使聊天客户端（浏览器，以及后续 M5Stack）可以让 Bot 在手机上操作 App。

本仓库状态：**仅路线图 / 脚手架**。此处尚未附带可运行的自动化。见 [`phone-use/`](../phone-use/)。

## 与 `bridge/` 的关系

| 层级 | 作用 |
| --- | --- |
| `bridge/` | 只管 **聊天 ↔ Agent**（浏览器 / M5Stack / 可选「手机当客户端」） |
| Phone-use | **Agent 能力** —— Grok Bot 上的工具（MCP、设备会话），**不是**新的 `AGENT_PROVIDER` |

不要为远程控机在 `grokbot` / `muse` 旁边再加一个 `phone` provider。那些适配器选择的是「聊天交给哪颗上游大脑」；phone-use 是这颗大脑用设备工具**去做什么**。

**可选后续：** 把手机当作 bridge 的**客户端**做语音/聊天（与 M5Stack 固件同一条路）——与「操控手机 UI」正交。

```text
浏览器 / M5Stack  ←→  bridge/  ←→  Agent（grokbot）
                                      │
                                      ├── 聊天 reply.url（已有）
                                      └── 手机工具（路线图）
                                            ├── 方案 A：云手机 MCP
                                            └── 方案 B：自有 Android（ADB / 投屏）
```

## 方案 A — 托管云手机（MCP）

使用托管的 Android/iOS 环境，对外提供 **MCP**（或同类工具 API），供 Agent 连接。

形态示例（具体厂商名会变，请自行核实现状）：

- **Mobilerun**（或类似）云手机 + MCP 连接器
- Agent 会话挂上 MCP → 点击 / 滑动 / 输入 / 截图 / 启应用等工具

**优点：** 无需本机 ADB，适合 Agent 云端上下文，多用户友好。  
**缺点：** 厂商锁定、费用、云设备上的隐私。

贡献者草图：

1. 文档化所选 MCP 的工具名与鉴权方式（环境变量 / vault —— 绝不进 git）。
2. 把连接器接到已经驱动 bridge routine 的那只 Grok Bot。
3. 在 routine 里加一句「已启用 phone-use」说明，方便网页 / M5Stack 用户知道 Bot 能接控机任务。

## 方案 B — 自有 Android（无线调试 + 投屏）

操控你自己的真机，类似 Phone Use Bot：

- 打开 **无线调试**（Android）
- Agent / 宿主机不在同一局域网时，用私有网络（**Tailscale** 等）到达设备
- 投屏 / 无障碍 / ADB 输入：点击、滑动、输入、截图

**优点：** 自己的硬件、可控、无按分钟计的云手机费用。  
**缺点：** 组网成本、设备需在线；没有厂商 API 时 iOS 难很多。

贡献者草图：

1. 文档化最小「Agent 宿主机 ↔ 手机」通路（Tailscale 上的 ADB 是常见做法）。
2. ADB 密钥与 Tailscale 凭证**留在仓库外**；用本地 secret / vault。
3. 以后可在 `phone-use/` 下放薄封装脚本 —— 仍然不要把凭证写进 git。

## 本脚手架明确不做

- 把 ADB 私钥、无线调试配对码、云 API key 提交进 git
- 在文档、Issue 或已提交的示例 `.env` 里粘贴真实密钥
- 逆向闭源 SDK 或专有 Phone Use 二进制
- 宣称本仓库今天已有可用的生产级 phone-use 实现

## 给贡献者的下一步

1. 为自己的部署选定 **方案 A**、**方案 B** 或两者都做；开 Issue 说明选择。
2. 方案 A：先把一只云手机 MCP 接到与 `bridge/` 相同的 Grok Bot；列出工具名和「打开设置并截图」示例提示词。
3. 方案 B：写一份上手清单（无线调试、Tailscale、adb devices、一次点击测试），PR 进 `phone-use/` —— 仍无密钥。
4. 保持 `bridge/` 聊天路由与 `agents/grokbot` / `agents/muse` 不变，除非加一句注释澄清「聊天 vs 控机」。
5. 端到端跑通后，勾上根 README 状态项，并补一段简短演示说明（欢迎 GIF/链接；不要密钥）。

## 另见

- [architecture.zh-CN.md](architecture.zh-CN.md) — 客户端与 Agent 适配层
- [`bridge/`](../bridge/) — 聊天 Worker（本脚手架不改动）
- [`phone-use/README.md`](../phone-use/README.md) — 目录占位
