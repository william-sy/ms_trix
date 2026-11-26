// DeepFilterNet 3 on the audio thread (noiseSuppression.ts "high"): the microphone arrives in
// blocks of 128 samples, goes through the model in frames of 480 (10 ms at 48 kHz) and comes out
// one frame later. Plain JavaScript without imports: it's loaded as is with addModule. The
// WebAssembly (models/deepfilternet3.wasm, built from denoise/) needs nothing from JavaScript.

const RING = 4096;

class DeepFilterProcessor extends AudioWorkletProcessor {
  constructor(options) {
    super();
    const { wasmBinary, attenLim } = options.processorOptions;
    this.frame = null;
    try {
      const x = new WebAssembly.Instance(new WebAssembly.Module(wasmBinary), {}).exports;
      const st = x.dn_create(attenLim);
      if (!st) throw new Error("the model didn't load");
      this.x = x;
      this.st = st;
      this.n = x.dn_frame_length(st);
      this.frame = new Float32Array(this.n);
      this.fill = 0;
      // What comes out lags one frame: that much silence is queued up front.
      this.ring = new Float32Array(RING);
      this.r = 0;
      this.w = this.n;
    } catch (e) {
      this.port.postMessage({ error: String(e) });
    }
    this.port.onmessage = (e) => {
      if (e.data === "free" && this.st) { this.x.dn_free(this.st); this.st = 0; }
    };
  }

  process(inputs, outputs) {
    const input = inputs[0] && inputs[0][0];
    const output = outputs[0] && outputs[0][0];
    if (!output) return true;
    if (!input) { output.fill(0); return true; }
    // Not running (failed or freed): the microphone as it is.
    if (!this.st) { output.set(input); return true; }
    for (let i = 0; i < input.length; i++) {
      this.frame[this.fill++] = input[i];
      if (this.fill === this.n) { this.run(); this.fill = 0; }
    }
    for (let i = 0; i < output.length; i++) {
      output[i] = this.ring[this.r];
      this.r = (this.r + 1) % RING;
    }
    return true;
  }

  run() {
    const x = this.x;
    let out = this.frame;
    try {
      // Views made per frame: the module's memory may have grown (and moved) since the last.
      new Float32Array(x.memory.buffer, x.dn_input(this.st), this.n).set(this.frame);
      x.dn_process(this.st);
      out = new Float32Array(x.memory.buffer, x.dn_output(this.st), this.n);
    } catch (e) {
      // A crash in the model leaves it unusable: from here on the plain microphone.
      this.st = 0;
      this.port.postMessage({ error: String(e) });
    }
    for (let i = 0; i < this.n; i++) {
      this.ring[this.w] = out[i];
      this.w = (this.w + 1) % RING;
    }
  }
}

registerProcessor("trix-deepfilter", DeepFilterProcessor);
