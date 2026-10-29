# 音频 / 信令 / MCP 一体化 SDK 设计（草案）

> 状态：**v0.4（真机前查缺补漏，2026-10-28）**。同一 Worker/Hub、`mediasession-rpc/1`、S1=PCM+全套 M1 MCP。**鉴权已落地**（设备 token + `MCP_API_KEY` 分轨）；语音默认关；回声策略定稿半双工+触摸打断；超长语句固件截断/bridge 接受恰好上限；TTS 中途失败立刻 abort。`stream.open` 仍为 S2。暂不抽 packages。  
> 英文简版：[audio-sdk-plan.md](audio-sdk-plan.md)。  
> 相关：原 MCP 规划 [mcp-plan.zh-CN.md](mcp-plan.zh-CN.md)（设备工具清单仍作参考）；现有实现 `bridge/src/{mcp,device,tts}/`。  
> **本期目标**：一套部署在 Cloudflare Workers 上的一体化栈——**设备 WebSocket（JSON-RPC + 二进制音频）** 与 **Agent 侧 MCP（Streamable HTTP）** 共用同一会话 / 流 / 错误模型，而不是两套并行协议。

## 0. 目标与非目标

**目标**

- **一条设备 WebSocket**：文本帧走 **JSON-RPC 2.0** 信令，二进制帧走 **音频媒体**；支持 PCM + Opus、断线重连。
- **一条 Agent MCP 入口**：`POST /mcp`（Streamable HTTP），工具调用落到同一 Durable Object 会话，驱动设备命令与 `speak` / 开流播放。
- **统一内核**：会话、流表、限流、错误码、音频帧格式只有一份；MCP tools 是 Agent 视图，JSON-RPC methods 是设备视图，一一映射。
- 服务端：**Cloudflare Workers + Hibernation Durable Object**；客户端 SDK：TypeScript 优先，固件复用同一协议。
- 双向音频：下行播放与上行采集共用帧格式；`speak` = TTS 适配器 + 下行 `play`。

**非目标（本期）**

- 不做 WebRTC / SFU。
- 不做端到端加密（鉴权确认后再加）。
- MCP 不做 SSE 长会话 / resources / prompts（与现有手写 MCP 一致；需要时再加）。
- 不在 Worker 内做 PCM↔Opus 转码。

## 1. 一体化架构

```text
┌──────────────┐  MCP Streamable HTTP POST /mcp   ┌─────────────────────────────────────┐
│  Grok Bot    │ ───────────────────────────────▶ │  Cloudflare Worker                  │
│  (MCP client)│ ◀─────────────────────────────── │   /mcp          McpGateway          │
└──────────────┘   tools/list · tools/call         │   /ws/device    设备接入             │
                                                   │   /api/chat     现有聊天（不动）      │
┌──────────────┐  wss JSON-RPC + binary audio      │                                     │
│  Device /    │ ◀───────────────────────────────▶ │   SessionHub DO（每 device/session） │
│  Client SDK  │   mediasession-rpc/1               │    ├ media: hello / stream / frames │
└──────────────┘   (+ device.* 控制方法)            │    ├ control: move_head / led / …  │
                                                   │    ├ mcp 映射层（tool ↔ rpc method）│
                                                   │    └ TTS /（可选）ASR 钩子           │
                                                   └─────────────────────────────────────┘
```

**两条通道，一个内核：**

| 通道 | 谁发起 | 入口 | 落到 |
| --- | --- | --- | --- |
| A. MCP | Grok / Agent | `POST /mcp` | `SessionHub`：校验参数 → JSON-RPC 下发或本地 `play()` |
| B. 设备 WS | 设备 / 浏览器 SDK | `GET /ws/device` | 同一 `SessionHub`：握手、收发帧、上报 `stream.state` |

现有 `ChatHub` + `/api/chat` **保持不动**（设备→Grok 的文本触发仍可走 webhook；M3 再把 `event.*` 转进 inbound）。

### 1.1 组件落点

| 组件 | 建议路径 | 职责 |
| --- | --- | --- |
| 协议内核 | `packages/mediasession-protocol/` | JSON-RPC、音频帧、错误码、能力类型；**MCP tool schema 与 `device.*` / `stream.*` 方法表的单一来源** |
| 服务端 | `packages/mediasession-server/` | `SessionHub` DO、设备 WS、`play()` / 流控、重连顶替 |
| MCP 适配 | `packages/mediasession-mcp/`（或 server 子路径） | `createMcpHandler` 或手写最小 MCP；`tools/call` → hub 方法 |
| 客户端 | `packages/mediasession-client/` | 设备/浏览器：连接、重连、RPC、收发流 |
| GrokChan 落地 | `bridge/` 依赖上述包，删除重复的 `device/protocol` 分叉 | 配置 `STACKCHAN_ENABLED`、TTS provider |

### 1.2 与现有代码的关系

- 现有 `bridge/src/device/*`、`mcp/*`、`tts/*` 视为 **v1 实现参考**；整合后协议名统一为 `mediasession-rpc/1`（已确认改名；先在 bridge 内收口），音频帧 **保持 8 字节头不变**，测试尽量复用。  
- `mcp-plan.zh-CN.md` 中的 M1 工具清单 **并入本文 §3**；该文档可标为「已由 audio-sdk-plan 吸收」。  

## 2. 传输约定

1. **一条 WebSocket**，子协议（Sec-WebSocket-Protocol）建议：`mediasession-rpc/1`。  
2. **文本帧** = JSON-RPC 2.0（request / response / notification）。  
3. **二进制帧** = 固定 8 字节小端头 + payload（与现有 GrokChan 帧布局兼容，便于复用测试与固件经验）：

```text
 offset  size  field
 0       u8    type     0x01 = downlink audio, 0x02 = uplink audio
 1       u8    flags    bit0 = LAST（本流最后一帧；可与 audio.end 双保险）
 2       u16   stream   stream_id（与 audio.begin 对应）
 4       u32   seq      流内从 0 递增
 8       …     payload  PCM 样本或单个 Opus 包
```

4. 二进制帧**必须**夹在对应方向的 `audio.begin` 与 `audio.end` 之间；未知 `stream_id`、`seq` 不连续 → 收端丢弃该流并发 `stream.error`。  
5. WebSocket 本身有序可靠，`seq` 用于对账、调试与检测实现 bug，**不用于 UDP 式重传**。

## 3. 会话与信令（JSON-RPC）

### 3.1 方法命名空间

| 前缀 | 方向 | 用途 |
| --- | --- | --- |
| `session.*` | 双向 | 握手、能力、关闭、心跳 |
| `stream.*` | 双向 | 开流 / 关流 / 流控 / 错误（语义层；二进制仍用 `audio.*` 界定媒体） |
| `audio.*` | 通知 | `audio.begin` / `audio.end` / 可选 `audio.credit`（与现有设备协议对齐，减少双栈） |
| `rpc.ping` / `rpc.pong` | 通知 | 保活（DO 可用 `setWebSocketAutoResponse`） |

> 说明：媒体界定继续用 `audio.begin|end` 通知，避免与已实现的 bridge/固件分叉；控制面开流意图用 `stream.open` request（见下），便于带超时与错误码。

### 3.2 握手

客户端连上后立即发 **request**：

```json
{
  "jsonrpc": "2.0",
  "id": 1,
  "method": "session.hello",
  "params": {
    "protocol": "mediasession-rpc/1",
    "role": "player",
    "client_id": "browser-abc",
    "session_id": null,
    "audio": {
      "play": [
        { "format": "opus", "sample_rate": 16000, "channels": 1, "frame_ms": 60 },
        { "format": "pcm_s16le", "sample_rate": 16000, "channels": 1 }
      ],
      "capture": [
        { "format": "opus", "sample_rate": 16000, "channels": 1, "frame_ms": 60 }
      ],
      "max_chunk_bytes": 4096,
      "buffer_ms": 2000
    }
  }
}
```

服务端 **result**：

```json
{
  "jsonrpc": "2.0",
  "id": 1,
  "result": {
    "session_id": "sess_…",
    "protocol": "mediasession-rpc/1",
    "role": "server",
    "heartbeat_ms": 20000,
    "audio": {
      "format": "opus",
      "sample_rate": 16000,
      "channels": 1,
      "frame_ms": 60,
      "chunk_bytes": 4096
    },
    "resume_token": "…"
  }
}
```

规则：

- `protocol` 不匹配 → error `-32006 unsupported`，并关闭连接（建议 close code `4002`）。  
- 服务端在双方 `play`/`capture` 交集中选**一种**默认下行格式（优先 opus，否则 pcm）；开流时可再覆盖。  
- `session_id` + `resume_token`：重连时带上，用于恢复会话元数据（**不**恢复未播完的媒体字节）。

### 3.3 开流 / 关流

**下行播放（server → client）典型时序**

```text
server → client  request   stream.open   { stream_id, direction:"down", format, sample_rate, channels, frame_ms?, total_bytes? }
client → server  response  { accepted: true, buffer_ms }
server → client  notif     audio.begin   { stream_id, format, … }     // 与 open 字段一致，便于只懂音频层的端
server → client  binary    frames…
server → client  notif     audio.end     { stream_id, total_chunks, total_bytes, reason:"complete"|"aborted" }
client → server  notif     stream.state  { stream_id, state:"started"|"ended"|"interrupted"|"error"|"underrun", position_ms? }
```

**上行采集（client → server）**：对称，`direction:"up"`，由 client 发 `stream.open` + `audio.begin` + `type=0x02` 帧。

`stream.open` 也可用 **notification** 简化（无应答）；**推荐 request**，以便拒绝不支持的格式（`-32006`）或忙（`-32000`）。

> **S1 落地偏差**：实现仍只用 `audio.begin` / `audio.end` + 二进制帧（与现有 bridge/固件一致）；`stream.open` / `stream.stop` 作为控制面开流意图 **留到 S2**。S1 的 `stop_audio` 继续走 `device.stop_audio`。

可选流控：收端发 `audio.credit { stream_id, ack_seq, buffer_ms }`；发端按信用或 ≤1.2× 实时速率推送，禁止一次性灌满。

### 3.4 打断与停止

| 方法 | 类型 | 含义 |
| --- | --- | --- |
| `stream.stop` | request | 停止指定 `stream_id`（或 `direction`）；对端以 `audio.end reason:aborted` + `stream.state interrupted` 收尾 |
| `session.close` | request | 优雅关会话，再关 WebSocket |

对「已被打断的 wait」返回业务错误：建议码 **`-32013 interrupted`**（与 GrokChan 文档中的 interrupted 语义对齐；若保持设备层独立，本 SDK 在 result 里用 `state:"interrupted"` 即可）。

### 3.5 错误码

沿用 JSON-RPC 标准码 + 自定义段：

| code | 含义 |
| --- | --- |
| -32700 … -32603 | 标准 |
| -32000 | busy |
| -32003 | timeout |
| -32004 | unauthorized（预留） |
| -32006 | unsupported（格式/协议） |
| -32007 | rate_limited |
| -32008 | expired（ttl） |
| -32010 | payload_too_large |
| -32012 | stream_error |
| -32013 | interrupted |

### 3.6 Close codes（WebSocket）

| code | 含义 |
| --- | --- |
| 4000 | replaced（同 session 被新连接顶替） |
| 4001 | hello timeout |
| 4002 | protocol mismatch |
| 4003 | auth failed（设备 Bearer 校验失败） |
| 1006 | 异常断开（客户端库常见） |

## 4. 音频格式约定

| format | payload | 必填 begin 字段 | 用途 |
| --- | --- | --- | --- |
| `pcm_s16le` | 交错小端 16-bit PCM | `sample_rate`, `channels` | bring-up、短句、无 Opus 的端 |
| `opus` | **每个二进制帧 = 1 个裸 Opus packet**（非 Ogg/容器） | `sample_rate`, `channels`, `frame_ms`（常用 20/40/60） | 低码率、双向实时 |

建议默认：16 kHz mono；PCM chunk 约 20–60 ms 或 ≤ `chunk_bytes`；Opus `frame_ms=60` 时每包一帧。

**不做**：Worker 内 PCM↔Opus 转码（成本高）；由生产者按协商格式直出。

## 5. 断线重连

### 5.1 客户端策略

1. 连接失败 / 非 4xxx 业务关闭 → 指数退避重连（如 1s → 2 → 4 → … 封顶 30s，加抖动）。  
2. 重连 URL 带 `session_id` + `resume_token`（或 hello.params 里带）。  
3. 重连成功后：  
   - 所有**未完成**的本地 stream 标为 `interrupted` / error，**不**自动续传媒体；  
   - 应用层若需要「接着说」，重新 `stream.open`。  
4. hello 未完成超时（如 5s）→ 主动断开，按失败重连。  
5. 心跳：每 `heartbeat_ms` 发 `rpc.ping`；连续 N 次无 `rpc.pong` 则主动重连。

### 5.2 服务端（Workers DO）

1. 每 `session_id` 一个 Durable Object（或「用户/设备维度」一个，内部多路 stream）。  
2. Hibernation：用 `setWebSocketAutoResponse` 应答精确 `rpc.ping`→`rpc.pong` 字符串，避免为保活唤醒。  
3. 同 session 新连接顶替旧连接（close 4000）。  
4. DO 被驱逐时：内存中的在途流与限流计数丢失；socket 与最小 session 元数据应可恢复的写入 DO storage（`session_id`, `resume_token`, 能力快照）。**媒体字节不落盘**。  
5. 客户端重连后，服务端返回同一 `session_id`；若 resume_token 无效 → 新 session。

## 6. SDK API 草图（TypeScript）

### 6.1 客户端

```ts
const session = await MediaSession.connect({
  url: "wss://example.workers.dev/v1/session",
  role: "player",
  clientId: "web-1",
  // preferredFormats: ["opus", "pcm_s16le"],
  onState: (s) => { /* connecting | open | reconnecting | closed */ },
});

// 播放下行（被动收：监听事件）
session.on("stream", async (stream) => {
  if (stream.direction !== "down") return;
  const sink = createPcmSink(stream); // 或 OpusDecoder
  for await (const frame of stream.frames()) {
    sink.write(frame.payload, frame.seq);
  }
});

// 或主动开上行
const up = await session.openStream({
  direction: "up",
  format: "opus",
  sampleRate: 16000,
  channels: 1,
  frameMs: 60,
});
up.write(opusPacket);
await up.end(); // → audio.end complete

await session.close();
```

要点：

- `connect` 内含 hello + 自动重连（可关）。  
- `MediaStreamHandle`：`write` / `end` / `abort`、`on("state")`。  
- 二进制与 JSON-RPC 在同一 socket；调用方不直接碰帧头。  
- 提供 `protocol` 纯函数包，便于固件/测试复用 encode/decode。

### 6.2 服务端（Workers）

```ts
export { SessionHub }; // Durable Object

export default {
  async fetch(req: Request, env: Env): Promise<Response> {
    return mediaSessionFetch(req, env, {
      createHub: (id) => env.SESSION.getByName(id),
      onSessionHello: async (peer, hello) => ({ /* choose format */ }),
      onUplinkFrame: async (peer, streamId, frame) => { /* ASR hook */ },
      // 下行：业务调用 peer.playPcm / peer.playOpus
    });
  },
};

// 在 DO 内：
await peer.play({ format: "pcm_s16le", sampleRate: 16000, channels: 1 }, pcmBytes);
```

DO 基类负责：握手、顶替连接、stream 表、credit 流控、限流、把 `play()` 编成 begin/帧/end。

## 7. MCP 整合（Agent 视图）

### 7.1 原则

1. **一个工具 ↔ 一个设备 JSON-RPC method**（或一次明确的本地 `play()` 流水线）。禁止 MCP 与 WS 两套不同语义。  
2. MCP 只做 **参数校验、设备寻址、等待策略、错误码映射**；真正副作用在 `SessionHub`。  
3. `speak` = `tts.synthesize`（可注入） + `stream.open`/`audio.*` 下行；对 Agent 仍暴露为单一 tool `speak`。  
4. 鉴权：**已实现**分轨（与 mcp-plan §1.6 一致）。`STACKCHAN_ENABLED` 仍为总开关；生产必须同时设 `MCP_API_KEY` 并注册设备 token。

### 7.2 M1 工具 ↔ 方法映射

| MCP tool | SessionHub / 设备 method | 说明 |
| --- | --- | --- |
| `list_devices` | Registry 查询 | 无设备 RPC |
| `get_device_status` | `device.get_status` 或缓存 `state.update` | |
| `move_head` | `device.move_head` | |
| `reset_pose` | `device.reset_pose` | |
| `set_expression` | `device.set_expression` | |
| `show_text` | `device.show_text` | |
| `set_led` | `device.set_led` | |
| `set_volume` | `device.set_volume` | |
| `stop_audio` | `stream.stop` / `device.stop_audio` | 中止下行流 |
| `emergency_stop` | `device.emergency_stop` | 最高优先级 |
| `speak` | TTS + `device.speak` + `audio.begin|frames|end` | 见 §3 |

可选纯媒体工具（给非 Stack-chan 客户端）：`play_pcm` / `play_opus` / `start_listen`——内部只走 `stream.*`，不出现 `device.*`。

### 7.3 MCP 错误 ↔ JSON-RPC

沿用现有 `mapDeviceError`：设备 `-3200x` → MCP envelope `error.code`（`busy`、`timeout`、`interrupted`、`device_offline` …）。Hub 离线短路径直接返回 `device_offline`，不排队（`speak` 除外若将来开 `queue_if_offline`）。

### 7.4 SDK 对外表面

```ts
// Worker
export { SessionHub, mediaSessionFetch, mcpFetch } from "mediasession-server";
// mcpFetch(req, env, { tools: stackchanTools | mediaOnlyTools, gateway })

// Device client
const s = await MediaSession.connect({ url, hello: { caps: ["speaker","head"], ... } });
s.onMethod("device.move_head", handler);
s.onAudioDown((stream) => { ... });
```

协议包导出：`TOOLS`（MCP schema）、`METHODS`（JSON-RPC）、`encodeFrame`/`decodeFrame`，**一份生成两边**，避免 bridge 里 schema 漂移。

## 8. 与 GrokChan 现有实现的映射


| 现有（旧名 grokchan-rpc/1） | 整合后（mediasession-rpc/1 + MCP，已改名） |
| --- | --- |
| `session.hello` | 同名；音频能力 + `caps`（含 head/led/…） |
| `device.*` 控制方法 | **保留**，由 MCP tools 映射 |
| `device.speak` + TTS | Hub.`speak()` = TTS + `play()`；MCP `speak` |
| `audio.begin` / binary / `audio.end` | **保持一致**（8 字节头） |
| `playback.state` | `stream.state`（可双发兼容旧固件） |
| `audio.credit` | 同名保留 |
| `POST /mcp` 手写服务 | `mediasession-mcp` 适配同一 Hub |

确认采用本 SDK 后，建议 bridge 音频路径改为依赖 `mediasession-*` 包，设备控制方法仍留在 `device/*`。

## 9. 里程碑（确认后执行）

| 阶段 | 内容 | 验收 |
| --- | --- | --- |
| **S0** | 协议名改 `mediasession-rpc/1`；帧编解码、错误码、`DEVICE_METHODS` 同源表（仍在 `bridge/src/device/`） | 帧互操作 + typecheck；固件 `kProtocol` 同步 |
| **S1** | 在 bridge 内收口 SessionHub + `/mcp`；PCM `speak`/play；断线重连/顶替；**不开 `stream.open`（S2）** | `npm test`（含 device.e2e）；协议字符串 `mediasession-rpc/1`；固件 native 测通过 |
| **S2** | Opus 双向 + credit；设备控制方法挂同一 Hub | 真机/模拟 Opus；`move_head` 等经 MCP 通路 |
| **S3** | resume 持久化、bridge 切依赖、文档合并（鉴权已在 S1 查缺补漏完成） | 可部署 demo；`mcp-plan` 标为已吸收 |

## 10. 请你确认的问题

1. **整合方式（已按你的要求默认）**：MCP + 音频信令同一 Worker / 同一 `SessionHub`；工具表与 JSON-RPC 方法表同源。若你希望 MCP 仍单独进程/路由，请说明。  
2. **包形态**：独立 `packages/mediasession-*` 再让 bridge 依赖，还是先在 `bridge/` 内收口再抽包？  
3. **协议名**：**已确认** `mediasession-rpc/1`。  
4. **`stream.open` vs 仅 `audio.begin`**：双段，还是保持现状只 begin？  
5. **S1 范围**：PCM only + 全套 M1 MCP 工具，是否够用？（Opus → S2）  
6. **鉴权**：✅ 已选并实现 S1 加 MCP key / 设备 token（分轨）。  
7. **固件**：TS SDK 优先，C++ 头文件是否要在 S1 同步生成？

## 11. 语音对话全链路（S1 增补，bridge 内实现）

> 状态：bridge 与固件核心已实现并有测试；**固件麦克风平台层未在真机验证（待实机确认）**；鉴权已落地（`STACKCHAN_ENABLED` + `MCP_API_KEY` + 设备 token）。协议名不变：`mediasession-rpc/1`。

### 11.1 链路

```text
设备麦克风 ──pcm_s16le 16k──▶ [上行流] ──▶ ASR(流式) ──▶ agent webhook(grokbot) ──reply.url──▶ 回复文本
                                                                                          │
设备扬声器 ◀──pcm 下行帧◀── [流式 TTS，按句送入，边合成边发] ◀───────────────────────────────────┘
```

- **上行**：设备发 `event.speech_start` → `audio.begin {direction:"uplink", stream_id, format:"pcm_s16le", sample_rate:16000, channels:1, lang?}` → 二进制帧（type `0x02`，8 字节头不变，seq 从 0 连续）→ `audio.end {direction:"uplink", stream_id, total_chunks, total_bytes}` → `event.speech_end`。`reason:"aborted"` 表示设备放弃本句。Opus 仅保留类型位，S1 拒绝（`unsupported_format`）。
- **单句限制**：默认 ≤15 s（`UPLINK_MAX_MS`）且 ≤ 对应字节数（上限 1 MB）。bridge 在 `session.hello` 的 result 里下发 `voice.uplink {format, sample_rate, channels, max_ms, max_bytes, idle_timeout_ms}`，设备应在限内截断并正常结束（固件核心已实现）。超限/超时/seq 断档/计数不符 ⇒ **丢弃该句**并发 `stream.error` + `turn.state idle reason=…`（不会拿半句去转录）。
- **ASR**：适配器接口为流式（`start()` 得到会话，`push(frame)` 边收边送，`onPartial`，`finish()` 取最终文本，`abort()`）。`ASR_PROVIDER`：`mock`（测试）/ `workers-ai`（整句缓冲后转录，未实测）/ `elevenlabs`（Scribe realtime WebSocket，帧即到即转发，`commit_strategy=manual`，`speech_end` 时提交）。未设置 ⇒ 语音关闭，hello 里不带 `voice`。
- **转发 grokbot**：最终文本走既有 agent webhook 链路（`agents/grokbot`，一次性 `reply.url`），`inbound.device = {id, modality:"voice", turn_id, hw?, fw?, caps?, lang?}`（网页聊天不带该字段，向后兼容）。回复由 `/api/reply/<token>` 回到 DeviceHub；token 带 `device:<id>:<turn_id>`，**过期回合的回复直接丢弃**（200 `{ok:true,dropped:"stale_turn"}`）。
- **流式 TTS**：回复文本按句切分；`TtsProvider.openInputStream()`（ElevenLabs `stream-input` WebSocket，`pcm_16000`）按句送文本，音频一到就发 `audio.begin`（不带 `total_bytes`）→ 下行帧 → `audio.end {total_chunks,total_bytes,reason:"complete"}`。首句尽早开始；没有 `openInputStream` 的 provider 退化为逐句合成。下行帧不带 LAST 标志，`audio.end` 为终止符（seq 连续）。
- **播放流控**：bridge 以约 1.2× 实时速率发送（`Pacer`，首 `burst` 一次性灌入后按速率），若设备发 `audio.credit {stream_id, buffer_ms}` 则按设备缓冲收紧；设备 `playback.state ended` 后才结束回合（`PLAYBACK_SLACK_MS` 兜底）。

### 11.2 回合状态机（bridge，DeviceHub 内 `VoiceEngine`，每设备一个）

```text
              speech_start / uplink audio.begin
   ┌──────┐ ───────────────────────────────▶ ┌───────────┐ speech_end / audio.end ┌──────────────┐
   │ idle │                                   │ listening │ ─────────────────────▶ │ transcribing │
   └──────┘ ◀──── reason(done/…) ──────────── └───────────┘                         └──────┬───────┘
      ▲  ▲                                          │ 超限/超时/中止/断线                  │ 最终转录
      │  │                                          ▼                                      ▼
      │  └──────────── reason(…) ◀──────────── （任意状态）                          ┌──────────┐ 回复到达 ┌──────────┐
      │                                                                              │ thinking │ ───────▶ │ speaking │
      └────────────────────── 播放结束 playback.state=ended（reason=done）◀──────────────┴──────────┘          └──────────┘
```

打断边（任何非 idle 状态都适用）：

| 触发 | 效果 |
| --- | --- |
| 新的 `event.speech_start` / 上行 `audio.begin`（barge-in） | 旧回合立即作废：`audio.end reason=aborted`（若正在 speaking）、取消 TTS/ASR/等待中的 agent 回复、清队列、迟到回复按 `stale_turn` 丢弃；随后进入新回合 `listening` |
| MCP `stop_audio`（`device.stop_audio`） / `emergency_stop` | 同上，回到 `idle`（reason `stop`）；设备端 `emergency_stop` 还会终止本地上行（`audio.end aborted`） |
| 断线 / 顶替连接 | 回合清空（`disconnect` / `session_replaced`），重连后从 `idle` 开始，旧回复丢弃 |
| MCP `speak` 期间有语音回合 | MCP `speak` 返回 `busy`（`interrupt:true` 可打断） |

### 11.3 事件 / 方法清单

| 方向 | 方法 | 说明 |
| --- | --- | --- |
| 设备→bridge | `event.speech_start` `{lang?}` / `event.speech_end` | VAD 或按键 |
| 设备→bridge | `audio.begin` / `audio.end`（`direction:"uplink"`） + 二进制 `0x02` 帧 | 上行 |
| 设备→bridge | `audio.credit {stream_id, buffer_ms}`、`playback.state` | 下行流控 / 播放状态（固件当前未发 `audio.credit`，只靠 1.2× 节流） |
| bridge→设备 | `turn.state {turn_id, state, prev, gen, reason?}` | 状态机变化，`state ∈ idle/listening/transcribing/thinking/speaking` |
| bridge→设备 | `asr.transcript {turn_id, final, text, seq}` | 部分（`final:false`）/最终转录 |
| bridge→设备 | `turn.reply {turn_id, text}` | agent 回复文本（用于显示） |
| bridge→设备 | `stream.error {stream_id, direction, code:-32012, reason, message}` | 上行被拒/失败 |
| bridge→设备 | `audio.begin` / 帧 / `audio.end`（下行，回复） | 流式 TTS |
| `reason` 取值 | `done barge_in stop disconnect session_replaced no_audio empty_audio empty_transcript uplink_aborted too_large too_long timeout seq_gap bad_frame count_mismatch unsupported_format asr_unavailable asr_failed asr_timeout agent_not_configured agent_unavailable agent_timeout tts_unavailable tts_failed device_rejected device_error device_interrupted playback_timeout rate_limited` | 见 `bridge/src/device/protocol.ts` `VoiceReason` |

`get_device_status` 的 result 在语音启用时带 `turn: {state, turn_id, gen}`。

### 11.4 时序（一次完整对话）

```text
设备                       bridge(DeviceHub)                 ASR            grokbot(webhook)         TTS
 │ event.speech_start ───▶  turn: listening
 │ audio.begin(up) ──────▶  ASR.start ───────────────────▶ 连接
 │ 0x02 帧 × N ──────────▶  asr.push ────────────────────▶ 流式
 │ ◀── asr.transcript(partial)…
 │ audio.end(up) ────────▶  turn: transcribing → ASR.finish ▶ 最终文本
 │ ◀── asr.transcript(final)
 │                         turn: thinking ── POST inbound(device:{…}) ───────▶ 处理
 │                         ◀──────────────────────── POST /api/reply/<token> {text}
 │ ◀── turn.reply          turn: speaking ── 文本按句 ───────────────────────────────▶ 合成
 │ ◀── audio.begin(down)   ◀───────────────────────────────── 音频块（边合成边到） ───┘
 │ ◀── 下行帧（≈1.2×）…
 │ ◀── audio.end(complete)
 │ playback.state=ended ─▶  turn: idle(reason=done)
```

### 11.5 配置

| 名称 | 类型 | 说明 | 默认 |
| --- | --- | --- | --- |
| `ASR_PROVIDER` | var | `mock` / `workers-ai` / `elevenlabs`；未设 ⇒ 语音关闭 | 未设 |
| `TTS_PROVIDER` | var | `mock`（整段）/ `mock-stream`（按文本流式）/ `elevenlabs`；未设 ⇒ `tts_unavailable` | 未设 |
| `ELEVENLABS_API_KEY` | **secret** | 仅从 Worker env 读取，只放请求头，不进 URL/日志 | — |
| `ELEVENLABS_VOICE_ID` / `_TTS_MODEL` / `_ASR_MODEL` / `_HOST` | var | 默认 `JBFqnCBsd6RMkjVDRZzb` / `eleven_flash_v2_5` / `scribe_v2_realtime` / `api.elevenlabs.io` | 见左 |
| `UPLINK_MAX_MS` `UPLINK_GRACE_MS` `UPLINK_IDLE_TIMEOUT_MS` `UPLINK_BEGIN_TIMEOUT_MS` | var | 单句上限 / 截止宽限 / 帧间隔超时 / speech_start 后等 audio.begin | `15000 2000 3000 3000` |
| `ASR_TIMEOUT_MS` `AGENT_REPLY_TIMEOUT_MS` `VOICE_REPLY_MAX_CHARS` `VOICE_TURNS_PER_MIN` | var | 转录超时 / agent 回复超时 / 回复截断 / 每设备每分钟回合数 | `10000 60000 1000 20` |
| `AUDIO_CHUNK_DELAY_MS` `PLAYBACK_SLACK_MS` | var | 测试用额外帧间隔 / 等 `playback.state` 的兜底 | `0 3000` |

设置密钥只用命令：`wrangler secret put ELEVENLABS_API_KEY`（本地开发写入 git 忽略的 `.dev.vars`；`.dev.vars.example` 里是空占位）。手动冒烟：`cd bridge && npm run smoke:elevenlabs`（读 `process.env.ELEVENLABS_API_KEY`，只输出成功/失败与首包/总耗时）。

### 11.6 固件侧（核心已实现，平台层待实机确认）

- `gc_voice.*`：`VoiceUplink` + `IMic`。能量 VAD（自适应噪声底、300 ms 预滚、连续 100 ms 才触发、700 ms 静音结束）或触摸 PTT；按 hello 下发的 `max_ms/max_bytes` 截断并正常 `audio.end`；`audio.end aborted`：急停/本地急停；收到 `turn.state` 离开 listening 或 `stream.error`：停止发送（不再宣告）；断线：清空、重连后重新 hello 才重新武装。
- 半双工（**定稿**）：默认 **播放期间 VAD 失聪**（无 AEC，避免自己打断自己）；仅 PTT/触摸或 `stop_audio` / `emergency_stop` 可打断：本地先 `stopAll()`（`playback.state interrupted`）再发 `speech_start`，bridge 同时断开自己的流。`GC_VOICE_BARGE_IN_BY_VAD=1` 仅在有 AEC 后考虑开启。
- `DeviceClient::setVoice()` 接入；`turn.state thinking` 时脸部表情切 `thinking`。`pf_mic.h`（M5.Mic）由 `GC_VOICE_ENABLED`（默认 0）开关：CoreS3 麦克风与扬声器共用 I2S，M5Unified 同时只允许其一，切换延迟/爆音待实机确认。

---

已确认并开工 S0→S1（bridge 内收口）。未抽 `packages/`；`stream.open`→S2。

### 11.7 语音策略定稿（真机前）

| 项 | 定稿 |
| --- | --- |
| 回声 | 半双工 + 触摸/PTT 打断；播放中禁用能量 VAD 自动 barge-in |
| 超长语句 | 固件截断并正常 `audio.end`；bridge 接受恰好上限的正常结束；仅超限/超时/seq 断档/计数不符 → `stream.error` |
| TTS 中途失败 | 立刻 abort：`audio.end reason=aborted` + `turn.state idle reason=tts_failed` |
| ElevenLabs ASR | `commit_strategy=manual`（设备 VAD / speech_end 触发） |
| ElevenLabs TTS | 按句推送（`sentences.ts` + `auto_mode=true`） |
| 生产默认 | 开发：ASR/TTS unset、STACKCHAN 关；生产 checklist：开 STACKCHAN、设 MCP_API_KEY、注册设备、ASR/TTS=elevenlabs；固件 `GC_VOICE_ENABLED` 仍默认 0 |
