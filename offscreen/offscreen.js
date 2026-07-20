import init, { AudioProcessor, SpeakerTimeline } from '../pkg/meet_transcriber.js';
import { WhisperEngine } from './whisper-adapter.js';

// 16 kHz chunk fed to Whisper per decode. 4 s keeps latency reasonable; tune
// against real decode time when the Whisper adapter is wired.
const CHUNK_SAMPLES = 16_000 * 4;

let audioCtx = null;
let workletNode = null;
let tabStream = null;
let micStream = null;

let processor = null;
const timeline = new SpeakerTimeline();
const whisper = new WhisperEngine();

let takenSamples = 0; // 16 kHz samples already consumed → audio clock (ms) = /16
let decoding = false;

const ready = (async () => {
  await init();
  await whisper.load();
})();

async function connectAudio(streamId) {
  await ready;
  await disconnectAudio(); // idempotent

  audioCtx = new AudioContext();
  processor = new AudioProcessor(audioCtx.sampleRate);
  takenSamples = 0;

  // 1. Tab audio (digital, lossless).
  tabStream = await navigator.mediaDevices.getUserMedia({
    audio: { mandatory: { chromeMediaSource: 'tab', chromeMediaSourceId: streamId } },
  });
  // 2. Local microphone.
  micStream = await navigator.mediaDevices.getUserMedia({ audio: true });

  const srcTab = audioCtx.createMediaStreamSource(tabStream);
  const srcMic = audioCtx.createMediaStreamSource(micStream);

  await audioCtx.audioWorklet.addModule(chrome.runtime.getURL('offscreen/pcm-worklet.js'));
  workletNode = new AudioWorkletNode(audioCtx, 'pcm-worklet');

  // Sum both sources into the worklet input (mixing happens here).
  srcTab.connect(workletNode);
  srcMic.connect(workletNode);

  // CRITICAL: loop tab audio back to the speakers, otherwise tabCapture
  // silences the tab and you stop hearing other participants.
  srcTab.connect(audioCtx.destination);

  workletNode.port.onmessage = (e) => onFrame(e.data);
}

async function onFrame(frame) {
  if (!processor) return;
  processor.push_samples(frame);
  if (decoding || !processor.has_chunk(CHUNK_SAMPLES)) return;

  decoding = true;
  const startMs = (takenSamples / 16); // 16 kHz → ms
  const chunk = processor.take_chunk(CHUNK_SAMPLES);
  takenSamples += chunk.length;
  const endMs = (takenSamples / 16);

  try {
    const text = (await whisper.transcribe(chunk)).trim();
    if (text) {
      const speaker = timeline.attribute(startMs, endMs) || 'Unknown Speaker';
      chrome.runtime.sendMessage({
        type: 'CAPTION_LINE',
        speaker,
        text,
        ts: new Date().toISOString(),
      });
    }
  } finally {
    decoding = false;
  }
}

async function disconnectAudio() {
  if (workletNode) {
    workletNode.port.onmessage = null;
    workletNode.disconnect();
    workletNode = null;
  }
  for (const s of [tabStream, micStream]) {
    s?.getTracks().forEach((t) => t.stop());
  }
  tabStream = micStream = null;
  if (audioCtx) {
    await audioCtx.close().catch(() => {});
    audioCtx = null;
  }
  processor = null;
  timeline.reset();
}

chrome.runtime.onMessage.addListener((message) => {
  if (message.type === 'CONNECT_AUDIO') {
    connectAudio(message.streamId);
  } else if (message.type === 'DISCONNECT_AUDIO') {
    disconnectAudio();
  } else if (message.type === 'SPEAKER_CHANGED') {
    // Stamp against the audio clock for best-effort attribution.
    const tMs = audioCtx ? audioCtx.currentTime * 1000 : 0;
    timeline.mark(message.name, tMs);
  }
});
