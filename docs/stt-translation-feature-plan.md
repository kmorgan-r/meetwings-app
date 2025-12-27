# Dual-Language STT Translation Feature Plan

## Overview

This feature adds real-time translation of STT (speech-to-text) transcriptions for users who need to see speech in both the original language (English) and a translated language (e.g., Persian/Farsi).

**Use Case:** A user whose partner's English isn't strong can enable translation so they can read along with speech transcriptions in their native language.

## User Choices

| Decision | Choice |
|----------|--------|
| Translation method | LLM-based (uses existing AI provider) |
| Display locations | Everywhere (meeting mode, normal mode, chat) |
| Content to translate | STT transcription only (not AI responses) |

---

## Implementation Plan

### Phase 1: Storage & Types

**File: `src/config/constants.ts`**

Add new storage keys:
```typescript
// In STORAGE_KEYS object
STT_TRANSLATION_ENABLED: "stt_translation_enabled",
STT_TRANSLATION_LANGUAGE: "stt_translation_language",
```

**File: `src/config/stt.constants.ts`**

Add default values:
```typescript
export const DEFAULT_TRANSLATION_ENABLED = false;
export const DEFAULT_TRANSLATION_LANGUAGE = "fa"; // Persian (Farsi)

// Reuse existing language list for translation targets
export const TRANSLATION_LANGUAGES = STT_LANGUAGES;
```

**File: `src/types/context.type.ts`**

Add to `IContextType`:
```typescript
// STT Translation settings
sttTranslationEnabled: boolean;
setSttTranslationEnabled: (enabled: boolean) => void;
sttTranslationLanguage: string;
setSttTranslationLanguage: (language: string) => void;
```

---

### Phase 2: Context State Management

**File: `src/contexts/app.context.tsx`**

Add state initialization:
```typescript
// STT Translation State
const [sttTranslationEnabled, setSttTranslationEnabledState] = useState<boolean>(
  safeLocalStorage.getItem(STORAGE_KEYS.STT_TRANSLATION_ENABLED) === "true"
);

const [sttTranslationLanguage, setSttTranslationLanguageState] = useState<string>(
  safeLocalStorage.getItem(STORAGE_KEYS.STT_TRANSLATION_LANGUAGE) || DEFAULT_TRANSLATION_LANGUAGE
);
```

Add setter functions:
```typescript
const setSttTranslationEnabled = (enabled: boolean) => {
  setSttTranslationEnabledState(enabled);
  safeLocalStorage.setItem(STORAGE_KEYS.STT_TRANSLATION_ENABLED, String(enabled));
  loadData();
};

const setSttTranslationLanguage = (language: string) => {
  setSttTranslationLanguageState(language);
  safeLocalStorage.setItem(STORAGE_KEYS.STT_TRANSLATION_LANGUAGE, language);
  loadData();
};
```

Update `loadData()` function and add to context value.

---

### Phase 3: Translation Function

**File: `src/lib/functions/translation.function.ts`** (NEW FILE)

```typescript
import { fetchAIResponse } from "./ai-response.function";
import { TYPE_PROVIDER } from "@/types";

export interface TranslationParams {
  text: string;
  targetLanguage: string;
  targetLanguageName: string;
  provider: TYPE_PROVIDER | undefined;
  selectedProvider: {
    provider: string;
    variables: Record<string, string>;
  };
  signal?: AbortSignal;
}

export interface TranslationResult {
  success: boolean;
  translation?: string;
  error?: string;
}

/**
 * Translates text using the configured AI provider.
 * Returns the complete translation as a string.
 */
export async function translateText(params: TranslationParams): Promise<TranslationResult> {
  const { text, targetLanguageName, provider, selectedProvider, signal } = params;

  const translationPrompt = `Translate the following text to ${targetLanguageName}.
Only output the translation, nothing else. Do not include explanations or notes.

Text to translate:
${text}`;

  try {
    let translation = "";

    for await (const chunk of fetchAIResponse({
      provider,
      selectedProvider,
      systemPrompt: "You are a professional translator. Only output the translation, nothing else.",
      history: [],
      userMessage: translationPrompt,
      imagesBase64: [],
      signal,
    })) {
      if (signal?.aborted) {
        return { success: false, error: "Translation cancelled" };
      }
      translation += chunk;
    }

    return {
      success: true,
      translation: translation.trim(),
    };
  } catch (error) {
    console.error("Translation failed:", error);
    return {
      success: false,
      error: error instanceof Error ? error.message : "Translation failed",
    };
  }
}
```

**File: `src/lib/functions/index.ts`**

Add export:
```typescript
export * from "./translation.function";
```

---

### Phase 4: Translation Hook

**File: `src/hooks/useTranslation.ts`** (NEW FILE)

```typescript
import { useCallback, useRef } from "react";
import { useApp } from "@/contexts";
import { translateText, TranslationResult } from "@/lib";
import { STT_LANGUAGES } from "@/config";

export const useTranslation = () => {
  const {
    sttTranslationEnabled,
    sttTranslationLanguage,
    selectedAIProvider,
    allAiProviders,
  } = useApp();

  const abortControllerRef = useRef<AbortController | null>(null);

  const getLanguageName = useCallback((code: string) => {
    const lang = STT_LANGUAGES.find(l => l.code === code);
    return lang?.name || code;
  }, []);

  const translate = useCallback(async (text: string): Promise<TranslationResult> => {
    if (!sttTranslationEnabled) {
      return { success: false, error: "Translation disabled" };
    }

    if (!text.trim()) {
      return { success: false, error: "Empty text" };
    }

    // Cancel any pending translation
    if (abortControllerRef.current) {
      abortControllerRef.current.abort();
    }
    abortControllerRef.current = new AbortController();

    const provider = allAiProviders.find(p => p.id === selectedAIProvider.provider);

    return translateText({
      text,
      targetLanguage: sttTranslationLanguage,
      targetLanguageName: getLanguageName(sttTranslationLanguage),
      provider,
      selectedProvider: selectedAIProvider,
      signal: abortControllerRef.current.signal,
    });
  }, [sttTranslationEnabled, sttTranslationLanguage, selectedAIProvider, allAiProviders, getLanguageName]);

  const cancelTranslation = useCallback(() => {
    if (abortControllerRef.current) {
      abortControllerRef.current.abort();
      abortControllerRef.current = null;
    }
  }, []);

  return {
    translate,
    cancelTranslation,
    isEnabled: sttTranslationEnabled,
    targetLanguage: sttTranslationLanguage,
    targetLanguageName: getLanguageName(sttTranslationLanguage),
  };
};
```

**File: `src/hooks/index.ts`**

Add export:
```typescript
export * from "./useTranslation";
```

---

### Phase 5: Update useCompletion for Meeting Mode

**File: `src/hooks/useCompletion.ts`**

Add new interface for transcript entries:
```typescript
interface TranscriptEntry {
  original: string;
  translation?: string;
  translationError?: string;
  timestamp: number;
}
```

Change state type:
```typescript
// Before
const [meetingTranscript, setMeetingTranscript] = useState<string[]>([]);

// After
const [meetingTranscript, setMeetingTranscript] = useState<TranscriptEntry[]>([]);
```

Update `addMeetingTranscript`:
```typescript
const addMeetingTranscript = useCallback((
  transcript: string,
  translation?: string,
  translationError?: string
) => {
  if (!transcript.trim()) return;

  const entry: TranscriptEntry = {
    original: transcript,
    translation,
    translationError,
    timestamp: Date.now(),
  };

  setMeetingTranscript((prev) => [...prev, entry]);
  // ... rest of existing logic for conversation history
}, []);
```

Add function to update translation for existing entry:
```typescript
const updateTranscriptTranslation = useCallback((
  timestamp: number,
  translation: string
) => {
  setMeetingTranscript((prev) =>
    prev.map(entry =>
      entry.timestamp === timestamp
        ? { ...entry, translation }
        : entry
    )
  );
}, []);
```

**File: `src/types/completion.hook.ts`**

Update type definition:
```typescript
// Add TranscriptEntry interface
interface TranscriptEntry {
  original: string;
  translation?: string;
  translationError?: string;
  timestamp: number;
}

// Update in UseCompletionReturn
meetingTranscript: TranscriptEntry[];
addMeetingTranscript: (transcript: string, translation?: string, error?: string) => void;
updateTranscriptTranslation: (timestamp: number, translation: string) => void;
```

---

### Phase 6: Update STT Components

**File: `src/pages/app/components/completion/AutoSpeechVad.tsx`**

Import translation hook and trigger translation:
```typescript
import { useTranslation } from "@/hooks";
import { useApp } from "@/contexts";

// Inside component
const { sttTranslationEnabled } = useApp();
const { translate } = useTranslation();

// In onSpeechEnd handler, after getting transcription:
if (transcription) {
  if (meetingAssistMode && addMeetingTranscript) {
    const timestamp = Date.now();

    // Add transcript immediately (no translation yet)
    addMeetingTranscript(transcription);

    // Translate in background if enabled
    if (sttTranslationEnabled) {
      translate(transcription).then(result => {
        if (result.success && result.translation) {
          updateTranscriptTranslation(timestamp, result.translation);
        }
      });
    }
  } else {
    // Normal mode: submit immediately, translation handled in display
    submit(transcription);
  }
}
```

**File: `src/pages/chats/components/AudioRecorder.tsx`**

Add translation support:
```typescript
import { useTranslation } from "@/hooks";
import { useApp } from "@/contexts";

// Inside component
const { sttTranslationEnabled } = useApp();
const { translate } = useTranslation();

// In handleSend, after getting transcription:
const text = await fetchSTT({ ... });

if (sttTranslationEnabled) {
  const result = await translate(text);
  onTranscriptionComplete(text, result.success ? result.translation : undefined);
} else {
  onTranscriptionComplete(text);
}
```

---

### Phase 7: Update Display Components

**File: `src/pages/app/components/completion/MeetingTranscriptPanel.tsx`**

Update to display dual-language transcripts:
```typescript
import { useApp } from "@/contexts";
import { Loader2 } from "lucide-react";

// Inside component
const { sttTranslationEnabled } = useApp();

// In render:
{meetingTranscript.map((entry, index) => (
  <div
    key={index}
    className="p-3 rounded-lg bg-muted/50 text-sm border-l-2 border-primary/30"
  >
    <div className="flex items-center gap-2 mb-1">
      <span className="text-[10px] text-muted-foreground font-medium">
        #{index + 1}
      </span>
      <span className="text-[10px] text-muted-foreground">
        {new Date(entry.timestamp).toLocaleTimeString([], {
          hour: "2-digit",
          minute: "2-digit",
        })}
      </span>
    </div>

    {/* Original text */}
    <p className="text-foreground">{entry.original}</p>

    {/* Translation section */}
    {sttTranslationEnabled && (
      <div className="mt-2 pt-2 border-t border-muted">
        {entry.translation ? (
          <p className="text-foreground/80 italic" dir="auto">
            {entry.translation}
          </p>
        ) : entry.translationError ? (
          <p className="text-destructive/70 text-xs">
            Translation unavailable
          </p>
        ) : (
          <div className="flex items-center gap-1 text-muted-foreground text-xs">
            <Loader2 className="h-3 w-3 animate-spin" />
            <span>Translating...</span>
          </div>
        )}
      </div>
    )}
  </div>
))}
```

**File: `src/pages/app/components/completion/Input.tsx`**

For user messages, optionally show translation:
```typescript
// In user message display section
{!keepEngaged && lastUserMessage && response && (
  <div className="mb-4 p-3 rounded-lg text-sm bg-primary/10 border-l-4 border-primary">
    <Markdown>{lastUserMessage.content}</Markdown>

    {/* Show translation if available and enabled */}
    {sttTranslationEnabled && lastUserMessage.translation && (
      <div className="mt-2 pt-2 border-t border-primary/20">
        <p className="text-foreground/80 italic text-sm" dir="auto">
          {lastUserMessage.translation}
        </p>
      </div>
    )}
  </div>
)}
```

**File: `src/pages/chats/components/View.tsx`**

Update message display to show translations when available.

---

### Phase 8: Settings UI

**File: `src/pages/dev/components/stt-configs/Providers.tsx`**

Add translation settings section after STT Language selection:
```typescript
import { Switch } from "@/components";
import { TRANSLATION_LANGUAGES } from "@/config";

// Inside component
const {
  sttTranslationEnabled,
  setSttTranslationEnabled,
  sttTranslationLanguage,
  setSttTranslationLanguage
} = useApp();

// In render, after STT Language selection:
{/* Translation Settings */}
<div className="space-y-4 pt-4 border-t">
  <div className="space-y-2">
    <Header
      title="Translation"
      description="Enable real-time translation of your speech transcriptions to a second language."
    />

    <div className="flex items-center justify-between py-2">
      <div className="flex flex-col gap-1">
        <span className="text-sm font-medium">Enable Translation</span>
        <span className="text-xs text-muted-foreground">
          Show translated version alongside original speech
        </span>
      </div>
      <Switch
        checked={sttTranslationEnabled}
        onCheckedChange={setSttTranslationEnabled}
      />
    </div>
  </div>

  {sttTranslationEnabled && (
    <div className="space-y-2">
      <Header
        title="Target Language"
        description="Select the language to translate your speech into."
      />
      <Selection
        selected={sttTranslationLanguage}
        options={TRANSLATION_LANGUAGES.map((lang) => ({
          label: lang.name,
          value: lang.code,
        }))}
        placeholder="Choose target language"
        onChange={(value) => {
          setSttTranslationLanguage(value);
        }}
      />
    </div>
  )}
</div>
```

---

## Critical Files Summary

| File | Change Type |
|------|-------------|
| `src/config/constants.ts` | Add 2 storage keys |
| `src/config/stt.constants.ts` | Add defaults and TRANSLATION_LANGUAGES |
| `src/types/context.type.ts` | Add 4 type properties |
| `src/contexts/app.context.tsx` | Add state + setters |
| `src/lib/functions/translation.function.ts` | **NEW** - Translation logic |
| `src/lib/functions/index.ts` | Export new function |
| `src/hooks/useTranslation.ts` | **NEW** - Translation hook |
| `src/hooks/index.ts` | Export new hook |
| `src/hooks/useCompletion.ts` | Change meetingTranscript type |
| `src/types/completion.hook.ts` | Update type definitions |
| `src/pages/app/components/completion/AutoSpeechVad.tsx` | Trigger translation |
| `src/pages/app/components/completion/MeetingTranscriptPanel.tsx` | Dual display |
| `src/pages/app/components/completion/Input.tsx` | Show translation |
| `src/pages/chats/components/AudioRecorder.tsx` | Handle translation |
| `src/pages/chats/components/View.tsx` | Display translation |
| `src/pages/dev/components/stt-configs/Providers.tsx` | Settings UI |

---

## Design Decisions

1. **Async Translation**: Original text displays immediately; translation appears when ready. This prevents blocking the UI.

2. **Graceful Degradation**: Translation errors don't block original display - users always see their speech.

3. **Translation is Display-Only**: The AI still receives the original English text for processing. Translation is purely for the user to read along.

4. **Uses Existing AI Provider**: No additional API keys or configuration needed - uses whatever AI provider is already configured.

5. **Persian Default**: Target language defaults to Persian (fa) since that's the primary use case, but users can select any supported language.

6. **RTL Support**: Uses `dir="auto"` on translation text to properly display right-to-left languages like Persian and Arabic.

7. **Cancellation Support**: Uses AbortController so new speech cancels pending translations, preventing race conditions.

---

## Error Handling

- Translation timeout after request completes or is cancelled
- Translation errors show small "Translation unavailable" indicator
- AbortController cancels pending translations on new speech input
- Errors logged to console but not shown intrusively to user
- If AI provider not configured, translation silently fails (original still shows)
