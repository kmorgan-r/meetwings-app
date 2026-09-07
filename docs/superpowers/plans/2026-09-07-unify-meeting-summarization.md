# Unify Meeting Summarization Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the two independent AI-summarization code paths (Odoo's transcript-based `generateMeetingLogSummary` and Context Memory's chat-based `generateConversationSummary`) with one shared, transcript-sourced `ensureMeetingSummary` helper backed by the existing `meeting_summaries` table, and use it to add an inline "expand to see summary" affordance on the meetings dashboard.

**Architecture:** A single new function, `ensureMeetingSummary(conversationId, entries, providerConfig, minEntries)`, becomes the one place that looks up a cached summary, decides whether to call the AI, and decides whether to persist the result. Every existing trigger (the Odoo push, `summarizeCurrentConversation`, the "Update Knowledge" backfill, and system-audio capture) is rewired to call it instead of the two functions it replaces. A new migration backfills `meeting_log_queue.summary_json` into `meeting_summaries` and drops the column, along with every `QUEUE_SQL` string that still names it. The dashboard's expand button is a small, row-local fetch-on-click component reusing a `SummaryContent` piece extracted from `SummaryDetail.tsx`.

**Tech Stack:** React 19 + TypeScript (strict), Tauri 2 (Rust) + `@tauri-apps/plugin-sql` (SQLite), Vitest for tests, `sql.js` for migration tests, Tailwind + shadcn/ui for the new UI.

**Spec:** `docs/superpowers/specs/2026-09-07-unify-meeting-summarization-design.md` — read it alongside this plan. Every "why" not repeated here lives there.

## Global Constraints

- Every summarization call must never throw — a summarization failure must not become a push failure or a lost meeting (spec: shared helper, step 5).
- The canonical `meeting_summaries` row is shared by every caller and keyed by `conversation_id` — only ONE summary is ever persisted per conversation (spec: What this design settles).
- The Odoo path's AI-call floor stays at `entries.length >= 1` (a short meeting still gets a real summary in its note); the PERSIST floor is a separate, fixed `entries.length >= 4` regardless of caller (spec: The shared summarization helper, step 4).
- `DbMeetingLogRow`'s conversation field is `conversation_id` (snake_case) — never `conversationId`.
- This repo's type-check script is `npm run type-check`, not `check:types`. Test files under `src/tests/**` are excluded from both `tsconfig.json` and `eslint.config.js` — they are neither type-checked nor linted by the standard gate, so a test file's own internal type errors will not be caught by `npm run type-check`.
- This repo's dev DB has a known `_sqlx_migrations` checksum-drift issue whenever a migration file changes after the dev DB already recorded it — if you hit this, patch the checksum via `node:sqlite` across ALL versions per existing project practice, never `sql.js`.
- Never hand-edit a `.sql` file under `src-tauri/src/db/migrations/` once it has a version below 16 assigned in `src-tauri/src/db/main.rs` — sqlx checksums applied migrations, and a changed checksum fails `Database.load` for every existing user.

---

## File Structure

**Create:**
- `src-tauri/src/db/migrations/meeting-log-queue-v2.sql` — migration 16: backfill `meeting_log_queue.summary_json` into `meeting_summaries`, then drop the column.
- `src/tests/helpers/migration-16.ts` — sql.js test helper for migration 16 (mirrors `src/tests/helpers/migration-14.ts`).
- `src/tests/ensure-meeting-summary.test.ts` — tests for the new shared helper and adapter.
- `src/pages/context-memory/components/SummaryContent.tsx` — presentational summary renderer extracted from `SummaryDetail.tsx`, shared with the dashboard expand.
- `src/tests/summary-content.render.test.tsx` — render test for the extracted component and the two places that use it.

**Modify:**
- `src/lib/functions/meeting-summarizer.ts` — replace `generateConversationSummary`, `generateMeetingLogSummary`, `summarizeConversation`, `shouldSummarize`, `formatConversationForSummary`, `countExchanges`, `MIN_EXCHANGES_FOR_SUMMARY` with `ensureMeetingSummary` and `chatMessagesToTranscriptEntries`. `saveSummarizationResult`, `parseSummarizationResponse`, `extractJsonObject`, `SUMMARIZATION_PROMPT` are unchanged.
- `src-tauri/src/db/main.rs` — register migration 16.
- `src-tauri/src/db/migration_tests.rs` — add a binding test for migration 16.
- `src/types/odoo.ts` — remove `summary_json` from `DbMeetingLogRow`.
- `src/lib/database/meeting-log.action.ts` — remove `setSummaryJson`, `QUEUE_SQL.setSummary`, and every `summary_json` reference in `deleteRow`, `deleteTerminalRow`, `prune`, `listActionable`; remove `summary_json` from `NewQueueRow` (it was never there — confirm) and from any row-construction helper.
- `src/lib/odoo/meeting-log-push.ts` — widen `PushDeps.summarize`, change `pushQueuedRow`'s call site, delete the row-level `row.summary_json`/`setSummaryJson` cache block.
- `src/hooks/useMeetingLog.ts` — widen the `summarize` `useCallback` and its two call sites (`pushHeldRow`, the closure passed to `runMeetingLogSweep`).
- `src/hooks/useCompletion.ts` — add `conversationTranscriptStartRef`, rewrite `summarizeCurrentConversation`, update its dependency array and inline guard, set the new ref in `loadConversation`, `startNewConversation`, `addMeetingTranscript`, `addMeetingTranscriptEntries`.
- `src/lib/functions/knowledge-compactor.ts` — use `chatMessagesToTranscriptEntries` + `ensureMeetingSummary` in `summarizePendingConversations`, in place of `summarizeConversation`/`shouldSummarize`.
- `src/hooks/useSystemAudio.ts` — same, in the capture-stop handler.
- `src/pages/context-memory/components/SummaryDetail.tsx` — render `SummaryContent` instead of inline JSX; update the metadata footer's wording.
- `src/pages/meetings/components/QueueRow.tsx` — row-local expand affordance, gated on `row.conversation_id !== null`.
- `src/pages/meetings/components/ConversationRow.tsx` — row-local expand affordance, always available (uses `id`).
- `src/tests/odoo-meeting-log-push.test.ts` — update `summarize` fakes to the new signature; add the no-`summary_json`-block and multi-row-sweep tests.
- `src/tests/meeting-log.action.test.ts` — remove `summary_json` from `seed()`'s default row and every override; rewrite two `describe("deleteQueueRow")` tests and two `describe("pruneTranscripts")` tests that assert on the removed column.
- `src/tests/meeting-log-actions.test.ts`, `src/tests/meeting-log-page.test.tsx`, `src/tests/meetings-page.test.tsx`, `src/tests/odoo-meeting-log-sweep.test.ts` — remove the `summary_json: null` fixture field.

---

### Task 1: `ensureMeetingSummary` — the shared summarization helper

**Files:**
- Modify: `src/lib/functions/meeting-summarizer.ts`
- Test: `src/tests/ensure-meeting-summary.test.ts`

**Interfaces:**
- Produces: `ensureMeetingSummary(conversationId: string | null, entries: TranscriptEntry[], providerConfig?: ProviderConfig, minEntries: number = 4): Promise<SummarizationResult | null>` — exported from `meeting-summarizer.ts`, re-exported via `@/lib/functions`.
- Produces: `chatMessagesToTranscriptEntries(messages: SummarizableMessage[]): TranscriptEntry[]`, where `SummarizableMessage = { role: "user" | "assistant" | "system"; content: string; timestamp: number; speaker?: SpeakerInfo; audioSource?: "microphone" | "system" }` (also exported).
- Consumes (unchanged, already exist): `SUMMARIZATION_PROMPT`, `parseSummarizationResponse`, `saveSummarizationResult` (all in this file); `renderTranscript` (`@/lib/odoo/meeting-log`); `fetchAIResponse` (`./ai-response.function`); `shouldUseMeetwingsAPI` (`./meetwings.api`); `getMeetingSummaryByConversation` (`@/lib/database`).

- [ ] **Step 1: Write the failing tests**

Create `src/tests/ensure-meeting-summary.test.ts`:

```ts
import { beforeEach, describe, expect, it, vi } from "vitest";

const { fetchAIResponse, shouldUseMeetwingsAPI } = vi.hoisted(() => ({
  fetchAIResponse: vi.fn(),
  shouldUseMeetwingsAPI: vi.fn(async () => true),
}));
vi.mock("@/lib/functions/ai-response.function", () => ({ fetchAIResponse }));
vi.mock("@/lib/functions/meetwings.api", () => ({ shouldUseMeetwingsAPI }));

const {
  createMeetingSummary,
  createOrUpdateKnowledgeEntity,
  createEntityMention,
  getMeetingSummaryByConversation,
  applySummaryTitleToConversation,
} = vi.hoisted(() => ({
  createMeetingSummary: vi.fn(),
  createOrUpdateKnowledgeEntity: vi.fn(async () => ({ id: "entity-1" })),
  createEntityMention: vi.fn(async () => true),
  getMeetingSummaryByConversation: vi.fn(async () => null),
  applySummaryTitleToConversation: vi.fn(async () => true),
}));
vi.mock("@/lib/database", () => ({
  createMeetingSummary,
  createOrUpdateKnowledgeEntity,
  createEntityMention,
  getMeetingSummaryByConversation,
  applySummaryTitleToConversation,
}));
vi.mock("@/lib/storage", () => ({
  getUserIdentity: vi.fn(() => null),
  hasUserIdentity: vi.fn(() => false),
}));

import {
  ensureMeetingSummary,
  chatMessagesToTranscriptEntries,
} from "@/lib/functions/meeting-summarizer";
import type { MeetingSummary, TranscriptEntry } from "@/types";

const ENTRIES: TranscriptEntry[] = [
  { original: "line one", timestamp: 1000 },
  { original: "line two", timestamp: 2000 },
  { original: "line three", timestamp: 3000 },
  { original: "line four", timestamp: 4000 },
];

const ENTRIES_LABELLED: TranscriptEntry[] = [
  { original: "we should ship on Friday", timestamp: 1000, audioSource: "microphone" },
  { original: "agreed", timestamp: 2000, audioSource: "system" },
  { original: "third line to clear minEntries", timestamp: 3000, audioSource: "microphone" },
  { original: "fourth line to clear minEntries", timestamp: 4000, audioSource: "system" },
];

function stream(chunks: string[]) {
  return async function* () {
    for (const c of chunks) yield c;
  };
}

const EXISTING: MeetingSummary = {
  id: "summary-1",
  conversationId: "conv-1",
  summary: "Cached summary text",
  title: "Cached Title",
  topics: ["topic"],
  goals: [],
  actionItems: [],
  nextSteps: [],
  decisions: [],
  teamUpdates: [],
  participants: [],
  exchangeCount: 4,
  durationSeconds: null,
  meetingStartedAt: null,
  meetingEndedAt: null,
  createdAt: 1,
  updatedAt: 1,
};

beforeEach(() => {
  fetchAIResponse.mockReset();
  shouldUseMeetwingsAPI.mockResolvedValue(true);
  createMeetingSummary
    .mockReset()
    .mockResolvedValue({ id: "new-summary", conversationId: "conv-1" });
  getMeetingSummaryByConversation.mockReset().mockResolvedValue(null);
  createOrUpdateKnowledgeEntity.mockClear();
  createEntityMention.mockClear();
});

describe("ensureMeetingSummary", () => {
  it("returns the cached summary's real fields on a cache hit, without calling the AI", async () => {
    getMeetingSummaryByConversation.mockResolvedValue(EXISTING);
    const result = await ensureMeetingSummary("conv-1", ENTRIES);
    expect(result).toMatchObject({
      title: "Cached Title",
      summary: "Cached summary text",
      topics: ["topic"],
    });
    expect(fetchAIResponse).not.toHaveBeenCalled();
  });

  it("skips the AI call when entries.length is below the default minEntries (4)", async () => {
    const result = await ensureMeetingSummary("conv-1", ENTRIES.slice(0, 3));
    expect(result).toBeNull();
    expect(fetchAIResponse).not.toHaveBeenCalled();
  });

  it("generates when entries.length meets a lower minEntries passed by the Odoo caller", async () => {
    fetchAIResponse.mockImplementation(stream(['{"summary":"short but real"}']));
    const result = await ensureMeetingSummary("conv-1", ENTRIES.slice(0, 1), undefined, 1);
    expect(result?.summary).toBe("short but real");
    expect(fetchAIResponse).toHaveBeenCalled();
  });

  it("generates but does NOT persist when entries.length is below the fixed 4-entry persist floor", async () => {
    fetchAIResponse.mockImplementation(stream(['{"summary":"short but real"}']));
    const result = await ensureMeetingSummary("conv-1", ENTRIES.slice(0, 2), undefined, 1);
    expect(result?.summary).toBe("short but real");
    expect(createMeetingSummary).not.toHaveBeenCalled();
  });

  it("generates and persists when entries.length meets the 4-entry persist floor", async () => {
    fetchAIResponse.mockImplementation(stream(['{"summary":"full meeting"}']));
    const result = await ensureMeetingSummary("conv-1", ENTRIES);
    expect(result?.summary).toBe("full meeting");
    expect(createMeetingSummary).toHaveBeenCalledWith(
      expect.objectContaining({ conversationId: "conv-1", exchangeCount: 4 })
    );
  });

  it("returns the generated result even when conversationId is null (no persist, no cache lookup)", async () => {
    fetchAIResponse.mockImplementation(stream(['{"summary":"anon meeting"}']));
    const result = await ensureMeetingSummary(null, ENTRIES);
    expect(result?.summary).toBe("anon meeting");
    expect(createMeetingSummary).not.toHaveBeenCalled();
    expect(getMeetingSummaryByConversation).not.toHaveBeenCalled();
  });

  it("returns the generated result even when the persist write fails", async () => {
    fetchAIResponse.mockImplementation(stream(['{"summary":"persist will fail"}']));
    createMeetingSummary.mockRejectedValue(new Error("db write failed"));
    const result = await ensureMeetingSummary("conv-1", ENTRIES);
    expect(result?.summary).toBe("persist will fail");
  });

  it("returns null rather than throwing on an AI failure", async () => {
    fetchAIResponse.mockImplementation(() => {
      throw new Error("Error in fetchAIResponse: 429");
    });
    expect(await ensureMeetingSummary("conv-1", ENTRIES)).toBeNull();
  });

  it("returns null rather than throwing when no provider is configured", async () => {
    shouldUseMeetwingsAPI.mockResolvedValue(false);
    expect(await ensureMeetingSummary("conv-1", ENTRIES)).toBeNull();
    expect(fetchAIResponse).not.toHaveBeenCalled();
  });

  it("sends a SPEAKER-labelled transcript (You/Guest from audioSource), not User/Assistant roles", async () => {
    // renderTranscript labels lines via speakerLabelFor's audioSource mapping
    // (microphone -> You, system -> Guest) - formatConversationForSummary's
    // msg.role labelling is gone, and this asserts the real replacement path.
    fetchAIResponse.mockImplementation(stream(['{"summary":"s"}']));
    await ensureMeetingSummary("conv-1", ENTRIES_LABELLED);
    const userMessage = fetchAIResponse.mock.calls[0][0].userMessage as string;
    expect(userMessage).toContain("You: we should ship on Friday");
    expect(userMessage).toContain("Guest: agreed");
    expect(userMessage).not.toContain("Assistant:");
  });

  it("returns null rather than throwing on unparseable JSON", async () => {
    fetchAIResponse.mockImplementation(stream(["not json at all"]));
    expect(await ensureMeetingSummary("conv-1", ENTRIES)).toBeNull();
  });

  it("threads a custom provider through when the Meetwings API is off", async () => {
    shouldUseMeetwingsAPI.mockResolvedValue(false);
    fetchAIResponse.mockImplementation(stream(['{"summary":"s"}']));
    const providerConfig = {
      provider: { id: "openai" },
      selectedProvider: { provider: "openai", variables: {} },
    };
    await ensureMeetingSummary("conv-1", ENTRIES, providerConfig as never);
    expect(fetchAIResponse.mock.calls[0][0].provider).toEqual({ id: "openai" });
  });
});

describe("chatMessagesToTranscriptEntries", () => {
  it("keeps only role: user messages", () => {
    const entries = chatMessagesToTranscriptEntries([
      { role: "user", content: "hello", timestamp: 1 },
      { role: "assistant", content: "hi there", timestamp: 2 },
      { role: "user", content: "bye", timestamp: 3 },
    ]);
    expect(entries).toEqual([
      { original: "hello", timestamp: 1, speaker: undefined, audioSource: undefined },
      { original: "bye", timestamp: 3, speaker: undefined, audioSource: undefined },
    ]);
  });

  it("carries speaker and audioSource across when present", () => {
    const entries = chatMessagesToTranscriptEntries([
      {
        role: "user",
        content: "hi",
        timestamp: 1,
        speaker: { speakerId: "source_you" as never },
        audioSource: "microphone",
      },
    ]);
    expect(entries[0]).toMatchObject({
      speaker: { speakerId: "source_you" },
      audioSource: "microphone",
    });
  });

  it("accepts messages with no speaker/audioSource fields at all (useSystemAudio's narrower ChatMessage)", () => {
    const entries = chatMessagesToTranscriptEntries([
      { role: "user", content: "narrow", timestamp: 1 },
    ]);
    expect(entries).toEqual([
      { original: "narrow", timestamp: 1, speaker: undefined, audioSource: undefined },
    ]);
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run src/tests/ensure-meeting-summary.test.ts`
Expected: FAIL — `ensureMeetingSummary`/`chatMessagesToTranscriptEntries` are not exported from `meeting-summarizer.ts` yet.

- [ ] **Step 3: Implement `chatMessagesToTranscriptEntries` and `ensureMeetingSummary`**

In `src/lib/functions/meeting-summarizer.ts`:

1. Add `SpeakerInfo` to the existing `@/types` import (it already imports `SummarizationResult, ExtractedEntity, CreateMeetingSummaryInput, CreateKnowledgeEntityInput, TranscriptEntry` from `"@/types"` — add `SpeakerInfo` to that list).

2. Delete `MIN_EXCHANGES_FOR_SUMMARY`, `formatConversationForSummary`, `countExchanges`, `generateConversationSummary`, `summarizeConversation`, `shouldSummarize`, and `generateMeetingLogSummary` in their entirety, along with `generateMeetingLogSummary`'s own `ProviderConfig` type declaration (currently the doc comment `/** The provider shape every caller in this file already threads through. */` plus `type ProviderConfig = {...}` immediately above it) — step 4 below declares the one and only `ProviderConfig` for this file, and leaving the old one in place would be a duplicate identifier. Delete the `Message` import from `"@/types"` at the top (line 1) — nothing left in this file uses it once these are gone.

3. Keep `filterUserFromParticipants`, `getUserIdentityInstruction`, `SUMMARIZATION_PROMPT`, `matchBalancedBrace`, `extractJsonObject`, `parseSummarizationResponse`, `saveSummarizationResult` exactly as they are.

4. Add, just above `generateMeetingLogSummary`'s current location (which is deleted and replaced by this):

```ts
export interface SummarizableMessage {
  role: "user" | "assistant" | "system";
  content: string;
  timestamp: number;
  speaker?: SpeakerInfo;
  audioSource?: "microphone" | "system";
}

/**
 * Filters a stored ChatMessage[] down to the transcript-originated lines and
 * reshapes them as TranscriptEntry[]. Assistant replies (and any system
 * messages) are dropped: they carry no speaker/audioSource, would render
 * unlabeled in renderTranscript, and reintroduce the "typed AI Q&A mixed
 * into the summary" framing this design drops - see the design spec's Why
 * section. Every live-transcript-originated ChatMessage is stamped
 * role: "user" by addMeetingTranscript/addMeetingTranscriptEntries in the
 * first place.
 */
export function chatMessagesToTranscriptEntries(
  messages: SummarizableMessage[]
): TranscriptEntry[] {
  return messages
    .filter((m) => m.role === "user")
    .map((m) => ({
      original: m.content,
      timestamp: m.timestamp,
      speaker: m.speaker,
      audioSource: m.audioSource,
    }));
}

/** The provider shape every caller in this file already threads through. */
type ProviderConfig = {
  provider: any;
  selectedProvider: { provider: string; variables: Record<string, string> };
};

/** Below this, a persisted summary would permanently lock the conversation's
 * canonical row to a fragment - see the design spec's shared-helper step 4. */
const MIN_PERSIST_ENTRIES = 4;

/**
 * The one place that decides whether a meeting has a summary: look up a
 * cached one, generate and cache a new one, or decline (never throwing).
 * Replaces generateConversationSummary and generateMeetingLogSummary.
 *
 * `minEntries` gates whether the AI is called AT ALL - the Odoo path passes
 * 1 (a short meeting still gets a real note), the Context Memory path and
 * every backfill caller use the default of 4. Persistence is gated
 * separately, on the FIXED MIN_PERSIST_ENTRIES floor, regardless of what
 * minEntries was: letting a 1-entry Odoo slice persist would permanently
 * lock the conversation's canonical `meeting_summaries` row to a fragment,
 * since step 1's cache-first read means the FIRST slice to persist wins for
 * the whole conversation.
 *
 * NEVER THROWS. A summarization failure must not become a push failure or a
 * lost meeting - losing a customer record because an AI provider returned
 * 429 is the wrong trade.
 */
export async function ensureMeetingSummary(
  conversationId: string | null,
  entries: TranscriptEntry[],
  providerConfig?: ProviderConfig,
  minEntries: number = 4
): Promise<SummarizationResult | null> {
  try {
    if (conversationId) {
      const existing = await getMeetingSummaryByConversation(conversationId);
      if (existing) {
        return {
          title: existing.title,
          summary: existing.summary,
          topics: existing.topics,
          goals: existing.goals,
          actionItems: existing.actionItems,
          nextSteps: existing.nextSteps,
          decisions: existing.decisions,
          teamUpdates: existing.teamUpdates,
          participants: existing.participants,
          entities: [],
        };
      }
    }

    if (entries.length < minEntries) {
      return null;
    }

    const useMeetwingsAPI = await shouldUseMeetwingsAPI();
    if (!useMeetwingsAPI && !providerConfig) {
      console.log("No AI provider configured for meeting summarization");
      return null;
    }

    const userMessage =
      `MEETING TRANSCRIPT:\n${renderTranscript(entries)}\n\nProvide the JSON summary:`;

    let fullResponse = "";
    for await (const chunk of fetchAIResponse({
      provider: useMeetwingsAPI ? undefined : providerConfig?.provider,
      selectedProvider: providerConfig?.selectedProvider || { provider: "", variables: {} },
      systemPrompt: SUMMARIZATION_PROMPT + getUserIdentityInstruction(),
      history: [],
      userMessage,
      imagesBase64: [],
    })) {
      fullResponse += chunk;
    }

    const result = parseSummarizationResponse(fullResponse);
    if (!result || !result.summary) {
      return null;
    }

    if (conversationId && entries.length >= MIN_PERSIST_ENTRIES) {
      await saveSummarizationResult(conversationId, result, entries.length);
    }

    return result;
  } catch (error) {
    console.error("Error generating meeting summary:", error);
    return null;
  }
}
```

5. `generateMeetingLogSummary` and its doc comment are already gone per step 2 above — the doc comment's rationale ("deliberately not `generateConversationSummary`") is moot now that there's only one function.

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npx vitest run src/tests/ensure-meeting-summary.test.ts`
Expected: PASS (all cases).

- [ ] **Step 5: Run the existing suite for this file to check nothing else broke**

Run: `npx vitest run src/tests/meeting-log-summary.test.ts src/tests/meeting-summarizer.title-sync.test.ts`
Expected: `meeting-log-summary.test.ts` FAILS — it imports `generateMeetingLogSummary`, which no longer exists. Delete this file entirely; its cases are superseded by `ensure-meeting-summary.test.ts`'s own new tests: "sends a SPEAKER-labelled transcript" is now covered directly (not just implied by `chatMessagesToTranscriptEntries`'s filter test), "returns null for an empty transcript" is covered by the `minEntries` gate test (`renderTranscript` itself is untouched and still tested at its own call site), and the two cases that had no replacement in the first draft of this plan — "returns null rather than throwing on unparseable JSON" and "threads a custom provider through when the Meetwings API is off" — are carried over verbatim in Step 1 above. `meeting-summarizer.title-sync.test.ts` should still PASS unmodified (`saveSummarizationResult` is untouched).

Run: `rm src/tests/meeting-log-summary.test.ts && npx vitest run src/tests/meeting-summarizer.title-sync.test.ts`
Expected: PASS.

- [ ] **Step 6: Type-check and lint**

Run: `npm run type-check && npm run lint`
Expected: no new errors. (Other files still importing `generateConversationSummary`/`summarizeConversation`/`shouldSummarize`/`generateMeetingLogSummary` will fail here — that's expected until Tasks 3, 4, 6 rewire them. If this is the first task executed, note the failing files in the task's own commit message rather than trying to fix them here.)

- [ ] **Step 7: Commit**

```bash
git add src/lib/functions/meeting-summarizer.ts src/tests/ensure-meeting-summary.test.ts
git rm src/tests/meeting-log-summary.test.ts
git commit -m "feat(meeting-summary): add ensureMeetingSummary, the shared cache-or-generate-or-decline helper"
```

---

### Task 2: Migration 16 — drop `summary_json`, backfill `meeting_summaries`, fix every reference

**Files:**
- Create: `src-tauri/src/db/migrations/meeting-log-queue-v2.sql`
- Create: `src/tests/helpers/migration-16.ts`
- Modify: `src-tauri/src/db/main.rs`
- Modify: `src-tauri/src/db/migration_tests.rs`
- Modify: `src/types/odoo.ts`
- Modify: `src/lib/database/meeting-log.action.ts`
- Modify: `src/tests/meeting-log.action.test.ts`, `src/tests/meeting-log-actions.test.ts`, `src/tests/meeting-log-page.test.tsx`, `src/tests/meetings-page.test.tsx`, `src/tests/odoo-meeting-log-sweep.test.ts`, `src/tests/odoo-meeting-log-push.test.ts` (its `seedRow` fixture's INSERT is built dynamically from `Object.keys()`, so its `summary_json: null` default must go too — see Step 10)

**Interfaces:**
- Produces: `meeting_log_queue` no longer has a `summary_json` column; `meeting_summaries` (unchanged shape) gains backfilled rows for every pre-existing queue row that had a cached summary.
- Consumes: `MIN_TARGETS`/none — pure schema + SQL-string change.

- [ ] **Step 1: Write the migration SQL**

Create `src-tauri/src/db/migrations/meeting-log-queue-v2.sql`:

```sql
-- Migration 16: meeting_summaries (keyed by conversation_id) replaces
-- meeting_log_queue.summary_json as the one cache/source of truth for a
-- meeting's AI summary.
INSERT INTO meeting_summaries (
  id, conversation_id, summary, title, topics, goals, action_items,
  next_steps, decisions, team_updates, participants, exchange_count,
  meeting_started_at, meeting_ended_at, created_at, updated_at
)
SELECT
  lower(hex(randomblob(16))), q.conversation_id,
  json_extract(q.summary_json, '$.summary'),
  json_extract(q.summary_json, '$.title'),
  json_extract(q.summary_json, '$.topics'),
  json_extract(q.summary_json, '$.goals'),
  json_extract(q.summary_json, '$.actionItems'),
  json_extract(q.summary_json, '$.nextSteps'),
  json_extract(q.summary_json, '$.decisions'),
  json_extract(q.summary_json, '$.teamUpdates'),
  json_extract(q.summary_json, '$.participants'),
  0, q.meeting_started_at, q.transcript_end_at, q.created_at, q.created_at
FROM meeting_log_queue q
WHERE q.summary_json IS NOT NULL
  AND q.conversation_id IS NOT NULL
  -- q.summary_json is AI-generated text written via setSummaryJson with no
  -- schema validation at write time. json_extract() RAISES on malformed JSON,
  -- and this migration runs inside sqlx's one transaction per file - any
  -- error here rolls back the WHOLE migration and it is never recorded as
  -- applied, permanently breaking Database.load() for that user on every
  -- future launch. json_valid() excludes malformed rows before json_extract
  -- ever runs on them (SQLite only evaluates the SELECT list for rows that
  -- already passed WHERE).
  AND json_valid(q.summary_json)
  -- meeting_summaries.summary is NOT NULL. Valid JSON with no "summary" key
  -- (or an explicit null) makes json_extract(...,'$.summary') return NULL,
  -- which would fail that NOT NULL constraint and abort the migration exactly
  -- as above - guard it the same way.
  AND json_extract(q.summary_json, '$.summary') IS NOT NULL
  -- session_key, not conversation_id, is what's UNIQUE on this table - one
  -- conversation can own several queue rows. meeting_summaries.conversation_id
  -- IS UNIQUE, so backfilling every matching row would violate it on the
  -- second row for a repeat conversation. Keep only the newest cached row
  -- per conversation (rowid tiebreak so two rows with an identical
  -- created_at still resolve to exactly one) - considering only rows that
  -- pass the same two guards, so a malformed or summary-less newest row never
  -- shadows a usable older one.
  AND q.rowid = (
    SELECT q2.rowid FROM meeting_log_queue q2
    WHERE q2.conversation_id = q.conversation_id
      AND q2.summary_json IS NOT NULL
      AND json_valid(q2.summary_json)
      AND json_extract(q2.summary_json, '$.summary') IS NOT NULL
    ORDER BY q2.created_at DESC, q2.rowid DESC LIMIT 1
  )
  AND NOT EXISTS (
    SELECT 1 FROM meeting_summaries s WHERE s.conversation_id = q.conversation_id
  );

ALTER TABLE meeting_log_queue DROP COLUMN summary_json;
```

- [ ] **Step 2: Register the migration**

In `src-tauri/src/db/main.rs`, after the `version: 15` entry, add:

```rust
        Migration {
            version: 16,
            description: "backfill_and_drop_queue_summary_json",
            sql: include_str!("migrations/meeting-log-queue-v2.sql"),
            kind: MigrationKind::Up,
        },
```

- [ ] **Step 3: Write the Rust binding test**

In `src-tauri/src/db/migration_tests.rs`, after the existing `meeting_log_queue_migration_is_version_12_and_points_at_its_own_file` test, add:

```rust
    #[test]
    fn summary_backfill_migration_is_version_16_and_points_at_its_own_file() {
        let m = migrations()
            .into_iter()
            .find(|m| m.description == "backfill_and_drop_queue_summary_json")
            .expect("summary backfill migration must be registered");
        assert_eq!(m.version, 16, "summary backfill migration must be version 16");
        assert_eq!(
            m.sql,
            include_str!("migrations/meeting-log-queue-v2.sql"),
            "summary backfill migration must embed migrations/meeting-log-queue-v2.sql"
        );
    }
```

- [ ] **Step 4: Run the Rust migration tests**

Run: `cargo test --manifest-path src-tauri/Cargo.toml migration_tests`
Expected: PASS — `migration_versions_are_unique_and_monotonic` and `every_migration_file_is_registered` pass automatically once Steps 1-2 land; the new binding test passes on its own assertions.

- [ ] **Step 5: Write the sql.js migration helper**

Create `src/tests/helpers/migration-16.ts`:

```ts
import { readFileSync } from "node:fs";
import initSqlJs, { type Database } from "sql.js";
import path from "node:path";
import { MIGRATIONS, readMigration } from "./migration-14";

const WASM_BINARY = path.resolve(__dirname, "../../../node_modules/sql.js/dist/sql-wasm.wasm");
export const INSTANCE = "http://h:8069|odoo";

// Every migration through 15, in registration order, so the pre-16 database
// this helper builds matches what a real app has on disk before v16 runs.
const PRE_16_FILES = [
  "system-prompts.sql",
  "chat-history.sql",
  "api-usage.sql",
  "api-usage-v2.sql",
  "api-usage-v3.sql",
  "meeting-context.sql",
  "meeting-context-v7.sql",
  "chat-history-v8.sql",
  "meeting-context-v9.sql",
  "meeting-context-v10.sql",
  "odoo-contacts.sql",
  "meeting-log-queue.sql",
  "odoo-lead-only-target.sql",
  "odoo-multi-target.sql",
  "conversation-title-source.sql",
];

async function freshDbThrough15(): Promise<Database> {
  const wasmBinary = readFileSync(WASM_BINARY);
  const SQL = await initSqlJs({ wasmBinary });
  const db = new SQL.Database();
  for (const file of PRE_16_FILES) db.run(readMigration(file));
  return db;
}

export function applyMigration16(db: Database) {
  db.exec(readMigration("meeting-log-queue-v2.sql"));
}

export function rows(db: Database, sql: string): Record<string, unknown>[] {
  const stmt = db.prepare(sql);
  const out: Record<string, unknown>[] = [];
  while (stmt.step()) out.push(stmt.getAsObject());
  stmt.free();
  return out;
}

interface PreQueueRow16 {
  id: string;
  conversationId: string | null;
  summaryJson: string | null;
  createdAt?: number;
}

/** Inserts a meeting_log_queue row in the pre-16 shape (summary_json still a
 * real column at this point). Each call needs a unique session_key, which is
 * derived from id so callers don't have to think about it. */
function insertPreQueueRow(db: Database, r: PreQueueRow16, seq: number) {
  db.run(
    `INSERT INTO meeting_log_queue
       (id, session_key, conversation_id, instance, contact_id, lead_id,
        transcript, transcript_start_at, transcript_end_at, summary_json,
        attachment_id, message_id, status, attempts, claimed_at, last_error,
        last_error_code, meeting_started_at, created_at, sent_at)
     VALUES (?, ?, ?, ?, NULL, NULL, 't', 1, 2, ?, NULL, NULL, 'sent', 1,
             NULL, NULL, NULL, 1, ?, NULL)`,
    [
      r.id,
      `session-${r.id}-${seq}`,
      r.conversationId,
      INSTANCE,
      r.summaryJson,
      r.createdAt ?? 1_700_000_000_000 + seq,
    ]
  );
}

export async function seedPre16(queueRows: PreQueueRow16[]): Promise<Database> {
  const db = await freshDbThrough15();
  queueRows.forEach((r, i) => insertPreQueueRow(db, r, i));
  return db;
}

export async function seedPre16WithExistingSummary(
  conversationId: string,
  existingTitle: string
): Promise<Database> {
  const db = await freshDbThrough15();
  db.run(
    `INSERT INTO meeting_summaries
       (id, conversation_id, summary, title, exchange_count, created_at, updated_at)
     VALUES ('existing', ?, 'already here', ?, 0, 1, 1)`,
    [conversationId, existingTitle]
  );
  return db;
}
```

(`readMigration`/`MIGRATIONS` are imported from the existing `migration-14.ts` helper rather than redefined, per that file's own header comment: it exists precisely so both files can share these without either being unable to import from the other.)

- [ ] **Step 6: Export `readMigration` from `migration-14.ts` if it isn't already**

Check `src/tests/helpers/migration-14.ts:19` — `readMigration` is already `export const`. No change needed; this step is a verification, not an edit.

- [ ] **Step 7: Write the failing migration tests**

Create `src/tests/migration-16.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { applyMigration16, INSTANCE, rows, seedPre16, seedPre16WithExistingSummary } from "./helpers/migration-16";

describe("migration 16 backfill", () => {
  it("backfills a queue row with a cached summary into meeting_summaries", async () => {
    const summaryJson = JSON.stringify({
      title: "Q3 renewal", summary: "Discussed renewal terms.",
      topics: ["renewal"], goals: [], actionItems: ["send contract"],
      nextSteps: [], decisions: [], teamUpdates: [], participants: ["Ada"],
    });
    const db = await seedPre16([
      { id: "r1", conversationId: "conv-1", summaryJson },
    ]);
    applyMigration16(db);

    const backfilled = rows(db, "SELECT * FROM meeting_summaries WHERE conversation_id = 'conv-1'");
    expect(backfilled).toHaveLength(1);
    expect(backfilled[0]).toMatchObject({
      title: "Q3 renewal",
      summary: "Discussed renewal terms.",
      exchange_count: 0,
    });

    const cols = rows(db, "PRAGMA table_info(meeting_log_queue)").map((c) => c.name);
    expect(cols).not.toContain("summary_json");
  });

  it("skips a row whose conversation_id is NULL", async () => {
    const db = await seedPre16([
      { id: "r1", conversationId: null, summaryJson: JSON.stringify({ summary: "orphan" }) },
    ]);
    applyMigration16(db);
    expect(rows(db, "SELECT * FROM meeting_summaries")).toHaveLength(0);
  });

  it("does not double-insert when a meeting_summaries row already exists for the conversation", async () => {
    const db = await seedPre16WithExistingSummary("conv-1", "Already Named");
    db.run(
      `INSERT INTO meeting_log_queue
         (id, session_key, conversation_id, instance, transcript, transcript_start_at,
          transcript_end_at, summary_json, status, attempts, meeting_started_at, created_at)
       VALUES ('r1', 's1', 'conv-1', 'http://h:8069|odoo', 't', 1, 2,
               ?, 'sent', 1, 1, 1700000000001)`,
      [JSON.stringify({ title: "New Title", summary: "new" })]
    );
    applyMigration16(db);
    const summaries = rows(db, "SELECT * FROM meeting_summaries WHERE conversation_id = 'conv-1'");
    expect(summaries).toHaveLength(1);
    expect(summaries[0].title).toBe("Already Named"); // untouched, not overwritten
  });

  it("keeps only the newest row when two queue rows share one conversation_id, DIFFERENT created_at", async () => {
    const db = await seedPre16([
      { id: "older", conversationId: "conv-1", summaryJson: JSON.stringify({ title: "Older", summary: "a" }), createdAt: 100 },
      { id: "newer", conversationId: "conv-1", summaryJson: JSON.stringify({ title: "Newer", summary: "b" }), createdAt: 200 },
    ]);
    applyMigration16(db);
    const summaries = rows(db, "SELECT * FROM meeting_summaries WHERE conversation_id = 'conv-1'");
    expect(summaries).toHaveLength(1);
    expect(summaries[0].title).toBe("Newer");
  });

  it("keeps exactly one row when two queue rows share one conversation_id AND an IDENTICAL created_at", async () => {
    const db = await seedPre16([
      { id: "a", conversationId: "conv-1", summaryJson: JSON.stringify({ title: "A", summary: "a" }), createdAt: 100 },
      { id: "b", conversationId: "conv-1", summaryJson: JSON.stringify({ title: "B", summary: "b" }), createdAt: 100 },
    ]);
    applyMigration16(db);
    // The point of this test is NOT which of the two wins (the rowid
    // tiebreak makes that deterministic but arbitrary) - it's that the
    // UNIQUE constraint on meeting_summaries.conversation_id does not abort
    // the migration.
    expect(rows(db, "SELECT * FROM meeting_summaries WHERE conversation_id = 'conv-1'")).toHaveLength(1);
  });

  it("backfills the meeting window from the queue row, not NULL", async () => {
    const db = await seedPre16([
      { id: "r1", conversationId: "conv-1", summaryJson: JSON.stringify({ summary: "s" }) },
    ]);
    applyMigration16(db);
    const [row] = rows(db, "SELECT meeting_started_at, meeting_ended_at FROM meeting_summaries WHERE conversation_id = 'conv-1'");
    expect(row.meeting_started_at).toBe(1);
    expect(row.meeting_ended_at).toBe(2);
  });

  it("a queue row with malformed JSON does not abort the migration, and is not backfilled", async () => {
    const db = await seedPre16([
      { id: "bad", conversationId: "conv-bad", summaryJson: "not json at all" },
      { id: "good", conversationId: "conv-good", summaryJson: JSON.stringify({ summary: "s" }) },
    ]);
    expect(() => applyMigration16(db)).not.toThrow();
    expect(rows(db, "SELECT * FROM meeting_summaries WHERE conversation_id = 'conv-bad'")).toHaveLength(0);
    expect(rows(db, "SELECT * FROM meeting_summaries WHERE conversation_id = 'conv-good'")).toHaveLength(1);
  });

  it("a queue row with valid JSON but no summary key does not abort the migration, and is not backfilled", async () => {
    const db = await seedPre16([
      { id: "nosum", conversationId: "conv-nosum", summaryJson: JSON.stringify({ title: "Has title, no summary" }) },
    ]);
    expect(() => applyMigration16(db)).not.toThrow();
    expect(rows(db, "SELECT * FROM meeting_summaries WHERE conversation_id = 'conv-nosum'")).toHaveLength(0);

    const cols = rows(db, "PRAGMA table_info(meeting_log_queue)").map((c) => c.name);
    expect(cols).not.toContain("summary_json");
  });

  it("listActionable's own SQL still runs after the column is dropped", async () => {
    // Imports the REAL QUEUE_SQL.listActionable string rather than a
    // hand-copied one, so a future SELECT/ORDER BY change can never drift out
    // of sync with what this test exercises. meeting-log.action.ts's only
    // load-time import chain (./config -> @tauri-apps/plugin-sql) has no
    // side effects at module scope - Database.load() only runs inside
    // getDatabase(), which this test never calls - so a plain static import
    // of QUEUE_SQL is safe under vitest's node environment, unmocked.
    const { QUEUE_SQL } = await import("@/lib/database/meeting-log.action");
    const db = await seedPre16([
      { id: "r1", conversationId: "conv-1", summaryJson: JSON.stringify({ summary: "s" }) },
    ]);
    applyMigration16(db);
    expect(() => {
      const stmt = db.prepare(QUEUE_SQL.listActionable);
      stmt.bind([INSTANCE, 3]); // ?1 = instance (matches every seeded row), ?2 = attempts threshold
      while (stmt.step()) stmt.getAsObject();
      stmt.free();
    }).not.toThrow();
  });
});
```

- [ ] **Step 8: Remove `summary_json` from the TypeScript types and the `QUEUE_SQL` strings**

Done BEFORE running the migration tests below — the `"listActionable's own SQL still runs after the column is dropped"` case (Step 7 above) imports the REAL `QUEUE_SQL.listActionable` string, which still names `summary_json` until this step runs. Running the tests first would hit a genuine `no such column: summary_json` against the already-migrated sql.js database that case builds, for a reason that has nothing to do with the migration SQL itself.

In `src/types/odoo.ts`, remove line 150 (`summary_json: string | null;`) from `DbMeetingLogRow`.

In `src/lib/database/meeting-log.action.ts`:
- Delete the `setSummary` entry from `QUEUE_SQL` (was: `` setSummary: `UPDATE meeting_log_queue SET summary_json = ? WHERE id = ?`, ``).
- In `deleteRow`, change `` SET status = 'deleted', transcript = '', summary_json = NULL `` to `` SET status = 'deleted', transcript = '' ``.
- In `deleteTerminalRow`, same change.
- In `prune`, change `` SET transcript = '', summary_json = NULL `` to `` SET transcript = '' ``, and change the WHERE clause `` AND (transcript <> '' OR summary_json IS NOT NULL) `` to `` AND transcript <> '' ``.
- In `listActionable`, remove `summary_json,` from the explicit SELECT column list (between `transcript_end_at,` and `attachment_id,`).
- Delete the `setSummaryJson` exported function (was at `:776-779`).
- Search the file for any other `summary_json` occurrence (`grep -n summary_json src/lib/database/meeting-log.action.ts`) and confirm none remain.

- [ ] **Step 9: Run the migration tests**

Unlike Task 1's TDD order, Step 1 already wrote the migration SQL before this test file existed — there is no meaningful red phase here, the SQL and the test were both written from the same spec. Now that Step 8 above has also removed `summary_json` from `QUEUE_SQL.listActionable`, all nine cases (including the one that imports that string directly) run against a consistent, fully-migrated picture:

Run: `npx vitest run src/tests/migration-16.test.ts`
Expected: PASS (all nine cases).

- [ ] **Step 10: Fix every broken test fixture and test that references `summary_json`**

In `src/tests/meeting-log.action.test.ts`:
- Line 133 (`seed()`'s default row): remove `summary_json: null,`.
- Rename and rewrite the test at line 1061 (`"blanks transcript AND summary_json while every timestamp survives"`) to drop the column entirely:

```ts
  it("blanks transcript while every timestamp survives", async () => {
    seed({
      id: "r", status: "failed", transcript: "You: secrets",
      transcript_start_at: 1000, transcript_end_at: 2000,
      session_key: "conv:1000", created_at: 1234, contact_id: 42, lead_id: 7,
    });

    expect(await deleteQueueRow("r")).toBe(true);

    expect(await getQueueRow("r")).toMatchObject({
      status: "deleted",
      transcript: "",
      transcript_start_at: 1000,
      transcript_end_at: 2000,
      session_key: "conv:1000",
      created_at: 1234,
      contact_id: 42,
      lead_id: 7,
    });
  });
```

- Rewrite the `it.each(["sent", "cancelled"])("deleteTerminalQueueRow removes a %s row, blanking it the same way", ...)` test (was `:1108-1120`) to drop `summary_json` from both the seed and the assertion:

```ts
  it.each(["sent", "cancelled"])(
    "deleteTerminalQueueRow removes a %s row, blanking it the same way",
    async (status) => {
      seed({
        id: "r", status, transcript: "You: secrets", created_at: 1234,
      });
      expect(await deleteTerminalQueueRow("r")).toBe(true);
      expect(await getQueueRow("r")).toMatchObject({
        status: "deleted", transcript: "", created_at: 1234,
      });
    }
  );
```

- Rename and rewrite the `describe("pruneTranscripts")` test at `:1416` (`"blanks transcript and summary on sent and cancelled rows past the cutoff"`):

```ts
  it("blanks transcript on sent and cancelled rows past the cutoff", async () => {
    seed({ id: "s", session_key: "s", status: "sent", transcript: "text", created_at: OLD });
    seed({ id: "c", session_key: "c", status: "cancelled", transcript: "text", created_at: OLD });

    expect(await pruneTranscripts(NOW)).toBe(2);

    expect(await getQueueRow("s")).toMatchObject({ transcript: "" });
    expect(await getQueueRow("c")).toMatchObject({ transcript: "" });
  });
```

- DELETE the test at `:1437` in full (`"blanks a past-cutoff row whose transcript is ALREADY blank but summary_json is not"`) — the `OR summary_json IS NOT NULL` predicate it exists to guard no longer exists; there is no longer a case where a row's transcript is blank but it still holds prunable content.
- At the `"is idempotent and never touches a timestamp"` test (`:1468`), remove `summary_json: null,` from its `seed({...})` call. The rest of the test (asserting `transcript_start_at`/`transcript_end_at`/`sent_at`/`created_at` survive) is unaffected.

In `src/tests/meeting-log-actions.test.ts` (lines 147, 161): remove `summary_json: null,` from both fixture object literals.

In `src/tests/meeting-log-page.test.tsx` (lines 160, 2317): remove `summary_json: null,` from both fixture object literals. (The comment at line 672 referencing "summary_json is null by construction" can stay as prose — it is no longer literally accurate but the test it documents, "passes the provider config derived from @/contexts, never null," is unaffected; optionally reword to "a `failed` row with no cached summary" if touching that line anyway.)

In `src/tests/meetings-page.test.tsx` (line 154): remove `summary_json: null,`.

In `src/tests/odoo-meeting-log-sweep.test.ts` (line 90): remove `summary_json: null,`.

In `src/tests/odoo-meeting-log-push.test.ts` (line 122): remove `summary_json: null,` from `seedRow`'s default object literal. This one is not merely a stale fixture value — `seedRow` builds its `INSERT INTO meeting_log_queue (...)` column list from `Object.keys(row)` dynamically, so leaving the key in place means every single test in this file (the whole `pushQueuedRow` suite) fails at `seedRow`'s own `db.run(...)` call with a real SQLite error (`table meeting_log_queue has no column named summary_json`) the moment migration 16's `ALTER TABLE ... DROP COLUMN` lands — not a type error, a runtime one, and this file is excluded from `npm run type-check` (see Task 8's note on `tsconfig.json`'s test-file exclusion) so nothing catches it before the test run itself.

- [ ] **Step 11: Run the full affected test suite**

Run: `npx vitest run src/tests/meeting-log.action.test.ts src/tests/meeting-log-actions.test.ts src/tests/meeting-log-page.test.tsx src/tests/meetings-page.test.tsx src/tests/odoo-meeting-log-sweep.test.ts src/tests/odoo-meeting-log-push.test.ts src/tests/migration-16.test.ts`
Expected: PASS, EXCEPT `odoo-meeting-log-push.test.ts` and `odoo-meeting-log-sweep.test.ts` may still show failures tied to `PushDeps.summarize`'s old signature — `meeting-log-push.ts` still imports the now-deleted `setSummaryJson` and still reads `row.summary_json`, a field `DbMeetingLogRow` no longer has. This task deliberately leaves that file untouched (a half-fix here would strand it in a worse, contradictory state); Task 3 rewrites it in full. Confirm any failures here are ONLY that class, never a `no such column: summary_json` SQLite error — that specific error means the `seedRow` fixture edit above did not land.

- [ ] **Step 12: Type-check and lint**

Run: `npm run type-check && npm run lint`
Expected: no NEW errors from this task's own files (`src/types/odoo.ts`, `src/lib/database/meeting-log.action.ts`). `npm run type-check` WILL newly fail on `src/lib/odoo/meeting-log-push.ts` (`Property 'summary_json' does not exist on type 'DbMeetingLogRow'`, and `Module has no exported member 'setSummaryJson'`) and on `src/hooks/useMeetingLog.ts` (`PushDeps.summarize`'s old signature) — both are real, expected, and Task 3/4's to fix, not this task's. Test files are excluded from `type-check` entirely (see Global Constraints), so this command never reports the test-fixture class of error; that class is caught only by actually running the suite in Step 11.

- [ ] **Step 13: Commit**

```bash
git add src-tauri/src/db/migrations/meeting-log-queue-v2.sql src-tauri/src/db/main.rs \
  src-tauri/src/db/migration_tests.rs src/types/odoo.ts src/lib/database/meeting-log.action.ts \
  src/tests/helpers/migration-16.ts src/tests/migration-16.test.ts \
  src/tests/meeting-log.action.test.ts src/tests/meeting-log-actions.test.ts \
  src/tests/meeting-log-page.test.tsx src/tests/meetings-page.test.tsx \
  src/tests/odoo-meeting-log-sweep.test.ts src/tests/odoo-meeting-log-push.test.ts
git commit -m "feat(db): migration 16 - backfill meeting_log_queue.summary_json into meeting_summaries, drop the column

meeting-log-push.ts is deliberately untouched here - Task 3 rewires it in full."
```

---

### Task 3: Rewire `PushDeps.summarize` and `pushQueuedRow`'s call site

**Files:**
- Modify: `src/lib/odoo/meeting-log-push.ts`
- Modify: `src/lib/odoo/meeting-log-actions.ts` — `boundedSummarize`'s returned `summarize` closure is a THIRD, independent caller of the old one-argument shape, entirely separate from `meeting-log-push.ts`. It is what `runAction` hands to `pushQueuedRow` as `PushDeps.summarize` (see Step 4 below).
- Modify: `src/tests/odoo-meeting-log-push.test.ts`
- Modify: `src/tests/meeting-log-actions.test.ts`

**Interfaces:**
- Consumes: `ensureMeetingSummary` (Task 1).
- Produces: `PushDeps.summarize: (conversationId: string | null, slice: TranscriptSlice) => Promise<SummarizationResult | null>` (was `(slice: TranscriptSlice) => ...`) — Task 4's `useMeetingLog.ts` change depends on this new shape. `boundedSummarize`'s returned `summarize` widens the same way, so it stays assignable to `PushDeps.summarize`.

- [ ] **Step 1: Update the failing/changed tests first**

In `src/tests/odoo-meeting-log-push.test.ts`, every existing test builds its deps via `makeDeps(over)` (`:195-203`), which already sets `summarize: vi.fn(async () => summary())` — a one-argument fake. Update `makeDeps`'s default to the new two-argument shape: `summarize: vi.fn(async (_conversationId: string | null) => summary())`. Any test that passes its OWN `summarize` override (search `summarize:` in the file — `makeDeps({ summarize: ... })` call sites) needs that override widened to accept `(conversationId, slice)` too, even where it ignores the first argument. Then add these three new cases, using the file's real `seedRow`/`makeDeps` helpers (`seedRow` inserts into the sql.js `db` and returns the inserted `DbMeetingLogRow`; `makeDeps` returns a `PushDeps`-shaped object):

```ts
  it("passes the row's own conversation_id to summarize, not undefined", async () => {
    const summarize = vi.fn(async (_conversationId: string | null) => summary());
    const row = seedRow({ conversation_id: "conv-42" });
    seedTargets(row.id, [{ resId: 42 }]);
    await pushQueuedRow(row, makeDeps({ summarize }));
    expect(summarize.mock.calls[0][0]).toBe("conv-42");
  });

  it("no longer branches on row.summary_json", async () => {
    // DbMeetingLogRow has no summary_json field after Task 2 - this test
    // exists to prove pushQueuedRow's OWN row-level cache block (the
    // if (row.summary_json) {...} else { deps.summarize(...) } this task
    // deletes in Step 3) is actually gone, not merely that the type compiles.
    const summarize = vi.fn(async (_conversationId: string | null) => summary({ summary: "generated" }));
    const row = seedRow({ conversation_id: "conv-1" });
    seedTargets(row.id, [{ resId: 42 }]);
    await pushQueuedRow(row, makeDeps({ summarize }));
    expect(summarize).toHaveBeenCalledTimes(1); // always calls summarize now - no row-level short-circuit
  });

  it("reaches the correct conversation_id for EACH row in a multi-row sweep", async () => {
    // The bug this signature change exists to fix: a closure built once,
    // before any row is known, cannot see a per-row conversationId. A
    // single-row test cannot distinguish "correct" from "always undefined"
    // if there's only ever one row to compare against.
    const seen: (string | null)[] = [];
    const summarize = vi.fn(async (conversationId: string | null) => {
      seen.push(conversationId);
      return summary();
    });
    const rowA = seedRow({ id: "row-a", session_key: "a", conversation_id: "conv-a" });
    const rowB = seedRow({ id: "row-b", session_key: "b", conversation_id: "conv-b" });
    seedTargets(rowA.id, [{ resId: 42 }]);
    seedTargets(rowB.id, [{ resId: 43 }]);
    await pushQueuedRow(rowA, makeDeps({ summarize }));
    await pushQueuedRow(rowB, makeDeps({ summarize }));
    expect(seen).toEqual(["conv-a", "conv-b"]);
  });
```

Two more fixes to this same file — pre-existing tests that break under the new signature, not new cases:

- The slice-capture in `"puts the AI summary in the note body instead of the fallback"` now points at `conversationId` (index 0) instead of the slice (index 1) — reindex it:

```ts
    const passedSlice = (d.summarize as ReturnType<typeof vi.fn>).mock.calls[0][1] as { entries: unknown[] };
```

- DELETE `"persists summary_json before the first write so a retry re-posts the same body"` in full. Its premise no longer holds either way: `summary_json` is gone (Task 2), `pushQueuedRow`'s own row-level cache branch is gone (Step 3 below), and its own second assertion (`expect(d.summarize).not.toHaveBeenCalled()` on a repeat push) now asserts the OPPOSITE of the real behavior — `deps.summarize` is unconditionally called on every push (see this task's new "no longer branches on row.summary_json" case above). What this test's first half verified — that the AI summary reaches the note body — is already covered by the very next test, "puts the AI summary in the note body instead of the fallback"; conversation-level caching (a repeat call for the SAME conversation returning the cached row without a second AI call) is `ensureMeetingSummary`'s own contract, already tested in Task 1's `ensure-meeting-summary.test.ts` ("returns the cached summary's real fields on a cache hit, without calling the AI").

`src/tests/meeting-log-actions.test.ts` also mocks the old export name and calls `summarize`/`deps.summarize` with the old one-argument shape, in six places — update all of them:

1. Rename the mock factory's export (`:81`):

```ts
const summarizer = vi.hoisted(() => ({
  ensureMeetingSummary: vi.fn(async () => ({ title: "T", summary: "S" })),
}));
```

2. Rename every `summarizer.generateMeetingLogSummary` reference to `summarizer.ensureMeetingSummary` (`:287`, `:450`, `:546`, `:556`, `:971` — five call sites; `grep -n generateMeetingLogSummary src/tests/meeting-log-actions.test.ts` afterward to confirm none remain).

3. Widen the two direct call sites that invoke `deps.summarize`/`summarize` with the old one-argument shape. `dbRow()`'s default `conversation_id` is `null`, so `null` is the accurate first argument in both:

`"INVOKES the summarize dep it hands to the push"` (`:541-547`):

```ts
    const result = await deps.summarize(null, {
      entries: [{ original: "hi", timestamp: 1 }], startAt: 1, endAt: 2,
    });
```

`"reports degraded when the summarize resolved null"` (`:556-558`):

```ts
    push.pushQueuedRow.mockImplementation(async (_row, deps) => {
      await deps.summarize(null, { entries: [{ original: "hi", timestamp: 1 }], startAt: 1, endAt: 2 });
    });
```

The two direct `boundedSummarize` unit tests in `describe("boundedSummarize", ...)` call the returned closure directly — widen both (`:974`, `:990`):

```ts
    const pending = summarize(null, { entries: [], startAt: 1, endAt: 2 });
```

```ts
    await summarize(null, { entries: [], startAt: 1, endAt: 2 });
```

- [ ] **Step 2: Run to verify these new/changed tests fail**

Run: `npx vitest run src/tests/odoo-meeting-log-push.test.ts src/tests/meeting-log-actions.test.ts`
Expected: FAIL on both files — `PushDeps.summarize`'s current type takes one argument, `pushQueuedRow`'s current body still branches on the now-nonexistent `row.summary_json` field (a compile error from Task 2's type removal, if that lands first), `boundedSummarize`'s closure still takes one argument, and `meeting-log-actions.test.ts` still mocks the deleted `generateMeetingLogSummary` export name.

- [ ] **Step 3: Widen `PushDeps.summarize` and rewrite `pushQueuedRow`'s summarize block**

In `src/lib/odoo/meeting-log-push.ts`:

1. Change the `PushDeps` interface's `summarize` field:

```ts
  /** Wrapped in its own try/catch here; may reject freely. */
  summarize: (
    conversationId: string | null,
    slice: TranscriptSlice
  ) => Promise<SummarizationResult | null>;
```

2. Replace the entire summarize block inside `pushQueuedRow` (the `let summary: SummarizationResult | null = null; if (row.summary_json) {...} else {...}` block) with:

```ts
    // ---- Summarize. Its own try/catch, walled off from last_error. --------
    let summary: SummarizationResult | null = null;
    try {
      summary = await deps.summarize(row.conversation_id, slice);
    } catch {
      // An AI-provider error NEVER reaches last_error: the redactor holds
      // [apiKey, login] only and has no needle for an AI key, and
      // fetchAIResponse re-wraps failures with the provider's own message.
      summary = null;
    }
```

3. Remove the `attemptsBefore`-adjacent comment block that explained the old row-level cache rationale (the "Built ONCE, before the summarize branch..." comment above the `slice` construction can stay — it still describes the slice itself correctly; only the cache-check paragraph beneath it, describing `row.summary_json`, is removed along with the code it described).

- [ ] **Step 4: Rewire `boundedSummarize` in `meeting-log-actions.ts` — the third caller**

Left alone, `boundedSummarize`'s returned `summarize` closure stays one-argument even after Step 3 widens the interface it is assigned to (`PushDeps.summarize`, passed in at `runAction`'s `pushQueuedRow(fresh, { client, instance, now, summarize })` call, `:211-216`) — a real type error (`string | null` is not assignable to `TranscriptSlice` at parameter 0), not a silent bug, but still a hard compile failure blocking this whole task.

In `src/lib/odoo/meeting-log-actions.ts`:

1. Change the import (`:13`):

```ts
import { ensureMeetingSummary } from "@/lib/functions/meeting-summarizer";
```

2. Rewrite `boundedSummarize` in full:

```ts
export function boundedSummarize(providerConfig: ProviderConfigLike | null): {
  summarize: (
    conversationId: string | null,
    slice: TranscriptSlice
  ) => Promise<SummarizationResult | null>;
  didSummarize: () => boolean | null;
} {
  let produced: boolean | null = null;

  const summarize = async (
    conversationId: string | null,
    slice: TranscriptSlice
  ): Promise<SummarizationResult | null> => {
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      const result = await Promise.race([
        ensureMeetingSummary(conversationId, slice.entries, providerConfig as never, 1),
        new Promise<null>((resolve) => {
          timer = setTimeout(() => resolve(null), SUMMARIZE_TIMEOUT_MS);
        }),
      ]);
      produced = result !== null;
      return result;
    } catch {
      // UNREACHABLE TODAY, kept as defence in depth. ensureMeetingSummary
      // catches everything and returns null, and the timeout leg only ever
      // resolves - so every real failure already arrives as `null` and sets
      // produced = false above. The actual guard keeping an AI error out of
      // last_error is the summarizer's own catch plus meeting-log-push.ts's
      // try/catch around deps.summarize, NOT this line; do not read it as the
      // redaction boundary.
      produced = false;
      return null;
    } finally {
      if (timer !== undefined) clearTimeout(timer);
    }
  };

  return { summarize, didSummarize: () => produced };
}
```

`minEntries: 1` matches the Odoo path's existing floor (a short meeting still gets a real note) — `ensureMeetingSummary` persists separately at its own fixed 4-entry floor regardless, so this does not change when a summary gets written to `meeting_summaries`, only whether the AI gets called at all. `providerConfig as never` is unchanged from the old call — `ProviderConfigLike` and `ensureMeetingSummary`'s `ProviderConfig` describe the same runtime shape without being the same declared type.

3. Update the two doc comments that name the old function: the "Two jobs" comment above `boundedSummarize` (`:108`, "fallback: generateMeetingLogSummary returns null identically...") and the inline comment inside `runAction` (`:237`, "generateMeetingLogSummary swallows its throw and returns null") — both become `ensureMeetingSummary`.

- [ ] **Step 5: Run the tests to verify they pass**

Run: `npx vitest run src/tests/odoo-meeting-log-push.test.ts src/tests/meeting-log-actions.test.ts`
Expected: PASS.

- [ ] **Step 6: Type-check and lint**

Run: `npm run type-check && npm run lint`
Expected: no new errors in `meeting-log-push.ts` or `meeting-log-actions.ts`. `useMeetingLog.ts` will still show a type error (its `summarize` callback doesn't match the new `PushDeps.summarize` shape yet) — that's Task 4's.

- [ ] **Step 7: Commit**

```bash
git add src/lib/odoo/meeting-log-push.ts src/lib/odoo/meeting-log-actions.ts \
  src/tests/odoo-meeting-log-push.test.ts src/tests/meeting-log-actions.test.ts
git commit -m "feat(odoo): thread conversation_id through PushDeps.summarize and boundedSummarize, drop the row-level summary cache"
```

---

### Task 4: Rewire `useMeetingLog.ts`'s `summarize` wiring

**Files:**
- Modify: `src/hooks/useMeetingLog.ts`
- Modify: `src/tests/useMeetingLog.enqueue.test.tsx`, `src/tests/useMeetingLog.hold.test.tsx` — both mock `@/lib/functions/meeting-summarizer` with a factory naming only the old `generateMeetingLogSummary` export. Once `useMeetingLog.ts` imports `ensureMeetingSummary` by name, that named import resolves against an incomplete mock and Vitest throws `No "ensureMeetingSummary" export is defined on the mock` at module load — both suites die entirely, not just the assertions that touch it.

**Interfaces:**
- Consumes: `ensureMeetingSummary` (Task 1), `PushDeps.summarize`'s new shape (Task 3).
- Produces: nothing new — this task only rewires an existing internal `useCallback`.

- [ ] **Step 1: Update the import and the `summarize` callback**

In `src/hooks/useMeetingLog.ts`:

1. Change the import at the top from `generateMeetingLogSummary` to `ensureMeetingSummary`:

```ts
import { ensureMeetingSummary } from "@/lib/functions/meeting-summarizer";
```

2. Replace the `summarize` `useCallback` (currently `:197-201`):

```ts
  const summarize = useCallback(
    (conversationId: string | null, entries: TranscriptEntry[]) =>
      ensureMeetingSummary(conversationId, entries, providerConfigRef.current, 1),
    []
  );
```

3. Update `pushHeldRow`'s call site (currently `:210-220`, the `summarize: (slice) => summarize(slice.entries)` line inside the `pushQueuedRow` deps object):

```ts
        summarize: (conversationId, slice) => summarize(conversationId, slice.entries),
```

4. Update the closure built at `:483` and handed to `runMeetingLogSweep`:

```ts
    void runMeetingLogSweep((conversationId, slice) => summarize(conversationId, slice.entries))
```

- [ ] **Step 2: Type-check**

Run: `npm run type-check`
Expected: PASS with no errors in `useMeetingLog.ts` or `meeting-log-push.ts`.

- [ ] **Step 3: Add a dedicated multi-row test proving per-row `conversation_id` reaches the sweep's shared closure**

`runMeetingLogSweep(async () => null)`'s existing call sites in `src/tests/odoo-meeting-log-sweep.test.ts` stay valid without edits — TypeScript allows a zero-parameter function to satisfy a two-parameter function type, since it's safe for a caller to pass arguments a function simply ignores. But none of those existing tests assert on what `summarize` is actually CALLED WITH, so none of them can catch the bug this task's signature change exists to fix (the single closure built in `useMeetingLog.ts` and handed to `runMeetingLogSweep` is defined once, before any row is known). Add this test, following the exact `seedRow`/`seedTargets`/`tauriFetch` pattern the file's own `"performs exactly one authenticate across a two-row run"` test already uses (`src/tests/odoo-meeting-log-sweep.test.ts`, around line 197):

```ts
  it("passes each row's own conversation_id to summarize, not the same value twice", async () => {
    seedRow({ id: "a", session_key: "a", conversation_id: "conv-a" });
    seedRow({ id: "b", session_key: "b", conversation_id: "conv-b" });
    seedTargets("a", 42);
    seedTargets("b", 42);
    tauriFetch.mockImplementation(async (_url, init) => {
      const body = String((init as { body: string }).body);
      if (body.includes("authenticate")) return AUTH();
      return body.includes("ir.attachment") ? intResponse(555) : intResponse(999);
    });

    const seen: (string | null)[] = [];
    await runMeetingLogSweep(async (conversationId) => {
      seen.push(conversationId);
      return null;
    });

    expect(seen).toEqual(["conv-a", "conv-b"]);
  });
```

- [ ] **Step 4: Run the sweep test suite**

Run: `npx vitest run src/tests/odoo-meeting-log-sweep.test.ts`
Expected: PASS (this file already had its `summary_json` fixture fixed in Task 2). Note this test exercises `runMeetingLogSweep` itself (in `meeting-log-push.ts`), directly — it proves that function's own per-row dispatch is correct, but it does NOT render `useMeetingLog`'s hook, so it says nothing about whether THIS task's own closures (Step 1.3, 1.4) forward their arguments correctly. Step 5 below closes that gap.

- [ ] **Step 5: Fix the two hook suites' stale mock, and add a real test of `pushHeldRow`'s own closure**

1. In both `src/tests/useMeetingLog.enqueue.test.tsx` and `src/tests/useMeetingLog.hold.test.tsx`, rename the mock factory's export:

```ts
const summarizer = vi.hoisted(() => ({
  ensureMeetingSummary: vi.fn(async () => null),
}));
```

Then rename every `summarizer.generateMeetingLogSummary` reference to `summarizer.ensureMeetingSummary`: `useMeetingLog.enqueue.test.tsx:220` (its `beforeEach`), and `useMeetingLog.hold.test.tsx:219` (its `beforeEach`) and `:287` (the "cancels the row, pushes nothing and makes no AI call" assertion). `grep -n generateMeetingLogSummary src/tests/useMeetingLog.enqueue.test.tsx src/tests/useMeetingLog.hold.test.tsx` afterward to confirm none remain.

2. Add this test to `useMeetingLog.hold.test.tsx`'s `describe("the hold", ...)` block, alongside "pushes exactly once after the hold elapses": it captures the ACTUAL closure `pushHeldRow` builds (Step 1.3 above) via the mocked `pushQueuedRow`'s own call arguments, then invokes that closure directly — the one thing Step 4's sweep test structurally cannot reach, since it never renders this hook at all.

```ts
  it("pushHeldRow's summarize dep forwards conversationId and the sliced entries to ensureMeetingSummary", async () => {
    action.getQueueRow.mockResolvedValue({ id: "row-1", status: "held", conversation_id: "conv-1" });
    render();
    await waitFor(() => expect(listeners.has("meeting-ended")).toBe(true));
    fireMeetingEnded();
    await waitFor(() => expect(action.insertQueueRow).toHaveBeenCalled());
    await vi.advanceTimersByTimeAsync(HOLD_MS);
    await waitFor(() => expect(push.pushQueuedRow).toHaveBeenCalledTimes(1));

    const deps = push.pushQueuedRow.mock.calls[0][1] as {
      summarize: (conversationId: string | null, slice: unknown) => unknown;
    };
    const slice = { entries: [entry(1000)], startAt: 1000, endAt: 2000 };
    await deps.summarize("conv-1", slice);

    expect(summarizer.ensureMeetingSummary).toHaveBeenCalledWith(
      "conv-1",
      slice.entries,
      expect.anything(),
      1
    );
  });
```

- [ ] **Step 6: Run both hook suites**

Run: `npx vitest run src/tests/useMeetingLog.enqueue.test.tsx src/tests/useMeetingLog.hold.test.tsx`
Expected: PASS (both suites load again now that the mock export name matches, and the new case passes).

- [ ] **Step 7: Lint**

Run: `npm run lint`
Expected: PASS.

- [ ] **Step 8: Commit**

```bash
git add src/hooks/useMeetingLog.ts src/tests/odoo-meeting-log-sweep.test.ts \
  src/tests/useMeetingLog.enqueue.test.tsx src/tests/useMeetingLog.hold.test.tsx
git commit -m "feat(odoo): rewire useMeetingLog's summarize wiring onto ensureMeetingSummary"
```

---

### Task 5: Per-conversation transcript slicing in `useCompletion.ts`

**Files:**
- Modify: `src/hooks/useCompletion.ts`
- Modify: `src/tests/useCompletion.meeting-assist.test.tsx`, `src/tests/odoo-target-new-chat-entry-points.test.tsx` — both mock `@/lib/functions/meeting-summarizer` with the old `{ summarizeConversation, shouldSummarize }` shape; once this task's Step 5 lands, that mock no longer matches what `useCompletion.ts` imports.
- Test: `src/tests/summarize-current-conversation.slice.test.tsx` (`.tsx`, not `.ts` — its `strictModeWrapper` helper below returns JSX).

**Interfaces:**
- Consumes: `ensureMeetingSummary` (Task 1).
- Produces: `conversationTranscriptStartRef` (internal ref, not exported) — no external API change; `summarizeCurrentConversation`'s observable behavior changes (calls `ensureMeetingSummary` with a slice of `meetingTranscript`, not the whole of `conversationHistory`).

This is the task carrying the CRITICAL risk identified in spec review: the ref MUST be read synchronously, before `summarizeCurrentConversation`'s own first `await`, or the fix silently never fires. Follow the steps in order; do not reorder the synchronous read below any `await`.

- [ ] **Step 1: Update the existing harness's meeting-summarizer mock**

`src/tests/useCompletion.meeting-assist.test.tsx` already mocks this module (near its top):

```ts
vi.mock("@/lib/functions/meeting-summarizer", () => ({
  summarizeConversation: vi.fn(),
  shouldSummarize: vi.fn(() => false),
}));
```

Change it to:

```ts
vi.mock("@/lib/functions/meeting-summarizer", () => ({
  ensureMeetingSummary: vi.fn(async () => null),
}));
```

and add `ensureMeetingSummary` to that file's existing top-of-file import block (alongside `appendMessagesToConversation`, `fetchAIResponse`, etc. — actually `ensureMeetingSummary` lives in `@/lib/functions/meeting-summarizer`, a different module than the `@/lib` barrel those are imported from; add a separate import: `import { ensureMeetingSummary } from "@/lib/functions/meeting-summarizer";`).

`src/tests/odoo-target-new-chat-entry-points.test.tsx` mocks the identical old shape at `:82-85`:

```ts
vi.mock("@/lib/functions/meeting-summarizer", () => ({
  summarizeConversation: vi.fn(),
  shouldSummarize: vi.fn(() => false),
}));
```

Change it the same way:

```ts
vi.mock("@/lib/functions/meeting-summarizer", () => ({
  ensureMeetingSummary: vi.fn(async () => null),
}));
```

This file never imports the named export directly (it only exercises `useCompletion` through its public surface), so no companion import line is needed here — unlike `useCompletion.meeting-assist.test.tsx` above.

- [ ] **Step 2: Write the failing test**

Create `src/tests/summarize-current-conversation.slice.test.tsx` (`.tsx`, not `.ts` — `strictModeWrapper` below returns JSX, and a `.ts` file cannot contain a JSX literal), reusing this repo's existing `useCompletion` harness verbatim (the mock blocks below are copied from `useCompletion.meeting-assist.test.tsx`, which already establishes this exact pattern):

```ts
import { PropsWithChildren, StrictMode } from "react";
import { act, renderHook } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

const APP_CONTEXT = {
  selectedAIProvider: { provider: null },
  allAiProviders: [],
  systemPrompt: "",
  screenshotConfiguration: { enabled: false, mode: "manual" },
  setScreenshotConfiguration: vi.fn(),
};
vi.mock("@/contexts", () => ({ useApp: () => APP_CONTEXT }));

vi.mock("@/hooks", () => ({
  useGlobalShortcuts: () => ({
    registerAudioCallback: vi.fn(),
    registerInputRef: vi.fn(),
    registerScreenshotCallback: vi.fn(),
  }),
}));

const resizeWindow = vi.hoisted(() => vi.fn(async () => {}));
vi.mock("@/hooks/useWindow", () => ({ useWindowResize: () => ({ resizeWindow }) }));

vi.mock("@/lib", () => {
  let messageIdSequence = 0;
  const mockGenerateConversationId = vi.fn(() => "conversation-B");
  return {
    fetchAIResponse: vi.fn(async function* () {} as never),
    saveConversation: vi.fn(),
    appendMessagesToConversation: vi.fn(),
    getConversationById: vi.fn().mockResolvedValue(null),
    generateConversationTitle: vi.fn((message: string) => message),
    shouldUseMeetwingsAPI: vi.fn().mockResolvedValue(false),
    MESSAGE_ID_OFFSET: 1,
    generateConversationId: mockGenerateConversationId,
    ensureConversationId: vi.fn((ref: { current: string | null }) => {
      ref.current ??= mockGenerateConversationId();
      return ref.current;
    }),
    generateMessageId: vi.fn(
      (role: string, timestamp: number) => `${role}-${timestamp}-${(messageIdSequence += 1)}`
    ),
    generateRequestId: vi.fn(() => "request-1"),
    getResponseSettings: vi.fn(() => ({ autoScroll: false })),
    createUsageRecord: vi.fn(),
    calculateCost: vi.fn(() => 0),
    calculateSTTCost: vi.fn(() => 0),
    setActiveConversationId: vi.fn(),
    clearActiveConversationId: vi.fn(),
  };
});

const ensureMeetingSummary = vi.fn(async () => null);
vi.mock("@/lib/functions/meeting-summarizer", () => ({ ensureMeetingSummary }));

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn() }));
vi.mock("@tauri-apps/api/event", () => ({ listen: vi.fn().mockResolvedValue(vi.fn()) }));

import { useCompletion } from "@/hooks/useCompletion";

const strictModeWrapper = ({ children }: PropsWithChildren) => (
  <StrictMode>{children}</StrictMode>
);

describe("summarizeCurrentConversation per-conversation slicing", () => {
  beforeEach(() => {
    ensureMeetingSummary.mockClear();
  });

  it("summarizes only entries added since the CURRENT conversation started, not the whole session", async () => {
    const { result } = renderHook(() => useCompletion(), { wrapper: strictModeWrapper });

    act(() => { result.current.setMeetingAssistMode(true); });

    // Conversation A: two entries.
    act(() => { result.current.addMeetingTranscript("A-1"); });
    act(() => { result.current.addMeetingTranscript("A-2"); });
    expect(result.current.meetingTranscript).toHaveLength(2);

    // Switch to a new conversation B. This fires summarizeCurrentConversation
    // for A fire-and-forget, then synchronously advances
    // conversationTranscriptStartRef to meetingTranscript.length (2).
    await act(async () => { await result.current.startNewConversation(); });

    // Conversation B: two more entries.
    act(() => { result.current.addMeetingTranscript("B-1"); });
    act(() => { result.current.addMeetingTranscript("B-2"); });
    expect(result.current.meetingTranscript).toHaveLength(4);

    ensureMeetingSummary.mockClear(); // discard whatever A's switch queued

    // Switch away from B.
    await act(async () => { await result.current.startNewConversation(); });

    expect(ensureMeetingSummary).toHaveBeenCalledTimes(1);
    const [, entries] = ensureMeetingSummary.mock.calls[0];
    expect(entries).toHaveLength(2);
    expect(entries.map((e: { original: string }) => e.original)).toEqual(["B-1", "B-2"]);
  });
});
```

This is the test that catches BOTH failure modes at once: a raw (unsliced) `meetingTranscript` read sends all four entries (`entries` would have length 4, containing A-1/A-2/B-1/B-2); an incorrectly-async slice read (computed after `summarizeCurrentConversation`'s first `await`, so the ref has already advanced by the time it's read) sends zero entries. Only the correct fix sends exactly `["B-1", "B-2"]`.

- [ ] **Step 3: Run to verify it fails**

Run: `npx vitest run src/tests/summarize-current-conversation.slice.test.tsx`
Expected: FAIL — `summarizeCurrentConversation` doesn't call `ensureMeetingSummary` yet (still calls the now-deleted `summarizeConversation`), so the import itself fails to compile, or `ensureMeetingSummary` is never called.

- [ ] **Step 4: Add `conversationTranscriptStartRef` and set it at every conversation-start point**

In `src/hooks/useCompletion.ts`:

0. Update the top-of-file import (currently `:32-35`):

```ts
import { ensureMeetingSummary } from "@/lib/functions/meeting-summarizer";
```

(replacing the existing `import { summarizeConversation, shouldSummarize } from "@/lib/functions/meeting-summarizer";` block — Step 5 below rewrites every call site that used those two names, so this file must stop importing them in the same task, not leave a dangling reference to a deleted export.)

1. Near the other refs (around `:196-201`, alongside `currentConversationIdRef`, `conversationHistoryRef`, `meetingTranscriptLengthRef`), add:

```ts
  // Index into meetingTranscript at which the CURRENT conversation's own
  // live activity begins. meetingTranscript is a session-wide buffer, never
  // cleared per conversation (see meeting-log.ts's doc comment on the same
  // fact) - this ref is what lets summarizeCurrentConversation slice out
  // only the entries that belong to the conversation actually being left,
  // mirroring the watermark useMeetingLog.ts's Odoo trigger already needs
  // for the identical reason.
  const conversationTranscriptStartRef = useRef(0);
```

2. In `addMeetingTranscript` (around `:606-646`), BEFORE the line that calls `setMeetingTranscript((prev) => [...prev, entry])`, capture whether this call is minting a brand-new conversation id (i.e. `currentConversationIdRef.current` is currently null), and if so set the start ref to the PRE-push length:

```ts
  const addMeetingTranscript = useCallback((
    transcript: string,
    speakerInfo?: SpeakerInfo,
    audioSource?: 'microphone' | 'system'
  ): number => {
    const timestamp = Date.now();
    if (!transcript.trim()) return timestamp;

    // A brand-new conversation starts with THIS entry - captured before the
    // push below so conversationTranscriptStartRef points at it, not past it.
    if (!currentConversationIdRef.current) {
      conversationTranscriptStartRef.current = meetingTranscriptLengthRef.current;
    }

    // Add to meeting transcript array with TranscriptEntry structure
    const entry: TranscriptEntry = {
```

(the rest of the function is unchanged). Apply the identical guard to `addMeetingTranscriptEntries` (around `:652-691`), before its own `setMeetingTranscript((prev) => [...prev, ...validEntries])` call.

Apply the SAME guard to `addSystemAudioTranscript` (`:732-776`), before its own `setMeetingTranscript((prev) => [...prev, entry])` call (`:750`) — it mints a new conversation id exactly like the two functions above (`ensureConversationId(currentConversationIdRef)` at `:753`), so a meeting whose first speaker arrives over system audio rather than the microphone needs the identical boundary set, or the slice for that conversation silently starts at the PREVIOUS conversation's boundary instead of its own:

```ts
      // A brand-new conversation starts with THIS entry - same guard as
      // addMeetingTranscript, needed here too because system audio can be
      // the first speaker in a meeting.
      if (!currentConversationIdRef.current) {
        conversationTranscriptStartRef.current = meetingTranscriptLengthRef.current;
      }

      // Just append - timestamps are monotonically increasing
      setMeetingTranscript((prev) => [...prev, entry]);
```

3. In `loadConversation` (around `:1401-1428`), right where `currentConversationIdRef.current = conversation.id;` is set (immediately BEFORE that line, so both refs advance together in the same synchronous statement group):

```ts
    conversationTranscriptStartRef.current = meetingTranscript.length;
    currentConversationIdRef.current = conversation.id;
```

4. In `startNewConversation` (around `:1430-1453`), same pattern, right before `currentConversationIdRef.current = null;`:

```ts
    conversationTranscriptStartRef.current = meetingTranscript.length;
    currentConversationIdRef.current = null;
```

Add `meetingTranscript.length` to this `useCallback`'s own dependency array (currently `[summarizeCurrentConversation, flushUnsavedMeetingTranscript]`, at the function's closing `}, [...])`) — matching `loadConversation`'s array, which already lists it:

```ts
  }, [summarizeCurrentConversation, meetingTranscript.length, flushUnsavedMeetingTranscript]);
```

Not a live bug today — `summarizeCurrentConversation` is itself already a dependency, and Step 5 below gives IT a `meetingTranscript` dependency, so `startNewConversation` is transitively recreated on every transcript change regardless. Add it anyway: `eslint-plugin-react-hooks`'s exhaustive-deps rule will flag the now-newly-read `meetingTranscript.length` as used-but-missing, and leaving it out relies on a transitive relationship a future, unrelated change to `summarizeCurrentConversation`'s own deps could silently break.

5. In `clearMeetingTranscript` (`:778-823`), right where `currentConversationIdRef.current = null;` is set (`:796`), add the same reset — `0`, not `meetingTranscript.length`, since this function is itself the one setting `meetingTranscript` to `[]` two lines above:

```ts
    conversationTranscriptStartRef.current = 0;
    currentConversationIdRef.current = null;
```

This path already self-heals without the explicit reset — `meetingTranscriptLengthRef.current` re-syncs to `0` via the `useLayoutEffect` at `:506-508` before any subsequent call can read it, and every subsequent conversation-start guard reads THAT ref, not this one directly. Add it anyway, for the same reason as `startNewConversation`'s deps entry above: an explicit reset keeps `conversationTranscriptStartRef`'s invariant ("always equals the boundary of the conversation `currentConversationIdRef` currently names") true by construction here too, rather than true only because of a timing relationship that lives in a different function.

- [ ] **Step 5: Rewrite `summarizeCurrentConversation`, reading the ref FIRST**

Replace the whole function (currently `:1358-1399`):

```ts
  const summarizeCurrentConversation = useCallback(() => {
    // MUST be the very first thing this function does, before any await.
    // loadConversation/startNewConversation call this function fire-and-
    // forget and then IMMEDIATELY run their own remaining synchronous
    // statements - including the line that advances
    // conversationTranscriptStartRef to the NEW conversation. Calling an
    // async function runs its body synchronously up to its first await;
    // anything after that await runs as a later microtask, AFTER the
    // caller's synchronous code has already finished. Reading the ref here,
    // before any await, guarantees this read happens before the caller's
    // own advance - moving this below an await makes the slice empty on
    // EVERY switch, deterministically, not as a rare race.
    if (!state.currentConversationId) {
      return;
    }
    const slice = meetingTranscript.slice(conversationTranscriptStartRef.current);

    void (async () => {
      const useMeetwingsAPI = await shouldUseMeetwingsAPI();
      const provider = allAiProviders.find(p => p.id === selectedAIProvider.provider);

      ensureMeetingSummary(
        state.currentConversationId,
        slice,
        useMeetwingsAPI ? undefined : provider ? {
          provider,
          selectedProvider: selectedAIProvider,
        } : undefined
      ).then(result => {
        if (result) {
          console.log("[Context Memory] Conversation summarized successfully");
        }
      }).catch(error => {
        console.error("[Context Memory] Failed to summarize conversation:", error);
      });
    })();
  }, [
    state.currentConversationId,
    meetingTranscript,
    allAiProviders,
    selectedAIProvider
  ]);
```

Note the shape change: the OUTER function is no longer `async` itself — it does its synchronous ref-read-and-guard FIRST, then kicks off an inner async IIFE for the actual AI-call machinery (which still needs its own `await shouldUseMeetwingsAPI()`). This is what makes "read the ref before any await" possible while keeping the existing provider-resolution logic, which does need to await something. The dependency array drops `state.conversationHistory` (no longer read) and adds `meetingTranscript` (now read directly, not through a ref, because the function needs the CURRENT array — using a ref here instead would reintroduce a version of the same staleness problem this task exists to fix).

- [ ] **Step 6: Run the test to verify it passes**

Run: `npx vitest run src/tests/summarize-current-conversation.slice.test.tsx`
Expected: PASS.

- [ ] **Step 7: Run the full `useCompletion` test suite**

Run: `npx vitest run` scoped to every existing test file that exercises `useCompletion`, `loadConversation`, `startNewConversation`, `addMeetingTranscript`, or `addMeetingTranscriptEntries` — find them with:

```bash
grep -rl "useCompletion\|loadConversation\|startNewConversation\|addMeetingTranscript" src/tests --include="*.test.ts*" -l
```

This pattern already matches `odoo-target-new-chat-entry-points.test.tsx` (it exercises `startNewConversation`), so Step 1's fix to that file gets verified here too — no separate run step needed for it.

Run each returned file with `npx vitest run <file>`.
Expected: PASS. Pay particular attention to any test asserting `summarizeCurrentConversation`'s OLD behavior (gating on `conversationHistory.length`, or calling the now-deleted `summarizeConversation`/`shouldSummarize`) — update those to the new contract (gates on `!state.currentConversationId` only; the length gate moved inside `ensureMeetingSummary`).

- [ ] **Step 8: Type-check and lint**

Run: `npm run type-check && npm run lint`
Expected: no new errors.

- [ ] **Step 9: Commit**

```bash
git add src/hooks/useCompletion.ts src/tests/useCompletion.meeting-assist.test.tsx \
  src/tests/odoo-target-new-chat-entry-points.test.tsx \
  src/tests/summarize-current-conversation.slice.test.tsx
git commit -m "fix(context-memory): scope summarizeCurrentConversation to the leaving conversation's own transcript slice"
```

---

### Task 6: `ChatMessage[] → TranscriptEntry[]` adapter in the two backfill callers

**Files:**
- Modify: `src/lib/functions/knowledge-compactor.ts`
- Modify: `src/hooks/useSystemAudio.ts`
- Test: `src/tests/summarize-pending-conversations.test.ts` (new — `summarizePendingConversations` has no existing dedicated test; `knowledge-compactor.summary-dates.test.ts` only covers the unrelated `formatSummariesForCompaction`)

**Interfaces:**
- Consumes: `ensureMeetingSummary`, `chatMessagesToTranscriptEntries` (Task 1).

- [ ] **Step 1: Rewire `knowledge-compactor.ts`**

In `src/lib/functions/knowledge-compactor.ts`:

1. Change the import from `./meeting-summarizer`:

```ts
import {
  chatMessagesToTranscriptEntries,
  ensureMeetingSummary,
} from "./meeting-summarizer";
```

Keep `extractJsonObject` — the existing top-of-file import (currently `import { extractJsonObject, summarizeConversation, shouldSummarize } from "./meeting-summarizer";`) is what this replaces, and `extractJsonObject` is still used at `:288`, inside the unrelated `parseCompactionResponse` (`JSON.parse(extractJsonObject(response))`) — nothing else in this task touches that function. Only `summarizeConversation`/`shouldSummarize` are actually going away:

```ts
import {
  extractJsonObject,
  chatMessagesToTranscriptEntries,
  ensureMeetingSummary,
} from "./meeting-summarizer";
```

Also add `getMeetingSummaryByConversation` to the existing `@/lib/database` import a few lines above (currently `getKnowledgeProfile, updateKnowledgeProfile, getOldestUncompactedSummaries, getUncompactedSummaryCount, getUnsummarizedConversations`) — Step 1.2 below needs it and it is not yet imported into this file.

2. Inside `summarizePendingConversations`'s loop (around `:87-116`), replace:

```ts
    const messages = conv.messages.map((m) => ({
      role: m.role,
      content: m.content,
    }));

    // Too short to summarize — a cheap no-AI skip, so it must not count against
    // the cap. (Already-summarized conversations are excluded at the DB layer by
    // getUnsummarizedConversations.)
    if (!shouldSummarize(messages)) {
      continue;
    }

    // From here summarizeConversation makes a streaming AI call whether it
    // succeeds or fails, so count the attempt (not just successes) against the
    // cap before making it.
    if (attempts >= MAX_BACKFILL_PER_CLICK) {
      cappedAtLimit = true;
      break;
    }
    attempts += 1;

    const ok = await summarizeConversation(conv.id, messages, providerConfig);
    if (ok) {
      summarized += 1;
    }
```

with:

```ts
    const entries = chatMessagesToTranscriptEntries(conv.messages);

    // Too short to summarize — a cheap no-AI skip, so it must not count
    // against the cap. Checked against the SAME 4-entry floor
    // ensureMeetingSummary applies internally (its default minEntries), so
    // this pre-check and the real gate can never disagree. (Already-
    // summarized conversations are excluded at the DB layer by
    // getUnsummarizedConversations.)
    if (entries.length < 4) {
      continue;
    }

    // From here ensureMeetingSummary makes a streaming AI call whether it
    // succeeds or fails, so count the attempt (not just successes) against the
    // cap before making it.
    if (attempts >= MAX_BACKFILL_PER_CLICK) {
      cappedAtLimit = true;
      break;
    }
    attempts += 1;

    const result = await ensureMeetingSummary(conv.id, entries, providerConfig);
    if (result) {
      // A truthy result means "generation and persistence both succeeded, OR
      // this conversation already had a cached summary" - it does NOT
      // distinguish those from "generation succeeded but the persist write
      // then threw", because ensureMeetingSummary's own outer try/catch
      // (Task 1) converts that case to a null return too. Re-check against
      // what is actually stored, rather than trusting the return value alone -
      // this counter drives the caller's attempts>0 && summarized===0
      // failure toast (src/pages/context-memory/index.tsx), and an
      // over-counted `summarized` here would silently swallow that toast on a
      // batch where the AI calls succeeded but nothing was actually saved.
      const persisted = await getMeetingSummaryByConversation(conv.id);
      if (persisted) {
        summarized += 1;
      }
    }
```

3. Remove the now-unused `shouldSummarize`/`summarizeConversation` import (already dropped in Step 1.1's replacement import block above).

- [ ] **Step 2: Rewire `useSystemAudio.ts`**

In `src/hooks/useSystemAudio.ts`:

1. Change the import at line 6 from `import { fetchSTT, fetchAIResponse, summarizeConversation, shouldSummarize } from "@/lib/functions";` to:

```ts
import { fetchSTT, fetchAIResponse, chatMessagesToTranscriptEntries, ensureMeetingSummary } from "@/lib/functions";
```

2. Replace the capture-stop block (around `:646-680`):

```ts
      // Trigger summarization if we have enough exchanges (async, non-blocking)
      if (conversation.id && conversation.messages.length > 0) {
        // conversation.messages is newest-first here (each exchange is prepended
        // during capture). summarizeConversation expects chronological
        // (oldest-first) order like the other callers, so reverse before sending.
        const messagesToSummarize = [...conversation.messages]
          .reverse()
          .map((msg) => ({
            role: msg.role,
            content: msg.content,
          }));

        if (shouldSummarize(messagesToSummarize)) {
          // Get provider config for summarization
          const provider = allAiProviders.find(
            (p) => p.id === selectedAIProvider.provider
          );

          const providerConfig = provider
            ? {
                provider,
                selectedProvider: selectedAIProvider,
              }
            : undefined;

          // Run summarization async (don't await to avoid blocking UI)
          summarizeConversation(
            conversation.id,
            messagesToSummarize,
            providerConfig
          )
            .then((success) => {
              if (success) {
                console.log(`Summarized conversation ${conversation.id}`);
              }
            })
            .catch((err) => {
              console.error("Background summarization failed:", err);
            });
        }
      }
```

with:

```ts
      // Trigger summarization if we have enough exchanges (async, non-blocking)
      if (conversation.id && conversation.messages.length > 0) {
        // conversation.messages is newest-first here (each exchange is
        // prepended during capture) - reverse to chronological order before
        // filtering/mapping to TranscriptEntry[]. This hook's local
        // ChatMessage (line 54) has no speaker/audioSource fields at all;
        // chatMessagesToTranscriptEntries handles that (both are optional
        // on its accepted shape) and still filters out role: "assistant".
        const entries = chatMessagesToTranscriptEntries(
          [...conversation.messages].reverse()
        );

        if (entries.length >= 4) {
          const provider = allAiProviders.find(
            (p) => p.id === selectedAIProvider.provider
          );

          const providerConfig = provider
            ? {
                provider,
                selectedProvider: selectedAIProvider,
              }
            : undefined;

          // Run summarization async (don't await to avoid blocking UI)
          ensureMeetingSummary(conversation.id, entries, providerConfig)
            .then((result) => {
              if (result) {
                console.log(`Summarized conversation ${conversation.id}`);
              }
            })
            .catch((err) => {
              console.error("Background summarization failed:", err);
            });
        }
      }
```

- [ ] **Step 3: Write the failing integration test for the filtered-count gate**

No existing test exercises `summarizePendingConversations`'s loop at all — `src/tests/knowledge-compactor.summary-dates.test.ts` only covers the unrelated `formatSummariesForCompaction` in the same file (it mocks `@/lib/database`, `ai-response.function`, `meetwings.api`, and `@/lib/storage`, but never calls `summarizePendingConversations` or touches `summarizeConversation`/`shouldSummarize`). Create `src/tests/summarize-pending-conversations.test.ts`, reusing that file's exact mocking pattern:

```ts
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ChatConversation } from "@/types";

const {
  getUnsummarizedConversations,
  createMeetingSummary,
  getMeetingSummaryByConversation,
} = vi.hoisted(() => ({
  getUnsummarizedConversations: vi.fn(),
  createMeetingSummary: vi.fn(async () => ({ id: "s1" })),
  // Call-aware, not a flat resolved value: ensureMeetingSummary's OWN
  // internal cache check (Task 1) calls this once per conversation BEFORE
  // generating, and Step 1.2's re-check above calls it a second time AFTER a
  // truthy result - the first call must stay a cache MISS (null) or the AI
  // path this test exists to exercise never runs at all, and the second call
  // must return a row or `summarized` stays 0 even on a real success.
  getMeetingSummaryByConversation: vi.fn(),
}));
vi.mock("@/lib/database", () => ({
  getKnowledgeProfile: vi.fn(),
  updateKnowledgeProfile: vi.fn(),
  getOldestUncompactedSummaries: vi.fn(),
  getUncompactedSummaryCount: vi.fn(),
  getUnsummarizedConversations,
  createMeetingSummary,
  getMeetingSummaryByConversation,
  createOrUpdateKnowledgeEntity: vi.fn(async () => ({ id: "e1" })),
  createEntityMention: vi.fn(async () => true),
  applySummaryTitleToConversation: vi.fn(async () => true),
}));

const { fetchAIResponse } = vi.hoisted(() => ({ fetchAIResponse: vi.fn() }));
vi.mock("@/lib/functions/ai-response.function", () => ({ fetchAIResponse }));

vi.mock("@/lib/functions/meetwings.api", () => ({
  shouldUseMeetwingsAPI: vi.fn(async () => false),
}));

vi.mock("@/lib/storage", () => ({
  getUserIdentity: vi.fn(() => null),
  hasUserIdentity: vi.fn(() => false),
  getActiveConversationId: vi.fn(() => null),
}));

import { summarizePendingConversations } from "@/lib/functions/knowledge-compactor";

function stream(chunks: string[]) {
  return async function* () {
    for (const c of chunks) yield c;
  };
}

const MIXED_CONVERSATION: ChatConversation = {
  id: "conv-1",
  title: "Old Chat",
  messages: [
    { id: "m1", role: "user", content: "u1", timestamp: 1 },
    { id: "m2", role: "assistant", content: "a1", timestamp: 2 },
    { id: "m3", role: "user", content: "u2", timestamp: 3 },
    { id: "m4", role: "assistant", content: "a2", timestamp: 4 },
    { id: "m5", role: "user", content: "u3", timestamp: 5 },
    { id: "m6", role: "assistant", content: "a3", timestamp: 6 },
    { id: "m7", role: "user", content: "u4", timestamp: 7 },
    { id: "m8", role: "assistant", content: "a4", timestamp: 8 },
  ],
  createdAt: 1,
  updatedAt: 8,
};

const providerConfig = {
  provider: { id: "openai" },
  selectedProvider: { provider: "openai", variables: {} },
};

beforeEach(() => {
  fetchAIResponse.mockReset();
  getUnsummarizedConversations.mockReset();
  createMeetingSummary.mockClear();
  getMeetingSummaryByConversation.mockReset();
  getMeetingSummaryByConversation
    .mockResolvedValueOnce(null) // ensureMeetingSummary's own cache check
    .mockResolvedValue({ id: "s1", conversationId: "conv-1" }); // this task's re-check, and any further calls
});

describe("summarizePendingConversations", () => {
  it("gates on the FILTERED user-message count (4), not the raw message count (8)", async () => {
    // 4 user + 4 assistant = 8 raw messages. If the loop's pre-check (or
    // ensureMeetingSummary's own gate) counted raw messages against a
    // minEntries of 4, this would pass trivially either way - the point of
    // this test is that it passes on the FILTERED count too, proving the
    // adapter's role==="user" filter runs before the count is checked, not
    // just that some AI call eventually happens.
    getUnsummarizedConversations.mockResolvedValue([MIXED_CONVERSATION]);
    fetchAIResponse.mockImplementation(stream(['{"summary":"backfilled"}']));

    const result = await summarizePendingConversations(providerConfig);

    expect(result.summarized).toBe(1);
    expect(result.attempts).toBe(1);
    expect(fetchAIResponse).toHaveBeenCalledTimes(1);
    const userMessage = fetchAIResponse.mock.calls[0][0].userMessage as string;
    // Only the 4 user lines should reach the transcript sent to the AI.
    expect(userMessage).toContain("u1");
    expect(userMessage).toContain("u4");
    expect(userMessage).not.toContain("a1");
    expect(userMessage).not.toContain("a4");
  });

  it("skips a conversation whose FILTERED count is below 4, without counting it as an attempt", async () => {
    const short: ChatConversation = {
      ...MIXED_CONVERSATION,
      // 3 user + 5 assistant = 8 raw messages, but only 3 pass the filter.
      messages: [
        ...MIXED_CONVERSATION.messages.slice(0, 6),
        { id: "m9", role: "assistant", content: "a5", timestamp: 9 },
      ],
    };
    getUnsummarizedConversations.mockResolvedValue([short]);

    const result = await summarizePendingConversations(providerConfig);

    expect(result.attempts).toBe(0);
    expect(result.summarized).toBe(0);
    expect(fetchAIResponse).not.toHaveBeenCalled();
  });
});
```

- [ ] **Step 4: Run to verify it fails, then implement, then verify it passes**

Run: `npx vitest run src/tests/summarize-pending-conversations.test.ts`
Expected: FAIL before Steps 1-2 of this task land (the import itself fails, or the old `shouldSummarize`/`summarizeConversation` path doesn't match these assertions); PASS after.

- [ ] **Step 5: Run the rest of the affected test suites**

```bash
grep -rl "knowledge-compactor\|useSystemAudio" src/tests --include="*.test.ts*"
```

Run each returned file with `npx vitest run <file>`.
Expected: PASS, including `src/tests/knowledge-compactor.summary-dates.test.ts` unmodified (it never touched `summarizeConversation`/`shouldSummarize` to begin with).

- [ ] **Step 6: Type-check and lint**

Run: `npm run type-check && npm run lint`
Expected: PASS, no errors anywhere referencing `summarizeConversation`, `shouldSummarize`, `generateConversationSummary`, or `generateMeetingLogSummary` (confirm with `grep -rn "summarizeConversation\|shouldSummarize\b" src --include="*.ts" --include="*.tsx"` returning nothing outside `meeting-summarizer.ts`'s own now-removed history).

- [ ] **Step 7: Commit**

```bash
git add src/lib/functions/knowledge-compactor.ts src/hooks/useSystemAudio.ts \
  src/tests/summarize-pending-conversations.test.ts
git commit -m "feat(context-memory): route the Update-Knowledge backfill and system-audio capture through ensureMeetingSummary"
```

---

### Task 7: Extract `SummaryContent` from `SummaryDetail.tsx`

**Files:**
- Create: `src/pages/context-memory/components/SummaryContent.tsx`
- Modify: `src/pages/context-memory/components/SummaryDetail.tsx`
- Test: `src/tests/summary-content.render.test.tsx`

**Interfaces:**
- Produces: `SummaryContent({ summary, entities, showSummary }: { summary: MeetingSummary; entities: KnowledgeEntity[]; showSummary?: boolean }): JSX.Element` — pure presentational, no fetching, no edit state (`showSummary`, default `true`, only toggles whether its OWN read-only summary-text block renders; it carries no editing logic of its own). Consumed by both `SummaryDetail.tsx` (Task 7) and the dashboard expand (Task 8). Per the spec ("the dashboard expand is a compact inline view and doesn't need it"), the exchange-count footer stays OUT of this component entirely — it is `SummaryDetail.tsx`'s own chrome, not part of the shared piece.

- [ ] **Step 1: Write the failing render test**

Create `src/tests/summary-content.render.test.tsx`:

```tsx
import { describe, expect, it } from "vitest";
import { render, screen } from "@testing-library/react";
import { SummaryContent } from "@/pages/context-memory/components/SummaryContent";
import type { MeetingSummary, KnowledgeEntity } from "@/types";

const SUMMARY: MeetingSummary = {
  id: "s1", conversationId: "c1", summary: "We discussed the roadmap.",
  title: "Roadmap Sync", topics: ["roadmap"], goals: ["ship v2"],
  actionItems: ["write the doc"], nextSteps: ["review Friday"],
  decisions: ["go with plan B"], teamUpdates: ["Ada joined the team"],
  participants: ["Ada", "Bo"], exchangeCount: 6, durationSeconds: 300,
  meetingStartedAt: 1000, meetingEndedAt: 1300, createdAt: 1, updatedAt: 1,
};

const ENTITIES: KnowledgeEntity[] = [
  // Deliberately NOT "Ada" — SUMMARY.participants already contains "Ada",
  // and the entity badge renders as a SEPARATE "organization:" span plus a
  // bare "Ada" text node inside the same Badge, which risks getByText("Ada")
  // resolving ambiguously against the participant badge depending on how
  // Testing Library's text matcher normalizes split text nodes. A distinct
  // fixture value sidesteps the ambiguity outright rather than relying on
  // matcher internals.
  { id: "e1", entityType: "organization", name: "Acme Corp", description: null, firstSeen: 1, lastSeen: 1, mentionCount: 1 },
];

describe("SummaryContent", () => {
  it("renders the summary text and every non-empty section", () => {
    render(<SummaryContent summary={SUMMARY} entities={ENTITIES} />);
    expect(screen.getByText("We discussed the roadmap.")).toBeInTheDocument();
    expect(screen.getByText("roadmap")).toBeInTheDocument();
    expect(screen.getByText("ship v2")).toBeInTheDocument();
    expect(screen.getByText("write the doc")).toBeInTheDocument();
    expect(screen.getByText("review Friday")).toBeInTheDocument();
    expect(screen.getByText("go with plan B")).toBeInTheDocument();
    expect(screen.getByText("Ada joined the team")).toBeInTheDocument();
    expect(screen.getByText("Ada")).toBeInTheDocument();
    expect(screen.getByText("Bo")).toBeInTheDocument();
    expect(screen.getByText(/Acme Corp/)).toBeInTheDocument();
  });

  it("omits a section entirely when its array is empty, rather than rendering an empty heading", () => {
    render(<SummaryContent summary={{ ...SUMMARY, goals: [] }} entities={[]} />);
    expect(screen.queryByText("Goals")).not.toBeInTheDocument();
  });

  it("omits its own summary text when showSummary is false, without touching any other section", () => {
    // SummaryDetail.tsx passes showSummary={false} while isEditing, so it can
    // render its OWN Textarea for the summary without this component's
    // read-only paragraph duplicating the same text underneath it.
    render(<SummaryContent summary={SUMMARY} entities={[]} showSummary={false} />);
    expect(screen.queryByText("We discussed the roadmap.")).not.toBeInTheDocument();
    expect(screen.getByText("roadmap")).toBeInTheDocument();
  });

  it("does not render an exchange-count footer at all — that stays in SummaryDetail.tsx's own chrome", () => {
    render(<SummaryContent summary={SUMMARY} entities={[]} />);
    expect(screen.queryByText(/transcript lines/)).not.toBeInTheDocument();
    expect(screen.queryByText(/exchanges/)).not.toBeInTheDocument();
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `npx vitest run src/tests/summary-content.render.test.tsx`
Expected: FAIL — `SummaryContent.tsx` does not exist yet.

- [ ] **Step 3: Extract `SummaryContent.tsx`**

Create `src/pages/context-memory/components/SummaryContent.tsx` by moving the Topics/Participants/Goals/Action Items/Next Steps/Decisions/Team Updates/Extracted Entities/Metadata blocks out of `SummaryDetail.tsx` (currently the JSX between the Summary text block and the closing `</CardContent>`, `:318-483` in the pre-Task-7 file) into a new component:

```tsx
import { Badge } from "@/components/ui/badge";
import { Label } from "@/components/ui/label";
import {
  Users, CheckCircle, ListTodo, Tag, Target, ArrowRight, MessageSquare,
} from "lucide-react";
import type { MeetingSummary, KnowledgeEntity } from "@/types";

export interface SummaryContentProps {
  summary: MeetingSummary;
  entities: KnowledgeEntity[];
  /** Default true. SummaryDetail.tsx passes false while isEditing, since it
   * renders its own Textarea for the summary text in that state and would
   * otherwise duplicate it directly below. */
  showSummary?: boolean;
}

export const SummaryContent = ({ summary, entities, showSummary = true }: SummaryContentProps) => {
  return (
    <div className="space-y-4">
      {showSummary && (
        <div className="space-y-2">
          <Label>Summary</Label>
          <p className="text-sm text-muted-foreground bg-accent/30 p-3 rounded-lg">
            {summary.summary}
          </p>
        </div>
      )}

      {summary.topics.length > 0 && (
        <div className="space-y-2">
          <Label className="flex items-center gap-2">
            <Tag className="h-3.5 w-3.5" />
            Topics
          </Label>
          <div className="flex flex-wrap gap-1.5">
            {summary.topics.map((topic, i) => (
              <Badge key={i} variant="secondary">{topic}</Badge>
            ))}
          </div>
        </div>
      )}

      {summary.participants.length > 0 && (
        <div className="space-y-2">
          <Label className="flex items-center gap-2">
            <Users className="h-3.5 w-3.5" />
            Participants
          </Label>
          <div className="flex flex-wrap gap-1.5">
            {summary.participants.map((person, i) => (
              <Badge key={i} variant="outline">{person}</Badge>
            ))}
          </div>
        </div>
      )}

      {summary.goals && summary.goals.length > 0 && (
        <div className="space-y-2">
          <Label className="flex items-center gap-2">
            <Target className="h-3.5 w-3.5" />
            Goals
          </Label>
          <ul className="space-y-1">
            {summary.goals.map((goal, i) => (
              <li key={i} className="text-sm text-muted-foreground flex items-start gap-2">
                <span className="text-muted-foreground/50">-</span>
                {goal}
              </li>
            ))}
          </ul>
        </div>
      )}

      {summary.actionItems.length > 0 && (
        <div className="space-y-2">
          <Label className="flex items-center gap-2">
            <ListTodo className="h-3.5 w-3.5" />
            Action Items
          </Label>
          <ul className="space-y-1">
            {summary.actionItems.map((item, i) => (
              <li key={i} className="text-sm text-muted-foreground flex items-start gap-2">
                <span className="text-muted-foreground/50">-</span>
                {item}
              </li>
            ))}
          </ul>
        </div>
      )}

      {summary.nextSteps && summary.nextSteps.length > 0 && (
        <div className="space-y-2">
          <Label className="flex items-center gap-2">
            <ArrowRight className="h-3.5 w-3.5" />
            Next Steps
          </Label>
          <ul className="space-y-1">
            {summary.nextSteps.map((step, i) => (
              <li key={i} className="text-sm text-muted-foreground flex items-start gap-2">
                <span className="text-muted-foreground/50">-</span>
                {step}
              </li>
            ))}
          </ul>
        </div>
      )}

      {summary.decisions.length > 0 && (
        <div className="space-y-2">
          <Label className="flex items-center gap-2">
            <CheckCircle className="h-3.5 w-3.5" />
            Decisions
          </Label>
          <ul className="space-y-1">
            {summary.decisions.map((decision, i) => (
              <li key={i} className="text-sm text-muted-foreground flex items-start gap-2">
                <span className="text-muted-foreground/50">-</span>
                {decision}
              </li>
            ))}
          </ul>
        </div>
      )}

      {summary.teamUpdates && summary.teamUpdates.length > 0 && (
        <div className="space-y-2">
          <Label className="flex items-center gap-2">
            <MessageSquare className="h-3.5 w-3.5" />
            Team Updates
          </Label>
          <ul className="space-y-1">
            {summary.teamUpdates.map((update, i) => (
              <li key={i} className="text-sm text-muted-foreground flex items-start gap-2">
                <span className="text-muted-foreground/50">-</span>
                {update}
              </li>
            ))}
          </ul>
        </div>
      )}

      {entities.length > 0 && (
        <div className="space-y-2">
          <Label>Extracted Entities</Label>
          <div className="flex flex-wrap gap-1.5">
            {entities.map((entity) => (
              <Badge key={entity.id} variant="outline" className="text-xs">
                <span className="capitalize text-muted-foreground mr-1">
                  {entity.entityType}:
                </span>
                {entity.name}
              </Badge>
            ))}
          </div>
        </div>
      )}
    </div>
  );
};
```

No exchange-count footer here — per the spec, that block stays in `SummaryDetail.tsx`'s own chrome (Step 4 below), since "the dashboard expand is a compact inline view and doesn't need it."

- [ ] **Step 4: Update `SummaryDetail.tsx` to render it**

In `src/pages/context-memory/components/SummaryDetail.tsx`:

1. Add the import: `import { SummaryContent } from "./SummaryContent";`

2. Replace the WHOLE `CardContent` body (currently `:301-483` — the Summary block at `:301-316` through the closing of the extraction range, right before `</CardContent>` at `:484`) with:

```tsx
        {isEditing && (
          <div className="space-y-2">
            <Label>Summary</Label>
            <Textarea
              value={editedSummary}
              onChange={(e) => setEditedSummary(e.target.value)}
              rows={4}
              className="resize-none"
            />
          </div>
        )}

        <SummaryContent summary={summary} entities={entities} showSummary={!isEditing} />

        {summary.exchangeCount > 0 && (
          <div className="pt-2 border-t border-border/50">
            <p className="text-xs text-muted-foreground">
              {summary.exchangeCount} transcript lines
            </p>
          </div>
        )}
```

This is why `showSummary` exists at all: Topics/Participants/Goals/etc. must stay visible while editing (today's actual behavior — the `isEditing` conditional in the current code wraps ONLY the summary text block, `:304-315`, never the sections after it), so `SummaryDetail.tsx` cannot simply swap `Textarea` for `<SummaryContent>` wholesale — it renders BOTH, telling `SummaryContent` to skip its own read-only summary paragraph while the Textarea is showing the same content in editable form directly above it. The exchange-count footer moves here too (was `:479-483`, inside the old extraction range) — per the spec, it is `SummaryDetail.tsx`'s own chrome, not part of the reusable piece, since the dashboard expand (Task 8) is a compact view that doesn't show it.

3. Remove the now-unused lucide icon imports from `SummaryDetail.tsx` that only the extracted JSX used: `Users, CheckCircle, ListTodo, Target, ArrowRight, MessageSquare`. Also remove the `Badge` import (`@/components/ui/badge`) — every `<Badge` usage in this file (topics, participants, extracted entities) was inside the extracted range; `tsconfig.json`'s `noUnusedLocals: true` fails `npm run type-check` on an unused import, not just lint. Do NOT remove `Tag` — it is used TWICE in this file, once inside the extracted Topics block (which moves to `SummaryContent.tsx` and gets its own `Tag` import there, already in Step 3's code) and once in the EMPTY-STATE icon at `:189` (`<Tag className="h-10 w-10 text-muted-foreground mb-3" />`), which stays in `SummaryDetail.tsx` and still needs it. Keep `Save, X, Edit2, Loader2, Copy, Check, MessageCircleReplyIcon` as before.

4. Add these two cases to `src/tests/summary-detail.conversation-link.test.tsx` (reusing its existing `SUMMARY` fixture, which already has `exchangeCount: 12`), covering the footer now that it lives here instead of in `SummaryContent`:

```tsx
  it("shows the entry-count footer with transcript-line wording, not 'exchanges'", () => {
    render(
      <SummaryDetail summary={SUMMARY} onClose={() => {}} onUpdate={() => {}} />
    );
    expect(screen.getByText(/12 transcript lines/)).toBeInTheDocument();
  });

  it("renders nothing in the footer for a migration-backfilled row (exchangeCount 0)", () => {
    render(
      <SummaryDetail
        summary={{ ...SUMMARY, exchangeCount: 0 }}
        onClose={() => {}}
        onUpdate={() => {}}
      />
    );
    expect(screen.queryByText(/transcript lines/)).not.toBeInTheDocument();
  });
```

- [ ] **Step 5: Run the tests**

Run: `npx vitest run src/tests/summary-content.render.test.tsx src/tests/summary-detail.conversation-link.test.tsx`
Expected: PASS. (`summary-detail.conversation-link.test.tsx` now also carries the two footer cases moved out of `summary-content.render.test.tsx` in Step 4.4 above.)

- [ ] **Step 6: Type-check and lint**

Run: `npm run type-check && npm run lint`
Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add src/pages/context-memory/components/SummaryContent.tsx \
  src/pages/context-memory/components/SummaryDetail.tsx \
  src/tests/summary-content.render.test.tsx \
  src/tests/summary-detail.conversation-link.test.tsx
git commit -m "refactor(context-memory): extract SummaryContent from SummaryDetail for reuse in the dashboard expand"
```

---

### Task 8: Dashboard expand button on `QueueRow.tsx` and `ConversationRow.tsx`

**Files:**
- Modify: `src/pages/meetings/components/QueueRow.tsx`
- Modify: `src/pages/meetings/components/ConversationRow.tsx`
- Test: `src/tests/queue-row.summary-expand.test.tsx`, `src/tests/conversation-row.summary-expand.test.tsx`

**Interfaces:**
- Consumes: `getMeetingSummaryByConversation` (`@/lib/database`), `getEntitiesForSummary` (`@/lib/database`), `SummaryContent` (Task 7).
- Produces: nothing new exported — purely additive UI inside each existing row component. Neither `QueueRowProps` nor `ConversationRowProps` gains a new prop (per the spec's "row-local, not parent-owned" decision) — this task adds internal `useState` only.

- [ ] **Step 1: Write the failing tests for `QueueRow`**

Create `src/tests/queue-row.summary-expand.test.tsx`:

```tsx
import { describe, expect, it, vi, beforeEach } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

const { getMeetingSummaryByConversation, getEntitiesForSummary } = vi.hoisted(() => ({
  getMeetingSummaryByConversation: vi.fn(),
  getEntitiesForSummary: vi.fn(async () => []),
}));
vi.mock("@/lib/database", () => ({
  getMeetingSummaryByConversation,
  getEntitiesForSummary,
}));

import { QueueRow, type QueueRowProps } from "@/pages/meetings/components/QueueRow";
import type { MeetingLogListRow, MeetingSummary } from "@/types";

const BASE_ROW: MeetingLogListRow = {
  id: "qr-1",
  session_key: "s1",
  conversation_id: null,
  instance: "http://h:8069|odoo",
  contact_id: null,
  lead_id: null,
  transcript_start_at: 1_700_000_000_000,
  transcript_end_at: 1_700_000_060_000,
  attachment_id: null,
  message_id: null,
  status: "pending",
  attempts: 0,
  claimed_at: null,
  last_error: null,
  last_error_code: null,
  meeting_started_at: 1_700_000_000_000,
  created_at: 1_700_000_000_000,
  sent_at: null,
  targets: [],
};

function baseProps(rowOver: Partial<MeetingLogListRow>): QueueRowProps {
  return {
    row: { ...BASE_ROW, ...rowOver },
    targetName: "Someone",
    conversationTitle: null,
    isRenaming: false,
    instance: "http://h:8069|odoo",
    busy: false,
    stale: false,
    outcome: null,
    transcript: null,
    contacts: new Map(),
    onRetry: vi.fn(),
    onAssign: vi.fn(),
    onDelete: vi.fn(),
    onToggleTranscript: vi.fn(),
    onReloadTranscript: vi.fn(),
    onRetryTarget: vi.fn(),
    onRemoveTarget: vi.fn(),
    onStartRename: vi.fn(),
    onCommitRename: vi.fn(async () => true),
    onCancelRename: vi.fn(),
  };
}

const SUMMARY: MeetingSummary = {
  id: "s1", conversationId: "c1", summary: "The meeting summary.",
  title: "T", topics: [], goals: [], actionItems: [], nextSteps: [],
  decisions: [], teamUpdates: [], participants: [], exchangeCount: 4,
  durationSeconds: null, meetingStartedAt: null, meetingEndedAt: null,
  createdAt: 1, updatedAt: 1,
};

beforeEach(() => {
  getMeetingSummaryByConversation.mockReset();
  getEntitiesForSummary.mockClear();
});

describe("QueueRow summary expand", () => {
  it("does not fetch until expanded", () => {
    render(<QueueRow {...baseProps({ conversation_id: "c1" })} />);
    expect(getMeetingSummaryByConversation).not.toHaveBeenCalled();
  });

  it("fetches and renders the summary on expand", async () => {
    getMeetingSummaryByConversation.mockResolvedValue(SUMMARY);
    render(<QueueRow {...baseProps({ conversation_id: "c1" })} />);
    await userEvent.click(screen.getByRole("button", { name: /summary/i }));
    await waitFor(() => expect(screen.getByText("The meeting summary.")).toBeInTheDocument());
    expect(getMeetingSummaryByConversation).toHaveBeenCalledWith("c1");
  });

  it("renders 'No summary available' when there is none", async () => {
    getMeetingSummaryByConversation.mockResolvedValue(null);
    render(<QueueRow {...baseProps({ conversation_id: "c1" })} />);
    await userEvent.click(screen.getByRole("button", { name: /summary/i }));
    await waitFor(() => expect(screen.getByText("No summary available")).toBeInTheDocument());
  });

  it("renders no expand affordance at all when conversation_id is null", () => {
    render(<QueueRow {...baseProps({ conversation_id: null })} />);
    expect(screen.queryByRole("button", { name: /summary/i })).not.toBeInTheDocument();
  });
});
```

`QueueRowProps` is imported as a type above specifically so `baseProps`'s return type is checked against it — if a future field is added to the real interface, this fixture fails to compile instead of silently omitting it (the fate of the pre-existing fixture at `src/tests/meeting-log-page.test.tsx:2392`, which predates several `QueueRowProps` fields and is invisible to `npm run type-check` only because `tsconfig.json` excludes `src/tests/**/*` — test files run under Vitest's untyped transform, not `tsc`).

- [ ] **Step 2: Run to verify it fails**

Run: `npx vitest run src/tests/queue-row.summary-expand.test.tsx`
Expected: FAIL — no "summary" button exists yet.

- [ ] **Step 3: Add the expand affordance to `QueueRow.tsx`**

In `src/pages/meetings/components/QueueRow.tsx`:

1. Add imports: `import { useState } from "react";` is already there (line 1 imports `memo, useState`) — add `import { getMeetingSummaryByConversation, getEntitiesForSummary } from "@/lib/database";`, `import { SummaryContent } from "@/pages/context-memory/components/SummaryContent";`, `import type { MeetingSummary, KnowledgeEntity } from "@/types";`.

2. Inside `QueueRowInner`, alongside the existing `useState` calls (around `:225-234`), add:

```ts
  const [summaryState, setSummaryState] = useState<
    { loading: true } | { loading: false; summary: MeetingSummary | null; entities: KnowledgeEntity[] } | null
  >(null);

  const toggleSummary = async () => {
    if (summaryState !== null) {
      setSummaryState(null); // collapse
      return;
    }
    if (row.conversation_id === null) return;
    setSummaryState({ loading: true });
    try {
      const summary = await getMeetingSummaryByConversation(row.conversation_id);
      const entities = summary ? await getEntitiesForSummary(summary.id) : [];
      setSummaryState({ loading: false, summary, entities });
    } catch (error) {
      // getMeetingSummaryByConversation's own try/catch only covers its
      // SELECT (meeting-context.action.ts:181-190) - the getDatabase() call
      // just above that try is NOT covered, so a Database.load() failure
      // propagates here uncaught. Without this catch, summaryState would
      // stay stuck at { loading: true } forever - a permanent spinner, not a
      // visible error. Fold it into the same "No summary available" branch a
      // genuine cache miss already uses, matching how every other summarize
      // path in this feature treats a failure as "nothing to show" rather
      // than a crash; the real error is still logged for diagnosis.
      console.error("Failed to load meeting summary:", error);
      setSummaryState({ loading: false, summary: null, entities: [] });
    }
  };
```

3. Add a button next to the existing "Show transcript"/"Hide transcript" button (around `:524-526`, inside the same `<div className="flex flex-wrap gap-2">`), rendered only when `row.conversation_id !== null`:

```tsx
          {row.conversation_id !== null && (
            <Button size="sm" variant="ghost" onClick={toggleSummary}>
              {summaryState ? "Hide summary" : "Show summary"}
            </Button>
          )}
```

4. Add the expanded content, mirroring where `transcript && transcriptBody(...)` renders (around `:536`):

```tsx
      {summaryState && (
        summaryState.loading ? (
          <p className="text-xs text-muted-foreground">Loading summary…</p>
        ) : summaryState.summary ? (
          <SummaryContent summary={summaryState.summary} entities={summaryState.entities} />
        ) : (
          <p className="text-xs text-muted-foreground">No summary available</p>
        )
      )}
```

5. `summaryState` is intentionally NOT added to `propsAreEqual` (`:599-636`) — it is `QueueRowInner`'s own internal `useState`, not a prop, so React's normal state/re-render behavior already handles it; the comparator only governs PROPS, and this task adds none.

- [ ] **Step 4: Run to verify the `QueueRow` tests pass**

Run: `npx vitest run src/tests/queue-row.summary-expand.test.tsx`
Expected: PASS.

- [ ] **Step 5: Write the failing test for `ConversationRow`**

Create `src/tests/conversation-row.summary-expand.test.tsx`, same shape as Step 1 but WITHOUT the "no expand when conversation_id is null" case (that scenario doesn't exist for `ConversationRow` — its `id` prop is never null):

```tsx
import { describe, expect, it, vi, beforeEach } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

const { getMeetingSummaryByConversation, getEntitiesForSummary } = vi.hoisted(() => ({
  getMeetingSummaryByConversation: vi.fn(),
  getEntitiesForSummary: vi.fn(async () => []),
}));
vi.mock("@/lib/database", () => ({
  getMeetingSummaryByConversation,
  getEntitiesForSummary,
}));

import { ConversationRow, type ConversationRowProps } from "@/pages/meetings/components/ConversationRow";
import type { MeetingSummary } from "@/types";

function baseProps(over: Partial<ConversationRowProps>): ConversationRowProps {
  return {
    id: "conv-1",
    title: "Quarterly review",
    messageCount: 8,
    updatedAt: 1_700_000_000_000,
    badgeStatus: null,
    badgeCount: 0,
    whoLabel: null,
    onOpen: vi.fn(),
    isRenaming: false,
    onStartRename: vi.fn(),
    onCommitRename: vi.fn(async () => true),
    onCancelRename: vi.fn(),
    ...over,
  };
}

const SUMMARY: MeetingSummary = {
  id: "s1", conversationId: "conv-1", summary: "The meeting summary.",
  title: "T", topics: [], goals: [], actionItems: [], nextSteps: [],
  decisions: [], teamUpdates: [], participants: [], exchangeCount: 4,
  durationSeconds: null, meetingStartedAt: null, meetingEndedAt: null,
  createdAt: 1, updatedAt: 1,
};

beforeEach(() => {
  getMeetingSummaryByConversation.mockReset();
  getEntitiesForSummary.mockClear();
});

describe("ConversationRow summary expand", () => {
  it("does not fetch until expanded", () => {
    render(<ConversationRow {...baseProps({ id: "conv-1" })} />);
    expect(getMeetingSummaryByConversation).not.toHaveBeenCalled();
  });

  it("fetches and renders the summary on expand, keyed on the id prop", async () => {
    getMeetingSummaryByConversation.mockResolvedValue(SUMMARY);
    render(<ConversationRow {...baseProps({ id: "conv-1" })} />);
    await userEvent.click(screen.getByRole("button", { name: /summary/i }));
    await waitFor(() => expect(screen.getByText("The meeting summary.")).toBeInTheDocument());
    expect(getMeetingSummaryByConversation).toHaveBeenCalledWith("conv-1");
  });
});
```

- [ ] **Step 6: Run to verify it fails**

Run: `npx vitest run src/tests/conversation-row.summary-expand.test.tsx`
Expected: FAIL.

- [ ] **Step 7: Add the expand affordance to `ConversationRow.tsx`**

In `src/pages/meetings/components/ConversationRow.tsx`, apply the same pattern as `QueueRow` (Step 3), keyed on the `id` prop instead of `row.conversation_id`, with no null-guard (`id` is never null here).

1. Add imports: `import { getMeetingSummaryByConversation, getEntitiesForSummary } from "@/lib/database";`, `import { SummaryContent } from "@/pages/context-memory/components/SummaryContent";`, `import type { MeetingSummary, KnowledgeEntity } from "@/types";`, and — this file has no `React` namespace import (only `import { memo, useState } from "react";`), so `toggleSummary`'s event parameter needs its own named import, not `React.MouseEvent` — `import type { MouseEvent } from "react";`.

2. Add the state and handler, alongside the existing `useState` calls near the top of `ConversationRowInner`:

```ts
  const [summaryState, setSummaryState] = useState<
    { loading: true } | { loading: false; summary: MeetingSummary | null; entities: KnowledgeEntity[] } | null
  >(null);

  const toggleSummary = async (e: MouseEvent) => {
    e.stopPropagation(); // this card's own onClick navigates - mirror the rename button's guard just above
    if (summaryState !== null) {
      setSummaryState(null);
      return;
    }
    setSummaryState({ loading: true });
    try {
      const summary = await getMeetingSummaryByConversation(id);
      const entities = summary ? await getEntitiesForSummary(summary.id) : [];
      setSummaryState({ loading: false, summary, entities });
    } catch (error) {
      // Same failure mode as QueueRow's toggleSummary (Step 3.2) - see its
      // comment: getMeetingSummaryByConversation's getDatabase() call sits
      // outside its own try/catch, so a connection failure lands here.
      console.error("Failed to load meeting summary:", error);
      setSummaryState({ loading: false, summary: null, entities: [] });
    }
  };
```

3. Add the toggle button beside the existing badges, inside the `<div className="flex items-center gap-1">` at `:217-232` (after the two existing `<Badge>`s):

```tsx
          <Button size="sm" variant="ghost" onClick={toggleSummary}>
            {summaryState ? "Hide summary" : "Show summary"}
          </Button>
```

4. Add the expanded content as a new sibling inside `<Card>`, after the existing outer `<div className="flex items-center justify-between">...</div>` block and before `</Card>`. This block MUST have its own `stopPropagation` wrapper — `QueueRow.tsx` has no card-level navigating `onClick` so its equivalent block (Step 3.4) does not need one, but `ConversationRow`'s whole `<Card>` navigates on click (`:120-123`), exactly like every other interactive child in this file (the rename input, the save/cancel buttons, the error `<p>`, all at `:135`/`:160-161`/`:174-175`/`:211`) — without this guard, clicking anywhere inside the expanded summary (a topic badge, the summary text itself) would bubble up and navigate away from the row instead of letting the user read it:

```tsx
      {summaryState && (
        <div onClick={(e) => e.stopPropagation()}>
          {summaryState.loading ? (
            <p className="text-xs text-muted-foreground">Loading summary…</p>
          ) : summaryState.summary ? (
            <SummaryContent summary={summaryState.summary} entities={summaryState.entities} />
          ) : (
            <p className="text-xs text-muted-foreground">No summary available</p>
          )}
        </div>
      )}
```

**Deviation from the spec, noted deliberately so it is not "fixed" back later:** the spec states `getMeetingSummaryByConversation` "already swallows every DB failure" (citing `meeting-context.action.ts:186-189`) and uses that to justify a loading/summary-only state with no error branch. Reading the real function (`:176-191`) shows `const db = await getDatabase();` sits BEFORE its `try` block, at `:179` — a `getDatabase()` failure is NOT caught by that function and propagates to its caller. The `try/catch` added in both `toggleSummary`s above does not add a third UI state (the spec's `loading | { summary: MeetingSummary | null }` shape is unchanged, matching its own design) — it only makes an already-anticipated failure mode ("no summary yet") the landing state for a failure mode the spec's own premise missed ("the read errored"), instead of an infinite spinner.

- [ ] **Step 8: Run to verify the `ConversationRow` tests pass**

Run: `npx vitest run src/tests/conversation-row.summary-expand.test.tsx`
Expected: PASS.

- [ ] **Step 9: Run the full meetings-page suite**

Run: `npx vitest run src/tests/meeting-log-page.test.tsx src/tests/meetings-page.test.tsx src/tests/odoo-meeting-log-render.test.ts src/tests/odoo-meeting-log-strip.test.tsx`
Expected: PASS — confirms neither row's existing behavior (retry, delete, transcript toggle, rename) regressed.

- [ ] **Step 10: Type-check and lint**

Run: `npm run type-check && npm run lint`
Expected: PASS.

- [ ] **Step 11: Manual smoke check**

Run `npm run tauri dev`, open the Meetings page, expand a queue row and a conversation row that each have a real summary, confirm the content renders and collapses correctly, and confirm a row with no `conversation_id` (an `unassigned` row with no linked conversation, if one exists in the dev DB) shows no summary toggle at all.

- [ ] **Step 12: Commit**

```bash
git add src/pages/meetings/components/QueueRow.tsx src/pages/meetings/components/ConversationRow.tsx \
  src/tests/queue-row.summary-expand.test.tsx src/tests/conversation-row.summary-expand.test.tsx
git commit -m "feat(meetings): add an inline expand-to-see-summary affordance to the dashboard"
```
