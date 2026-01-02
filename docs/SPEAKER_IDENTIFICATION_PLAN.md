# Speaker Identification for Meetings - Feature Plan (v3.1)

## Executive Summary

This document outlines a **phased implementation plan** for reliable speaker identification in Meetwings's Meeting Assist Mode. The approach prioritizes **shipping value incrementally** while building toward the full solution.

**Core Strategy:**
1. **Phase 1:** Microphone audio = "You" (immediate value, zero risk)
2. **Phase 2:** Integrate system audio, label as "Guest" (separate audio sources)
3. **Phase 3:** Batch diarization to distinguish multiple guests (retroactive labels)
4. **Phase 4:** Code cleanup (only after everything works)

**Key Principle:** Each phase delivers working functionality. No phase depends on future phases to be useful.

---

## Review Notes (v3.1)

### Issues Identified and Fixed

| # | Issue | Severity | Fix |
|---|-------|----------|-----|
| 1 | `addMeetingTranscriptEntry` doesn't exist | Critical | Use `addMeetingTranscriptEntries([entry])` |
| 2 | Timestamp generation conflict | Medium | Let hook generate timestamp, return it |
| 3 | Translation missing in Phase 1 code | Medium | Added translation integration |
| 4 | useMeetingAudio cleanup race condition | High | Added cleanup guard |
| 5 | Speech segments dropped under load | Medium | Use queue instead of lock |
| 6 | O(n log n) sort on every insert | Low | Just append (timestamps are monotonic) |
| 7 | No translation for system audio | High | Added translation callback |
| 8 | NodeJS.Timeout browser incompatibility | Medium | Use `ReturnType<typeof setTimeout>` |
| 9 | AudioContext memory leak | High | Reuse single context |
| 10 | Cross-batch speaker mapping broken | High | Clear mapping per batch, add batch ID |
| 11 | 3s timestamp window too wide | Medium | Reduced to 1.5s |
| 12 | Text similarity threshold arbitrary | Low | Added fallback matching |
| 13 | Duplicate type definitions | Low | Noted for consolidation |
| 14 | Wrong year in document history | Low | Fixed to 2025 |
| 15 | Missing error feedback in useMeetingAudio | Medium | Added error callback |
| 16 | Missing full prop chain in Audio.tsx | Medium | Added complete changes |
| 17 | Missing audioSource/confirmed fields | Critical | Confirmed required |

---

## Table of Contents

1. [Problem Statement](#problem-statement)
2. [Research Findings](#research-findings)
3. [Solution Overview](#solution-overview)
4. [Technical Architecture](#technical-architecture)
5. [Implementation Phases](#implementation-phases)
6. [Detailed Phase Specifications](#detailed-phase-specifications)
7. [Known Limitations & Mitigations](#known-limitations--mitigations)
8. [Code Refactoring Plan](#code-refactoring-plan)
9. [Testing Checklist](#testing-checklist)
10. [Future Enhancements](#future-enhancements)

---

## Problem Statement

### Current Behavior
When using Meeting Assist Mode, all transcript entries are labeled as "YOU" regardless of who is actually speaking. This makes meeting transcripts confusing and unusable for distinguishing speakers.

### Root Cause Analysis

```
Current Flow (Broken):
┌─────────────┐     ┌─────────────┐     ┌─────────────┐
│ You speak   │ ──► │ VAD sends   │ ──► │ AssemblyAI  │ ──► "Speaker A"
│ (5 seconds) │     │ Request #1  │     │ (isolated)  │
└─────────────┘     └─────────────┘     └─────────────┘

┌─────────────┐     ┌─────────────┐     ┌─────────────┐
│ Guest speaks│ ──► │ VAD sends   │ ──► │ AssemblyAI  │ ──► "Speaker A"
│ (5 seconds) │     │ Request #2  │     │ (isolated)  │
└─────────────┘     └─────────────┘     └─────────────┘
```

**Problem:** Each VAD segment is sent as a separate API request. AssemblyAI assigns speaker labels (A, B, C) within each request. Since each request typically contains only one speaker, everyone gets labeled "Speaker A".

### Critical Discovery: Missing System Audio Integration

**Current codebase architecture:**
- `AutoSpeechVad.tsx` uses `useMicVAD` (JavaScript) for **microphone only**
- `useSystemAudio.ts` captures system audio via **Rust backend** (separate feature)
- These are **completely separate** and not integrated in Meeting Assist Mode

**This means:** The original plan assumed we could differentiate mic vs system audio, but Meeting Assist Mode currently only captures microphone audio.

---

## Research Findings

### AssemblyAI API Capabilities

| API Type | Latency | Diarization Support |
|----------|---------|---------------------|
| **Batch/Async API** | ~2-4 seconds | ✅ Yes |
| **Real-time Streaming API** | <1 second | ❌ No |

**Conclusion:** We must use the Batch API for diarization. The ~2-4 second latency for text is acceptable.

### Voice Embedding Solutions (Rejected)

| Solution | Cost | Accuracy | Verdict |
|----------|------|----------|---------|
| Picovoice Eagle | $6,000/year | ~95% | Too expensive |
| TensorFlow.js | Free | N/A | No speaker model exists |
| Simple Pitch Clustering | Free | ~60-70% | Too unreliable |

**Conclusion:** Voice embeddings are not worth the cost/complexity. Audio source separation is simpler and more reliable.

### Key Insight: Audio Source = Identity

For **remote meetings** (video calls, watching streams):
- **Microphone audio** = User's voice (close-mic'd, clear)
- **System audio** = Other participants (from meeting apps, videos)

This provides **100% reliable** speaker identification for the user with **zero cost** and **zero additional latency**.

---

## Solution Overview

### Phased Approach

```
┌─────────────────────────────────────────────────────────────┐
│                    PHASED ROLLOUT                           │
├─────────────────────────────────────────────────────────────┤
│                                                             │
│  PHASE 1: Microphone = "You"                               │
│  ─────────────────────────────                             │
│  • Simplest possible change                                │
│  • 100% accurate for user's voice                          │
│  • Ships in 1-2 days                                       │
│  • VALUE: User's speech correctly labeled                  │
│                                                             │
│  PHASE 2: System Audio = "Guest"                           │
│  ───────────────────────────────                           │
│  • Integrate Rust system audio into Meeting Assist         │
│  • Others' speech labeled "Guest"                          │
│  • Ships in 3-5 days                                       │
│  • VALUE: Can distinguish self from others                 │
│                                                             │
│  PHASE 3: Batch Diarization                                │
│  ──────────────────────────                                │
│  • Buffer system audio, diarize every 30s                  │
│  • "Guest" → "Speaker 1", "Speaker 2"                      │
│  • Ships in 3-5 days                                       │
│  • VALUE: Can distinguish multiple guests                  │
│                                                             │
│  PHASE 4: Code Cleanup                                     │
│  ─────────────────────                                     │
│  • Remove unused voice enrollment code                     │
│  • Simplify speaker profiles                               │
│  • Only after Phases 1-3 work                              │
│                                                             │
└─────────────────────────────────────────────────────────────┘
```

### What Each Phase Delivers

| Phase | User Sees | Accuracy | Latency |
|-------|-----------|----------|---------|
| **Phase 1** | "You: Hello" | 100% for user | ~2-3s |
| **Phase 2** | "You: Hello" + "Guest: Hi there" | 100% for you vs others | ~2-3s |
| **Phase 3** | "You: Hello" + "Speaker 1: Hi" + "Speaker 2: Morning" | Distinguishes multiple guests | ~2-3s text, ~30s labels |

---

## Technical Architecture

### Phase 1 Architecture (Microphone Only)

```
┌─────────────────────────────────────────────────────────────┐
│                  PHASE 1: MICROPHONE PATH                   │
└─────────────────────────────────────────────────────────────┘
                              │
                              ▼
                    ┌───────────────────┐
                    │    MICROPHONE     │
                    │  (User's Voice)   │
                    └─────────┬─────────┘
                              │
                              ▼
                    ┌───────────────────┐
                    │   useMicVAD       │
                    │  (JavaScript)     │
                    └─────────┬─────────┘
                              │
                              ▼
                    ┌───────────────────┐
                    │   fetchSTT()      │
                    │ (No Diarization)  │
                    └─────────┬─────────┘
                              │
                              ▼
                    ┌───────────────────┐
                    │  Label: "You"     │
                    │  audioSource: mic │
                    └─────────┬─────────┘
                              │
                              ▼
                    ┌───────────────────┐
                    │ Meeting Transcript│
                    └───────────────────┘
```

### Phase 2 Architecture (Microphone + System Audio)

```
┌─────────────────────────────────────────────────────────────┐
│           PHASE 2: DUAL AUDIO SOURCE                        │
└─────────────────────────────────────────────────────────────┘
                              │
          ┌───────────────────┴───────────────────┐
          │                                       │
          ▼                                       ▼
┌───────────────────┐                   ┌───────────────────┐
│    MICROPHONE     │                   │   SYSTEM AUDIO    │
│  (User's Voice)   │                   │ (Others' Voices)  │
└─────────┬─────────┘                   └─────────┬─────────┘
          │                                       │
          ▼                                       ▼
┌───────────────────┐                   ┌───────────────────┐
│   useMicVAD       │                   │   Rust VAD        │
│  (JavaScript)     │                   │ (Tauri Backend)   │
└─────────┬─────────┘                   └─────────┬─────────┘
          │                                       │
          ▼                                       ▼
┌───────────────────┐                   ┌───────────────────┐
│   fetchSTT()      │                   │   fetchSTT()      │
└─────────┬─────────┘                   └─────────┬─────────┘
          │                                       │
          ▼                                       ▼
┌───────────────────┐                   ┌───────────────────┐
│  Label: "You"     │                   │  Label: "Guest"   │
│  audioSource: mic │                   │  audioSource: sys │
└─────────┬─────────┘                   └─────────┬─────────┘
          │                                       │
          └───────────────────┬───────────────────┘
                              │
                              ▼
                    ┌───────────────────┐
                    │ Meeting Transcript│
                    │ (Merged Timeline) │
                    └───────────────────┘
```

### Phase 3 Architecture (With Diarization)

```
┌─────────────────────────────────────────────────────────────┐
│           PHASE 3: FULL ARCHITECTURE                        │
└─────────────────────────────────────────────────────────────┘

     MICROPHONE PATH                    SYSTEM AUDIO PATH
     ───────────────                    ─────────────────
          │                                    │
          ▼                                    ▼
   ┌─────────────┐                      ┌─────────────┐
   │  useMicVAD  │                      │  Rust VAD   │
   └──────┬──────┘                      └──────┬──────┘
          │                                    │
          ▼                                    ├────────────────┐
   ┌─────────────┐                             │                │
   │ fetchSTT()  │                             ▼                ▼
   └──────┬──────┘                      ┌─────────────┐  ┌─────────────┐
          │                             │ fetchSTT()  │  │ Audio Buffer│
          ▼                             │ (immediate) │  │ (accumulate)│
   ┌─────────────┐                      └──────┬──────┘  └──────┬──────┘
   │ Label "You" │                             │                │
   │ confirmed:  │                             ▼                │
   │   true      │                      ┌─────────────┐         │
   └──────┬──────┘                      │Label "Guest"│         │
          │                             │ confirmed:  │         │
          │                             │   false     │         │
          │                             └──────┬──────┘         │
          │                                    │                │
          │                                    │     Every 30 seconds
          │                                    │                │
          │                                    │                ▼
          │                                    │         ┌─────────────┐
          │                                    │         │ Diarization │
          │                                    │         │   Batch     │
          │                                    │         └──────┬──────┘
          │                                    │                │
          │                                    │                ▼
          │                                    │         ┌─────────────┐
          │                                    │         │   Match &   │
          │                                    │◄────────│   Update    │
          │                                    │         │   Labels    │
          │                                    │         └─────────────┘
          │                                    │
          └────────────────┬───────────────────┘
                           │
                           ▼
                 ┌───────────────────┐
                 │ Meeting Transcript│
                 │   You: "Hello"    │
                 │   Speaker 1: "Hi" │
                 │   Speaker 2: "Hey"│
                 └───────────────────┘
```

---

## Implementation Phases

### Phase 1: Microphone "You" Labeling

**Goal:** All microphone audio in Meeting Assist Mode is labeled "You"

**Scope:**
- Minimal changes to existing code
- No new features, just correct labeling
- Does not affect non-Meeting Assist Mode behavior

**Files to Modify:**

| File | Change |
|------|--------|
| `src/types/completion.ts` | Extend `SpeakerInfo` with `confirmed` and `TranscriptEntry` with `audioSource` |
| `src/pages/app/components/completion/AutoSpeechVad.tsx` | Set `audioSource: 'microphone'` and speaker label "You" |
| `src/hooks/useCompletion.ts` | Modify `addMeetingTranscript` to accept optional speaker info |

**Type Changes:**

```typescript
// src/types/completion.ts

// EXTEND existing SpeakerInfo (don't break it - all new fields optional)
export interface SpeakerInfo {
  speakerId: string;           // Keep: "A", "B", "C" from AssemblyAI or "you"/"guest"
  speakerLabel?: string;       // Keep: "You", "Guest", "Speaker 1"
  speakerProfileId?: string;   // Keep: Reference to profile
  confidence?: number;         // Keep: 0-1 match confidence
  needsConfirmation?: boolean; // Keep
  confirmed?: boolean;         // NEW: true if label is finalized (not pending diarization)
}

// EXTEND existing TranscriptEntry (don't break it - all new fields optional)
export interface TranscriptEntry {
  original: string;
  translation?: string;
  translationError?: string;
  timestamp: number;
  speaker?: SpeakerInfo;
  audioChunkId?: string;
  audioSource?: 'microphone' | 'system'; // NEW: Where audio came from
}
```

**useCompletion.ts Changes:**

```typescript
// Option A: Modify addMeetingTranscript to accept optional speaker info
const addMeetingTranscript = useCallback((
  transcript: string,
  speakerInfo?: SpeakerInfo,
  audioSource?: 'microphone' | 'system'
): number => {
  const timestamp = Date.now();
  if (!transcript.trim()) return timestamp;

  const entry: TranscriptEntry = {
    original: transcript,
    timestamp,
    speaker: speakerInfo,
    audioSource,
  };
  setMeetingTranscript((prev) => [...prev, entry]);

  // ... rest of existing code (conversation history, etc.)
  return timestamp;
}, []);
```

**AutoSpeechVad.tsx Changes:**

```typescript
// In onSpeechEnd handler, when in meetingAssistMode:
if (meetingAssistMode && addMeetingTranscript) {
  // Create speaker info for microphone audio (always "You")
  const speakerInfo: SpeakerInfo = {
    speakerId: 'you',
    speakerLabel: 'You',
    confirmed: true, // Microphone = always confirmed as user
  };

  // Add transcript with speaker info
  const timestamp = addMeetingTranscript(transcription, speakerInfo, 'microphone');

  // Handle translation (existing code - unchanged)
  if (translationEnabled && updateTranscriptTranslation) {
    translate(transcription).then((result) => {
      if (result.success && result.translation) {
        updateTranscriptTranslation(timestamp, result.translation);
      } else if (result.error) {
        updateTranscriptTranslation(timestamp, undefined, result.error);
      }
    });
  }
}
```

**Alternative Approach (Option B):** Use existing `addMeetingTranscriptEntries` with single-item array:

```typescript
if (meetingAssistMode && addMeetingTranscriptEntries) {
  const timestamp = Date.now();
  const entry: TranscriptEntry = {
    original: transcription,
    timestamp,
    audioSource: 'microphone',
    speaker: {
      speakerId: 'you',
      speakerLabel: 'You',
      confirmed: true,
    },
  };
  addMeetingTranscriptEntries([entry]);

  // Handle translation
  if (translationEnabled && updateTranscriptTranslation) {
    translate(transcription).then((result) => {
      if (result.success && result.translation) {
        updateTranscriptTranslation(timestamp, result.translation);
      } else if (result.error) {
        updateTranscriptTranslation(timestamp, undefined, result.error);
      }
    });
  }
}
```

**Recommended:** Option A (modify existing function) is cleaner and maintains backward compatibility.

**Outcome:** User's speech correctly labeled "You". No other speakers handled yet.

**Testing:**
- [ ] Enable Meeting Assist Mode
- [ ] Speak into microphone
- [ ] Verify transcript shows "You: [text]" with speaker label
- [ ] Verify non-Meeting Assist Mode still works normally (no speaker info)
- [ ] Verify translation still works with new entry format
- [ ] Verify existing conversations without speaker info still load correctly

---

### Phase 2: System Audio Integration

**Goal:** Capture system audio in Meeting Assist Mode, label as "Guest"

**Scope:**
- Add system audio capture to Meeting Assist Mode
- Run both mic VAD and system audio VAD simultaneously
- Merge results into single transcript timeline

**New Files:**

| File | Purpose |
|------|---------|
| `src/hooks/useMeetingAudio.ts` | Combines mic + system audio for Meeting Assist |

**Files to Modify:**

| File | Change |
|------|--------|
| `src/hooks/useCompletion.ts` | Add system audio event listener |
| `src/pages/app/components/completion/Audio.tsx` | Start/stop system audio with Meeting Assist |
| `src/pages/app/components/completion/MeetingAssistToggle.tsx` | Trigger system audio capture |

**System Audio Integration Approach:**

```typescript
// src/hooks/useMeetingAudio.ts (NEW FILE)

import { useEffect, useCallback, useRef } from 'react';
import { listen } from '@tauri-apps/api/event';
import { invoke } from '@tauri-apps/api/core';
import { fetchSTT } from '@/lib';

interface UseMeetingAudioProps {
  enabled: boolean;
  onSystemAudioTranscript: (text: string, timestamp: number) => void;
  onError?: (error: Error) => void; // NEW: Error callback for user feedback
  sttProvider: any;
  selectedSttProvider: any;
  sttLanguage: string;
}

export function useMeetingAudio({
  enabled,
  onSystemAudioTranscript,
  onError,
  sttProvider,
  selectedSttProvider,
  sttLanguage,
}: UseMeetingAudioProps) {
  // FIX: Use queue instead of simple lock to avoid dropping speech segments
  const processingQueueRef = useRef<string[]>([]);
  const isProcessingRef = useRef(false);
  const isSetupCompleteRef = useRef(false); // FIX: Track setup completion for safe cleanup

  // Process queue of audio segments
  const processQueue = useCallback(async () => {
    if (isProcessingRef.current || processingQueueRef.current.length === 0) return;
    isProcessingRef.current = true;

    while (processingQueueRef.current.length > 0) {
      const base64Audio = processingQueueRef.current.shift()!;

      try {
        // Convert base64 to blob
        const binaryString = atob(base64Audio);
        const bytes = new Uint8Array(binaryString.length);
        for (let i = 0; i < binaryString.length; i++) {
          bytes[i] = binaryString.charCodeAt(i);
        }
        const audioBlob = new Blob([bytes], { type: 'audio/wav' });

        // Transcribe
        const transcription = await fetchSTT({
          provider: sttProvider,
          selectedProvider: selectedSttProvider,
          audio: audioBlob,
          language: sttLanguage,
        });

        if (transcription?.trim()) {
          onSystemAudioTranscript(transcription, Date.now());
        }
      } catch (err) {
        console.error('[MeetingAudio] STT failed:', err);
        // Don't call onError for individual STT failures - just log
      }
    }

    isProcessingRef.current = false;
  }, [sttProvider, selectedSttProvider, sttLanguage, onSystemAudioTranscript]);

  useEffect(() => {
    if (!enabled) return;

    let unlisten: (() => void) | undefined;
    isSetupCompleteRef.current = false;

    const setup = async () => {
      // Start system audio capture
      try {
        await invoke('start_system_audio_capture', {
          vadConfig: {
            enabled: true,
            hop_size: 1024,
            sensitivity_rms: 0.012,
            peak_threshold: 0.035,
            silence_chunks: 45,
            min_speech_chunks: 7,
            pre_speech_chunks: 12,
            noise_gate_threshold: 0.003,
            max_recording_duration_secs: 180,
          },
          deviceId: null, // Use default output device
        });
      } catch (err) {
        console.error('[MeetingAudio] Failed to start system audio:', err);
        // FIX: Notify user of failure
        onError?.(new Error('Failed to capture system audio. Check audio permissions.'));
        return;
      }

      // Listen for speech detected events
      unlisten = await listen('speech-detected', async (event) => {
        const base64Audio = event.payload as string;
        // FIX: Queue instead of dropping
        processingQueueRef.current.push(base64Audio);
        processQueue();
      });

      isSetupCompleteRef.current = true;
    };

    setup();

    return () => {
      // FIX: Only cleanup if setup completed
      if (isSetupCompleteRef.current) {
        if (unlisten) unlisten();
        invoke('stop_system_audio_capture').catch(() => {});
      }
      // Clear queue on cleanup
      processingQueueRef.current = [];
    };
  }, [enabled, processQueue, onError]);
}
```

**useCompletion.ts Changes:**

```typescript
// Add handler for system audio transcripts (with translation support)
const addSystemAudioTranscript = useCallback((
  text: string,
  timestamp: number,
  translate?: (text: string) => Promise<{ success: boolean; translation?: string; error?: string }>,
  translationEnabled?: boolean
) => {
  const entry: TranscriptEntry = {
    original: text,
    timestamp,
    audioSource: 'system',
    speaker: {
      speakerId: 'guest',
      speakerLabel: 'Guest',
      confirmed: false, // Will be updated by diarization in Phase 3
    },
  };

  // FIX: Just append - timestamps are monotonically increasing, no sort needed
  // This is O(1) instead of O(n log n)
  setMeetingTranscript(prev => [...prev, entry]);

  // Also add to conversation history
  const conversationId = currentConversationIdRef.current || generateConversationId("chat");
  currentConversationIdRef.current = conversationId;

  const userMessage: ChatMessage = {
    id: generateMessageId("user", timestamp),
    role: "user",
    content: text,
    timestamp,
  };

  conversationHistoryRef.current = [...conversationHistoryRef.current, userMessage];
  setState((prev) => ({
    ...prev,
    currentConversationId: conversationId,
    conversationHistory: [...prev.conversationHistory, userMessage],
  }));

  // FIX: Handle translation for system audio (was missing)
  if (translationEnabled && translate) {
    translate(text).then((result) => {
      if (result.success && result.translation) {
        updateTranscriptTranslation(timestamp, result.translation);
      } else if (result.error) {
        updateTranscriptTranslation(timestamp, undefined, result.error);
      }
    });
  }
}, [updateTranscriptTranslation]);
```

**Dual VAD Considerations:**

| Aspect | Microphone VAD | System Audio VAD |
|--------|---------------|------------------|
| Library | `@ricky0123/vad-react` (JS) | Rust backend |
| Runs in | Browser | Native process |
| Conflict risk | Low (different audio sources) | Low |
| Testing needed | Verify no performance issues | Verify no audio conflicts |

**Outcome:**
- User speech: "You: [text]"
- Others' speech: "Guest: [text]"
- Single transcript timeline, sorted by timestamp

**Testing:**
- [ ] Enable Meeting Assist Mode
- [ ] Play a video with someone speaking
- [ ] Verify video speech shows as "Guest: [text]"
- [ ] Verify your speech still shows as "You: [text]"
- [ ] Verify both appear in same transcript in correct order

---

### Phase 3: Batch Diarization for System Audio

**Goal:** Distinguish multiple speakers in system audio ("Guest" → "Speaker 1", "Speaker 2")

**Scope:**
- Buffer system audio segments
- Every 30 seconds, send batch to AssemblyAI with diarization
- Match results to existing transcript entries
- Update labels retroactively

**New Files:**

| File | Purpose |
|------|---------|
| `src/lib/functions/audio-buffer.ts` | Audio buffering and concatenation |
| `src/hooks/useSpeakerDiarization.ts` | Batch diarization and label matching |

**Audio Buffer Implementation:**

```typescript
// src/lib/functions/audio-buffer.ts

interface BufferedSegment {
  audio: Blob;
  timestamp: number;
  transcriptEntryId: string; // Link to displayed entry
}

export class AudioBuffer {
  private segments: BufferedSegment[] = [];
  private batchDurationMs: number;
  private onBatchReady: (segments: BufferedSegment[], batchId: string) => void;
  // FIX: Use browser-compatible type instead of NodeJS.Timeout
  private batchTimer: ReturnType<typeof setTimeout> | null = null;
  private firstSegmentTime: number | null = null;
  private batchCounter: number = 0; // FIX: Track batch for cross-batch speaker mapping

  constructor(
    batchDurationMs: number = 30000,
    onBatchReady: (segments: BufferedSegment[], batchId: string) => void
  ) {
    this.batchDurationMs = batchDurationMs;
    this.onBatchReady = onBatchReady;
  }

  addSegment(audio: Blob, timestamp: number, entryId: string): void {
    this.segments.push({ audio, timestamp, transcriptEntryId: entryId });

    if (this.firstSegmentTime === null) {
      this.firstSegmentTime = timestamp;
      this.startBatchTimer();
    }
  }

  private startBatchTimer(): void {
    this.batchTimer = setTimeout(() => {
      this.flushBatch();
    }, this.batchDurationMs);
  }

  private flushBatch(): void {
    if (this.segments.length === 0) return;

    const batch = [...this.segments];
    this.segments = [];
    this.firstSegmentTime = null;
    this.batchTimer = null;

    // FIX: Include batch ID for cross-batch speaker tracking
    const batchId = `batch_${++this.batchCounter}_${Date.now()}`;
    this.onBatchReady(batch, batchId);
  }

  clear(): void {
    if (this.batchTimer) {
      clearTimeout(this.batchTimer);
      this.batchTimer = null;
    }
    this.segments = [];
    this.firstSegmentTime = null;
  }

  // Force flush on meeting end
  forceFlush(): void {
    if (this.batchTimer) {
      clearTimeout(this.batchTimer);
    }
    this.flushBatch();
  }
}

// FIX: Reuse single AudioContext to avoid memory leak
let sharedAudioContext: AudioContext | null = null;

function getSharedAudioContext(): AudioContext {
  if (!sharedAudioContext || sharedAudioContext.state === 'closed') {
    sharedAudioContext = new AudioContext();
  }
  return sharedAudioContext;
}

// Concatenate audio blobs into single blob
export async function concatenateAudioBlobs(blobs: Blob[]): Promise<Blob> {
  if (blobs.length === 0) {
    throw new Error('No audio blobs to concatenate');
  }

  if (blobs.length === 1) {
    return blobs[0]; // No need to concatenate single blob
  }

  // FIX: Reuse single AudioContext instead of creating one per blob
  const audioContext = getSharedAudioContext();

  const decodedBuffers = await Promise.all(
    blobs.map(async (blob) => {
      const arrayBuffer = await blob.arrayBuffer();
      return audioContext.decodeAudioData(arrayBuffer.slice(0)); // slice(0) to avoid detached ArrayBuffer
    })
  );

  // Calculate total length
  const totalLength = decodedBuffers.reduce((sum, buffer) => sum + buffer.length, 0);
  const sampleRate = decodedBuffers[0]?.sampleRate || 16000;

  // Create combined buffer using OfflineAudioContext
  const offlineContext = new OfflineAudioContext(1, totalLength, sampleRate);
  let offset = 0;

  for (const decoded of decodedBuffers) {
    const source = offlineContext.createBufferSource();
    source.buffer = decoded;
    source.connect(offlineContext.destination);
    source.start(offset / sampleRate);
    offset += decoded.length;
  }

  const renderedBuffer = await offlineContext.startRendering();

  // Convert to WAV blob
  return audioBufferToWavBlob(renderedBuffer);
}

function audioBufferToWavBlob(buffer: AudioBuffer): Blob {
  const numChannels = 1;
  const sampleRate = buffer.sampleRate;
  const format = 1; // PCM
  const bitDepth = 16;

  const bytesPerSample = bitDepth / 8;
  const blockAlign = numChannels * bytesPerSample;

  const samples = buffer.getChannelData(0);
  const dataLength = samples.length * bytesPerSample;
  const headerLength = 44;
  const totalLength = headerLength + dataLength;

  const arrayBuffer = new ArrayBuffer(totalLength);
  const view = new DataView(arrayBuffer);

  // WAV header
  const writeString = (offset: number, str: string) => {
    for (let i = 0; i < str.length; i++) {
      view.setUint8(offset + i, str.charCodeAt(i));
    }
  };

  writeString(0, 'RIFF');
  view.setUint32(4, totalLength - 8, true);
  writeString(8, 'WAVE');
  writeString(12, 'fmt ');
  view.setUint32(16, 16, true);
  view.setUint16(20, format, true);
  view.setUint16(22, numChannels, true);
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, sampleRate * blockAlign, true);
  view.setUint16(32, blockAlign, true);
  view.setUint16(34, bitDepth, true);
  writeString(36, 'data');
  view.setUint32(40, dataLength, true);

  // Write samples
  let offset = 44;
  for (let i = 0; i < samples.length; i++) {
    const sample = Math.max(-1, Math.min(1, samples[i]));
    view.setInt16(offset, sample < 0 ? sample * 0x8000 : sample * 0x7fff, true);
    offset += 2;
  }

  return new Blob([arrayBuffer], { type: 'audio/wav' });
}
```

**Diarization Matching Algorithm:**

```typescript
// src/hooks/useSpeakerDiarization.ts

interface DiarizationResult {
  speaker: string; // "A", "B", "C"
  text: string;
  start: number; // ms from batch start
  end: number;
}

// FIX: Improved structure to handle cross-batch speaker tracking
interface BatchSpeakerMap {
  [diarizationLabel: string]: {
    sessionId: string; // "speaker_1", "speaker_2"
    displayName: string; // "Speaker 1" or user-assigned name
    color: string;
  };
}

interface SessionSpeakerRegistry {
  // Global counter for speaker assignment
  nextSpeakerNumber: number;
  // Per-batch mappings (AssemblyAI labels reset per batch)
  batchMappings: { [batchId: string]: BatchSpeakerMap };
  // Assigned speakers (persists across batches)
  assignedSpeakers: {
    [sessionId: string]: {
      displayName: string;
      color: string;
    };
  };
}

export function matchDiarizationResults(
  pendingEntries: TranscriptEntry[],
  diarizationResults: DiarizationResult[],
  batchStartTime: number,
  batchId: string, // FIX: Added batch ID for proper mapping
  speakerRegistry: SessionSpeakerRegistry,
  updateEntry: (timestamp: number, speaker: SpeakerInfo) => void
): void {
  // FIX: Create new batch mapping (AssemblyAI labels "A", "B" reset per batch)
  if (!speakerRegistry.batchMappings[batchId]) {
    speakerRegistry.batchMappings[batchId] = {};
  }
  const batchMap = speakerRegistry.batchMappings[batchId];

  for (const result of diarizationResults) {
    // Calculate absolute timestamp
    const absoluteTimestamp = batchStartTime + result.start;

    // Find matching entry with improved matching
    const entry = findBestMatchingEntry(pendingEntries, result, absoluteTimestamp);

    if (entry) {
      // Get or create session speaker for this batch's label
      let speakerMapping = batchMap[result.speaker];
      if (!speakerMapping) {
        const speakerNum = speakerRegistry.nextSpeakerNumber++;
        const sessionId = `speaker_${speakerNum}`;
        speakerMapping = {
          sessionId,
          displayName: `Speaker ${speakerNum}`,
          color: SPEAKER_COLORS[(speakerNum - 1) % SPEAKER_COLORS.length],
        };
        batchMap[result.speaker] = speakerMapping;

        // Also register in global assigned speakers
        speakerRegistry.assignedSpeakers[sessionId] = {
          displayName: speakerMapping.displayName,
          color: speakerMapping.color,
        };
      }

      // Update entry
      updateEntry(entry.timestamp, {
        speakerId: speakerMapping.sessionId,
        speakerLabel: speakerMapping.displayName,
        confirmed: true,
      });
    }
  }
}

// FIX: Improved matching with tighter window and fallback
function findBestMatchingEntry(
  pendingEntries: TranscriptEntry[],
  result: DiarizationResult,
  absoluteTimestamp: number
): TranscriptEntry | undefined {
  // Filter candidates
  const candidates = pendingEntries.filter((e) => {
    // Must be system audio and not yet confirmed
    if (e.audioSource !== 'system') return false;
    if (e.speaker?.confirmed) return false;
    return true;
  });

  if (candidates.length === 0) return undefined;

  // FIX: Reduced to 1.5 second window (was 3s - too wide)
  const TIME_WINDOW_MS = 1500;

  // Score each candidate
  const scored = candidates.map((entry) => {
    const timeDiff = Math.abs(entry.timestamp - absoluteTimestamp);
    const textSimilarity = calculateTextSimilarity(entry.original, result.text);

    // Calculate combined score (prefer time proximity + text match)
    let score = 0;

    // Time score: 1.0 at exact match, 0 at boundary
    if (timeDiff <= TIME_WINDOW_MS) {
      score += (1 - timeDiff / TIME_WINDOW_MS) * 0.5;
    }

    // Text similarity score (weighted more heavily)
    score += textSimilarity * 0.5;

    return { entry, score, timeDiff, textSimilarity };
  });

  // Sort by score descending
  scored.sort((a, b) => b.score - a.score);

  // Return best match if score is above threshold
  const best = scored[0];
  // FIX: Require either good time match OR good text match (not necessarily both)
  if (best && (best.timeDiff <= TIME_WINDOW_MS || best.textSimilarity > 0.7)) {
    return best.entry;
  }

  return undefined;
}

function calculateTextSimilarity(a: string, b: string): number {
  const longer = a.length > b.length ? a : b;
  const shorter = a.length > b.length ? b : a;

  if (longer.length === 0) return 1.0;

  const editDistance = levenshteinDistance(longer, shorter);
  return (longer.length - editDistance) / longer.length;
}

function levenshteinDistance(a: string, b: string): number {
  const matrix: number[][] = [];

  for (let i = 0; i <= b.length; i++) {
    matrix[i] = [i];
  }
  for (let j = 0; j <= a.length; j++) {
    matrix[0][j] = j;
  }

  for (let i = 1; i <= b.length; i++) {
    for (let j = 1; j <= a.length; j++) {
      if (b.charAt(i - 1) === a.charAt(j - 1)) {
        matrix[i][j] = matrix[i - 1][j - 1];
      } else {
        matrix[i][j] = Math.min(
          matrix[i - 1][j - 1] + 1,
          matrix[i][j - 1] + 1,
          matrix[i - 1][j] + 1
        );
      }
    }
  }

  return matrix[b.length][a.length];
}

const SPEAKER_COLORS = [
  '#22c55e', // green
  '#f97316', // orange
  '#8b5cf6', // purple
  '#ec4899', // pink
  '#14b8a6', // teal
  '#eab308', // yellow
];
```

**Cross-Batch Speaker Consistency:**

**Known Limitation:** AssemblyAI assigns labels (A, B, C) independently per request. "Speaker A" in Batch 1 may not be the same person as "Speaker A" in Batch 2.

**Mitigation Strategies:**

1. **Text matching:** If same text patterns repeat, likely same speaker
2. **Manual correction:** User can reassign labels, applied to all matching entries
3. **Accept limitation:** Document that cross-batch consistency is best-effort

**For v1, we accept the limitation and rely on manual correction.**

**Outcome:**
- "Guest" entries update to "Speaker 1", "Speaker 2" after ~30 seconds
- Multiple speakers distinguished within same batch
- Manual tagging available for corrections

**Testing:**
- [ ] Play video with multiple speakers
- [ ] Verify initial labels show "Guest"
- [ ] After 30 seconds, verify labels update to "Speaker 1", "Speaker 2"
- [ ] Verify manual tagging still works for corrections

---

### Phase 4: Code Cleanup

**Goal:** Remove unused voice enrollment code

**IMPORTANT:** Only execute this phase AFTER Phases 1-3 are working and tested.

**Files to Remove:**

| File | Reason |
|------|--------|
| `src/lib/functions/speaker-embedding.function.ts` | Voice embeddings not needed |
| `src/components/SpeakerConfirmation.tsx` | Voice matching not needed |

**Files to Simplify:**

| File | Changes |
|------|---------|
| `src/pages/speakers/components/SpeakerProfiles.tsx` | Remove voice recording UI |
| `src/lib/storage/speaker-profiles.storage.ts` | Remove embedding fields |
| `src/pages/speakers/components/DiarizationSettings.tsx` | Update description text |

**Safe Refactoring Order:**

1. Verify Phases 1-3 work completely
2. Remove `speaker-embedding.function.ts`
3. Remove `SpeakerConfirmation.tsx`
4. Simplify `SpeakerProfiles.tsx` (remove recording)
5. Simplify storage types (remove embedding fields)
6. Update `DiarizationSettings.tsx` text
7. Full regression test

---

## Known Limitations & Mitigations

### Limitation 1: Remote Meetings Only

**Issue:** This approach assumes mic = user, system audio = others. In-person meetings break this assumption.

**Mitigation:**
- Add "Meeting Mode" toggle in settings (Remote vs In-Person)
- In-Person mode: Fall back to diarization-only approach
- **Deferred to future enhancement**

### Limitation 2: Cross-Batch Speaker Consistency

**Issue:** AssemblyAI speaker labels (A, B, C) reset per batch. Without voice matching, "Speaker A" in batch 1 may be a different person than "Speaker A" in batch 2.

**v3.1 Mitigation Strategy:**
- **Per-batch mapping:** Each batch gets its own label-to-speaker mapping
- **Incremental numbering:** New speakers always get next available number (Speaker 1, Speaker 2, etc.)
- **Accept limitation:** Same person may get different Speaker numbers across batches
- **Manual correction:** User can manually reassign speakers; this propagates to all matching entries
- **Text similarity:** Used as secondary matching signal within batches

**Result:** Speakers are correctly distinguished *within* each 30-second batch. Cross-batch consistency requires manual correction for v1.

### Limitation 3: System Audio Capture Platform Differences

**Issue:** System audio capture works differently on Windows, macOS, Linux.

**Mitigation:**
- Test on all platforms before release
- Graceful degradation if system audio unavailable
- Show clear error message if capture fails

### Limitation 4: Dual API Calls for System Audio

**Issue:** System audio is transcribed twice (immediate + diarization batch), doubling cost.

**Mitigation:**
- Accept cost for better UX (immediate text)
- Alternative: Only batch, but text delayed 30s (rejected per user preference)

---

## Code Refactoring Plan

### What to Keep

| File | Reason |
|------|--------|
| `SpeakerTaggingPopover.tsx` | Manual assignment UI - essential |
| `DiarizationSettings.tsx` | Enable/disable toggle - useful |
| `addMeetingTranscriptEntries()` | Batch entry adding - useful |

### What to Remove (Phase 4 Only)

| File | Reason |
|------|--------|
| `speaker-embedding.function.ts` | Voice embeddings not used |
| `SpeakerConfirmation.tsx` | Voice matching not used |

### What to Simplify (Phase 4 Only)

| File | Remove | Keep |
|------|--------|------|
| `SpeakerProfiles.tsx` | Recording UI, progress bar, quality badges | Name/color editing |
| `speaker-profiles.storage.ts` | `embedding`, `audioSampleBase64`, `enrollmentQuality` | `id`, `name`, `color`, `type` |

---

## Testing Checklist

### Phase 1 Tests
- [ ] Meeting Assist Mode: Mic speech labeled "You"
- [ ] Non-Meeting Assist Mode: Unchanged behavior
- [ ] Translation still works with new entry format
- [ ] Existing conversations still load correctly

### Phase 2 Tests
- [ ] System audio captured when Meeting Assist enabled
- [ ] System audio labeled "Guest"
- [ ] Mic + system audio appear in same transcript
- [ ] Correct chronological ordering
- [ ] System audio stops when Meeting Assist disabled
- [ ] No performance degradation with dual VAD

### Phase 3 Tests
- [ ] Audio buffer accumulates correctly
- [ ] Batch sent after 30 seconds
- [ ] Labels update from "Guest" to "Speaker N"
- [ ] Multiple speakers distinguished
- [ ] Manual tagging overrides diarization
- [ ] Buffer clears on meeting end
- [ ] Graceful handling of diarization failures

### Phase 4 Tests
- [ ] App still builds after removing files
- [ ] No runtime errors from missing imports
- [ ] Speaker profiles page works (simplified)
- [ ] Settings page works

---

## Future Enhancements

### In-Person Meeting Mode
- Detect when system audio is silent (no video call)
- Use diarization on microphone audio only
- User identifies themselves after first speech

### Voice Learning (Optional)
- When user assigns name to speaker, store audio features
- In future sessions, auto-suggest matching speakers
- Require confirmation before applying

### Configurable Batch Duration
- Settings option: 15s / 30s / 60s
- Trade-off: Shorter = more API calls, longer = more delay

### Meeting Templates
- Pre-configured speaker lists for recurring meetings
- "1-on-1 with John" template
- Auto-apply names when starting

---

## Success Metrics

| Metric | Target |
|--------|--------|
| "You" identification accuracy | 100% |
| Text appears within | 3-4 seconds |
| Speaker labels update within | 30-45 seconds |
| Manual override available | Always |
| Graceful degradation on failure | Yes |

---

## Document History

| Version | Date | Author | Changes |
|---------|------|--------|---------|
| 1.0 | 2025-12-29 | Claude | Initial plan |
| 2.0 | 2025-12-29 | Claude | Added hybrid approach and refactoring plan |
| 3.0 | 2025-12-29 | Claude | Complete rewrite with phased approach (D+F), addressed architectural flaws, added detailed implementation specs |
| 3.1 | 2025-12-29 | Claude | Bug fix review: Fixed 17 issues including function name mismatch, race conditions, memory leaks, type incompatibilities, and improved matching algorithms |
| 3.2 | 2025-12-29 | Claude | Phase 1-2 implementation review: (1) Changed speakerId from static 'guest' to unique `guest_${timestamp}` for individual entry updates by diarization, (2) Added `updateEntrySpeaker(timestamp, speakerInfo)` function for Phase 3 diarization to update individual entries |
| 3.3 | 2025-12-29 | Claude | Phase 3 implementation: (1) Created `audio-buffer.ts` with `DiarizationAudioBuffer` class for 30-second batching and `concatenateAudioBlobs()` for audio concatenation, (2) Created `useSpeakerDiarization.ts` hook with batch processing, matching algorithm, and session speaker registry, (3) Modified `useMeetingAudio.ts` to accept optional audio buffer for diarization, (4) Integrated diarization in `Audio.tsx` - conditionally enables when diarization is enabled in settings and AssemblyAI API key is present |
| 4.0 | 2025-12-29 | Claude | Phase 4 code cleanup: (1) Removed `speaker-embedding.function.ts` (voice embeddings not needed), (2) Removed `SpeakerConfirmation.tsx` (voice matching not used), (3) Simplified `SpeakerProfiles.tsx` - removed voice recording UI, kept name/type/color editing with inline rename capability, (4) Simplified `speaker-profiles.storage.ts` - removed `embedding`, `audioSampleBase64`, `enrollmentQuality` fields and related functions (`saveAudioSample`, `getAudioSample`, `updateProfileEmbedding`, `getProfilesWithEmbeddings`), bumped IndexedDB version to 2 with migration to delete old `audioSamples` store, (5) Updated `DiarizationSettings.tsx` - replaced voice enrollment instructions with accurate explanation of audio source-based identification |

---

## References

- [AssemblyAI Speaker Diarization Docs](https://www.assemblyai.com/docs/speech-to-text/speaker-diarization)
- [AssemblyAI Streaming FAQ](https://www.assemblyai.com/docs/faq/can-i-use-speaker-diarization-with-live-audio-transcription)
- [Meetwings Meeting Context Memory Plan](./MEETING_CONTEXT_MEMORY_PLAN.md)
