/**
 * Downlink flow control for one audio stream. The device buffers
 * `burstMs` of audio; beyond that the bridge sends at `speed`× real time
 * (1.2 by default, a little faster than playback so the buffer stays full).
 * If the device reports `audio.credit {buffer_ms}`, the estimated device
 * buffer is also kept <= burstMs. Pure: takes `now` explicitly.
 */
export class Pacer {
  private t0 = -1;
  private sentMs = 0;
  private credit: { bufferMs: number; at: number; sentMs: number } | null = null;
  constructor(
    private readonly bytesPerMs: number,
    private readonly burstMs: number,
    private readonly speed = 1.2,
  ) {}

  /** Milliseconds to wait before the next frame may be sent. */
  delayMs(now: number): number {
    if (this.t0 < 0) return 0;
    const base = this.t0 + Math.max(0, this.sentMs - this.burstMs) / this.speed - now;
    let extra = 0;
    if (this.credit) {
      const est = this.credit.bufferMs + (this.sentMs - this.credit.sentMs) - (now - this.credit.at);
      extra = est - this.burstMs;
    }
    return Math.max(0, Math.ceil(Math.max(base, extra)));
  }

  /** Record a sent frame. */
  sent(bytes: number, now: number): void {
    if (this.t0 < 0) this.t0 = now;
    this.sentMs += bytes / this.bytesPerMs;
  }

  /** Device-reported playback buffer (audio.credit / playback.state buffer_ms). */
  onCredit(bufferMs: number, now: number): void {
    if (Number.isFinite(bufferMs) && bufferMs >= 0) this.credit = { bufferMs, at: now, sentMs: this.sentMs };
  }

  get audioMs(): number {
    return this.sentMs;
  }
}
