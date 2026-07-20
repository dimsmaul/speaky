// AudioWorklet processor. Sources (tab audio + mic) are connected to this node;
// their signals are summed at the node input, so inputs[0][0] is the mixed mono
// channel at the AudioContext sample rate. We batch samples to keep the
// postMessage rate low, then hand them to the main offscreen thread.
const BATCH = 4096;

class PCMWorklet extends AudioWorkletProcessor {
  constructor() {
    super();
    this._buf = new Float32Array(BATCH);
    this._n = 0;
  }

  process(inputs) {
    const ch = inputs[0]?.[0];
    if (!ch) return true; // no input connected this quantum
    for (let i = 0; i < ch.length; i++) {
      this._buf[this._n++] = ch[i];
      if (this._n === BATCH) {
        this.port.postMessage(this._buf.slice(0));
        this._n = 0;
      }
    }
    return true; // keep the processor alive
  }
}

registerProcessor('pcm-worklet', PCMWorklet);
