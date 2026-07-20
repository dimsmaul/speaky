// Whisper adapter — the local STT seam for the Phase 3 audio path.
//
// ⚠️ STATUS: NOT WIRED. This is an honest integration seam, not a working
// transcriber. The audio pipeline (capture → mix → resample → 16 kHz chunks)
// is complete and testable, but actual speech-to-text needs a Whisper model
// (~40–150 MB) and browser-side benchmarking that cannot be done offline here.
// Until wired, `transcribe()` returns '' so the pipeline runs end-to-end
// without producing text.
//
// TO WIRE (see FEASIBILITY N1-B / R4):
//   1. Pick a whisper.cpp WASM build (e.g. the `whisper.wasm` from
//      ggml-org/whisper.cpp, or a wrapper like `@xenova/transformers` Whisper).
//   2. In load(): fetch the wasm + a ggml model (tiny/base) from a CDN on first
//      use, cache the weights in OPFS (navigator.storage.getDirectory) so it
//      downloads once. Report progress to the popup.
//   3. In transcribe(): feed the Float32Array (16 kHz mono) to the model and
//      return the recognized text. Whisper prefers ~30 s windows; tune CHUNK
//      in offscreen.js against measured decode time (fall back to the caption
//      path if decode is slower than realtime).

export class WhisperEngine {
  constructor() {
    this.ready = false;
    this._warned = false;
  }

  /**
   * Lazy-load the model. Returns true when ready to transcribe.
   * Currently a no-op stub — see the wiring notes above.
   */
  async load(/* { model = 'tiny', onProgress } = {} */) {
    this.ready = false;
    return this.ready;
  }

  /**
   * @param {Float32Array} _samples16k mono PCM at 16 kHz
   * @returns {Promise<string>} recognized text ('' until wired)
   */
  async transcribe(_samples16k) {
    if (!this.ready) {
      if (!this._warned) {
        console.warn(
          '[whisper-adapter] STT not wired — audio pipeline runs but yields no text. See whisper-adapter.js.',
        );
        this._warned = true;
      }
      return '';
    }
    // Wired implementation returns model output here.
    return '';
  }
}
