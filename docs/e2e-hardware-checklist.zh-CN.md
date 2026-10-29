# GrokChan 真机端到端测试 Checklist（M5Stack CoreS3 StackChan）

> 适用版本：本仓库 `main`（含流式语音链路、设备鉴权、四状态界面）。协议 `mediasession-rpc/1`。
> 用法：从上到下做，做完一项把 `[ ]` 改成 `[x]`；每项都有「操作 → 期望 → 失败时看什么」。
> 本文只用仓库里真实存在的命令和配置名；凡写着「待实机确认」的，就是代码里也没验证过的地方，**以你看到的为准并记录下来**。
> 相关文档：[`firmware/README.md`](../firmware/README.md)、[`bridge/README.md`](../bridge/README.md)、[`audio-sdk-plan.zh-CN.md`](audio-sdk-plan.zh-CN.md)（§11 语音）、[`mcp-plan.zh-CN.md`](mcp-plan.zh-CN.md)。

**建议顺序**：先把「语音关」的一切测通（§0–§3.8，含舵机/音频播放），再进入「语音开」（§2.4 之后的 §3.9 起）。第一次上电舵机时**手放在头旁边**，随时准备按触摸屏急停或拔电。

---

## 0. 准备

### 0.1 硬件与线缆
- [ ] M5Stack CoreS3 + StackChan 舵机底座（pan/tilt 两个舵机、12 灯环、电池）已组装，**舵机在安装时头部能自由转动，没有被线缆/外壳卡住**
- [ ] 一根能传数据的 USB-C 线（不是只充电线）
- [ ] 电池已充到 > 50%（低于 10% 且未充电时固件会拒绝运动命令 `-32002`）
- [ ] 桌面空旷，头部转动范围内没有障碍物；设备放在稳固平面上
- [ ] 测试环境：一个相对安静的房间（VAD 调参要用）；另备一个手机热点，用于「换网络/断网」测试

### 0.2 网络
- [ ] Wi‑Fi 是 **2.4 GHz**（CoreS3 不支持 5 GHz），SSID/密码已知
- [ ] 该 Wi‑Fi 能访问 `*.workers.dev`（TLS 443，WebSocket）和 ElevenLabs（`api.elevenlabs.io`，由 Worker 访问，不由设备访问）。（固件 #16「workers.dev 在你网络下是否可达」待实机确认）
- [ ] 电脑与设备同网或随意（已部署的 workers.dev 不要求同网）

### 0.3 账号与密钥
- [ ] Cloudflare 账号（能 `wrangler login`）
- [ ] 一个 Grok Bot **webhook 类型 routine**（bridge 靠它把设备说的话交给 Grok Bot 并取回复），已拿到 webhook URL 和 sender key，routine 逻辑：读 `message`/`history` → 生成回复 → `POST {"text":"…"}` 到 `reply.url`（见 `bridge/README.md`「Grok Bot routine tips」）
- [ ] ElevenLabs 账号 + **新生成**的 API key（**不要用聊天里粘贴过的那个，见 §6**）
- [ ] 准备好一个站点口令 `SITE_PASSCODE`（`openssl rand -base64 18` 生成），一个 MCP 密钥 `MCP_API_KEY`（`openssl rand -hex 32`；与口令、webhook key **不要共用**）

### 0.4 工具
- [ ] Node **≥ 22**：`node -v`（wrangler 4 不支持 Node 20）
- [ ] 在 `bridge/` 里 `npm install`，`npx wrangler --version`（package.json 锁定 4.152.0）
- [ ] PlatformIO：`pip install platformio`，`pio --version`
- [ ] `curl`、`jq`（本文 curl 示例用 jq 美化，没有 jq 去掉 `| jq` 即可）
- [ ] 串口监视器：`pio device monitor -b 115200`（本文所有「串口日志」都指它；每行前缀是开机毫秒数 `[12345] …`，**可用来算时间差**）
- [ ] 一个能看秒表的东西（手机），延迟表（§3.14）里的一些项要手动计时
- [ ] 开着第二个终端跑 `npx wrangler tail`（bridge 日志，见 §1.5）

> **失败排查**：`pio` 找不到设备 → 换数据线/换口；CoreS3 需要进下载模式时：长按侧面复位键约 3 s 直到绿灯闪烁，再烧录（来源：`firmware/README.md`）。

---

## 先用 Web 虚拟设备预演

> （可选，省掉反复烧录）详见 [`webdevice.zh-CN.md`](webdevice.zh-CN.md)。浏览器里的虚拟设备跑的是**同一份固件核心**（wasm）+ 同一份屏幕光栅化，对**同一个 bridge** 说 `mediasession-rpc/1`，默认用独立的 `device_id = stackchan-web`（不会挤掉真机 `stackchan-01`）。
> 建议顺序：先在这里把「可预演」项目全部测通（改 bridge 后也先在这里回归），再进入 §1 起的真机流程；真机只需要重点测右边「不能预演」的项目。
> 启动：本地 `bridge/` 里 `npx wrangler dev`（`.dev.vars` 开 `STACKCHAN_ENABLED`、`SIM_UI_ENABLED`、`ASR_PROVIDER=mock`、`TTS_PROVIDER=mock`），登录 `http://127.0.0.1:8787/` 后打开 `/sim/` → 签发 token → 上电。线上 `/sim` 默认关闭，见 webdevice 文档 §2.3。

- [ ] 预演 P.1：能打开 `/sim/`，「上电」后徽标变 `ready`，`mcp list_devices` 里 `stackchan-web` `online: true`（对应 §3.1.1 的 bridge 侧）
- [ ] 预演 P.2：错 token（页面里「错 token 重连」）→ close **4003**（对应 §3.1.2；浏览器能看到真实关闭码，比固件的固定 1006 更直观）；改回正确 token 后恢复（§3.1.4）
- [ ] 预演 P.3：断线/黑洞/丢包故障注入 → 退避重连 → `ready`；断线期间 MCP 返回 `device_offline`，重连后不重放（§3.2.1、§3.2.3）
- [ ] 预演 P.4：回合状态与 11 个表情、字幕、`duration_ms` 回落、表情与回合叠加（§3.3.1–§3.3.5、§3.4）——**只验证逻辑与外观，帧率/配色看真机（§3.3.6）**
- [ ] 预演 P.5：MCP 11 个工具的参数校验与返回（§3.5），`move_head` 限位/超限拒绝、过热拒绝 `-32002`、`emergency_stop`（§3.6 的**逻辑部分**；舵机真实方向/限位/堵转只能真机）
- [ ] 预演 P.6：`speak` 起播/停止/`stop_audio`、下行帧解码与播放排队（§3.7 的**协议部分**；音质/音量/喇叭失真只能真机）
- [ ] 预演 P.7：完整语音回合（需 `ASR_PROVIDER=mock`，用「虚拟麦克风」说一句）：speech_start → 0x02 上行 → ASR final → webhook → reply → TTS → 播放（§3.9 的上行协议、§3.10；VAD 阈值只在真实麦克风/真机上有意义）
- [ ] 预演 P.8：播放中点「触摸/按住说话」打断，bridge 中止流（§3.11）；超长语句被截断（§3.12）；TTS 失败回落（§3.13，需要 mock 触发词）
- [ ] 预演 P.9：延迟表（§3.14）的**计时口径**能出数；注意 mock 数据不代表真机，真实数字必须真机/真 ASR/TTS 测
- [ ] 预演 P.10：低电量 5% / 过热 / 堵转故障注入后的状态与 MCP 返回（§3.16 的**逻辑部分**）

**预演无法覆盖（仍必须真机）**：I2S 麦克风/喇叭与真实回声（含 `GC_VOICE_BARGE_IN_BY_VAD` 的回声自触发）、舵机真实运动与堵转、LCD 真实帧率与配色（§3.3.6）、PSRAM/内存余量与 `FATAL: out of memory`、Wi‑Fi 2.4 GHz/RSSI/换网络、固件烧录与首次启动（§2）、稳定性长跑（§3.15）、真实 ASR 精度与首包延迟、真实 Grok Bot/ElevenLabs 的端到端延迟。

---

## 1. 部署 bridge

> 先跑一遍 `cd bridge && npm test && npm run typecheck`（Node 22）确认本机环境没问题，不过这些测的都是 mock，**不替代真机测试**。

### 1.1 首次部署，拿到 origin
```bash
cd bridge
npm install
npx wrangler login            # 或设置 CLOUDFLARE_API_TOKEN
npx wrangler deploy
# 输出里有 https://grokchan-bridge.<你的子域>.workers.dev —— 这就是 ORIGIN
```
- [ ] 记下 origin：`export ORIGIN=https://grokchan-bridge.<你的子域>.workers.dev`
- [ ] 编辑 `bridge/wrangler.toml` 的 `[vars]`：`PUBLIC_ORIGIN = "$ORIGIN"`（https，无末尾斜杠）。**PUBLIC_ORIGIN 必须是公网 https**，否则 Grok Bot 云端 routine 无法回 `reply.url`，语音回合会 `agent_timeout`

### 1.2 设置 secrets（只用 `wrangler secret put`，别写进文件）
```bash
npx wrangler secret put GROK_WEBHOOK_URL
npx wrangler secret put GROK_WEBHOOK_KEY
npx wrangler secret put SITE_PASSCODE
npx wrangler secret put MCP_API_KEY
npx wrangler secret put ELEVENLABS_API_KEY      # 测试期沿用现有 key，正式上线前再轮换，见 §6
```
- [ ] 5 个 secret 都 put 成功（`npx wrangler secret list` 能看到 5 个名字）
- [ ] 本机 shell 里导出（**不要写进脚本/仓库**；用完 `unset`）：
```bash
export SITE_PASSCODE='…'     # 上面设的同一个
export MCP_API_KEY='…'
```

### 1.3 打开 Stack-chan 与 provider（阶段 A：先不开 ASR）
在 `bridge/wrangler.toml` 的 `[vars]` 里取消注释/新增：
```toml
STACKCHAN_ENABLED = "true"
TTS_PROVIDER = "elevenlabs"      # speak 需要；mock | mock-stream | elevenlabs
# ASR_PROVIDER 先不设（= 语音上行关，session.hello 不带 voice 块）——阶段 B 再开
```
可选调参（默认值见 `bridge/README.md`）：`ELEVENLABS_VOICE_ID`、`VOLUME_CAP`（默认 70）、`PAN_MIN/PAN_MAX/TILT_MIN/TILT_MAX`（默认 -90 90 0 60）、`DEVICE_CMD_TIMEOUT_MS`（默认 3000，speak 为 5000）。
```bash
npx wrangler deploy
```
- [ ] 重新部署成功
- [ ] 健康检查：`curl -s $ORIGIN/api/health` → 期望 `{"ok":true,"configured":true}`
- [ ] 未带密钥访问 MCP 应被拒：`curl -s -o /dev/null -w "%{http_code}\n" -X POST $ORIGIN/mcp -d '{}'` → 期望 `401`
- [ ] 带密钥通：见 §1.4 + §3.5
- [ ] 打开 `$ORIGIN/`，用 `SITE_PASSCODE` 登录，在网页聊天里发一句话，**确认 Grok Bot 能回**（这一步不通，后面语音回合一定不通；401 → 重新 `wrangler secret put GROK_WEBHOOK_KEY`，见 `bridge/README.md`「Secret caveat」）

### 1.4 签发设备 token（明文只显示一次）
```bash
export DEVICE_ID=stackchan-01        # 要和固件 GC_DEVICE_ID 一致
curl -s -X POST -H "X-Passcode: $SITE_PASSCODE" "$ORIGIN/api/devices/$DEVICE_ID/token" | jq
# => { "ok": true, "device_id": "stackchan-01", "token": "<TOKEN>", "note": "…" }
```
- [ ] 把 `<TOKEN>` 马上复制到固件 `GC_DEVICE_TOKEN`（§2.1）。**不要贴到聊天/issue/截图里**
- [ ] 列出设备：`curl -s -H "X-Passcode: $SITE_PASSCODE" $ORIGIN/api/devices | jq` → 该 id 的 `has_token: true`
- [ ] 吊销（§3.1 要用）：`curl -s -X DELETE -H "X-Passcode: $SITE_PASSCODE" "$ORIGIN/api/devices/$DEVICE_ID/token"` → `{"ok":true,"revoked":true}`；吊销后要重新 POST 签发新 token 并重烧固件

> **失败排查**：`stackchan_not_configured`(503) → `STACKCHAN_ENABLED` 没设为 `"true"` 或没重新部署；401/`bad` → 口令不对（同一 IP 每分钟 10 次错误会被限速 429）。

### 1.5 看 bridge 日志
```bash
npx wrangler tail            # 另开一个终端，测试全程开着
```
- [ ] `wrangler tail` 能连上、能看到请求日志（`wrangler.toml` 已开 `[observability]`）；语音相关错误会打印 `asr error:` / `tts error:` / `deliver error:` / `tts stream error:` / `voice speak error:`（**不会打印 key 或 webhook URL**）

### 1.6 （可选，强烈建议）ElevenLabs 冒烟
```bash
cd bridge
ELEVENLABS_API_KEY='<新 key>' npm run smoke:elevenlabs:worker     # workerd 路径：验证 Worker 里的 fetch+Upgrade
```
- [ ] 输出 ok 并带首包耗时（仅输出 ok/fail 与耗时，不打印 key）。失败时看提示；Node 路径 `npm run smoke:elevenlabs` 是兜底

---

## 2. 配置并烧录固件

### 2.1 阶段 1 配置：语音关
```bash
cd firmware
cp include/gc_config.example.h include/gc_config.h     # gc_config.h 已 gitignore，不要提交
```
编辑 `include/gc_config.h`：

| 宏 | 填什么 |
|---|---|
| `GC_WIFI_SSID` / `GC_WIFI_PASS` | 2.4 GHz Wi‑Fi |
| `GC_SERVER_HOST` | `grokchan-bridge.<你的子域>.workers.dev`（不带 `https://`） |
| `GC_SERVER_PORT` / `GC_SERVER_TLS` | `443` / `1`（局域网 `wrangler dev` 才用 `8787` / `0`） |
| `GC_TLS_INSECURE` | 保持 `1`（加密但**不校验证书**，有中间人风险，M1 已知限制） |
| `GC_WS_PATH` | 保持 `"/ws/device"` |
| `GC_DEVICE_ID` | `stackchan-01`，与 §1.4 的 `$DEVICE_ID` 一致 |
| `GC_DEVICE_TOKEN` | §1.4 拿到的 `<TOKEN>` |
| `GC_VOICE_ENABLED` | **`0`**（阶段 1） |
| `GC_TOUCH_EMERGENCY_STOP` | **`1`**（阶段 1：触摸 = 急停） |
| `GC_LOG_PROTOCOL` | 调试时设 `1`（串口打印每一帧 JSON-RPC，很吵，但能对延迟）；稳定性测试时设回 `0` |

其余（舵机引脚 `GC_SERVO_*`、`GC_PY32_*`、`GC_LED_*`、`GC_VOLUME_CAP`、`GC_PAN/TILT_*`）先保持默认——它们来自官方固件源码，**未在你的机器上验证**，在 §3 里逐项验证后再改。

- [ ] 确认 `GC_DEVICE_TOKEN` 非空（空 token 会被 bridge 以 close `4003` 拒绝）
- [ ] 确认 `git status` 里**没有** `gc_config.h`（已被 .gitignore；token/WiFi 密码不入库）

### 2.2 编译与烧录
```bash
pio run -e cores3                    # 首次会下载依赖
pio run -e cores3 -t upload          # USB-C 连接 CoreS3
pio device monitor -b 115200
```
- [ ] 编译通过（编译通过不代表能在板上跑）
- [ ] 烧录通过。烧不进去 → 进下载模式（长按侧面复位约 3 s，绿灯闪烁）重试

### 2.3 首次启动检查（串口 + 屏幕）
- [ ] 屏幕依次出现「GrokChan 启动中…」→「连接 WiFi…」
- [ ] 串口出现（顺序大致如下）：
  - `GrokChan firmware 0.1.0 booting, device_id stackchan-01`
  - `PY32 expander ok`（否则 `PY32 expander NOT found (no servo power / LEDs)`）
  - `servos ok`（否则 `servos NOT answering (head commands will return device_fault)`）
  - `wifi connected, ip …`
  - `session ready <session_id>`（hello 完成）
- [ ] 如果出现 `PY32 expander NOT found` / `servos NOT answering`：**先停**，查 `firmware/README.md` 待实机确认 #1/#8（引脚/供电/`M5.In_I2C`），本轮跳过 §3.6 舵机，其余照测
- [ ] 如果出现 `no PSRAM ring, using internal RAM`：记录下来（环形缓冲退化为 48 KB，播放更易 underrun）
- [ ] 如果出现 `FATAL: out of memory…` / 屏幕「内存不足」：记录，停

### 2.4 阶段 2：开语音（§3.1–§3.8 全部通过后再做）
**bridge 侧**（`wrangler.toml` `[vars]` 加）：
```toml
ASR_PROVIDER = "elevenlabs"
```
然后 `npx wrangler deploy`。
**固件侧**（`gc_config.h`）：
```c
#define GC_VOICE_ENABLED 1
#define GC_TOUCH_EMERGENCY_STOP 0   // 触摸改为「按住说话」PTT（按下开始、松开结束，可打断播放）；急停改用 MCP emergency_stop
#define GC_VOICE_VAD 1              // 1 = 能量 VAD 自动起说；0 = 只用触摸 PTT（调试时可先设 0）
#define GC_VOICE_BARGE_IN_BY_VAD 0  // 保持 0！见 §4
#define GC_MIC_GAIN 16              // 待实机确认，§3.9 调
#define GC_VOICE_MIN_RMS 500        // 待实机确认，§3.9 调
```
重新 `pio run -e cores3 -t upload`。
- [ ] 重新部署 + 重新烧录完成
- [ ] 串口 `session ready` 之后，`get_device_status`（§3.5）的 result 在语音启用时带 `turn: {state, turn_id, gen}`
- [ ] 串口**没有**出现 `mic buffers: out of memory, voice disabled`
- [ ] 注意：`GC_TOUCH_EMERGENCY_STOP 0` 时触摸**不再**急停（只有 PTT）。此阶段的安全手段是 MCP `emergency_stop` / 直接拔电 / 手扶住头

---

## 3. 分阶段测试

> 记法：**操作 → 期望 → 失败时看什么**。MCP 调用先设置一个辅助函数（§3.5 也会用到）：

```bash
# ORIGIN / MCP_API_KEY 已 export。用法: mcp <tool> '<arguments JSON>'
mcp() { curl -s -X POST "$ORIGIN/mcp" \
  -H "Authorization: Bearer $MCP_API_KEY" -H "Content-Type: application/json" \
  -d "{\"jsonrpc\":\"2.0\",\"id\":1,\"method\":\"tools/call\",\"params\":{\"name\":\"$1\",\"arguments\":${2:-{\}}}}" \
  | jq '.result.structuredContent // .'; }
```
返回都是 `{ok, device_id, status, result, latency_ms}` 或 `{ok:false, error:{code,message}}`（`latency_ms` 是 bridge 看到的命令往返，延迟表可用）。

### 3.1 连接与鉴权
| # | 操作 | 期望 | 失败看什么 |
|---|---|---|---|
| [ ] 3.1.1 | 设备重启，看串口 | `wifi connected` → `session ready <id>`；`curl -s -H "X-Passcode: $SITE_PASSCODE" $ORIGIN/api/devices \| jq` 里该设备 `fw_version` `hw`(`m5stack-cores3`) `caps` 有值；`mcp list_devices` 显示 `online: true` | 卡在 `wifi retry` → SSID/密码/2.4 GHz；有 wifi 无 `session ready` → 看下面 3.1.2、`wrangler tail` |
| [ ] 3.1.2 | **错误 token**：把 `GC_DEVICE_TOKEN` 改成随便一串（或置空）重烧，或先用 §1.4 的 DELETE 吊销再让设备重连 | 串口 `socket closed, code 1006`（固件上报的关闭码固定 1006，库不给真实码，见 firmware/README「行为约定」）；bridge 侧以 **WebSocket close 4003** 拒绝（`wrangler tail` 里应能看到该请求，具体日志格式待实机确认）；设备**一直处于重连退避**，屏幕保持 idle；`list_devices` 里该设备 `online:false` | 如果居然连上了 → 鉴权失效，**立刻停止测试并回传日志**。测完把正确 token 写回（必要时重新签发） |
| [ ] 3.1.3 | **错误 MCP key**：`curl -s -o /dev/null -w "%{http_code}\n" -X POST $ORIGIN/mcp -H "Authorization: Bearer wrong" -d '{}'` | `401`；连续错 10 次/分钟后 `429`（IP 限速） | 返回 200 → 鉴权失效，回传 |
| [ ] 3.1.4 | 正确 token 重烧后再连 | 恢复 `session ready` | 仍 4003 → 重新 POST 签发、确认粘贴无空格/换行 |
| [ ] 3.1.5 | 把 `GC_DEVICE_ID` 与签发 id 不一致（可选） | 被拒（4003） | — |

### 3.2 重连
| # | 操作 | 期望 | 失败看什么 |
|---|---|---|---|
| [ ] 3.2.1 | 关路由器 Wi‑Fi 30 s 再开（或手机热点开关） | 串口 `wifi lost` → 退避重连（1 s…30 s 指数退避+抖动）→ `wifi connected` → `session ready`；MCP 期间 `device_offline`（带 `retry_after_ms`），恢复后可用 | 不再重连 → 看 `wifi retry`；注意 `WebSocketsClient::loop()` 在 TCP 连接阶段会阻塞约 5 s，期间舵机/画面短暂停顿属已知 |
| [ ] 3.2.2 | 重新 `npx wrangler deploy`（等同 bridge 重启/DO 重置） | 设备自动重连并 hello；旧回合被清空 | 反复断开 → `wrangler tail` |
| [ ] 3.2.3 | 断线期间发 `move_head`，再恢复网络 | 断线时返回 `device_offline`；**重连后不会重放**这条运动 | 恢复后头突然转动 → 记录为 bug |
| [ ] 3.2.4 | 同一设备 id 再开第二个连接（可选：再烧一台或用 mock） | 旧连接被 close **4000**（replaced） | — |

### 3.3 屏幕：四个回合状态
> 阶段 1 没有语音时，idle 与 speaking 可以直接测（speak 期间显示 speaking）；listening/thinking 需阶段 2。预览参考图：`firmware/docs/images/`。

| # | 操作 | 期望 | 失败看什么 |
|---|---|---|---|
| [ ] 3.3.1 idle | 静置观察 20 s | 奶白色 blob 缓慢呼吸（约 4 s 一周期），小眼睛，视线游移，每 3–6.5 s 眨眼 | 不动/花屏 → 看 §3.3.6 |
| [ ] 3.3.2 speaking | `mcp speak '{"text":"你好，我是 Stack-chan","wait":"done"}'` | 笑眼 + 腮红，嘴随节奏开合，两侧**绿色**音柱起伏，身体轻微弹动；播完回 idle | 有声无画面变化 → 记录 |
| [ ] 3.3.3 listening（阶段 2） | 按住触摸屏（PTT）或对着设备说话（VAD） | 眼睛睁大，**青色**同心波纹向外扩散，随音量变粗 | 见 §3.9 |
| [ ] 3.3.4 thinking（阶段 2） | 说完一句后、等 Grok Bot 回复期间 | 大小眼、视线右上、**琥珀色**圆点绕身体旋转 | — |
| [ ] 3.3.5 状态切换 | 观察四状态之间切换 | 弹簧过渡，无突跳，无整屏闪烁 | 闪烁 → 记录 |
| [ ] 3.3.6 帧率/画质（待实机确认 #18/#19/#21） | 目测 + 用手机慢动作拍 | 约 20 fps 无明显卡顿；配色在暗处不刺眼；圆环/多边形边缘无缝、毛刺 | 卡顿 → 在串口测一帧耗时，必要时调 `pf_display.h` 的 `kFrameMs`（默认 50）；配色改 `gc_face.cpp` 顶部；**把现象+照片记在 §5** |

### 3.4 屏幕：11 个表情 + 字幕
逐个发（`neutral` 表示清除叠加）：
```bash
for e in neutral happy sad angry surprised sleepy thinking confused love wink speaking; do
  echo "== $e"; mcp set_expression "{\"expression\":\"$e\",\"duration_ms\":4000}"; sleep 5
done
```
- [ ] 11 个表情都有各自外观（happy 弯眼腮红；sad 泪滴蓝调；angry 红调颤抖；surprised 大眼小圆嘴；sleepy Zzz；thinking = 思考外观；confused 问号；love 心形眼；wink 单眼眨；speaking = 说话外观）
- [ ] `duration_ms` 到时自动回到当前回合状态（不设 `duration_ms` 则保持，发 `neutral` 清除）
- [ ] `look_at`：`mcp set_expression '{"expression":"surprised","look_at":{"pan":20,"tilt":10}}'` → 表情改变同时头小角度转动（需舵机正常）
- [ ] 未知表情回落 `neutral`（通过 `fallback` 字段；MCP 层 enum 校验会先挡，此项可略）
- [ ] `show_text`：
```bash
mcp show_text '{"text":"你好，GrokChan！","duration_ms":4000}'
mcp show_text '{"text":"底部大字","position":"bottom","size":"l","duration_ms":4000}'
mcp show_text '{"text":"居中小字","position":"center","size":"s","duration_ms":4000}'
mcp show_text '{"text":"这是一段比较长的中文文本，用来检查换行、截断和字体覆盖，包含标点、数字 12345 和 English words。","duration_ms":6000}'
mcp show_text '{"clear":true}'
```
  期望：三种位置 × 三种字号都能显示；中文字形完整（efontCN，**无方块/缺字**）；字幕出现时角色自动缩小让位；到时或 `clear` 自动消失。失败：缺字/排版错 → 记录字、位置、字号（待实机确认 #13）。
- [ ] 表情与回合状态叠加：speak 期间 `set_expression love`，仍能看到绿色音柱（叠加层）

### 3.5 MCP 全部 11 个工具（含 Grok Bot 挂载方式）

**A. 先用 curl 直测（不依赖 Grok Bot）**
```bash
# 握手 + 列工具
curl -s -X POST $ORIGIN/mcp -H "Authorization: Bearer $MCP_API_KEY" -H "Content-Type: application/json" \
  -d '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-03-26","capabilities":{},"clientInfo":{"name":"curl","version":"0"}}}' | jq
curl -s -X POST $ORIGIN/mcp -H "Authorization: Bearer $MCP_API_KEY" -H "Content-Type: application/json" \
  -d '{"jsonrpc":"2.0","id":2,"method":"tools/list"}' | jq '.result.tools[].name'
```
- [ ] `tools/list` 返回恰好 11 个：`list_devices get_device_status move_head reset_pose set_expression show_text set_led speak stop_audio set_volume emergency_stop`

**B. Grok Bot 挂载 MCP（待确认）**
- 服务地址：`$ORIGIN/mcp`（Streamable HTTP，**仅 POST**、无状态、无 SSE；GET 返回 405）
- 鉴权：自定义请求头 `Authorization: Bearer <MCP_API_KEY>`
- [ ] 在 Grok Bot 里添加「自定义远程 MCP server」，填上面两项。**注意**：Grok Bot 是否支持自定义远程 MCP、支持哪种鉴权头（Bearer / OAuth），在 `docs/mcp-plan.zh-CN.md` §7 Q1 里是**未确认**项。如果它不让你填自定义 Bearer 头 → 这一项记为「受限」并在 §5 记录它的实际界面选项；替代方案是用 curl 完成本节全部测试，Grok 侧挂载延后
- [ ] 挂载成功后，对 Grok Bot 说「列出我的 Stack-chan 设备」「让它开心一下」，确认能调用工具并有物理效果

**C. 逐工具测试**
| # | 工具 / 命令 | 期望 | 失败看什么 |
|---|---|---|---|
| [ ] | `mcp list_devices` | `devices[]` 含 `stackchan-01`、`online:true`、`fw_version`、`hw`、`caps` | `device_not_found` → 设备从未成功 hello |
| [ ] | `mcp get_device_status` / `mcp get_device_status '{"fresh":true}'` | 电量 %、音量、pose(pan/tilt)、expression、playback、limits、`wifi_rssi`；`fresh:true` 向设备实时取（更慢）；语音启用时带 `turn` | 电量为空/不合理 → 待实机确认 #15（电量计精度） |
| [ ] | `mcp move_head '{"pan":10,"tilt":10,"speed":150}'` | 头小角度转动。**见 §3.6 的方向/限位验证** | `device_fault`(-32009) → 舵机不应答，查 `servo fault:` 串口日志 |
| [ ] | `mcp reset_pose` | 回 pan 0/tilt 0，同时中性表情（`reset_face` 默认 true） | — |
| [ ] | `mcp set_expression '{"expression":"happy","duration_ms":3000}'` | 见 §3.4 | — |
| [ ] | `mcp show_text '{"text":"hi"}'` | 见 §3.4 | — |
| [ ] | `mcp set_led '{"color":"#00FF00","side":"both","mode":"solid","brightness":40}'`；再试 `side` left/right、`mode` breathe/blink、`{"mode":"off"}`、`color` 用 `{"r":255,"g":0,"b":0}`、`duration_ms:3000` | 灯环按颜色/侧/模式点亮；`duration_ms` 后熄灭；**确认「left/right」是否对应实际左右半环**（待实机确认 #9，不对就改 `GC_LED_LEFT_MASK/RIGHT_MASK`）；亮度可接受、不发烫（#10） | 灯全不亮 → PY32 未就绪（§2.3） |
| [ ] | `mcp set_volume '{"volume":30}'`、`'{"volume":100}'`、`'{"mute":true}'`、`'{"mute":false}'`、`'{"volume":40,"persist":true}'` | 返回 `volume`/`muted`；超过 `VOLUME_CAP`(70) 被夹到 70 并 `clamped:true` | — |
| [ ] | `mcp speak '{"text":"测试一二三","wait":"done"}'` | 听到语音，返回 `playback`；见 §3.7 | `tts_failed` → `TTS_PROVIDER`/`ELEVENLABS_API_KEY`；`busy` → 正在语音回合或队列满 |
| [ ] | `mcp stop_audio` | 播放中调用能立刻停；返回 `stopped`/`cleared` | — |
| [ ] | `mcp emergency_stop` | 见 §3.6 | — |
| [ ] | 幂等：同一个 `request_id` 连发两次 `move_head` | 第二次 `deduplicated:true`，不重复执行（60 s 内） | — |
| [ ] | 限速：快速连发 > 20 次/秒（`DEVICE_RATE_LIMIT_PER_SEC`） | 出现 `rate_limited`（`emergency_stop` 不受限） | — |

### 3.6 舵机：方向、限位、急停
> ⚠️ **手放在头旁边。** 先小角度低速。固件 #1–#7 全部「待实机确认」。

| # | 操作 | 期望 | 失败看什么 |
|---|---|---|---|
| [ ] 3.6.1 方向 pan | `mcp move_head '{"pan":10,"speed":150}'` | 头向**机器人的右**转 10°（pan 正 = 右） | 反了 → 改 `GC_SERVO_PAN_SIGN -1` 重烧（#3） |
| [ ] 3.6.2 方向 tilt | `mcp move_head '{"tilt":10}'` | 头**抬头**（tilt 正 = 上） | 反了 → 改 `GC_SERVO_TILT_SIGN -1` |
| [ ] 3.6.3 零位 | `mcp reset_pose` | 头居中、水平。偏了 → 微调 `GC_SERVO_ZERO_PAN`(460)/`GC_SERVO_ZERO_TILT`(620) | — |
| [ ] 3.6.4 渐进幅度 | pan 20/30/45、tilt 20/30，各发一次 | 平滑到位，无抖动/啸叫/撞限位声 | 抖动 → 记录；撞限位 → 立即 `emergency_stop`，缩小 `GC_PAN/TILT_*`（#6） |
| [ ] 3.6.5 速度 | `speed` 100 / 150 / 500 / 1000 | 速度明显递增（约 `speed×0.3` °/s，#5 猜测值，**记录实际速度**） | — |
| [ ] 3.6.6 相对运动 | `mcp move_head '{"pan":10,"relative":true}'` 发 3 次 | 累计 +30° | — |
| [ ] 3.6.7 限位夹紧 | `mcp move_head '{"pan":200,"tilt":120}'` | 被夹到 pan 90 / tilt 60，返回 `clamped:true`（软限位在 bridge，设备端有第二道） | 撞限位 → 缩小限位 |
| [ ] 3.6.8 wait=done | `mcp move_head '{"pan":-30,"wait":"done"}'` | 运动结束才返回 | 超时 `timeout`(-32003) → 记录 |
| [ ] 3.6.9 打断运动 | 发一个慢速大幅 `wait:"done"` 的 move，运动中再发另一个 move | 前一条以 `busy`(-32000) 结束 | — |
| [ ] 3.6.10 **MCP 急停** | 运动中 + 播放中调用 `mcp emergency_stop` | 头**立即**停；音频停；返回 `motion_halted`/`audio_stopped`；急停后可继续发新命令（不锁存） | 不停 → **立刻拔电**并记录 |
| [ ] 3.6.11 **触摸急停**（阶段 1，`GC_TOUCH_EMERGENCY_STOP 1`） | 运动/播放中点一下触摸屏 | 头停 + 音频停 + 上报 `event.local_stop` | 误触严重 → 阶段 2 已改为 0；记录误触频率（#14） |
| [ ] 3.6.12 力矩/发热 | 持续保持姿态 5 min 后摸舵机 | 不烫手；有保持力矩。如过热 → 设 `GC_SERVO_RELEASE_TORQUE_IDLE 1`（静止约 2 s 后释放力矩）重烧再测（#7） | 过热/异味 → 立刻断电 |
| [ ] 3.6.13 堵转 | 轻轻用手挡一下头再 `move_head`（小心） | 固件**未实现堵转保护**，只有「无应答」故障（#7）。**不要硬挡**；记录现象即可 | — |
| [ ] 3.6.14 低电量保护 | （可选）电量 < 10% 且未充电时发 `move_head` | 返回 `low_battery`(-32002)，音量封顶 40 | — |

### 3.7 音频播放（阶段 1）
| # | 操作 | 期望 | 失败看什么 |
|---|---|---|---|
| [ ] 3.7.1 短句 | `mcp speak '{"text":"你好，很高兴见到你。","wait":"done"}'` | 听到清晰中文；记录 **起播延迟**（命令发出 → 出声）；返回 `playback:"done"` | 无声：先 `set_volume` 30（`mute:false`）；串口 `audio.begin` / `audio frame` 错误；`wrangler tail` 看 `tts error` |
| [ ] 3.7.2 音质/爆音 | 听起播和结尾 | 无明显爆音/咔哒声、无断续（#11） | 记录现象；断续 → #12 缓冲/WiFi 抖动，可提高 `GC_AUDIO_PREBUFFER_MS`(300) |
| [ ] 3.7.3 长句（约 200 字） | 发一段长文本 | 流畅播完，无 underrun；有 underrun 时 bridge 能收到 `playback.state`（`wrangler tail`/`GC_LOG_PROTOCOL 1` 可见） | — |
| [ ] 3.7.4 排队 | 连发 3 次 `speak`（默认 `wait:started`，`interrupt:false`） | 依次播放；超过队列上限（3）时返回 `busy` | — |
| [ ] 3.7.5 打断 | 播放中发 `speak '{"text":"我插一句","interrupt":true}'` | 前一句立刻被切断，新的接着播 | — |
| [ ] 3.7.6 `stop_audio` | 播放中 `mcp stop_audio` | 立刻静音，队列清空（默认 `clear_queue:true`） | — |
| [ ] 3.7.7 音量与上限 | `set_volume` 10/40/70/100；`speak` 带 `"volume":100` | 响度递增；100 被夹到 `VOLUME_CAP`(70)，返回 `volume_clamped_to` / `clamped:true`；响度映射 `percent×255/100`（#11 记录主观响度是否合适，**不要开到太大听坏喇叭**） | — |
| [ ] 3.7.8 静音 | `set_volume {"mute":true}` 后 `speak` | 无声但流程正常结束 | — |
| [ ] 3.7.9 `speak` + 表情 | `speak '{"text":"我很开心","expression":"happy","wait":"done"}'` | 播放期间脸部为所选表情叠加 | — |
| [ ] 3.7.10 播放中断线 | 播放中关 Wi‑Fi | 设备安全收尾（不死机、不循环噪音），重连后恢复 idle | 死机/噪音 → 记录，回传串口日志 |

### 3.8 阶段 1 收尾
- [ ] 以上 §3.1–§3.7 无阻塞项，再进入阶段 2（§2.4 重新部署 + 烧录）。有未解决的舵机/音频问题，可只测语音部分，但在 §5 注明

### 3.9 麦克风上行（阶段 2）
**I2S 麦/扬切换（`firmware/README.md`「语音上行」节的待实机确认 #18–#21，即 `pf_mic.h`；注意与「待实机确认清单」表里的角色 #18–#21 是两套编号）**：CoreS3 的麦克风与扬声器共用 I2S，M5Unified 同时只允许其一；开始录音时固件 `M5.Speaker.end()`，下次播放时再重新占用扬声器。

| # | 操作 | 期望 | 失败看什么 |
|---|---|---|---|
| [ ] 3.9.1 武装 | 启动后看 `get_device_status`；串口 | hello result 带 `voice.uplink`（`ASR_PROVIDER` 已设）；设备武装语音 | `get_device_status` 无 `turn` / 串口无 voice 迹象 → 检查 `ASR_PROVIDER` 是否部署、固件 `GC_VOICE_ENABLED` 是否 1 |
| [ ] 3.9.2 PTT 触摸 | 按住触摸屏说「你好」，松开 | 按下 → 脸变 listening（青色波纹）；松开 → 转 transcribing/thinking；`state.update.privacy.mic = true` 仅在录音期间 | 无反应 → 确认 `GC_TOUCH_EMERGENCY_STOP 0`；`mic` 启动失败（`M5.Mic.begin()` 返回 false）→ 记录 |
| [ ] 3.9.3 录音→放音切换 | PTT 说完一句，等回复播放，再说一句，反复 5 轮 | 每轮都能录、能放；切换**无明显爆音/延迟/卡死**（#18） | 第二轮起无声/无录音 → I2S 切换问题，**记录串口日志并回传** |
| [ ] 3.9.4 VAD 自动触发 | 设 `GC_VOICE_VAD 1`，在安静环境对着设备正常说话 | 约 100 ms 连续超阈即触发；300 ms 预滚保证开头不被截；停顿约 700 ms 结束；之后冷却 400 ms | 不触发 → 见 3.9.6 |
| [ ] 3.9.5 误触发 | 安静环境静置 2 min；然后放背景音乐/电视/敲桌子 | 静置无误触发；噪声下记录误触次数 | 误触多 → 提高 `GC_VOICE_MIN_RMS` |
| [ ] 3.9.6 **调参（增益/阈值）** | 逐步调整并各自重烧测试：<br>`GC_MIC_GAIN` 8 / 16 / 32；<br>`GC_VOICE_MIN_RMS` 300 / 500 / 800 / 1200 | 触发规则 = `max(GC_VOICE_MIN_RMS, 自适应底噪×3)`。目标：正常说话（约 30–50 cm）稳定触发、安静时不触发、小声说话也可触发。ASR 转录文本基本正确 | 声音太小/发闷 → 增大增益；失真/削波 → 减小；**把最终采用的两个值和环境写进 §5** |
| [ ] 3.9.7 干扰（#20） | 录音期间让表情动画/舵机运动/灯环亮 | 噪声不应严重污染转录；记录对比 | 舵机噪声大 → 记录，转录前不要同时 move_head |
| [ ] 3.9.8 并发吞吐（#21） | 一边上行一边下行（PTT 打断播放） | 无断线、无严重卡顿 | — |
| [ ] 3.9.9 `GC_VOICE_VAD 0` | 仅 PTT 模式 | 只有按住触摸才录音 | — |

### 3.10 完整语音回合
> 前提：§1.3 网页聊天已能得到 Grok Bot 回复；`PUBLIC_ORIGIN` 是公网 https。

流程：说话 → 设备上行 → ElevenLabs 流式 ASR → Grok Bot（webhook，inbound 里带 `device:{id,modality:"voice",turn_id,…}`）→ `reply.url` 回复 → ElevenLabs 流式 TTS → 设备播放。状态机：`idle → listening → transcribing → thinking → speaking → idle`。

| # | 操作 | 期望 | 失败看什么 |
|---|---|---|---|
| [ ] 3.10.1 一轮完整对话 | PTT 说「今天天气怎么样」（或任意问题） | 屏幕依次：listening → thinking → speaking → idle；听到 Grok 的语音回复；`wrangler tail` 无报错 | 卡在 transcribing → `asr error:`（key/模型/网络）；卡在 thinking → `deliver error:` / `voice: agent … delivery failed`（webhook URL/KEY）；超时 `agent_timeout`（默认 60 s）→ routine 没回 `reply.url`，检查 `PUBLIC_ORIGIN`；卡在 speaking 无声 → `tts error:` / `tts stream error:` |
| [ ] 3.10.2 转录显示 | 串口开 `GC_LOG_PROTOCOL 1` | 能看到 `asr.transcript`（partial/final）、`turn.state`、`turn.reply` | — |
| [ ] 3.10.3 多轮 | 连续 5 轮 | 每轮都成功；ChatHub 历史带上上下文（可在网页里看 `/api/history`） | — |
| [ ] 3.10.4 空/无声 | PTT 按住但不说话 | `turn.state idle`，reason 如 `no_audio`/`empty_audio`/`empty_transcript`，不触发 Grok Bot | — |
| [ ] 3.10.5 速率限制 | 1 分钟内说 > 20 次（`VOICE_TURNS_PER_MIN`）（可选） | 超出出现 `rate_limited` | — |
| [ ] 3.10.6 MCP `speak` 与语音回合互斥 | 语音回合中调 `mcp speak` | 返回 `busy`（`interrupt:true` 可打断） | — |
| [ ] 3.10.7 ASR 提交模式（决策项 5） | 说一句带停顿的话（「我想问……那个……明天几点」） | ElevenLabs 为 `commit_strategy=manual`，设备 `speech_end` 才提交；记录是否被中途截断、识别准确率 | 记录，决定是否改用其内置 VAD |
| [ ] 3.10.8 TTS 分句（决策项 5） | 让 Grok 回一段 3–4 句的长回复 | 首句尽早开始播放，句间自然；记录句间停顿是否突兀 | — |

### 3.11 打断
| # | 操作 | 期望 | 失败看什么 |
|---|---|---|---|
| [ ] 3.11.1 触摸打断 | speaking 中按住触摸（PTT，`GC_TOUCH_EMERGENCY_STOP 0`） | 本地立即停播（`playback.state interrupted`），bridge `audio.end reason=aborted`、取消 TTS；转入新一轮 listening | 没停 → 记录；迟到的 Grok 回复应被丢弃（`stale_turn`） |
| [ ] 3.11.2 thinking 中打断 | 说完后、Grok 回复前，再按 PTT 说一句新的 | 旧回合作废，新回合进行；旧回复到达时 bridge 回 `200 {"ok":true,"dropped":"stale_turn"}`，**设备不播旧回复** | 播了旧回复 → 记录（回合 gen 计数器 bug） |
| [ ] 3.11.3 `stop_audio` | speaking 中 `mcp stop_audio` | 立即静音，回合回 `idle`（reason `stop`） | — |
| [ ] 3.11.4 `emergency_stop` | speaking/listening 中 `mcp emergency_stop` | 音频停、头停、本地上行终止（`audio.end aborted`） | — |
| [ ] 3.11.5 断线 | speaking 中断开 Wi‑Fi，再恢复 | 回合清空（reason `disconnect`），重连后从 idle 开始，旧回复丢弃 | — |
| [ ] 3.11.6 **VAD 不得自动打断**（半双工） | speaking 中 **不触摸**，对着设备说话/拍手 | 保持 `GC_VOICE_BARGE_IN_BY_VAD 0`：播放期间 VAD 失聪，**不会**被打断，也**不会**被自己的声音触发 | 被自己的回声反复触发 → 确认宏为 0 并重烧；见 §4 |

### 3.12 超长语句
| # | 操作 | 期望 | 失败看什么 |
|---|---|---|---|
| [ ] 3.12.1 | PTT 按住连续说话 > 15 s（`UPLINK_MAX_MS`） | 固件在上限处**截断并正常 `audio.end`**；bridge 接受恰好上限的正常结束并继续转录/回复（只转录前 15 s）；**不会** `stream.error` | 出现 `stream.error`/`too_long`/`too_large` → 记录，说明固件与 bridge 上限不一致 |
| [ ] 3.12.2 | （可选）临时在 bridge 调小 `UPLINK_MAX_MS=5000` 重新部署，说 8 s | 5 s 处被截断，回合正常 | 测完改回 `15000` |
| [ ] 3.12.3 | 上行中途断网 | `uplink_aborted`/`timeout`/`seq_gap` 等 → 丢弃该句，回合 idle，**不拿半句转录** | 把 `turn.state` 的 reason 记下 |

### 3.13 TTS 失败
| # | 操作 | 期望 | 失败看什么 |
|---|---|---|---|
| [ ] 3.13.1 | 临时去掉 `TTS_PROVIDER`（`wrangler.toml` 注释掉后重新部署，测完恢复），然后 `mcp speak` 并做一轮语音（ASR 仍可用） | `speak` 返回 `tts_failed`；语音回合在 thinking 之后回 idle，reason `tts_unavailable`；设备不卡死 | 记录实际 reason（`tts_unavailable`/`tts_failed`） |
| [ ] 3.13.2 | 中途失败策略（决策项 6）：播放中让 TTS 断流（比如断开 bridge 到 ElevenLabs 的网络——难以人为制造，**做不到就跳过并注明**） | 定稿行为：立刻 abort：`audio.end reason=aborted` + `turn.state idle reason=tts_failed`；设备静音回 idle，不卡 speaking | 设备卡在 speaking → 记录 |

### 3.14 延迟记录表（请填空，回传）
> bridge 没有分阶段耗时的日志字段；用**串口时间戳**（行首 `[毫秒]`，开 `GC_LOG_PROTOCOL 1`）+ 手机秒表 + MCP 返回的 `latency_ms` 估算。每项取 3 次，填「均值 / 最大」。

| 阶段 | 测量方法 | 次1 | 次2 | 次3 | 备注 |
|---|---|---|---|---|---|
| MCP 控制命令往返（`move_head wait:accepted`） | 返回的 `latency_ms` | | | | |
| `speak` 起播延迟（命令 → 出声） | 秒表 / `speak wait:started` 的 `latency_ms` | | | | |
| 说完 → 出现 `asr.transcript final` | 串口时间戳（`audio.end` 上行 → final） | | | | 参考冒烟：ASR 首个 partial ≈ 0.3–0.5 s |
| ASR final → Grok 回复文本到达（`turn.reply`） | 串口时间戳 | | | | 取决于 Grok Bot，通常最大头 |
| `turn.reply` → 第一个下行音频帧/出声 | 串口时间戳 + 听 | | | | 参考冒烟：TTS 首包 ≈ 0.27–0.29 s |
| **说完到出声的总耗时** | 秒表 | | | | 目标值：自己定，记录体感 |
| 触摸 PTT 打断 → 停声 | 秒表 | | | | |
| `stop_audio` → 停声 | 秒表 | | | | |
| Wi‑Fi 断开 → 重新 `session ready` | 串口时间戳 | | | | 退避 1 s…30 s |
| RSSI（`get_device_status.wifi_rssi`） | | | | | |

### 3.15 稳定性
| # | 操作 | 期望 | 失败看什么 |
|---|---|---|---|
| [ ] 3.15.1 长时间挂机 | `GC_LOG_PROTOCOL 0`，挂机 ≥ 30 min（理想 2 h），每 10 min 发一次 `get_device_status` | 持续在线，无重启（串口无 reboot/panic 日志）；`state.update` 30 s 周期上报；断线次数记录 | 重启/panic → 保存完整串口日志（含回溯） |
| [ ] 3.15.2 内存泄露迹象 | 挂机中循环 50 次 `speak` + 50 次表情 | 无变慢、无 OOM | — |
| [ ] 3.15.3 断网重连×N | 反复开关 Wi‑Fi 5 次 | 每次都能重连 hello；无句柄泄露 | — |
| [ ] 3.15.4 DO 重启（待决策：DO 驱逐会丢进行中回合） | 语音回合进行中 `npx wrangler deploy`（或等待闲置后再发） | 设备重连；回合清空；不卡 speaking | 卡死 → 记录 |
| [ ] 3.15.5 ChatHub 孤儿历史 | thinking 中被打断后查网页 `/api/history` | 被打断那句用户话可能仍在历史里**无回复**（已知） | 仅记录 |
| [ ] 3.15.6 token 吊销 | 运行中 DELETE token | 已建立连接是否立刻断：记录；重连时 4003 | — |

### 3.16 电量 / 温度 / 舵机过热
| # | 操作 | 期望 | 失败看什么 |
|---|---|---|---|
| [ ] 3.16.1 电量读数 | 满电/半电/低电各读一次 `get_device_status`，对照设备显示或充电状态 | 读数合理（#15）；充电状态正确 | 偏差大 → 记录读数 vs 实际 |
| [ ] 3.16.2 低电量事件 | 电量 < 10%（`GC_LOW_BATTERY_PCT`）时 | 上报 `event.battery_low`；运动被拒 `-32002`；音量封顶 40（`GC_LOW_BATTERY_VOLUME_CAP`） | — |
| [ ] 3.16.3 温度 | 持续运行（说话+灯环+舵机）30 min 后，用手背摸机身、CoreS3 背面、舵机、灯环附近 | 温热可接受；**固件不上报温度**，只能手感。烫手 → 断电，降低 `GC_LED_MAX_CHANNEL`(168)/`GC_LED_BRIGHTNESS_DEFAULT`(40)，设 `GC_SERVO_RELEASE_TORQUE_IDLE 1` | 记录：哪个部位、多少分钟后、主观温度 |
| [ ] 3.16.4 舵机故障 | 观察 `servo fault:` 串口日志 / `event.servo_fault` | 正常无故障 | 频繁出现 → 供电/接线 |
| [ ] 3.16.5 灯环电流 | `set_led` 白色 `#FFFFFF` 满亮度 `brightness:100` 持续 1 min | 不重启、不掉电压 | 掉电/重启 → 降低 `GC_LED_MAX_CHANNEL`（#10） |

---

## 4. 已知限制与「不要做」的事

**已知限制（别当 bug 报，但请记录实际表现）**
- 无回声消除（AEC）。回声策略已定稿为 **半双工 + 触摸/PTT 打断**：播放期间 VAD 失聪，只有触摸 PTT、`stop_audio`、`emergency_stop` 能打断。
- 固件**从未在真机运行过**；SCS 舵机协议是按官方源码自写的精简实现，未对拍真机；所有标「待实机确认」的项（舵机引脚/ID/零位/方向/速度换算/限位、PY32 I2C、灯环左右划分、扬声器音质、麦/扬共用 I2S、屏幕帧率/配色、电量计精度、TLS 可达性）都是默认值/猜测。
- TLS 不校验证书（`GC_TLS_INSECURE 1`），有中间人风险。
- 触摸急停可能误触；阶段 2 为了 PTT 已设为 0。
- Workers AI ASR 适配器未实测；无 HTTP `/stream` TTS 兜底。
- 进行中的回合在 DO 被驱逐时丢失；thinking 被打断时那句用户话会留在 ChatHub 历史里无回复。
- 仅支持 PCM s16le 16 kHz 单声道；Opus、`stream.open`/`stream.stop`（S2）未实现；免打扰时段未实现；`ttl_ms` 仅 ≤0 判过期。
- 固件不发 `audio.credit`，下行靠 bridge 的 1.2× 节流。
- 传输层关闭码固定上报 1006；`WebSocketsClient::loop()` 在 TCP 连接阶段可能阻塞约 5 s。
- 断线后，MCP 命令不会排队重放。

**不要做**
- ❌ **不要开启 `GC_VOICE_BARGE_IN_BY_VAD 1`**（无 AEC，设备会被自己的声音反复打断）。
- ❌ 不要把音量开到很大测试；不要超过 `VOLUME_CAP`。
- ❌ 不要在舵机运动时用手硬挡/掰头；不要在没有手扶的情况下首次测试大角度。
- ❌ 不要把 `gc_config.h`、`.dev.vars`、token、MCP key、passcode、ElevenLabs key、webhook URL 提交 git / 贴进聊天 / 贴进截图。
- ❌ 不要在阶段 1 就开 `GC_VOICE_ENABLED`（先把舵机/音频基本盘测稳）。
- ❌ 不要关掉鉴权（`MCP_API_KEY` 为空时 `/mcp` 一律 401，这是 fail-closed 设计，别绕过）。
- ❌ 不要同时在两台设备上用同一个 `GC_DEVICE_ID`（后连的会顶掉前者，close 4000）。
- ❌ 不要在公共场所/他人在旁时开录音测试；录音时 `privacy.mic = true`。

---

## 5. 问题记录模板与回传清单

### 5.1 问题记录模板（每个问题复制一份）
```markdown
### 问题 #N：<一句话标题>
- 对应 checklist 项：§3.x.x
- 固件配置：GC_VOICE_ENABLED=_ GC_VOICE_VAD=_ GC_TOUCH_EMERGENCY_STOP=_ GC_MIC_GAIN=_ GC_VOICE_MIN_RMS=_ GC_LOG_PROTOCOL=_
- bridge 配置：ASR_PROVIDER=_ TTS_PROVIDER=_ STACKCHAN_ENABLED=_（不含任何密钥）
- 现象：<看到/听到了什么；与「期望」的差别>
- 发生时间（Asia/Shanghai）：
- 复现步骤：
  1.
  2.
- 复现概率：每次 / 偶发（x/10）
- 串口日志：<粘贴相关前后 30 行，已去除 token/WiFi 密码>
- bridge 日志：<`wrangler tail` 对应时段，已去除密钥>
- 已尝试：<调过哪些宏/配置，结果>
- 照片/视频：<有则附>
```

### 5.2 需要回传给我的日志清单
- [ ] 本文件（填好勾选、延迟表、调参最终值）
- [ ] 首次启动完整串口日志（§2.3，从开机到 `session ready`）
- [ ] 每个失败项的「问题记录」
- [ ] 语音回合：成功一轮 + 失败一轮的串口日志（`GC_LOG_PROTOCOL 1`）和同时段 `wrangler tail`
- [ ] I2S 麦/扬切换：5 轮连续录放的串口日志（§3.9.3）
- [ ] 舵机：方向是否反、最终有效的 `GC_SERVO_*` 值、是否撞限位、速度实测
- [ ] 灯环：左右半环实际对应、舵机/灯环温度手感
- [ ] 屏幕：4 状态 + 若干表情的照片/短视频，帧率体感，缺字情况
- [ ] 稳定性：挂机时长、断线次数、有无重启/panic（完整回溯）
- [ ] 决策项反馈：ASR 提交模式（manual vs 内置 VAD）、TTS 分句体验、是否需要 AEC、是否要开 `GC_VOICE_BARGE_IN_BY_VAD`
- [ ] **回传前去掉**：`GC_DEVICE_TOKEN`、`MCP_API_KEY`、`SITE_PASSCODE`、`ELEVENLABS_API_KEY`、webhook URL/KEY、WiFi 密码

---

## 6. 密钥安全提醒

- [ ] **（上线前再做，测试期可跳过）轮换 ElevenLabs API key**：之前那个 key 曾被贴到聊天里，视为已泄露。正式上线前去 ElevenLabs 后台撤销旧 key → 新建 → `npx wrangler secret put ELEVENLABS_API_KEY`（§1.2）。本地冒烟用 `ELEVENLABS_API_KEY='…' npm run …`（只放环境变量，别写文件）
- [ ] 同样建议：`SITE_PASSCODE`、`MCP_API_KEY` 用全新随机值；设备 token 泄露后用 §1.4 的 DELETE 吊销再重发
- [ ] 测试结束后：`unset SITE_PASSCODE MCP_API_KEY`；`git status` 确认没有 `gc_config.h` / `.dev.vars`；不想继续暴露时把 `wrangler.toml` 的 `STACKCHAN_ENABLED` 设回 `"false"`（或删掉）后重新部署——`/mcp` 和 `/ws/device` 都会变回 404
- [ ] 测试结束后（如果只是临时测试）：吊销设备 token（`DELETE /api/devices/<id>/token`），并在 ElevenLabs 后台检查该 key 的用量是否符合预期
