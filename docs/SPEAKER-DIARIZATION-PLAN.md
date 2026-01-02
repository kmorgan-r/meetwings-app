# Speaker Diarization with AssemblyAI

## Implementation Plan for Meetwings

**Created:** December 27, 2025
**Status:** Planning Complete - Ready for Implementation

---

## Table of Contents

1. [Overview](#overview)
2. [User Requirements](#user-requirements)
3. [Technical Architecture](#technical-architecture)
4. [Phase 1: AssemblyAI Provider Integration](#phase-1-assemblyai-provider-integration)
5. [Phase 2: Within-Session Speaker Tagging](#phase-2-within-session-speaker-tagging)
6. [Phase 3: Voice Enrollment System](#phase-3-voice-enrollment-system)
7. [Phase 4: Cross-Session Speaker Matching](#phase-4-cross-session-speaker-matching)
8. [Phase 5: Cost Tracking Integration](#phase-5-cost-tracking-integration)
9. [Files to Create/Modify](#files-to-createmodify)
10. [Implementation Order](#implementation-order)
11. [Technical Considerations](#technical-considerations)
12. [Cost Analysis](#cost-analysis)

---

## Overview

Add speaker identification to Meeting Assist Mode using AssemblyAI's diarization API. The system will:

- Identify different speakers in meetings (Speaker A, B, C, etc.)
- Allow users to enroll their voice for automatic recognition
- Remember speaker profiles between sessions
- Support enrolling colleagues and clients for future recognition

---

## User Requirements

| Requirement | Decision |
|-------------|----------|
| Provider integration | AssemblyAI as new selectable STT provider |
| Speaker labels | Persistent profiles saved between sessions |
| Self-identification | Manual enrollment - user records 30-second voice sample |
| Other speakers | Can enroll colleagues/clients too |
| Scope | Meeting Assist Mode only |
| Persistence | All settings remembered between sessions |
| Audio processing | Process each VAD segment individually (faster) |
| Enrollment duration | Require 30-second sample for reliable identification |
| Fallback behavior | Fall back to previous provider if no API key |
| Match confirmation | Prompt user to confirm on medium confidence (50-70%) |
| Cost tracking | Include AssemblyAI costs in tracking system |

---

## Technical Architecture

### Current Flow

```
VAD detects speech → Audio blob → fetchSTT() → Transcription string
                                      ↓
                              MeetingTranscript[] / submit to AI
```

### New Flow with Speaker Diarization

```
VAD detects speech → Audio blob ──────────────────────────────────┐
                         │                                        │
                         ▼                                        ▼
                   AssemblyAI STT                          Store audio chunk
                   (with diarization)                      (for embedding)
                         │                                        │
                         ▼                                        ▼
                   Transcription +                         Extract embedding
                   Speaker ID ("A", "B")                   (TensorFlow.js)
                         │                                        │
                         ▼                                        ▼
                   Match against                           Compare with
                   session mapping                         enrolled profiles
                         │                                        │
                         └──────────────┬─────────────────────────┘
                                        ▼
                              Display with speaker label
                              ("You", "Sarah - Client", etc.)
                                        │
                                        ▼
                              MeetingTranscript with SpeakerInfo
```

---

## Phase 1: AssemblyAI Provider Integration

### 1.1 Add AssemblyAI to Provider List

**File:** `src/config/stt.constants.ts`

Add new provider configuration:

```typescript
{
  id: "assemblyai",
  name: "AssemblyAI (with Speaker Diarization)",
  curl: `curl -X POST "https://api.assemblyai.com/v2/upload" \
    -H "Authorization: {{API_KEY}}" \
    -H "Content-Type: application/octet-stream" \
    --data-binary {{AUDIO}}`,
  responseContentPath: "upload_url",
  streaming: false,
  requiresSpecialHandler: true,
  specialHandler: "assemblyai-diarization",
}
```

> **Note:** AssemblyAI requires a 2-step process:
> 1. Upload audio to get `upload_url`
> 2. Create transcript with `speaker_labels: true`
> 3. Poll until complete

### 1.2 Fallback Behavior

When AssemblyAI is selected but API key is missing:

1. Check for API key before processing audio
2. If missing, fall back to previously configured STT provider
3. Show toast notification: "AssemblyAI API key not configured. Using [previous provider] instead."
4. Disable speaker diarization features for this session

### 1.3 Create AssemblyAI Handler

**File:** `src/lib/functions/assemblyai.function.ts` (NEW)

```typescript
export interface AssemblyAITranscriptResult {
  transcription: string;
  utterances: Array<{
    speaker: string;      // "A", "B", "C", etc.
    text: string;
    start: number;        // milliseconds
    end: number;
    confidence: number;
  }>;
  rawResponse: any;
}

export interface AssemblyAIConfig {
  apiKey: string;
  language?: string;
  speakersExpected?: number;
}

/**
 * Transcribes audio using AssemblyAI with speaker diarization.
 *
 * Process:
 * 1. Upload audio file to AssemblyAI
 * 2. Create transcript job with speaker_labels enabled
 * 3. Poll until transcription is complete
 * 4. Return structured result with utterances
 */
export async function fetchAssemblyAIWithDiarization(
  audio: Blob,
  config: AssemblyAIConfig
): Promise<AssemblyAITranscriptResult> {
  const { apiKey, language = "en", speakersExpected } = config;

  // Step 1: Upload audio
  const uploadResponse = await fetch("https://api.assemblyai.com/v2/upload", {
    method: "POST",
    headers: {
      "Authorization": apiKey,
      "Content-Type": "application/octet-stream",
    },
    body: audio,
  });

  if (!uploadResponse.ok) {
    throw new Error(`Upload failed: ${uploadResponse.statusText}`);
  }

  const { upload_url } = await uploadResponse.json();

  // Step 2: Create transcript with diarization
  const transcriptResponse = await fetch("https://api.assemblyai.com/v2/transcript", {
    method: "POST",
    headers: {
      "Authorization": apiKey,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      audio_url: upload_url,
      speaker_labels: true,
      speakers_expected: speakersExpected,
      language_code: language,
    }),
  });

  if (!transcriptResponse.ok) {
    throw new Error(`Transcript creation failed: ${transcriptResponse.statusText}`);
  }

  const { id: transcriptId } = await transcriptResponse.json();

  // Step 3: Poll for completion
  const result = await pollForCompletion(transcriptId, apiKey);

  return {
    transcription: result.text,
    utterances: result.utterances || [],
    rawResponse: result,
  };
}

async function pollForCompletion(
  transcriptId: string,
  apiKey: string,
  maxAttempts: number = 60,
  intervalMs: number = 1000
): Promise<any> {
  for (let i = 0; i < maxAttempts; i++) {
    const response = await fetch(
      `https://api.assemblyai.com/v2/transcript/${transcriptId}`,
      {
        headers: { "Authorization": apiKey },
      }
    );

    const result = await response.json();

    if (result.status === "completed") {
      return result;
    }

    if (result.status === "error") {
      throw new Error(`Transcription failed: ${result.error}`);
    }

    await new Promise(resolve => setTimeout(resolve, intervalMs));
  }

  throw new Error("Transcription timeout");
}
```

### 1.4 Update Type Definitions

**File:** `src/types/completion.ts`

Add speaker information to transcript entries:

```typescript
export interface SpeakerInfo {
  speakerId: string;           // "A", "B", "C" from AssemblyAI
  speakerLabel?: string;       // "You", "Sarah - Client", or undefined
  speakerProfileId?: string;   // Reference to enrolled profile
  confidence?: number;         // 0-1 match confidence
  needsConfirmation?: boolean; // True if medium confidence, awaiting user input
}

// Update existing TranscriptEntry
export interface TranscriptEntry {
  original: string;
  translation?: string;
  translationError?: string;
  timestamp: number;
  // New speaker fields
  speaker?: SpeakerInfo;
  audioChunkId?: string;       // Reference for embedding extraction
}
```

### 1.5 Update Display Components

**File:** `src/pages/app/components/completion/MeetingTranscriptPanel.tsx`

Add speaker labels to transcript display:

```tsx
// Helper function for speaker colors
const SPEAKER_COLORS: Record<string, string> = {
  'A': 'bg-blue-500/20 text-blue-700 dark:text-blue-300',
  'B': 'bg-green-500/20 text-green-700 dark:text-green-300',
  'C': 'bg-purple-500/20 text-purple-700 dark:text-purple-300',
  'D': 'bg-orange-500/20 text-orange-700 dark:text-orange-300',
  'user': 'bg-primary/20 text-primary',
};

function getSpeakerColor(speakerId: string): string {
  return SPEAKER_COLORS[speakerId] || SPEAKER_COLORS['A'];
}

// In the transcript mapping:
{meetingTranscript.map((entry, index) => (
  <div key={index} className="p-3 rounded-lg bg-muted/50">
    {/* Speaker label */}
    {entry.speaker && (
      <div className="flex items-center gap-2 mb-2">
        <span
          className={`text-xs font-medium px-2 py-0.5 rounded ${
            getSpeakerColor(entry.speaker.speakerId)
          }`}
        >
          {entry.speaker.speakerLabel || `Speaker ${entry.speaker.speakerId}`}
        </span>
        <span className="text-xs text-muted-foreground">
          {new Date(entry.timestamp).toLocaleTimeString([], {
            hour: "2-digit",
            minute: "2-digit",
          })}
        </span>
      </div>
    )}

    <p className="text-sm">{entry.original}</p>

    {/* Translation (existing) */}
    {sttTranslationEnabled && entry.translation && (
      <div className="mt-2 pt-2 border-t border-primary/20">
        <p className="text-foreground/80 italic" dir="auto">
          {entry.translation}
        </p>
      </div>
    )}
  </div>
))}
```

### 1.6 Add Storage Keys

**File:** `src/config/constants.ts`

```typescript
// Speaker diarization settings
SPEAKER_DIARIZATION_ENABLED: "speaker_diarization_enabled",
SPEAKER_PROFILES: "speaker_profiles",
USER_VOICE_ENROLLMENT: "user_voice_enrollment",
ASSEMBLYAI_API_KEY: "assemblyai_api_key",
PREVIOUS_STT_PROVIDER: "previous_stt_provider",  // For fallback
```

---

## Phase 2: Within-Session Speaker Tagging

### 2.1 Session Speaker Mapping

Track speaker assignments within a meeting session:

```typescript
interface SessionSpeakerMap {
  [speakerId: string]: {
    label: string;           // Display name
    profileId?: string;      // If matched to enrolled profile
    assignedAt: number;      // Timestamp of assignment
  };
}

// Store in useCompletion hook state
const [sessionSpeakerMap, setSessionSpeakerMap] = useState<SessionSpeakerMap>({});
```

### 2.2 Inline Tagging UI

When user clicks a speaker label, show tagging popover:

```tsx
<Popover>
  <PopoverTrigger asChild>
    <button className="text-xs font-medium px-2 py-0.5 rounded cursor-pointer hover:opacity-80">
      {entry.speaker.speakerLabel || `Speaker ${entry.speaker.speakerId}`}
    </button>
  </PopoverTrigger>
  <PopoverContent className="w-48 p-2">
    <div className="space-y-1">
      <p className="text-xs text-muted-foreground mb-2">Who is this?</p>

      {/* Quick "That's me" button */}
      <Button
        size="sm"
        variant="outline"
        className="w-full justify-start"
        onClick={() => assignSpeaker(entry.speaker.speakerId, 'You', userProfileId)}
      >
        That's me
      </Button>

      {/* Enrolled profiles */}
      {enrolledProfiles.map(profile => (
        <Button
          key={profile.id}
          size="sm"
          variant="ghost"
          className="w-full justify-start"
          onClick={() => assignSpeaker(entry.speaker.speakerId, profile.name, profile.id)}
        >
          {profile.name}
        </Button>
      ))}

      {/* Add new person */}
      <Button
        size="sm"
        variant="ghost"
        className="w-full justify-start text-muted-foreground"
        onClick={() => setShowNewPersonInput(true)}
      >
        + Add new person
      </Button>
    </div>
  </PopoverContent>
</Popover>
```

### 2.3 Propagate Assignments

When a speaker is assigned, update all entries with that speaker ID:

```typescript
function assignSpeaker(speakerId: string, label: string, profileId?: string) {
  // Update session mapping
  setSessionSpeakerMap(prev => ({
    ...prev,
    [speakerId]: { label, profileId, assignedAt: Date.now() },
  }));

  // Update all transcript entries with this speaker ID
  setMeetingTranscript(prev => prev.map(entry => {
    if (entry.speaker?.speakerId === speakerId) {
      return {
        ...entry,
        speaker: {
          ...entry.speaker,
          speakerLabel: label,
          speakerProfileId: profileId,
        },
      };
    }
    return entry;
  }));
}
```

---

## Phase 3: Voice Enrollment System

### 3.1 Speaker Profile Data Structure

```typescript
interface SpeakerProfile {
  id: string;                    // UUID
  name: string;                  // "You", "Sarah Chen", etc.
  type: 'user' | 'colleague' | 'client' | 'other';
  color: string;                 // Hex color for visual distinction
  createdAt: number;             // Timestamp
  lastSeenAt: number;            // Last time this speaker was identified

  // Enrollment data
  audioSampleBase64?: string;    // Raw audio sample (stored in IndexedDB)
  embedding?: number[];          // Voice embedding vector (512 dimensions)
  enrollmentQuality: 'excellent' | 'good' | 'fair' | 'poor' | 'none';
}
```

### 3.2 Storage Functions

**File:** `src/lib/storage/speaker-profiles.ts` (NEW)

```typescript
import { openDB, DBSchema, IDBPDatabase } from 'idb';

interface SpeakerProfilesDB extends DBSchema {
  profiles: {
    key: string;
    value: SpeakerProfile;
    indexes: { 'by-type': string };
  };
  audioSamples: {
    key: string;  // profileId
    value: {
      profileId: string;
      audioBase64: string;
      recordedAt: number;
    };
  };
}

let db: IDBPDatabase<SpeakerProfilesDB> | null = null;

async function getDB(): Promise<IDBPDatabase<SpeakerProfilesDB>> {
  if (!db) {
    db = await openDB<SpeakerProfilesDB>('speaker-profiles', 1, {
      upgrade(db) {
        const profileStore = db.createObjectStore('profiles', { keyPath: 'id' });
        profileStore.createIndex('by-type', 'type');
        db.createObjectStore('audioSamples', { keyPath: 'profileId' });
      },
    });
  }
  return db;
}

export async function getSpeakerProfiles(): Promise<SpeakerProfile[]> {
  const db = await getDB();
  return db.getAll('profiles');
}

export async function getSpeakerProfile(id: string): Promise<SpeakerProfile | undefined> {
  const db = await getDB();
  return db.get('profiles', id);
}

export async function getUserProfile(): Promise<SpeakerProfile | undefined> {
  const db = await getDB();
  const profiles = await db.getAllFromIndex('profiles', 'by-type', 'user');
  return profiles[0];  // Should only be one user profile
}

export async function saveSpeakerProfile(profile: SpeakerProfile): Promise<void> {
  const db = await getDB();
  await db.put('profiles', profile);
}

export async function deleteSpeakerProfile(id: string): Promise<void> {
  const db = await getDB();
  await db.delete('profiles', id);
  await db.delete('audioSamples', id);
}

export async function saveAudioSample(
  profileId: string,
  audioBase64: string
): Promise<void> {
  const db = await getDB();
  await db.put('audioSamples', {
    profileId,
    audioBase64,
    recordedAt: Date.now(),
  });
}

export async function getAudioSample(profileId: string): Promise<string | undefined> {
  const db = await getDB();
  const sample = await db.get('audioSamples', profileId);
  return sample?.audioBase64;
}
```

### 3.3 Voice Enrollment UI

**File:** `src/pages/dev/components/SpeakerProfiles.tsx` (NEW)

```tsx
import { useState, useRef, useEffect } from 'react';
import { Button, Header, Progress } from '@/components';
import { MicIcon, StopCircleIcon, TrashIcon, UserIcon } from 'lucide-react';
import {
  getSpeakerProfiles,
  saveSpeakerProfile,
  deleteSpeakerProfile,
  saveAudioSample,
  getUserProfile,
} from '@/lib/storage/speaker-profiles';

const ENROLLMENT_DURATION = 30; // seconds

export function SpeakerProfiles() {
  const [profiles, setProfiles] = useState<SpeakerProfile[]>([]);
  const [userProfile, setUserProfile] = useState<SpeakerProfile | null>(null);
  const [isRecording, setIsRecording] = useState(false);
  const [recordingProgress, setRecordingProgress] = useState(0);
  const [recordingFor, setRecordingFor] = useState<'user' | string | null>(null);

  const mediaRecorderRef = useRef<MediaRecorder | null>(null);
  const audioChunksRef = useRef<Blob[]>([]);
  const timerRef = useRef<NodeJS.Timeout | null>(null);

  useEffect(() => {
    loadProfiles();
  }, []);

  async function loadProfiles() {
    const allProfiles = await getSpeakerProfiles();
    const user = await getUserProfile();
    setProfiles(allProfiles.filter(p => p.type !== 'user'));
    setUserProfile(user || null);
  }

  async function startRecording(forProfile: 'user' | string) {
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      const mediaRecorder = new MediaRecorder(stream);
      mediaRecorderRef.current = mediaRecorder;
      audioChunksRef.current = [];

      mediaRecorder.ondataavailable = (event) => {
        if (event.data.size > 0) {
          audioChunksRef.current.push(event.data);
        }
      };

      mediaRecorder.onstop = async () => {
        const audioBlob = new Blob(audioChunksRef.current, { type: 'audio/wav' });
        await handleRecordingComplete(forProfile, audioBlob);
        stream.getTracks().forEach(track => track.stop());
      };

      mediaRecorder.start(100); // Collect data every 100ms
      setIsRecording(true);
      setRecordingFor(forProfile);
      setRecordingProgress(0);

      // Progress timer
      const startTime = Date.now();
      timerRef.current = setInterval(() => {
        const elapsed = (Date.now() - startTime) / 1000;
        setRecordingProgress(Math.min(elapsed / ENROLLMENT_DURATION, 1));

        if (elapsed >= ENROLLMENT_DURATION) {
          stopRecording();
        }
      }, 100);

    } catch (error) {
      console.error('Failed to start recording:', error);
    }
  }

  function stopRecording() {
    if (timerRef.current) {
      clearInterval(timerRef.current);
      timerRef.current = null;
    }
    if (mediaRecorderRef.current && isRecording) {
      mediaRecorderRef.current.stop();
      setIsRecording(false);
    }
  }

  async function handleRecordingComplete(forProfile: 'user' | string, audioBlob: Blob) {
    // Convert to base64
    const reader = new FileReader();
    reader.onloadend = async () => {
      const base64 = reader.result as string;

      if (forProfile === 'user') {
        // Create or update user profile
        const profile: SpeakerProfile = {
          id: userProfile?.id || crypto.randomUUID(),
          name: 'You',
          type: 'user',
          color: '#3b82f6',
          createdAt: userProfile?.createdAt || Date.now(),
          lastSeenAt: Date.now(),
          enrollmentQuality: 'good',
        };
        await saveSpeakerProfile(profile);
        await saveAudioSample(profile.id, base64);

        // TODO: Extract embedding here (Phase 4)

        setUserProfile(profile);
      } else {
        // Update existing profile
        const profile = profiles.find(p => p.id === forProfile);
        if (profile) {
          profile.enrollmentQuality = 'good';
          profile.lastSeenAt = Date.now();
          await saveSpeakerProfile(profile);
          await saveAudioSample(profile.id, base64);
          loadProfiles();
        }
      }

      setRecordingFor(null);
    };
    reader.readAsDataURL(audioBlob);
  }

  return (
    <div className="space-y-6">
      {/* User Voice Profile */}
      <div className="space-y-3">
        <Header
          title="Your Voice Profile"
          description="Record your voice for automatic speaker identification in meetings."
        />

        <div className="p-4 border rounded-lg">
          {isRecording && recordingFor === 'user' ? (
            <div className="space-y-3">
              <div className="flex items-center gap-2">
                <div className="h-3 w-3 bg-red-500 rounded-full animate-pulse" />
                <span className="text-sm font-medium">Recording...</span>
              </div>
              <Progress value={recordingProgress * 100} className="h-2" />
              <p className="text-xs text-muted-foreground">
                {Math.round(recordingProgress * ENROLLMENT_DURATION)}/{ENROLLMENT_DURATION} seconds
              </p>
              <p className="text-xs text-muted-foreground">
                Speak naturally about anything - your day, what you see, or read something aloud.
              </p>
              <Button variant="destructive" size="sm" onClick={stopRecording}>
                <StopCircleIcon className="h-4 w-4 mr-2" />
                Stop Recording
              </Button>
            </div>
          ) : userProfile ? (
            <div className="flex items-center justify-between">
              <div className="flex items-center gap-3">
                <div className="h-10 w-10 rounded-full bg-primary/20 flex items-center justify-center">
                  <UserIcon className="h-5 w-5 text-primary" />
                </div>
                <div>
                  <p className="font-medium">Voice Enrolled</p>
                  <p className="text-xs text-muted-foreground">
                    Quality: {userProfile.enrollmentQuality}
                  </p>
                </div>
              </div>
              <Button variant="outline" size="sm" onClick={() => startRecording('user')}>
                <MicIcon className="h-4 w-4 mr-2" />
                Re-record
              </Button>
            </div>
          ) : (
            <div className="text-center py-4">
              <p className="text-sm text-muted-foreground mb-3">
                Record a 30-second voice sample to enable automatic identification.
              </p>
              <Button onClick={() => startRecording('user')}>
                <MicIcon className="h-4 w-4 mr-2" />
                Start Recording
              </Button>
            </div>
          )}
        </div>
      </div>

      {/* Other Speaker Profiles */}
      <div className="space-y-3">
        <Header
          title="Other Speaker Profiles"
          description="Add profiles for colleagues and clients you meet with regularly."
        />

        {profiles.length === 0 ? (
          <p className="text-sm text-muted-foreground">
            No other speakers enrolled yet.
          </p>
        ) : (
          <div className="space-y-2">
            {profiles.map(profile => (
              <div
                key={profile.id}
                className="flex items-center justify-between p-3 border rounded-lg"
              >
                <div className="flex items-center gap-3">
                  <div
                    className="h-8 w-8 rounded-full flex items-center justify-center text-white text-sm font-medium"
                    style={{ backgroundColor: profile.color }}
                  >
                    {profile.name.charAt(0).toUpperCase()}
                  </div>
                  <div>
                    <p className="font-medium text-sm">{profile.name}</p>
                    <p className="text-xs text-muted-foreground">
                      {profile.type} • {profile.enrollmentQuality === 'none' ? 'Not enrolled' : `Quality: ${profile.enrollmentQuality}`}
                    </p>
                  </div>
                </div>
                <div className="flex items-center gap-2">
                  <Button
                    variant="ghost"
                    size="icon"
                    onClick={() => startRecording(profile.id)}
                  >
                    <MicIcon className="h-4 w-4" />
                  </Button>
                  <Button
                    variant="ghost"
                    size="icon"
                    onClick={() => {
                      deleteSpeakerProfile(profile.id);
                      loadProfiles();
                    }}
                  >
                    <TrashIcon className="h-4 w-4" />
                  </Button>
                </div>
              </div>
            ))}
          </div>
        )}

        <Button variant="outline" size="sm">
          + Add Speaker Profile
        </Button>
      </div>
    </div>
  );
}
```

---

## Phase 4: Cross-Session Speaker Matching

### 4.1 Voice Embedding Extraction

**File:** `src/lib/functions/speaker-embedding.ts` (NEW)

Use TensorFlow.js for local, privacy-preserving voice embeddings:

```typescript
import * as tf from '@tensorflow/tfjs';

let embeddingModel: tf.LayersModel | null = null;
let isModelLoading = false;

/**
 * Load the speaker embedding model.
 * Call this early (e.g., when user visits settings) to pre-load.
 */
export async function loadEmbeddingModel(): Promise<void> {
  if (embeddingModel || isModelLoading) return;

  isModelLoading = true;
  try {
    // Use a pre-trained speaker verification model
    // Options:
    // - Host a converted model in your app
    // - Use a CDN-hosted model
    embeddingModel = await tf.loadLayersModel('/models/speaker-embedding/model.json');
  } catch (error) {
    console.error('Failed to load embedding model:', error);
    throw error;
  } finally {
    isModelLoading = false;
  }
}

/**
 * Extract a voice embedding from an audio blob.
 * Returns a 512-dimensional vector representing the speaker's voice.
 */
export async function extractEmbedding(audioBlob: Blob): Promise<number[]> {
  if (!embeddingModel) {
    await loadEmbeddingModel();
  }

  // Convert audio to mel spectrogram
  const audioBuffer = await audioBlob.arrayBuffer();
  const audioData = new Float32Array(audioBuffer);

  // Process audio into model-expected format
  // (This will depend on the specific model used)
  const inputTensor = preprocessAudio(audioData);

  // Get embedding
  const embeddingTensor = embeddingModel!.predict(inputTensor) as tf.Tensor;
  const embedding = await embeddingTensor.data();

  // Cleanup
  inputTensor.dispose();
  embeddingTensor.dispose();

  return Array.from(embedding);
}

/**
 * Calculate cosine similarity between two embedding vectors.
 * Returns a value between -1 and 1, where 1 means identical.
 */
export function cosineSimilarity(a: number[], b: number[]): number {
  if (a.length !== b.length) {
    throw new Error('Embeddings must have same length');
  }

  let dotProduct = 0;
  let normA = 0;
  let normB = 0;

  for (let i = 0; i < a.length; i++) {
    dotProduct += a[i] * b[i];
    normA += a[i] * a[i];
    normB += b[i] * b[i];
  }

  return dotProduct / (Math.sqrt(normA) * Math.sqrt(normB));
}

/**
 * Find the best matching profile for an embedding.
 */
export function findBestMatch(
  embedding: number[],
  profiles: Array<{ id: string; embedding: number[] }>
): { profileId: string; confidence: number } | null {
  let bestMatch: { profileId: string; confidence: number } | null = null;

  for (const profile of profiles) {
    if (!profile.embedding) continue;

    const similarity = cosineSimilarity(embedding, profile.embedding);
    const confidence = (similarity + 1) / 2;  // Normalize to 0-1

    if (!bestMatch || confidence > bestMatch.confidence) {
      bestMatch = { profileId: profile.id, confidence };
    }
  }

  return bestMatch;
}

function preprocessAudio(audioData: Float32Array): tf.Tensor {
  // Implementation depends on model requirements
  // Typically: resample to 16kHz, compute mel spectrogram, normalize
  // This is a placeholder
  return tf.tensor(audioData).reshape([1, -1]);
}
```

### 4.2 Speaker Matching Flow

```typescript
// In AutoSpeechVad.tsx or a new hook

async function processSpeechWithIdentification(
  audioBlob: Blob,
  assemblyAIResult: AssemblyAITranscriptResult
) {
  const profiles = await getSpeakerProfiles();
  const profilesWithEmbeddings = profiles.filter(p => p.embedding);

  // For each utterance, try to match speaker
  for (const utterance of assemblyAIResult.utterances) {
    // Extract embedding from utterance audio segment
    // (Would need to slice audio based on utterance timestamps)
    const utteranceAudio = await sliceAudio(audioBlob, utterance.start, utterance.end);
    const embedding = await extractEmbedding(utteranceAudio);

    // Find best match
    const match = findBestMatch(
      embedding,
      profilesWithEmbeddings.map(p => ({ id: p.id, embedding: p.embedding! }))
    );

    if (match) {
      if (match.confidence >= 0.7) {
        // High confidence - auto-assign
        utterance.matchedProfileId = match.profileId;
        utterance.matchConfidence = match.confidence;
      } else if (match.confidence >= 0.5) {
        // Medium confidence - needs confirmation
        utterance.matchedProfileId = match.profileId;
        utterance.matchConfidence = match.confidence;
        utterance.needsConfirmation = true;
      }
      // Low confidence (<0.5) - leave as generic speaker label
    }
  }
}
```

### 4.3 Confirmation Prompt UI

**File:** `src/components/SpeakerConfirmation.tsx` (NEW)

```tsx
interface SpeakerConfirmationProps {
  speakerId: string;
  suggestedProfile: SpeakerProfile;
  confidence: number;
  onConfirm: (confirmed: boolean) => void;
  onDismiss: () => void;
}

export function SpeakerConfirmation({
  speakerId,
  suggestedProfile,
  confidence,
  onConfirm,
  onDismiss,
}: SpeakerConfirmationProps) {
  return (
    <div className="mt-2 p-2 bg-muted/50 rounded border border-input/50 text-xs">
      <p className="text-muted-foreground mb-2">
        Is this {suggestedProfile.name}? ({Math.round(confidence * 100)}% match)
      </p>
      <div className="flex gap-2">
        <Button
          size="sm"
          variant="outline"
          className="h-6 text-xs"
          onClick={() => onConfirm(true)}
        >
          Yes, that's {suggestedProfile.type === 'user' ? 'me' : suggestedProfile.name}
        </Button>
        <Button
          size="sm"
          variant="ghost"
          className="h-6 text-xs"
          onClick={() => onConfirm(false)}
        >
          No, someone else
        </Button>
        <Button
          size="sm"
          variant="ghost"
          className="h-6 text-xs text-muted-foreground"
          onClick={onDismiss}
        >
          Always ask
        </Button>
      </div>
    </div>
  );
}
```

---

## Phase 5: Cost Tracking Integration

### 5.1 Update STT Pricing Config

**File:** `src/lib/storage/pricing.storage.ts`

Update AssemblyAI pricing to reflect Universal model with diarization:

```typescript
assemblyai: {
  "universal": { perMinute: 0.0025 },              // Base transcription
  "universal-diarization": { perMinute: 0.00283 }, // With speaker labels (+$0.00033)
  "nano": { perMinute: 0.002 },
  "*": { perMinute: 0.00283 },  // Default assumes diarization enabled
},
```

### 5.2 Emit STT Usage Events

In `assemblyai.function.ts`, emit usage after successful transcription:

```typescript
// After successful transcription
function emitSTTUsage(provider: string, model: string, audioSeconds: number): void {
  if (typeof window !== "undefined") {
    window.dispatchEvent(
      new CustomEvent("stt-usage-captured", {
        detail: { provider, model, audioSeconds },
      })
    );
  }
}

// Call after transcription completes
emitSTTUsage("assemblyai", "universal-diarization", audioBlob.size / 32000); // Estimate seconds
```

---

## Files to Create/Modify

### New Files

| File | Description |
|------|-------------|
| `src/lib/functions/assemblyai.function.ts` | AssemblyAI API handler with diarization |
| `src/lib/functions/speaker-embedding.ts` | TensorFlow.js voice embedding extraction |
| `src/lib/storage/speaker-profiles.ts` | IndexedDB storage for profiles & audio |
| `src/pages/dev/components/SpeakerProfiles.tsx` | Voice enrollment settings UI |
| `src/components/SpeakerConfirmation.tsx` | Inline confirmation prompt |
| `src/hooks/useSpeakerMatching.ts` | Hook for speaker identification logic |

### Modified Files

| File | Changes |
|------|---------|
| `src/config/constants.ts` | Add storage keys |
| `src/config/stt.constants.ts` | Add AssemblyAI provider |
| `src/types/completion.ts` | Add SpeakerInfo interface |
| `src/lib/functions/stt.function.ts` | Handle AssemblyAI special case, fallback logic |
| `src/lib/storage/pricing.storage.ts` | Update AssemblyAI pricing |
| `src/contexts/app.context.tsx` | Add diarization settings state |
| `src/types/context.type.ts` | Add diarization types |
| `src/hooks/useCompletion.ts` | Handle speaker info in transcripts |
| `src/pages/app/components/completion/AutoSpeechVad.tsx` | Integrate speaker matching |
| `src/pages/app/components/completion/MeetingTranscriptPanel.tsx` | Display speaker labels |
| `src/pages/dev/components/stt-configs/Providers.tsx` | Add diarization toggle |
| `src/pages/dev/index.tsx` | Add SpeakerProfiles section |

---

## Implementation Order

### Sprint 1: Basic AssemblyAI Integration (Phase 1)

1. Add AssemblyAI to `stt.constants.ts`
2. Create `assemblyai.function.ts` with upload/transcribe/poll
3. Update `stt.function.ts` to detect and handle AssemblyAI
4. Add fallback logic for missing API key
5. Add storage keys to `constants.ts`
6. Update `TranscriptEntry` type with `SpeakerInfo`
7. Update `MeetingTranscriptPanel.tsx` to show speaker labels
8. Add diarization enable toggle in settings
9. Update pricing config with AssemblyAI rates
10. Test end-to-end with basic "Speaker A/B/C" labels

### Sprint 2: Within-Session Tagging (Phase 2)

11. Add `sessionSpeakerMap` state to `useCompletion`
12. Create inline tagging popover component
13. Implement `assignSpeaker()` function
14. Propagate assignments to all matching entries
15. Test speaker assignment flow

### Sprint 3: Voice Enrollment (Phase 3)

16. Install `idb` package for IndexedDB
17. Create `speaker-profiles.ts` storage functions
18. Create `SpeakerProfiles.tsx` settings component
19. Implement 30-second voice recording UI
20. Store audio samples in IndexedDB
21. Add section to settings page
22. Test enrollment flow

### Sprint 4: Cross-Session Matching (Phase 4)

23. Research and select TensorFlow.js speaker model
24. Create `speaker-embedding.ts` with model loading
25. Implement embedding extraction
26. Implement cosine similarity matching
27. Create `SpeakerConfirmation.tsx` component
28. Integrate matching into `AutoSpeechVad.tsx`
29. Handle confirmation flow
30. Test end-to-end speaker recognition

### Sprint 5: Polish & Cost Tracking (Phase 5)

31. Verify cost tracking emits correct events
32. Test pricing calculations
33. Add error handling throughout
34. Add loading states
35. Performance optimization
36. Documentation

---

## Technical Considerations

### AssemblyAI API Latency

- Upload + transcription takes 2-5 seconds for short clips
- May feel slower than instant Whisper providers
- Mitigation: Show "Processing..." indicator with speaker detection icon

### Audio Storage Requirements

| Item | Size | Notes |
|------|------|-------|
| 30-second WAV sample | ~960 KB | Per enrolled speaker |
| 512-dim embedding | ~4 KB | After extraction |
| 5 enrolled speakers | ~5 MB | Total with samples |

IndexedDB handles this easily; localStorage would not.

### Embedding Model Size

- TensorFlow.js models: 10-50 MB
- Load lazily on first enrollment or matching
- Pre-load when user visits speaker settings

### Privacy

- All embedding extraction happens locally (TensorFlow.js)
- Audio samples never leave device except:
  - To AssemblyAI for transcription (required)
- Clear "Delete all voice data" option in settings

### Offline Behavior

- Enrollment works offline (audio stored locally)
- Matching works offline (embeddings compared locally)
- Transcription requires network (AssemblyAI API)

---

## Cost Analysis

### AssemblyAI Universal + Diarization: $0.00283/min

| Usage | Cost |
|-------|------|
| 1 hour | $0.17 |
| 10 hours/week | $1.70 |
| 40 hours/month | $6.80 |

### Comparison

| Provider | Cost/min | With Diarization |
|----------|----------|------------------|
| GPT-4o-mini-transcribe | $0.003 | Not available |
| **AssemblyAI Universal** | **$0.00283** | **Included** |
| Deepgram Nova-2 | $0.0043 | ~$0.005 |
| Google Cloud | $0.024 | ~$0.024 |

**Result:** AssemblyAI with diarization is **cheaper** than GPT-4o-mini-transcribe without it.

---

## Appendix: API Reference

### AssemblyAI Endpoints

```
POST https://api.assemblyai.com/v2/upload
  Headers: Authorization: <api_key>
  Body: Raw audio binary
  Response: { "upload_url": "..." }

POST https://api.assemblyai.com/v2/transcript
  Headers: Authorization: <api_key>
  Body: {
    "audio_url": "<upload_url>",
    "speaker_labels": true,
    "speakers_expected": 2  // optional
  }
  Response: { "id": "<transcript_id>", "status": "queued" }

GET https://api.assemblyai.com/v2/transcript/<id>
  Headers: Authorization: <api_key>
  Response: {
    "status": "completed",
    "text": "...",
    "utterances": [
      { "speaker": "A", "text": "...", "start": 0, "end": 5000, "confidence": 0.95 }
    ]
  }
```

### Sources

- [AssemblyAI Pricing](https://www.assemblyai.com/pricing)
- [AssemblyAI Speaker Diarization Docs](https://www.assemblyai.com/docs/speech-understanding/speaker-diarization)
- [AssemblyAI JavaScript SDK](https://www.npmjs.com/package/assemblyai)
