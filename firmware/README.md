# GrokChan 固件（M5Stack StackChan / CoreS3）

M5Stack StackChan（CoreS3 + 舵机底座）上的 **JSON-RPC 2.0 WebSocket 客户端**。固件连接 `bridge/` Worker 的 `/ws/device`，按 `mediasession-rpc/1` 协议（见 `bridge/src/device/protocol.ts`、`docs/audio-sdk-plan.zh-CN.md`、`docs/mcp-plan.zh-CN.md`）：

- 连接后发送 `session.hello` 请求，收到 `session_id / heartbeat_s / audio` 后进入 Ready；
- 响应 bridge→设备的命令：`device.move_head`、`device.reset_pose`、`device.set_expression`、`device.show_text`、`device.set_led`、`device.speak`、`device.stop_audio`、`device.set_volume`、`device.emergency_stop`、`device.get_status`，返回 result 或带 bridge 错误码的 error（含 `_meta.deduplicated` 重放去重：最近 32 个 id/key，60 s）；
- 主动上报 `state.update`（变化触发 + 30 s 周期）和 `event.<name>` 通知、`playback.state`；
- `audio.begin` → 二进制帧（PCM s16le 16 kHz 单声道）→ `audio.end`，经 PSRAM 环形缓冲播放；
- **语音上行（可选，`GC_VOICE_ENABLED`，默认关）**：本地 VAD / 触摸 PTT → `event.speech_start` → `audio.begin{direction:uplink}` → 0x02 帧 → `audio.end` → `event.speech_end`；处理 bridge 的 `turn.state` / `stream.error`，打断时 `audio.end reason=aborted`；
- `ping`/`pong` 保活 + 指数退避 + 抖动重连（1 s … 30 s）；
- 暂无认证（`-32004 unauthorized` 仅在 bridge 侧保留）。

> **状态：已在主机上测试、已用 PlatformIO 编译通过，尚未在真机上运行。** 所有硬件相关参数都放在 `include/gc_config.example.h`，凡带「设备鉴权 / Auth

固件握手携带 `Authorization: Bearer <GC_DEVICE_TOKEN>` 与 `Device-Id: <GC_DEVICE_ID>`。在 bridge 上用站点口令签发（只显示一次）：

```bash
curl -s -X POST -H "X-Passcode: $SITE_PASSCODE" \
  "$ORIGIN/api/devices/$GC_DEVICE_ID/token"
# 把返回的 token 写入 include/gc_config.h 的 GC_DEVICE_TOKEN（该文件已 gitignore）
```

回声策略定稿为**半双工**：`GC_VOICE_BARGE_IN_BY_VAD` 默认 0，播放期间能量 VAD 不自动 barge-in，仅触摸/PTT 或 MCP `stop_audio` / `emergency_stop` 可打断。

待实机确认」的都只来自官方 StackChan 固件源码（MIT）或保守猜测，不是在你的机器上验证过的事实。

> 真机端到端测试请按 [`docs/e2e-hardware-checklist.zh-CN.md`](../docs/e2e-hardware-checklist.zh-CN.md)（可勾选 checklist：部署、烧录、分阶段测试、延迟表、问题模板）。
> 不想反复烧录？先用浏览器里的 Web 虚拟设备（同一份固件核心编译成 wasm）预演：[`docs/webdevice.zh-CN.md`](../docs/webdevice.zh-CN.md)

## 目录结构

```text
firmware/
  platformio.ini                 # env:cores3（真机）  env:native（主机单测）
  include/gc_config.example.h    # 配置模板（WiFi/服务器/设备ID/引脚/限位）。复制为 gc_config.h，后者已 gitignore
  lib/grokchan_core/src/         # 与硬件无关的核心（主机可编译、可测试）
    gc_protocol.*                #   JSON-RPC 编解码、错误码、二进制音频帧头
    gc_device.*                  #   DeviceClient：会话状态机、方法分发、去重、限位、状态/事件上报
    gc_audio.*                   #   PcmQueue 环形缓冲 + AudioPlayer（流状态机、underrun、playback.state）
    gc_voice.*                   #   VoiceUplink：能量 VAD / PTT、预滚、上行帧、限长、打断；IMic / IVoiceLink 接口
    gc_face.*                    #   角色动画（blob + 眼睛）：回合状态 + 表情叠加 + 弹簧动画 → 绘制图元（FaceFrame）
    gc_dedup.* gc_backoff.h gc_util.*
    gc_hal.h                     #   HAL 接口：IHead/IDisplay/ILed/IPcmSink/ISystem/ITransport
  src/main.cpp                   # 装配：WiFi、PSRAM 环形缓冲、DeviceClient、触摸急停
  src/platform/                  # ESP32 / M5Unified / Arduino 的 HAL 实现（只在真机编译）
    pf_transport.h               #   links2004/WebSockets
    pf_head.h                    #   Feetech SCS 舵机（Serial1），50 Hz 平滑插值
    pf_py32.h  pf_led.h          #   PY32 IO 扩展器（I2C 0x6F）：舵机电源 + 12 灯环
    pf_display.h                 #   把 gc_face 的图元画到 PSRAM sprite（M5GFX）+ 字幕气泡（efontCN 中文字体）
    pf_audio.h                   #   M5.Speaker.playRaw，3 个轮转缓冲
    pf_mic.h                     #   M5.Mic 采集（待实机确认：与扬声器共用 I2S，需在录/放间切换）
    pf_system.h                  #   电量/RSSI/NVS 音量/日志
  test/test_core/                # 139 个主机单测（Unity）
  tools/preview/                 # 桌面预览（无硬件）：face_dump.cpp + preview.html + run_preview.sh
  docs/images/                   # 预览截图（4 个状态、状态拼图、全部表情拼图、字幕布局、状态切换过渡）
  tools/sim/sim_stdio.cpp        # 核心的 stdio 模拟器（把核心接到真实 bridge）
  tools/e2e/                     # 13 个端到端测试：真实 bridge（wrangler dev）+ 核心模拟器
  tools/run_e2e.sh
```

## 配置

```bash
cd firmware
cp include/gc_config.example.h include/gc_config.h   # gc_config.h 已在 .gitignore，不要提交
```

编辑 `include/gc_config.h`：

| 宏 | 含义 |
|---|---|
| `GC_WIFI_SSID` / `GC_WIFI_PASS` | WiFi（仅 2.4 GHz） |
| `GC_SERVER_HOST` / `GC_SERVER_PORT` / `GC_SERVER_TLS` | bridge 地址。已部署的 workers.dev：`443` + TLS `1`；局域网 `wrangler dev`：电脑局域网 IP + `8787` + TLS `0` |
| `GC_TLS_INSECURE` | M1 的 TLS **不校验服务器证书**（库默认 `setInsecure`），有中间人风险；CA 校验后续再做 |
| `GC_DEVICE_ID` | 设备 ID，`[A-Za-z0-9_-]{1,64}`；连接 URL 为 `/ws/device?device_id=<id>`，必须与 `session.hello.device_id` 一致 |
| `GC_SERVO_*`、`GC_PY32_*`、`GC_LED_*` | 舵机/灯环参数（均「待实机确认」，见下） |
| `GC_PAN_MIN/MAX`、`GC_TILT_MIN/MAX`、`GC_VOLUME_CAP` | 固件侧限位（与 bridge 默认一致，设备侧是第二道保险） |
| `GC_TOUCH_EMERGENCY_STOP` | 触摸屏幕 = 本地急停（停舵机 + 停音频 + `event.local_stop`） |
| `GC_LOG_PROTOCOL` | 1 = 串口打印每一帧 JSON-RPC，调试用 |

没有 `gc_config.h` 时会回退到 example（能编译，但 WiFi 是占位符，连不上，编译时有 `#warning`）。

## 编译 / 烧录（真机）

需要 [PlatformIO](https://platformio.org/)（`pip install platformio`）。

```bash
cd firmware
pio run -e cores3                    # 编译（首次会下载 espressif32@^6.9.0、M5Unified、WebSockets、ArduinoJson）
pio run -e cores3 -t upload          # 烧录（USB-C 连接 CoreS3）
pio device monitor -b 115200         # 串口日志
```

CoreS3 偶尔需要进入下载模式：长按侧面复位键约 3 s 直到绿灯闪烁，再 upload。串口为 USB CDC（`ARDUINO_USB_CDC_ON_BOOT=1`）。

编译实测（本机构建环境，2026-10-26 Asia/Shanghai）：`pio run -e cores3` 成功，固件约 2.27 MB（占 app 分区 34.6%），静态 RAM 15.6%。**这只证明能编译，不证明能在板子上正常运行。**

## 主机测试（不需要硬件）

```bash
pio test -e native                   # 139 个单测：协议、分发、错误码、去重、限位、重连、音频状态机、语音上行、角色动画
bash tools/run_e2e.sh                # 13 个端到端：真实 bridge(wrangler dev) <-> 固件核心模拟器
```

`run_e2e.sh` 需要 Node ≥ 22 和已 `npm install` 的 `../bridge`，并需先跑过一次 `pio test -e native`（拉取 ArduinoJson）。

## 语音上行（`gc_voice`，核心已测，平台层待实机确认）

- 开关：`GC_VOICE_ENABLED`（默认 0）。开启后 `main.cpp` 创建 `pf::M5Mic` + `VoiceUplink` 并 `DeviceClient::setVoice()`；仅当 bridge 的 `session.hello` result 带 `voice.uplink`（即配置了 `ASR_PROVIDER`）才武装。
- 参数（`gc_config.example.h`）：`GC_MIC_GAIN 16`、`GC_VOICE_VAD 1`、`GC_VOICE_BARGE_IN_BY_VAD 0`、`GC_VOICE_MIN_RMS 500`。内部：20 ms 分析帧，自适应噪声底，触发 = max(minRms, 底噪×3)，连续 5 帧（100 ms）触发，300 ms 预滚，700 ms 静音结束，冷却 400 ms，单句 ≤ `max_ms`（bridge 下发，默认 15 s；超限在设备端截断并正常 `audio.end`）。
- 触摸：`GC_TOUCH_EMERGENCY_STOP 0` 时触摸 = 按键说话（按下开始、松开结束，可打断播放）；为 1 时触摸仍是急停，只有 VAD 触发。
- 半双工：播放期间默认不做 VAD（无 AEC，避免扬声器声音触发自己）；`GC_VOICE_BARGE_IN_BY_VAD 1` 允许语音打断，需实机评估回声。打断时：本地 `stopAll()` + `playback.state interrupted`，bridge 随之 `audio.end aborted`。
- 隐私：录音中 `state.update.privacy.mic = true`。
- **待实机确认**：#18 CoreS3 麦克风/扬声器共用 I2S，`M5.Mic.begin()` 前需 `M5.Speaker.end()`，切换延迟与爆音；#19 `GC_MIC_GAIN` 与 `minRms` 阈值（环境噪声下的误触发/漏触发）；#20 录音期间屏幕/舵机噪声对麦克风的影响；#21 WiFi 上行 + 下行同时的吞吐。

测试：`firmware/test/test_core/t_voice.cpp`（FakeMic + FakeTransport：VAD 触发/预滚/限长/PTT/打断/断线/发送失败/协议顺序）。

## 界面状态与预览（`gc_face` + `pf_display.h`）

屏幕上是一个「奶白色圆润 blob + 深色椭圆眼睛」的角色，随**语音回合状态**变化；`device.set_expression` 的表情作为**叠加层**盖在回合状态之上。

> 风格灵感来自 [blessonism/grok-icon-study](https://github.com/blessonism/grok-icon-study)（blob 角色 + 眼睛、弹簧动画、眨眼、视线）。**所有形状都是本项目原创的程序绘制**（超椭圆 / 椭圆 / 线段 / 心形公式，自选参数与配色）；没有使用、复制或转写该项目的几何数据、SVG 路径或坐标（其素材归 xAI，仅供学习研究）。

### 四个回合状态

| 状态 | 触发 | 画面 |
|---|---|---|
| **idle** | 默认；`turn.state=idle`；断线 | 平静呼吸（约 4 s 一周期），小椭圆眼睛，视线缓慢随机游移，每 3–6.5 s 眨眼（偶尔连眨） |
| **listening** | 本地 VAD/PTT 开始说话，或 `turn.state=listening` | 眼睛睁大、身体略挺起并微微倾斜，**青色同心波纹从身体向外扩散**（有音量提示时波纹变粗） |
| **thinking** | `turn.state=transcribing / thinking` | 眼睛一大一小、一侧眼睑下压（眯眼），视线向右上，身体微歪，**琥珀色圆点绕身体旋转（拖尾）** |
| **speaking** | `turn.state=speaking`，或回合已 idle 但仍在播放回复音频 | 眼睛变成弯弯的笑眼，腮红，嘴巴随节奏开合，**身体两侧绿色音柱起伏**，身体随节奏轻微弹动 |

状态切换全部走弹簧（半隐式欧拉、子步长积分），切换瞬间有一个小的「挤压」脉冲，没有跳变。

### 表情（叠加层，名称与原 MCP `set_expression` 完全一致）

`neutral`（清除叠加）· `happy`（弯眼 + 腮红 + 微笑）· `sad`（眼睑下垂、泪滴、蓝调）· `angry`（斜眉眼 + 怒气符号 + 红调 + 轻微颤抖）· `surprised`（大眼 + 小圆嘴 + 感叹线 + 身体拉高）· `sleepy`（眼睑半闭并周期性下垂、Zzz）· `thinking`（= 思考状态外观）· `confused`（大小眼 + 问号 + 身体歪斜）· `love`（心形眼 + 飘心 + 粉色）· `wink`（单眼眨 + 微笑）· `speaking`（= 说话状态外观）。

- 回合状态是**基础**，表情是**叠加**：表情替换眼睛 / 嘴 / 身体姿态，但基础状态的效果层（听的波纹、想的圆点、说的音柱）仍然可见，所以 `listening + love` 依然看得出在听。
- 表情由核心 `DeviceClient` 按 `ttl_ms` 超时回退（`exprRevertAt_`），回到 `neutral` 即清除叠加、回到回合状态；`FaceAnimator::setExpression(name, now, ttlMs)` 自身也支持 TTL。
- 字幕出现时角色自动缩小并让位（字幕在上 → 角色在下；字幕在下 → 角色在上；居中 → 角色缩到左上角），平滑过渡，字幕区域不再被角色遮挡。

### 接线

- `IDisplay` 新增两个**可选**虚函数：`setTurnState(const std::string&)`、`setAudioLevel(float)`（默认空实现，其他显示实现不受影响）。
- `DeviceClient` 每个 tick / 每次 `turn.state` 计算当前回合（本地 VAD/PTT → `voice.turnState()`；idle 但播放器忙 → `speaking`；未 Ready → `idle`），**仅在变化时**调用 `display.setTurnState`。没有语音功能时默认为 idle，播放时为 speaking。
- `pf_display.h` 以 20 fps 上限整帧重绘到 PSRAM sprite 再一次性推屏（无整屏闪烁），多边形用三角扇填充，椭圆 / 圆环用 M5GFX 原语，屏幕宽度按 `W/320` 缩放。

### 桌面预览（不需要硬件）

```bash
tools/preview/run_preview.sh          # 编译 face_dump，生成 tools/preview/dist/preview_data.js
tools/preview/run_preview.sh --png    # 同时用无头 Chrome 渲染 docs/images/*.png（需要 Chrome/Chromium + Pillow）
# 然后用浏览器打开 tools/preview/preview.html 看实时动画（回合状态时间轴 / 表情时间轴）
```

`face_dump.cpp` 运行与固件**同一份** `gc_face.cpp`，把每帧图元导出为 JSON；`preview.html` 用 Canvas 画同样的图元。预览与真机的差别：Canvas 有抗锯齿，字幕字体是浏览器字体而不是 efontCN，颜色未经真实屏幕校准。

| 图 | 内容 |
|---|---|
| `docs/images/states-montage.png` | 四个回合状态拼图 |
| `docs/images/state-{idle,listening,thinking,speaking}.png` | 单个状态（2× 放大） |
| `docs/images/expressions-montage.png` | 全部 11 个表情拼图 + `listening+love` 叠加示例 |
| `docs/images/text-layouts.png` | 字幕在上 / 中 / 下时角色让位 |
| `docs/images/transitions.png` | 四种状态切换后 0 / 100 / 200 / 350 / 600 / 1000 ms 的过渡帧 |

测试：`test/test_core/t_face.cpp`（状态区分、收敛、眨眼节奏上下界、参数范围、NaN / 缓冲溢出、过渡不跳变、11 个表情、TTL / 清除回落、叠加共存、字幕让位、时钟回绕）+ `t_voice.cpp` 里的 `display_turn_state_*`（接线）。

## 行为约定（设备侧语义，文档里没写死的部分）

- 新的运动命令会让上一条尚未完成的 `wait=done` 运动以 `-32000 busy` 结束。
- `emergency_stop` 不去重、不锁存：执行后可继续发新命令。
- `stop_audio` 带 `stream_id` 时只停该流；否则停当前流（`clear_queue` 时清空队列）。
- LED：先按 `GC_LED_MAX_CHANNEL`(168) 封顶，再乘亮度；左右半环由 `GC_LED_LEFT_MASK/RIGHT_MASK` 决定。
- `set_expression` 的 `look_at` 以默认速度转头；未知表情回落 `neutral` 并在 result 里带 `fallback`。
- 低电量（<10% 且未充电）：拒绝运动命令（`-32002 low_battery`），音量封顶 40。
- `ttl_ms` 无法在设备端精确度量，仅 `ttl_ms <= 0` 返回 `-32008 expired`。
- 仅声明并支持 PCM s16le 16 kHz 单声道；MP3/Opus 不在 M1。免打扰时段未实现。
- 传输层关闭码固定上报 1006（WebSockets 库不给关闭码）。
- `WebSocketsClient::loop()` 在 TCP 连接阶段会阻塞最多约 5 s，期间舵机插值/画面会停顿；仅出现在断线重连时。

## 待实机确认清单

下列每一项都**未在真机验证**。「来源」说明数据出处：官方 = M5Stack 官方 StackChan 固件（ESP-IDF，MIT）源码；猜测 = 无依据，用保守默认。

| # | 项目 | 当前值 / 做法 | 来源 |
|---|---|---|---|
| 1 | 舵机串口引脚 | UART1，1 Mbps，TX=GPIO6、RX=GPIO7（`Serial1.begin(1000000, 8N1, rx=7, tx=6)`） | 官方；Arduino 下半双工/回显行为未验证 |
| 2 | 舵机 ID / 零位 | 偏航 ID1 零位 raw 460；俯仰 ID2 零位 raw 620；0.3125°/步 | 官方 |
| 3 | **转向符号** | `GC_SERVO_PAN_SIGN/TILT_SIGN = +1`：pan 正=向右、tilt 正=抬头 | 猜测——头转反了就改符号 |
| 4 | 舵机包格式 | `FF FF ID LEN INST addr … ~sum`，字为大端，`WritePos(raw, time=20ms, speed=0)` | 官方 FTServo 源码；自写实现，未对拍真机 |
| 5 | 速度换算 | 协议 speed(100–1000) × 0.3 = °/s（150 → 45°/s） | 猜测 |
| 6 | 机械限位 | 官方范围 yaw ±128°、pitch 3–87°；固件取 pan ±90 / tilt 0–60（bridge 默认），并把 raw 夹在 0..1000 | 官方范围；是否会撞限位未验证 |
| 7 | 舵机力矩/堵转 | 默认保持力矩（`GC_SERVO_RELEASE_TORQUE_IDLE=0`）；未实现堵转保护，只有"无应答"故障 | 官方会在静止时释放；我们未验证 |
| 8 | PY32 扩展器 | I2C 0x6F、内部总线（SDA=GPIO12/SCL=GPIO11，经 `M5.In_I2C`）、100 kHz；舵机电源=引脚 0；灯环=引脚 13 | 官方；`M5.In_I2C` 是否可直接访问未验证 |
| 9 | 灯环 | 12 灯，RGB565，写 0x30+2i 后刷新位；左半 0–5、右半 6–11 | 官方寄存器；**左右划分为猜测** |
| 10 | 灯亮度/电流 | 通道上限 168 | 官方工具范围；发热/供电未验证 |
| 11 | 扬声器 | `M5.Speaker.playRaw` 16 kHz 单声道（M5Unified 自动重采样），音量 `percent*255/100` | 官方是 24 kHz I2S + AW88298；本方案未验证音质/爆音/响度 |
| 12 | 音频缓冲 | 环形 256 KB（PSRAM）、预缓冲 300 ms、3×8 KB 轮转缓冲 | 猜测；WiFi 抖动下是否 underrun 未验证 |
| 13 | 屏幕 | 320×240，字幕中文用 `efontCN_12/16/24`（角色见下 #18–#21） | M5GFX 自带字体；排版/闪烁/字形覆盖未验证 |
| 14 | 触摸急停 | 任意触摸 = 本地急停 | 猜测；可能误触，不要可设 `GC_TOUCH_EMERGENCY_STOP 0` |
| 15 | 电量 | `M5.Power.getBatteryLevel()`，低电量阈值 10% | 电量计精度未验证 |
| 16 | TLS | `beginSSL` 无 CA = 不校验证书；workers.dev 在你网络下是否可达未验证 | 库行为 |
| 17 | WiFi 省电 | 关闭 WiFi 休眠以保证音频流畅 | 猜测，耗电更高 |
| 18 | **角色帧率** | 20 fps 上限整帧重绘（`kFrameMs=50`）：约 150 个三角形 + 若干椭圆 + `pushSprite`；PSRAM sprite 的填充 + SPI 推屏耗时未测，可能掉到 <20 fps，也可能可以提到 30 | 猜测；用串口测一帧耗时，必要时调 `kFrameMs` |
| 19 | **角色配色** | 背景 `#0D0F14`、身体 `#F1EFE8`、听=青、想=琥珀、说=绿；表情各有色调。RGB565 + 面板伽马下是否好看、暗处是否刺眼未验证 | 自选；在 `gc_face.cpp` 顶部改 |
| 20 | **屏幕尺寸适配** | 以虚拟 320×240 计算，渲染按 `W/320` 缩放（宽高比假定 4:3）；字幕布局的像素常量仍是 320×240 | 非 CoreS3 屏幕未验证 |
| 21 | 多边形填充 / 椭圆圆环 | 三角扇填充（假定各多边形对质心是星形）、圆环用同心 `drawEllipse` 描边；整数取整后边缘是否有缝 / 毛刺、圆环粗细观感未验证（桌面预览是抗锯齿的） | M5GFX 原语；真机肉眼确认 |

## 真机测试清单（建议顺序）

准备：bridge 已部署（或 `wrangler dev --ip 0.0.0.0`），`gc_config.h` 填好，串口监视器打开。

1. **启动**：屏幕出现「GrokChan 启动中…」→「连接 WiFi…」；串口依次出现 `PY32 expander ok`、`servos ok`、`wifi connected`。若 `PY32 NOT found` / `servos NOT answering`，先查 #1 #8（引脚/供电），其余测试跳过运动项。
2. **握手**：串口显示 hello 完成；bridge 侧 `list_devices` 能看到设备（caps head/led/display/speaker）。
3. **状态**：`get_device_status`：电量、音量、pose、wifi_rssi 合理。
4. **屏幕**：`set_expression` 逐个试 11 个表情（含 `look_at`）；`show_text` 试中文、长文本、Bubble/Center/Bottom 三种位置与三种字号；到时自动清除。
5. **灯**：`set_led` left/right/both、solid/breathe/blink；确认左右半环是否与预期一致（#9），亮度是否可接受。
6. **舵机（先小角度、手放在头旁）**：`move_head` pan=10/tilt=10 低速 → 确认**方向**（#3）；再试 ±45/30、`relative`、`wait=done`；`reset_pose`；超范围值应被夹到 `clamped:true`。观察抖动、啸叫、是否撞限位（#6）。
7. **音频**：`speak` 一句短中文（wait=done）：听音质、爆音、起播延迟；再试长句 + 连续两句排队；`set_volume` 与静音；`stop_audio` 中途停。
8. **急停**：运动/播放中调用 `emergency_stop`；再点一次触摸屏幕，确认 `local_stop` 事件和停止效果。
9. **断线恢复**：关 WiFi / 重启 bridge 或手机热点断开，设备应在退避后自动重连并重新 hello；断线期间的 `move_head` 不应在重连后重放。
10. **长时间**：挂机 30 min，观察内存/发热/断线次数；播放中途拔 WiFi 看是否安全收尾。

## 已知问题 / 风险

- 真机行为全部未验证（见上表）；SCS 舵机协议是按官方源码自写的精简实现。
- bridge 侧 `emergency_stop` 会在设备回报 `playback.state=interrupted` 前先本地 abort 音频，因此对"已开始的 `speak wait=done`"可能仍返回 ok（playback=started）。属 bridge 行为，固件按协议正确上报 `interrupted`。
- 语音上行（见上节）的麦克风平台层、VAD 阈值和 I2S 切换全部未上机；没有回声消除。
- 触摸急停、低电量、LED 封顶等安全默认值都是保守猜测。
