import init, { TranscriberManager } from '../pkg/meet_transcriber.js';

let manager;

// Init WASM + hydrate state from storage (MV3 idle-kill recovery, FEASIBILITY N5).
const ready = (async () => {
  await init();
  manager = new TranscriberManager();
  const { live_transcript } = await chrome.storage.local.get('live_transcript');
  if (live_transcript) manager.load_from_json(live_transcript);
})();

// Live-session health, reflected on the toolbar badge. Note: this state is
// in-memory and resets on an MV3 idle-kill; the badge itself persists.
let health = 'idle'; // 'idle' | 'waiting' | 'ok' | 'stale'

function setHealth(state) {
  health = state;
  if (state === 'stale') {
    chrome.action.setBadgeText({ text: '!' });
    chrome.action.setBadgeBackgroundColor({ color: '#d93025' });
  } else {
    chrome.action.setBadgeText({ text: '' });
  }
}

async function getMeetTab() {
  const [tab] = await chrome.tabs.query({
    active: true,
    currentWindow: true,
    url: 'https://meet.google.com/*',
  });
  return tab;
}

// --- Phase 3 (optional): audio pipeline via an offscreen document ---

async function ensureOffscreen() {
  if (await chrome.offscreen.hasDocument()) return;
  await chrome.offscreen.createDocument({
    url: 'offscreen/offscreen.html',
    reasons: ['USER_MEDIA'],
    justification: 'Mix Meet tab audio + microphone and run local STT for transcription.',
  });
}

async function startAudioPipeline() {
  const tab = await getMeetTab();
  if (!tab) return { ok: false, error: 'no_meet_tab' };
  await ensureOffscreen();
  // Must target the Meet tab explicitly — a popup message has no sender.tab.
  const streamId = await chrome.tabCapture.getMediaStreamId({ targetTabId: tab.id });
  chrome.runtime.sendMessage({ type: 'CONNECT_AUDIO', streamId });
  return { ok: true };
}

async function stopAudioPipeline() {
  chrome.runtime.sendMessage({ type: 'DISCONNECT_AUDIO' });
  if (await chrome.offscreen.hasDocument()) await chrome.offscreen.closeDocument();
  return { ok: true };
}

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  (async () => {
    await ready;

    switch (message.type) {
      case 'START_TRANSCRIPTION':
      case 'STOP_TRANSCRIPTION': {
        const tab = await getMeetTab();
        if (tab) {
          try {
            await chrome.tabs.sendMessage(tab.id, { type: message.type });
          } catch {
            // Content script not injected yet (tab opened before the extension loaded).
            sendResponse({ ok: false, error: 'content_script_not_ready' });
            return;
          }
        }
        setHealth(message.type === 'START_TRANSCRIPTION' && tab ? 'waiting' : 'idle');
        sendResponse({ ok: !!tab, error: tab ? undefined : 'no_meet_tab' });
        break;
      }

      case 'CAPTION_LINE': {
        manager.add_line(message.ts, message.speaker, message.text);
        await chrome.storage.local.set({ live_transcript: manager.get_all_json() });
        if (health !== 'ok') setHealth('ok');
        break;
      }

      case 'HEALTH': {
        setHealth(message.state); // 'stale' | 'ok' from the content script
        break;
      }

      case 'START_AUDIO': {
        const res = await startAudioPipeline();
        if (res.ok) setHealth('waiting');
        sendResponse(res);
        break;
      }

      case 'STOP_AUDIO': {
        sendResponse(await stopAudioPipeline());
        break;
      }

      case 'SPEAKER_CHANGED': {
        manager.set_speaker(message.name);
        break;
      }

      case 'EXPORT': {
        sendResponse({ json: manager.get_all_json(), count: manager.len() });
        break;
      }

      case 'STATUS': {
        sendResponse({ count: manager.len(), health });
        break;
      }

      case 'RESET': {
        manager.reset();
        await chrome.storage.local.remove('live_transcript');
        setHealth('idle');
        sendResponse({ ok: true });
        break;
      }
    }
  })();
  return true; // keep the channel open for async sendResponse
});
