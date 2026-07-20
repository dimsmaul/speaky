use wasm_bindgen::prelude::*;
use serde::{Serialize, Deserialize};

#[derive(Serialize, Deserialize, Clone, Debug)]
pub struct ConversationLine {
    pub timestamp: String,
    pub speaker: String,
    pub text: String,
}

#[wasm_bindgen]
pub struct TranscriberManager {
    history: Vec<ConversationLine>,
    active_speaker: String,
}

#[wasm_bindgen]
impl TranscriberManager {
    #[wasm_bindgen(constructor)]
    pub fn new() -> TranscriberManager {
        TranscriberManager {
            history: Vec::new(),
            active_speaker: "Unknown Speaker".to_string(),
        }
    }

    pub fn set_speaker(&mut self, name: String) {
        if !name.trim().is_empty() {
            self.active_speaker = name;
        }
    }

    /// Add a line. If the speaker matches the last line and the new text is an
    /// extension of the old text (a partial caption update), the last line is
    /// replaced rather than appended — preventing duplicates.
    pub fn add_line(&mut self, timestamp: String, speaker: String, text: String) -> JsValue {
        let speaker = if speaker.trim().is_empty() {
            self.active_speaker.clone()
        } else {
            self.active_speaker = speaker.clone();
            speaker
        };

        let line = ConversationLine { timestamp, speaker, text };

        let replace_last = matches!(
            self.history.last(),
            Some(last) if last.speaker == line.speaker
                && (line.text.starts_with(&last.text) || last.text.starts_with(&line.text))
        );
        if replace_last {
            *self.history.last_mut().unwrap() = line.clone();
        } else {
            self.history.push(line.clone());
        }

        serde_wasm_bindgen::to_value(&line).unwrap_or(JsValue::NULL)
    }

    /// Rebuild history from JSON — used by the service worker to hydrate
    /// after an MV3 idle-kill (see PRD §5.5, FEASIBILITY N5).
    pub fn load_from_json(&mut self, json: String) {
        if let Ok(lines) = serde_json::from_str::<Vec<ConversationLine>>(&json) {
            self.history = lines;
        }
    }

    pub fn get_all_json(&self) -> String {
        serde_json::to_string_pretty(&self.history).unwrap_or_else(|_| "[]".to_string())
    }

    pub fn len(&self) -> usize {
        self.history.len()
    }

    pub fn reset(&mut self) {
        self.history.clear();
        self.active_speaker = "Unknown Speaker".to_string();
    }
}

// ============================================================================
// Phase 3 — audio pipeline preprocessing (real CPU work, hence Rust/WASM).
// The mixed audio (tab + mic) arrives from an AudioWorklet at the AudioContext
// sample rate (typically 48 kHz, mono). Whisper wants 16 kHz mono f32. This
// module resamples and accumulates samples into fixed-size chunks.
// ============================================================================

const TARGET_RATE: usize = 16_000;

#[wasm_bindgen]
pub struct AudioProcessor {
    input_rate: usize,
    ratio: f64, // input_rate / TARGET_RATE
    pos: f64,   // fractional read position into the running input buffer
    tail: Vec<f32>, // input samples not yet consumed by resampling
    out: Vec<f32>,  // accumulated 16 kHz samples awaiting a chunk
}

#[wasm_bindgen]
impl AudioProcessor {
    #[wasm_bindgen(constructor)]
    pub fn new(input_rate: usize) -> AudioProcessor {
        let rate = if input_rate == 0 { 48_000 } else { input_rate };
        AudioProcessor {
            input_rate: rate,
            ratio: rate as f64 / TARGET_RATE as f64,
            pos: 0.0,
            tail: Vec::new(),
            out: Vec::new(),
        }
    }

    /// Feed a frame of input samples (context-rate, mono). Linearly resamples
    /// to 16 kHz and appends to the output accumulator.
    pub fn push_samples(&mut self, frame: &[f32]) {
        self.tail.extend_from_slice(frame);
        // Consume as many resampled output samples as the buffer allows,
        // leaving a small tail for the next call to interpolate across.
        let last_index = self.tail.len() as f64 - 1.0;
        while self.pos + 1.0 <= last_index {
            let i = self.pos.floor() as usize;
            let frac = (self.pos - i as f64) as f32;
            let s = self.tail[i] * (1.0 - frac) + self.tail[i + 1] * frac;
            self.out.push(s);
            self.pos += self.ratio;
        }
        // Drop fully-consumed input, keep the remainder; rebase pos.
        let consumed = self.pos.floor() as usize;
        if consumed > 0 && consumed <= self.tail.len() {
            self.tail.drain(0..consumed);
            self.pos -= consumed as f64;
        }
    }

    pub fn has_chunk(&self, min_samples: usize) -> bool {
        self.out.len() >= min_samples
    }

    /// Detach up to `n` accumulated 16 kHz samples for Whisper.
    pub fn take_chunk(&mut self, n: usize) -> Vec<f32> {
        let take = n.min(self.out.len());
        self.out.drain(0..take).collect()
    }

    pub fn input_rate(&self) -> usize {
        self.input_rate
    }
}

// ---------------------------------------------------------------------------
// Speaker attribution by time window (FEASIBILITY N4-B). STT text arrives
// 1–3 s after the utterance, so "current speaker" is wrong. We keep a timeline
// of speaker-change events and, given the audio window a transcript covers,
// return the speaker dominant during that window.
// ---------------------------------------------------------------------------

struct SpeakerEvent {
    name: String,
    t_ms: f64,
}

#[wasm_bindgen]
pub struct SpeakerTimeline {
    events: Vec<SpeakerEvent>,
}

#[wasm_bindgen]
impl SpeakerTimeline {
    #[wasm_bindgen(constructor)]
    pub fn new() -> SpeakerTimeline {
        SpeakerTimeline { events: Vec::new() }
    }

    /// Record that `name` became the active speaker at `t_ms`.
    pub fn mark(&mut self, name: String, t_ms: f64) {
        if name.trim().is_empty() {
            return;
        }
        if let Some(last) = self.events.last() {
            if last.name == name {
                return; // no change
            }
        }
        self.events.push(SpeakerEvent { name, t_ms });
    }

    /// Speaker dominant over [start_ms, end_ms]: the one holding the floor for
    /// the largest slice of that window. Empty string if the timeline is empty.
    pub fn attribute(&self, start_ms: f64, end_ms: f64) -> String {
        if self.events.is_empty() {
            return String::new();
        }
        let (start, end) = if start_ms <= end_ms {
            (start_ms, end_ms)
        } else {
            (end_ms, start_ms)
        };

        let mut best_name = String::new();
        let mut best_dur = -1.0_f64;

        for (idx, ev) in self.events.iter().enumerate() {
            let seg_start = ev.t_ms;
            let seg_end = self
                .events
                .get(idx + 1)
                .map(|n| n.t_ms)
                .unwrap_or(f64::INFINITY);
            let overlap = seg_end.min(end) - seg_start.max(start);
            if overlap > best_dur {
                best_dur = overlap;
                best_name = ev.name.clone();
            }
        }

        // If the window predates all events, fall back to the earliest speaker.
        if best_dur <= 0.0 {
            return self.events[0].name.clone();
        }
        best_name
    }

    pub fn reset(&mut self) {
        self.events.clear();
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn resampler_halves_rate_roughly() {
        // 32 kHz → 16 kHz should output ~half the samples.
        let mut p = AudioProcessor::new(32_000);
        let frame: Vec<f32> = (0..3200).map(|i| (i as f32).sin()).collect();
        p.push_samples(&frame);
        let out = p.take_chunk(100_000);
        // ratio = 2.0 → ~1600 out for 3200 in (±a few for tail handling).
        assert!(
            (out.len() as i32 - 1600).abs() < 10,
            "got {} samples",
            out.len()
        );
    }

    #[test]
    fn chunker_thresholds() {
        let mut p = AudioProcessor::new(16_000); // ratio 1.0, passthrough
        p.push_samples(&vec![0.5; 500]);
        assert!(!p.has_chunk(1000));
        p.push_samples(&vec![0.5; 600]);
        assert!(p.has_chunk(1000));
        let c = p.take_chunk(1000);
        assert_eq!(c.len(), 1000);
    }

    #[test]
    fn timeline_dominant_speaker() {
        let mut t = SpeakerTimeline::new();
        t.mark("Alice".into(), 0.0);
        t.mark("Bob".into(), 1000.0);
        t.mark("Alice".into(), 1200.0);
        // Window 0..1000 → Alice held 0..1000 (1000ms) vs Bob 0 → Alice.
        assert_eq!(t.attribute(0.0, 1000.0), "Alice");
        // Window 1000..1150 → Bob holds 1000..1150.
        assert_eq!(t.attribute(1000.0, 1150.0), "Bob");
        // Window before any event → earliest speaker.
        assert_eq!(t.attribute(-500.0, -100.0), "Alice");
    }

    #[test]
    fn timeline_empty_is_blank() {
        let t = SpeakerTimeline::new();
        assert_eq!(t.attribute(0.0, 100.0), "");
    }
}
