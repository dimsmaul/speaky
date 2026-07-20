# Chrome Web Store — Listing Copy

Ready-to-paste text for the Developer Dashboard. Edit names/links before submitting.

---

## Summary (max 132 chars)

> Turn Google Meet captions into a timestamped transcript with speaker names. Export to JSON, TXT, or Markdown. 100% local.

Alt (shorter):

> Save Google Meet conversations as a transcript with speaker names — export JSON/TXT/Markdown. Local-only, no account.

---

## Detailed description

**Speaky turns Google Meet's live captions into a clean, timestamped transcript you can keep.**

While you're in a meeting with captions (CC) turned on, the extension reads each caption line — the speaker's name and what they said — and builds a structured transcript in real time. When the meeting ends, export it in one click.

**What it does**
- 📝 Real-time transcript with **speaker names** and timestamps
- 💾 Export to **JSON**, **TXT**, or **Markdown**
- 👀 Live preview in the popup while the meeting runs
- ⚡ Built on a Rust/WebAssembly core for fast, low-overhead transcript handling
- 🔔 Warns you if captions stop being detected mid-meeting

**Privacy first**
- **Everything stays on your device.** No servers, no accounts, no telemetry, no uploads.
- Transcripts are stored locally in your browser and only leave your machine when *you* export a file.

**How to use**
1. Open Google Meet and turn on captions (CC).
2. Click the extension icon → **Start**.
3. When you're done → **Export** (JSON / TXT / Markdown).

**Important — please read**
- This extension relies on Google Meet's built-in captions, so **captions must be turned on** for it to capture text.
- Transcribing a conversation may require the **consent of other participants** depending on your local laws. You are responsible for obtaining it.
- Google occasionally changes Meet's interface; if capture stops working, an update to the extension may be needed.

---

## Single-purpose description (required field)

> This extension has a single purpose: to capture Google Meet's on-screen captions into a downloadable transcript with speaker names, entirely on the user's device.

---

## Permission justifications

Paste these into the "Permission justification" fields.

| Permission | Justification |
|---|---|
| `activeTab` / `tabs` | To detect the active Google Meet tab and route start/stop commands to the transcript capture running there. |
| `storage` | To save the in-progress transcript locally so it survives navigation and can be exported. Data never leaves the device. |
| `host_permissions: https://meet.google.com/*` | The extension only runs on Google Meet, where it reads the on-screen caption text. |
| `tabCapture` | (Optional/experimental audio mode) Captures the meeting's tab audio locally to generate a transcript when captions are unavailable. Audio is processed on-device and never uploaded. |
| `offscreen` | (Optional/experimental audio mode) Required to run the local audio/speech processing, which a Manifest V3 service worker cannot do directly. |

> ⚠️ If you submit **without** the experimental audio path, remove `tabCapture` + `offscreen` from `manifest.json` first — Chrome review scrutinizes unused high-privilege permissions. The Phase 1 caption-only build does not need them.

---

## Category & fields

- **Category**: Productivity (or Workflow & Planning)
- **Language**: English
- **Privacy policy URL**: host `PRIVACY.md` (e.g. GitHub Pages) and paste the URL — required because the extension handles meeting content.
