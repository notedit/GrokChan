import type { DeviceGateway, DeviceOutcome, DeviceSummary } from "../device/gateway";
import { DEVICE_METHODS } from "../device/protocol";

/** Soft limits enforced by the bridge. The device re-checks against its own hard limits (-32001). */
export interface Limits {
  panMin: number;
  panMax: number;
  tiltMin: number;
  tiltMax: number;
  speedMin: number;
  speedMax: number;
  speedDefault: number;
  volumeCap: number;
}
export const DEFAULT_LIMITS: Limits = { panMin: -90, panMax: 90, tiltMin: 0, tiltMax: 60, speedMin: 100, speedMax: 1000, speedDefault: 150, volumeCap: 70 };

export const EXPRESSIONS = ["neutral", "happy", "sad", "angry", "surprised", "sleepy", "thinking", "confused", "love", "wink", "speaking"] as const;
export const LED_SIDES = ["left", "right", "both"] as const;
export const LED_MODES = ["solid", "breathe", "blink", "off"] as const;
export const TEXT_POSITIONS = ["bubble", "center", "bottom"] as const;
export const TEXT_SIZES = ["s", "m", "l"] as const;

export interface ToolContext {
  gateway: DeviceGateway;
  limits: Limits;
}

export type Envelope = Record<string, unknown> & { ok: boolean };
export interface ToolResult {
  envelope: Envelope;
}

export interface ToolDef {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
  annotations?: Record<string, unknown>;
  run(args: Record<string, unknown>, ctx: ToolContext): Promise<Envelope>;
}

class ArgError extends Error {}

// ---- argument readers (throw ArgError -> invalid_args) ----
const isObj = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);

function optNum(a: Record<string, unknown>, k: string): number | undefined {
  const v = a[k];
  if (v === undefined || v === null) return undefined;
  if (typeof v !== "number" || !Number.isFinite(v)) throw new ArgError(`${k} must be a number`);
  return v;
}
function optInt(a: Record<string, unknown>, k: string): number | undefined {
  const v = optNum(a, k);
  return v === undefined ? undefined : Math.round(v);
}
function intIn(a: Record<string, unknown>, k: string, min: number, max: number): number | undefined {
  const v = optNum(a, k);
  if (v === undefined) return undefined;
  if (!Number.isInteger(v) || v < min || v > max) throw new ArgError(`${k} must be an integer in ${min}..${max}`);
  return v;
}
function optBool(a: Record<string, unknown>, k: string): boolean | undefined {
  const v = a[k];
  if (v === undefined || v === null) return undefined;
  if (typeof v !== "boolean") throw new ArgError(`${k} must be a boolean`);
  return v;
}
function optStr(a: Record<string, unknown>, k: string, maxLen: number): string | undefined {
  const v = a[k];
  if (v === undefined || v === null) return undefined;
  if (typeof v !== "string") throw new ArgError(`${k} must be a string`);
  if ([...v].length > maxLen) throw new ArgError(`${k} must be at most ${maxLen} characters`);
  return v;
}
function optEnum<T extends string>(a: Record<string, unknown>, k: string, allowed: readonly T[]): T | undefined {
  const v = a[k];
  if (v === undefined || v === null) return undefined;
  if (typeof v !== "string" || !(allowed as readonly string[]).includes(v)) throw new ArgError(`${k} must be one of: ${allowed.join(", ")}`);
  return v as T;
}
/** Strip control characters (keep \n) so text can't smuggle terminal/protocol control codes. */
const cleanText = (s: string) => s.replace(/[\u0000-\u0009\u000b-\u001f\u007f-\u009f]/g, " ");
const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v));
const num = (v: unknown): number | undefined => (typeof v === "number" && Number.isFinite(v) ? v : undefined);

function fail(code: string, message: string, extra: Record<string, unknown> = {}, device_id?: string): Envelope {
  return { ok: false, ...(device_id ? { device_id } : {}), error: { code, message, ...extra } };
}

export function outcomeToEnvelope(o: DeviceOutcome, mapResult?: (r: Record<string, unknown>) => Record<string, unknown>): Envelope {
  if (!o.ok) return { ok: false, device_id: o.device_id, ...(o.command_id ? { command_id: o.command_id } : {}), error: o.error as unknown as Record<string, unknown> };
  return {
    ok: true,
    device_id: o.device_id,
    command_id: o.command_id,
    status: o.status,
    result: mapResult ? mapResult(o.result) : o.result,
    latency_ms: o.latency_ms,
    ...(o.deduplicated ? { deduplicated: true } : {}),
  };
}

/** Resolve the target device: explicit id (must be known), or the only device. */
async function resolveDevice(args: Record<string, unknown>, ctx: ToolContext): Promise<{ id: string } | { error: Envelope }> {
  const given = optStr(args, "device_id", 64);
  if (given !== undefined) {
    if (!/^[A-Za-z0-9_-]{1,64}$/.test(given)) throw new ArgError("device_id must match [A-Za-z0-9_-]{1,64}");
    if (!(await ctx.gateway.hasDevice(given))) return { error: fail("device_not_found", `unknown device ${given}; call list_devices`) };
    return { id: given };
  }
  const all = await ctx.gateway.listDevices();
  if (all.length === 0) return { error: fail("device_not_found", "no device has connected to this bridge yet") };
  if (all.length > 1) return { error: fail("device_required", "several devices exist; pass device_id (see list_devices)", { devices: all.map((d) => d.device_id) }) };
  return { id: all[0]!.device_id };
}

function requestId(args: Record<string, unknown>): string | undefined {
  const v = optStr(args, "request_id", 64);
  return v === "" ? undefined : v;
}

const commonProps = {
  device_id: { type: "string", description: "Target device id. Optional when exactly one device is registered." },
  request_id: { type: "string", maxLength: 64, description: "Idempotency key: repeating the same call with the same request_id within 60 s returns the first result without re-executing." },
};

function schema(props: Record<string, unknown>, required: string[] = [], device = true): Record<string, unknown> {
  return { type: "object", properties: { ...(device ? commonProps : {}), ...props }, ...(required.length ? { required } : {}), additionalProperties: false };
}

/** Wrapper for tools that talk to one device. */
function deviceTool(
  def: Omit<ToolDef, "run">,
  body: (args: Record<string, unknown>, id: string, ctx: ToolContext) => Promise<Envelope>,
): ToolDef {
  return {
    ...def,
    async run(args, ctx) {
      try {
        const r = await resolveDevice(args, ctx);
        if ("error" in r) return r.error;
        return await body(args, r.id, ctx);
      } catch (e) {
        if (e instanceof ArgError) return fail("invalid_args", e.message);
        throw e;
      }
    },
  };
}

const waitSchema = { type: "string", enum: ["accepted", "done"], description: "accepted (default): return when the device accepted the command. done: return when it finished." };
const timeoutSchema = { type: "integer", minimum: 1000, maximum: 120000, description: "With wait=done: how long to wait (default 30000)." };

function motionWait(args: Record<string, unknown>): { wait: "accepted" | "done"; timeout_ms?: number } {
  const wait = optEnum(args, "wait", ["accepted", "done"] as const) ?? "accepted";
  const t = wait === "done" ? (intIn(args, "timeout_ms", 1000, 120000) ?? 30000) : undefined;
  return { wait, ...(t ? { timeout_ms: t } : {}) };
}

export function buildTools(): ToolDef[] {
  return [
    {
      name: "list_devices",
      description: "List Stack-chan devices known to this bridge with their online state. Read-only. Call first when several devices exist.",
      inputSchema: schema({}, [], false),
      annotations: { readOnlyHint: true, openWorldHint: false },
      async run(_args, ctx) {
        const devices = await ctx.gateway.listDevices();
        return { ok: true, status: "done", result: { devices: devices.map(deviceView) } };
      },
    },
    deviceTool(
      {
        name: "get_device_status",
        description: "Read a device's state: online, battery %, volume, head pose (pan/tilt degrees), expression, playback, limits. Uses the latest snapshot the device reported; set fresh=true to ask the device now (slower). Read-only.",
        inputSchema: schema({ fresh: { type: "boolean", description: "Ask the device for a live snapshot (default false)." } }),
        annotations: { readOnlyHint: true, openWorldHint: false },
      },
      async (args, id, ctx) => outcomeToEnvelope(await ctx.gateway.status(id, optBool(args, "fresh") ?? false)),
    ),
    deviceTool(
      {
        name: "move_head",
        description:
          "Turn the robot's head. pan = horizontal angle in degrees (negative = robot's left), tilt = vertical angle in degrees (0 = level, positive = up). Values outside the safe range (pan -90..90, tilt 0..60 by default) are clamped and reported with clamped=true. speed 100-1000 (150 = natural). Give pan and/or tilt. Physical action: it is never retried automatically.",
        inputSchema: schema({
          pan: { type: "number", description: "Degrees, default range -90..90." },
          tilt: { type: "number", description: "Degrees, default range 0..60." },
          speed: { type: "integer", minimum: 100, maximum: 1000, description: "Default 150." },
          relative: { type: "boolean", description: "Treat pan/tilt as deltas from the current pose." },
          wait: waitSchema,
          timeout_ms: timeoutSchema,
        }),
      },
      async (args, id, ctx) => {
        const L = ctx.limits;
        let pan = optNum(args, "pan");
        let tilt = optNum(args, "tilt");
        if (pan === undefined && tilt === undefined) throw new ArgError("give pan and/or tilt");
        const relative = optBool(args, "relative") ?? false;
        const requested = { ...(pan !== undefined ? { pan } : {}), ...(tilt !== undefined ? { tilt } : {}) };
        let clamped = false;
        const fit = (v: number, lo: number, hi: number) => {
          const r = Math.round(clamp(v, lo, hi));
          if (r !== v) clamped = true;
          return r;
        };
        if (pan !== undefined) pan = relative ? fit(pan, -(L.panMax - L.panMin), L.panMax - L.panMin) : fit(pan, L.panMin, L.panMax);
        if (tilt !== undefined) tilt = relative ? fit(tilt, -(L.tiltMax - L.tiltMin), L.tiltMax - L.tiltMin) : fit(tilt, L.tiltMin, L.tiltMax);
        let speed = optNum(args, "speed") ?? L.speedDefault;
        const fitted = clamp(Math.round(speed), L.speedMin, L.speedMax);
        if (fitted !== speed) clamped = true;
        speed = fitted;
        const w = motionWait(args);
        const out = await ctx.gateway.call(id, {
          tool: "move_head",
          method: DEVICE_METHODS.move_head,
          params: { ...(pan !== undefined ? { pan } : {}), ...(tilt !== undefined ? { tilt } : {}), speed, relative, wait: w.wait },
          ...(w.timeout_ms ? { timeout_ms: w.timeout_ms } : {}),
          ...(requestId(args) ? { request_id: requestId(args)! } : {}),
          wait: w.wait,
        });
        return outcomeToEnvelope(out, (r) => ({ pan: num(r.pan) ?? pan ?? null, tilt: num(r.tilt) ?? tilt ?? null, clamped: clamped || r.clamped === true, requested }));
      },
    ),
    deviceTool(
      {
        name: "reset_pose",
        description: "Return the head to its neutral pose (pan 0, tilt 0) and, by default, the neutral face. Not a reboot.",
        inputSchema: schema({ speed: { type: "integer", minimum: 100, maximum: 1000 }, reset_face: { type: "boolean", description: "Also set the neutral expression (default true)." }, wait: waitSchema, timeout_ms: timeoutSchema }),
      },
      async (args, id, ctx) => {
        const speed = optNum(args, "speed");
        const w = motionWait(args);
        const params: Record<string, unknown> = { reset_face: optBool(args, "reset_face") ?? true, wait: w.wait };
        if (speed !== undefined) params.speed = clamp(Math.round(speed), ctx.limits.speedMin, ctx.limits.speedMax);
        return outcomeToEnvelope(
          await ctx.gateway.call(id, { tool: "reset_pose", method: DEVICE_METHODS.reset_pose, params, wait: w.wait, ...(w.timeout_ms ? { timeout_ms: w.timeout_ms } : {}), ...(requestId(args) ? { request_id: requestId(args)! } : {}) }),
          (r) => ({ pan: num(r.pan) ?? 0, tilt: num(r.tilt) ?? 0 }),
        );
      },
    ),
    deviceTool(
      {
        name: "set_expression",
        description: `Change the face expression, optionally returning to another one after duration_ms and turning the head (look_at). Expressions: ${EXPRESSIONS.join(", ")}. If the device lacks one it falls back (result.fallback).`,
        inputSchema: schema(
          {
            expression: { type: "string", enum: [...EXPRESSIONS] },
            duration_ms: { type: "integer", minimum: 0, maximum: 600000, description: "Revert after this time; omit to keep." },
            revert_to: { type: "string", enum: [...EXPRESSIONS] },
            look_at: { type: "object", properties: { pan: { type: "number" }, tilt: { type: "number" } }, additionalProperties: false },
          },
          ["expression"],
        ),
      },
      async (args, id, ctx) => {
        const expression = optEnum(args, "expression", EXPRESSIONS);
        if (!expression) throw new ArgError("expression is required");
        const duration = intIn(args, "duration_ms", 0, 600000);
        const revert = optEnum(args, "revert_to", EXPRESSIONS);
        const params: Record<string, unknown> = { expression };
        if (duration !== undefined) params.duration_ms = duration;
        if (revert) params.revert_to = revert;
        const look = args.look_at;
        if (look !== undefined && look !== null) {
          if (!isObj(look)) throw new ArgError("look_at must be an object {pan,tilt}");
          const lp = optNum(look, "pan");
          const lt = optNum(look, "tilt");
          if (lp === undefined && lt === undefined) throw new ArgError("look_at needs pan and/or tilt");
          params.look_at = {
            ...(lp !== undefined ? { pan: Math.round(clamp(lp, ctx.limits.panMin, ctx.limits.panMax)) } : {}),
            ...(lt !== undefined ? { tilt: Math.round(clamp(lt, ctx.limits.tiltMin, ctx.limits.tiltMax)) } : {}),
          };
        }
        return outcomeToEnvelope(await ctx.gateway.call(id, { tool: "set_expression", method: DEVICE_METHODS.set_expression, params, ...(requestId(args) ? { request_id: requestId(args)! } : {}) }), (r) => ({
          expression: typeof r.expression === "string" ? r.expression : expression,
          applied: true,
          ...(typeof r.fallback === "string" ? { fallback: r.fallback } : {}),
        }));
      },
    ),
    deviceTool(
      {
        name: "show_text",
        description: "Show a short text bubble on the robot's screen (max 200 characters). duration_ms 0 keeps it until clear=true. Text is shown verbatim.",
        inputSchema: schema({
          text: { type: "string", maxLength: 200 },
          duration_ms: { type: "integer", minimum: 0, maximum: 600000, description: "Default 5000; 0 = until cleared." },
          position: { type: "string", enum: [...TEXT_POSITIONS], description: "Default bubble." },
          size: { type: "string", enum: [...TEXT_SIZES] },
          clear: { type: "boolean", description: "Clear the text instead of showing (text then optional)." },
        }),
      },
      async (args, id, ctx) => {
        const clear = optBool(args, "clear") ?? false;
        const raw = optStr(args, "text", 200);
        const text = raw === undefined ? undefined : cleanText(raw);
        if (!clear && (text === undefined || text.trim() === "")) throw new ArgError("text is required unless clear=true");
        const params: Record<string, unknown> = { clear, duration_ms: intIn(args, "duration_ms", 0, 600000) ?? 5000 };
        if (!clear && text !== undefined) params.text = text;
        const position = optEnum(args, "position", TEXT_POSITIONS);
        const size = optEnum(args, "size", TEXT_SIZES);
        params.position = position ?? "bubble";
        if (size) params.size = size;
        return outcomeToEnvelope(await ctx.gateway.call(id, { tool: "show_text", method: DEVICE_METHODS.show_text, params, ...(requestId(args) ? { request_id: requestId(args)! } : {}) }), (r) => ({
          shown: r.shown !== false,
          truncated: r.truncated === true,
        }));
      },
    ),
    deviceTool(
      {
        name: "set_led",
        description: "Set the robot's LEDs. color is \"#RRGGBB\" or {r,g,b} with 0-255 per channel (the device scales to its safe range). mode: solid, breathe, blink, off. brightness 0-100 (default 40). duration_ms turns them off afterwards.",
        inputSchema: schema({
          color: { oneOf: [{ type: "string", pattern: "^#[0-9a-fA-F]{6}$" }, { type: "object", properties: { r: { type: "integer", minimum: 0, maximum: 255 }, g: { type: "integer", minimum: 0, maximum: 255 }, b: { type: "integer", minimum: 0, maximum: 255 } }, required: ["r", "g", "b"], additionalProperties: false }] },
          side: { type: "string", enum: [...LED_SIDES], description: "Default both." },
          mode: { type: "string", enum: [...LED_MODES], description: "Default solid." },
          brightness: { type: "integer", minimum: 0, maximum: 100, description: "Default 40." },
          duration_ms: { type: "integer", minimum: 0, maximum: 600000 },
        }),
      },
      async (args, id, ctx) => {
        const mode = optEnum(args, "mode", LED_MODES) ?? "solid";
        const side = optEnum(args, "side", LED_SIDES) ?? "both";
        const brightness = intIn(args, "brightness", 0, 100) ?? 40;
        const duration = intIn(args, "duration_ms", 0, 600000);
        let rgb = { r: 0, g: 0, b: 0 };
        const c = args.color;
        if (c === undefined || c === null) {
          if (mode !== "off") throw new ArgError("color is required unless mode is off");
        } else if (typeof c === "string") {
          const m = /^#([0-9a-fA-F]{2})([0-9a-fA-F]{2})([0-9a-fA-F]{2})$/.exec(c);
          if (!m) throw new ArgError('color must be "#RRGGBB" or {r,g,b}');
          rgb = { r: parseInt(m[1]!, 16), g: parseInt(m[2]!, 16), b: parseInt(m[3]!, 16) };
        } else if (isObj(c)) {
          rgb = { r: intIn(c, "r", 0, 255) ?? NaN, g: intIn(c, "g", 0, 255) ?? NaN, b: intIn(c, "b", 0, 255) ?? NaN };
          if (Object.values(rgb).some(Number.isNaN)) throw new ArgError("color needs integer r, g and b in 0..255");
        } else throw new ArgError('color must be "#RRGGBB" or {r,g,b}');
        const params: Record<string, unknown> = { ...rgb, side, mode, brightness };
        if (duration !== undefined) params.duration_ms = duration;
        return outcomeToEnvelope(await ctx.gateway.call(id, { tool: "set_led", method: DEVICE_METHODS.set_led, params, ...(requestId(args) ? { request_id: requestId(args)! } : {}) }), (r) => ({
          applied_rgb: isObj(r.applied_rgb) ? r.applied_rgb : rgb,
          clamped: r.clamped === true,
        }));
      },
    ),
    deviceTool(
      {
        name: "speak",
        description:
          "Make the robot say something out loud: the bridge synthesizes speech (cloud TTS) and streams it to the device. text is plain text, max 500 characters. interrupt=true cuts off current speech, otherwise it is queued (max 3). wait: queued (return once audio is delivered), started (default, return when playback starts), done (return when it finishes). volume is a one-off 0-100 (capped).",
        inputSchema: schema(
          {
            text: { type: "string", maxLength: 500 },
            voice: { type: "string", maxLength: 64 },
            lang: { type: "string", maxLength: 16, description: "Default zh." },
            interrupt: { type: "boolean", description: "Default false." },
            expression: { type: "string", enum: [...EXPRESSIONS], description: "Face to show while speaking." },
            volume: { type: "integer", minimum: 0, maximum: 100 },
            wait: { type: "string", enum: ["queued", "started", "done"] },
            timeout_ms: { type: "integer", minimum: 1000, maximum: 120000, description: "Default 30000." },
          },
          ["text"],
        ),
      },
      async (args, id, ctx) => {
        const raw = optStr(args, "text", 500);
        const text = raw === undefined ? "" : cleanText(raw).trim();
        if (!text) throw new ArgError("text is required");
        const expression = optEnum(args, "expression", EXPRESSIONS);
        const vol = intIn(args, "volume", 0, 100);
        const voice = optStr(args, "voice", 64);
        const lang = optStr(args, "lang", 16) ?? "zh";
        const wait = optEnum(args, "wait", ["queued", "started", "done"] as const) ?? "started";
        const timeout = intIn(args, "timeout_ms", 1000, 120000) ?? 30000;
        const volume = vol === undefined ? undefined : Math.min(vol, ctx.limits.volumeCap);
        const out = await ctx.gateway.speak(id, {
          text,
          ...(voice ? { voice } : {}),
          lang,
          interrupt: optBool(args, "interrupt") ?? false,
          ...(expression ? { expression } : {}),
          ...(volume !== undefined ? { volume } : {}),
          wait,
          timeout_ms: timeout,
          ...(requestId(args) ? { request_id: requestId(args)! } : {}),
        });
        const env = outcomeToEnvelope(out);
        if (env.ok && volume !== undefined && vol !== undefined && volume !== vol) (env.result as Record<string, unknown>).volume_clamped_to = volume;
        return env;
      },
    ),
    deviceTool(
      {
        name: "stop_audio",
        description: "Stop speech/audio playback immediately. By default also clears queued speech (clear_queue=true).",
        inputSchema: schema({ stream_id: { type: "integer", minimum: 1, maximum: 65535 }, clear_queue: { type: "boolean", description: "Default true." } }),
      },
      async (args, id, ctx) => {
        const streamId = intIn(args, "stream_id", 1, 65535);
        const params: Record<string, unknown> = { clear_queue: optBool(args, "clear_queue") ?? true };
        if (streamId !== undefined) params.stream_id = streamId;
        return outcomeToEnvelope(await ctx.gateway.call(id, { tool: "stop_audio", method: DEVICE_METHODS.stop_audio, params, ...(requestId(args) ? { request_id: requestId(args)! } : {}) }), (r) => ({
          stopped: Array.isArray(r.stopped) ? r.stopped : [],
          cleared: num(r.cleared) ?? 0,
        }));
      },
    ),
    deviceTool(
      {
        name: "set_volume",
        description: "Set the speaker volume 0-100 and/or mute. Values above the safety cap (default 70) are clamped. persist=true stores it on the device.",
        inputSchema: schema({ volume: { type: "integer", minimum: 0, maximum: 100 }, mute: { type: "boolean" }, persist: { type: "boolean", description: "Default false." } }),
      },
      async (args, id, ctx) => {
        const vol = intIn(args, "volume", 0, 100);
        const mute = optBool(args, "mute");
        if (vol === undefined && mute === undefined) throw new ArgError("give volume and/or mute");
        const volume = vol === undefined ? undefined : Math.min(vol, ctx.limits.volumeCap);
        const params: Record<string, unknown> = { persist: optBool(args, "persist") ?? false };
        if (volume !== undefined) params.volume = volume;
        if (mute !== undefined) params.mute = mute;
        return outcomeToEnvelope(await ctx.gateway.call(id, { tool: "set_volume", method: DEVICE_METHODS.set_volume, params, ...(requestId(args) ? { request_id: requestId(args)! } : {}) }), (r) => ({
          volume: num(r.volume) ?? volume ?? null,
          muted: typeof r.muted === "boolean" ? r.muted : (mute ?? false),
          clamped: volume !== undefined && volume !== vol,
          ...(volume !== vol ? { requested: vol } : {}),
        }));
      },
    ),
    deviceTool(
      {
        name: "emergency_stop",
        description: "EMERGENCY: immediately halt head motion and stop all audio on the device, and drop queued speech. Highest priority; bypasses rate limits.",
        inputSchema: schema({}, [], true),
        annotations: { destructiveHint: false, idempotentHint: true },
      },
      async (_args, id, ctx) =>
        outcomeToEnvelope(await ctx.gateway.call(id, { tool: "emergency_stop", method: DEVICE_METHODS.emergency_stop, params: {} }), (r) => ({
          motion_halted: r.motion_halted !== false,
          audio_stopped: r.audio_stopped !== false,
        })),
    ),
  ];
}

function deviceView(d: DeviceSummary) {
  return {
    device_id: d.device_id,
    online: d.online,
    last_seen: d.last_seen ? new Date(d.last_seen).toISOString() : null,
    fw_version: d.fw_version ?? null,
    hw: d.hw ?? null,
    caps: d.caps,
  };
}
