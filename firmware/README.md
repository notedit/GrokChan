# GrokChan 固件（M5Stack StackChan / CoreS3）

M5Stack StackChan（CoreS3 + 舵机底座）上的 **JSON-RPC 2.0 WebSocket 客户端**。固件连接 `bridge/` Worker 的 `/ws/device`，按 `mediasession-rpc/1` 协议（见 `bridge/src/device/protocol.ts`、`docs/audio-sdk-plan.zh-CN.md`、`docs/mcp-plan.zh-CN.md`）：

- 连接后发送 `session.hello` 请求，收到 `session_id / heartbeat_s / audio` 后进入 Ready；
- 响应 bridge→设备的命令：`device.move_head`、`device.reset_pose`、`device.set_expression`、`device.show_text`、`device.set_led`、`device.speak`、`device.stop_audio`、`device.set_volume`、`device.emergency_stop`、`device.get_status`，返回 result 或带 bridge 错误码的 error（含 `_meta.deduplicated` 重放去重：最近 32 个 id/key，60 s）；
- 主动上报 `state.update`（变化触发 + 30 s 周期）和 `event.<name>` 通知、`playback.state`；
- `audio.begin` → 二进制帧（PCM s16le 16 kHz 单声道）→ `audio.end`，经 PSRAM 环形缓冲播放；
- `ping`/`pong` 保活 + 指数退避 + 抖动重连（1 s … 30 s）；
- 暂无认证（`-32004 unauthorized` 仅在 bridge 侧保留）。

> **状态：已在主机上测试、已用 PlatformIO 编译通过，尚未在真机上运行。** 所有硬件相关参数都放在 `include/gc_config.example.h`，凡带「待实机确认」的都只来自官方 StackChan 固件源码（MIT）或保守猜测，不是在你的机器上验证过的事实。

## 目录结构

```text
firmware/
  platformio.ini                 # env:cores3（真机）  env:native（主机单测）
  include/gc_config.example.h    # 配置模板（WiFi/服务器/设备ID/引脚/限位）。复制为 gc_config.h，后者已 gitignore
  lib/grokchan_core/src/         # 与硬件无关的核心（主机可编译、可测试）
    gc_protocol.*                #   JSON-RPC 编解码、错误码、二进制音频帧头
    gc_device.*                  #   DeviceClient：会话状态机、方法分发、去重、限位、状态/事件上报
    gc_audio.*                   #   PcmQueue 环形缓冲 + AudioPlayer（流状态机、underrun、playback.state）
    gc_dedup.* gc_backoff.h gc_util.*
    gc_hal.h                     #   HAL 接口：IHead/IDisplay/ILed/IPcmSink/ISystem/ITransport
  src/main.cpp                   # 装配：WiFi、PSRAM 环形缓冲、DeviceClient、触摸急停
  src/platform/                  # ESP32 / M5Unified / Arduino 的 HAL 实现（只在真机编译）
    pf_transport.h               #   links2004/WebSockets
    pf_head.h                    #   Feetech SCS 舵机（Serial1），50 Hz 平滑插值
    pf_py32.h  pf_led.h          #   PY32 IO 扩展器（I2C 0x6F）：舵机电源 + 12 灯环
    pf_display.h                 #   程序绘制的表情 + 文字气泡（efontCN 中文字体）
    pf_audio.h                   #   M5.Speaker.playRaw，3 个轮转缓冲
    pf_system.h                  #   电量/RSSI/NVS 音量/日志
  test/test_core/                # 97 个主机单测（Unity）
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
pio test -e native                   # 97 个单测：协议、分发、错误码、去重、限位、重连、音频状态机
bash tools/run_e2e.sh                # 13 个端到端：真实 bridge(wrangler dev) <-> 固件核心模拟器
```

`run_e2e.sh` 需要 Node ≥ 22 和已 `npm install` 的 `../bridge`，并需先跑过一次 `pio test -e native`（拉取 ArduinoJson）。

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
| 13 | 屏幕 | 320×240，程序绘制表情，中文用 `efontCN_12/16/24`，≤15 fps | M5GFX 自带字体；排版/闪烁/字形覆盖未验证 |
| 14 | 触摸急停 | 任意触摸 = 本地急停 | 猜测；可能误触，不要可设 `GC_TOUCH_EMERGENCY_STOP 0` |
| 15 | 电量 | `M5.Power.getBatteryLevel()`，低电量阈值 10% | 电量计精度未验证 |
| 16 | TLS | `beginSSL` 无 CA = 不校验证书；workers.dev 在你网络下是否可达未验证 | 库行为 |
| 17 | WiFi 省电 | 关闭 WiFi 休眠以保证音频流畅 | 猜测，耗电更高 |

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
- 触摸急停、低电量、LED 封顶等安全默认值都是保守猜测。
