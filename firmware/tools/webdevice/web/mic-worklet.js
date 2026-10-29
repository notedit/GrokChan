// AudioWorklet: mono mic -> 16 kHz s16le (box-filter downsample from the context rate), posted in ~20 ms blocks.
class GcMic16k extends AudioWorkletProcessor {
  constructor() {
    super();
    this.ratio = sampleRate / 16000;
    this.acc = 0; this.n = 0; this.pos = 0;
    this.out = new Int16Array(320); this.o = 0;
  }
  process(inputs) {
    const ch = inputs[0] && inputs[0][0];
    if (!ch) return true;
    for (let i = 0; i < ch.length; i++) {
      this.acc += ch[i]; this.n++; this.pos += 1;
      if (this.pos >= this.ratio) {
        this.pos -= this.ratio;
        const v = Math.max(-1, Math.min(1, this.acc / this.n));
        this.out[this.o++] = v < 0 ? v * 32768 : v * 32767;
        this.acc = 0; this.n = 0;
        if (this.o === this.out.length) { const b = this.out.slice(); this.port.postMessage(b.buffer, [b.buffer]); this.o = 0; }
      }
    }
    return true;
  }
}
registerProcessor('gc-mic-16k', GcMic16k);
