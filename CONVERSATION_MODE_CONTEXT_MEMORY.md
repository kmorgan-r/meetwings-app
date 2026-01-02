# Adding Context Memory to Conversation Mode

## Overview

This document describes how to add context memory (auto-summarization) to Conversation Mode in Meetwings. Currently, context memory only works with System Audio mode.

## Current State

### System Audio Mode (`useSystemAudio.ts`)
- Has a clear "end" point: `stopCapture()` function
- Summarization triggers when capture stops with 2+ exchanges
- Works well because there's an explicit session boundary

### Conversation Mode (`useCompletion.ts`)
- No clear "end" - conversations can go on indefinitely
- State tracked in: `currentConversationId`, `conversationHistory`
- Conversations switch via: `loadConversation()`, `startNewConversation()`
- **Currently does NOT trigger summarization**

---

## Implementation Plan

### Trigger Points

The best approach is to summarize when the user **leaves** a conversation:

| Function | Location | Trigger |
|----------|----------|---------|
| `loadConversation()` | Line ~357 | User switches to a different conversation |
| `startNewConversation()` | Line ~370 | User starts a fresh conversation |

Both indicate the user is "done" with the current conversation.

### Flow Diagram

```
┌─────────────────────────────────────────────────────────────────┐
│  User in Conversation A (4+ messages)                          │
│                                                                 │
│  User clicks "New Chat" or selects Conversation B              │
│            │                                                    │
│            ▼                                                    │
│  ┌─────────────────────────────────────────────────────────────┐
│  │  Before switching:                                          │
│  │  1. Check if current conversation has 2+ exchanges (4 msgs) │
│  │  2. If yes, trigger async summarization                     │
│  │  3. Don't block - continue with switch immediately          │
│  └─────────────────────────────────────────────────────────────┘
│            │                                                    │
│            ▼                                                    │
│  Switch to new conversation (non-blocking)                     │
│                                                                 │
│  Meanwhile, in background:                                      │
│  - AI generates summary                                         │
│  - Entities extracted                                           │
│  - Saved to database                                            │
└─────────────────────────────────────────────────────────────────┘
```

---

## Code Changes

### File: `src/hooks/useCompletion.ts`

#### 1. Add Imports

```typescript
import {
  summarizeConversation,
  shouldSummarize
} from "@/lib/functions/meeting-summarizer";
```

#### 2. Add Helper Function

```typescript
// Helper function to summarize the current conversation before switching
const summarizeCurrentConversation = useCallback(async () => {
  // Need at least 2 exchanges (4 messages: 2 user + 2 assistant)
  if (!state.currentConversationId || state.conversationHistory.length < 4) {
    return;
  }

  // Convert ChatMessage[] to Message[] format
  const messages = state.conversationHistory.map(msg => ({
    role: msg.role,
    content: msg.content,
  }));

  // Check if should summarize (has enough exchanges)
  if (!shouldSummarize(messages)) {
    return;
  }

  // Get provider config for AI summarization
  const useMeetwingsAPI = await shouldUseMeetwingsAPI();
  const provider = allAiProviders.find(p => p.id === selectedAIProvider.provider);

  // Trigger summarization asynchronously (don't await - non-blocking)
  summarizeConversation(
    state.currentConversationId,
    messages,
    useMeetwingsAPI ? undefined : provider ? {
      provider,
      selectedProvider: selectedAIProvider,
    } : undefined
  ).then(success => {
    if (success) {
      console.log("[Context Memory] Conversation summarized successfully");
    }
  }).catch(error => {
    console.error("[Context Memory] Failed to summarize conversation:", error);
  });
}, [
  state.currentConversationId,
  state.conversationHistory,
  allAiProviders,
  selectedAIProvider
]);
```

#### 3. Modify `loadConversation`

```typescript
const loadConversation = useCallback((conversation: ChatConversation) => {
  // Summarize current conversation before switching
  summarizeCurrentConversation();

  currentConversationIdRef.current = conversation.id;
  setState((prev) => ({
    ...prev,
    currentConversationId: conversation.id,
    conversationHistory: conversation.messages,
    input: "",
    response: "",
    error: null,
    isLoading: false,
  }));
}, [summarizeCurrentConversation]);
```

#### 4. Modify `startNewConversation`

```typescript
const startNewConversation = useCallback(() => {
  // Summarize current conversation before starting new
  summarizeCurrentConversation();

  currentConversationIdRef.current = null;
  setState((prev) => ({
    ...prev,
    currentConversationId: null,
    conversationHistory: [],
    input: "",
    response: "",
    error: null,
    isLoading: false,
    attachedFiles: [],
  }));
}, [summarizeCurrentConversation]);
```

---

## Key Considerations

| Consideration | Solution |
|---------------|----------|
| Don't block UI | Use `.then()` pattern (non-blocking async) |
| Avoid duplicates | `summarizeConversation` already checks if summary exists via `getMeetingSummaryByConversation` |
| Minimum exchanges | Only summarize if 4+ messages (2 user + 2 assistant) |
| Provider config | Reuse existing `selectedAIProvider` and `allAiProviders` from context |

### Message Format Mapping

The `ChatMessage` type in useCompletion:
```typescript
interface ChatMessage {
  id: string;
  role: "user" | "assistant" | "system";
  content: string;
  timestamp: number;
}
```

The `Message` type expected by summarizer:
```typescript
interface Message {
  role: "user" | "assistant" | "system";
  content: string;
}
```

Mapping is simple - just extract `role` and `content`:
```typescript
const messages = conversationHistory.map(m => ({
  role: m.role,
  content: m.content
}));
```

---

## Testing Checklist

- [ ] Start a new conversation, have 2+ exchanges, start another new conversation
  - Verify first conversation gets summarized
- [ ] Have a conversation, then select a different conversation from history
  - Verify previous conversation gets summarized
- [ ] Check Context Memory page shows the new summaries
- [ ] Verify entities are extracted correctly
- [ ] Confirm no duplicate summaries are created for same conversation
- [ ] Ensure UI is not blocked during summarization

---

## Future Enhancements

1. **App close/window hide**: Could also trigger summarization when app is about to close
2. **Idle timeout**: Summarize after X minutes of inactivity in a conversation
3. **Manual trigger**: Add a button to manually summarize current conversation
4. **Backfill existing chats**: Process historical conversations that haven't been summarized
