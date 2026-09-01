# Unified Meetings Page Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Merge the Chats and Meeting log pages into one `/meetings` page, let the user rename conversations without an automatic titler overwriting it, name speakers in the downloaded transcript, and stop two conversation rows being minted for one session.

**Architecture:** Four independent slices landing as four commits on one branch. The 1013-line queue page is lifted into a `useMeetingLogQueue()` hook with exactly one addition (a badge query inside the existing token guard), so its accumulated race fixes travel unchanged. Title provenance is enforced by a SQL clause (`AND title_source = 'auto'`), not a read-then-write, so there is no check-then-act window. Speaker labelling and conversation-id minting each collapse a copy-pasted helper into one module-scope function under `src/lib/functions/`.

**Tech Stack:** React 19 + TypeScript, Tauri 2, SQLite via `@tauri-apps/plugin-sql`, sqlx migrations declared in Rust, Vitest + Testing Library, Tailwind + shadcn/ui.

**Spec:** `docs/superpowers/specs/2026-08-31-unified-meetings-page-design.md`

## Global Constraints

- **Never edit a released migration file.** sqlx checksums applied migrations; a changed checksum fails `Database.load`, which gates chat history, prompts, cost tracking and meeting context — the whole app's persistence. New behaviour means a new migration file.
- **Migration 15 is the next free version.** `src-tauri/src/db/main.rs` registers 1–14.
- **Migration descriptions are verb-first snake_case.** All fourteen are (`create_*`, `add_*`, `remove_*`, `adopt_*`, `allow_*`). The description string is also the lookup key in `migration_tests.rs`, so the registration and the test must agree exactly.
- **The DB test harness is a mocked `execute`.** See `src/tests/chat-history.update-title.test.ts:6-8,22`. No test may assert a real-table outcome ("the row now holds X"); assert statement shape and params instead.
- **`src/lib/index.ts` star-exports `./functions`, `./database` and `./odoo` into one flat namespace.** Every new exported name must be unique across all of `src/lib`. Verified free at plan time: `speakerLabelFor`, `conversationToMarkdown`, `ensureConversationId`, `renameConversationManually`.
- **Path alias is `@/`.** Files are kebab-case, components PascalCase, hooks `use*` camelCase, helper modules in `src/lib/functions/` use the `*.function.ts` suffix.
- **Commit boundaries are the four items, in task order.** Migration 15 lands inside Task 6 so it can be reverted without touching the page merge.
- **Run tests scoped to the files you touched**, e.g. `npx vitest run src/tests/foo.test.ts`. Never a bare `npx vitest run` — this repo has pre-existing unrelated failures and a full-suite run will not tell you whether your change is sound.

## Ordering and dependencies

| Slice | Tasks | Depends on |
|---|---|---|
| 4 — duplicate mint fix | 1–3 | nothing |
| 3 — speaker labels | 4–5 | nothing |
| 2 — rename + migration 15 | 6–9 | Task 10 only for where the rename UI mounts |
| 1 — page merge | 10–14 | nothing (Task 14 wires in the Task 9 rename UI) |

Slices 4 and 3 come first because they are self-contained and touch code the later slices also edit — landing them first means the page merge rebases onto settled files rather than the reverse.

## File Structure

| Path | Responsibility |
|---|---|
| `src/lib/functions/conversation-id.function.ts` | **new** — `ensureConversationId(ref)`. Module scope so the `useCallback(…, [])` deps at the call sites stay empty. |
| `src/lib/functions/speaker-label.function.ts` | **new** — `speakerLabelFor(m)`. The single speaker-label helper, replacing two copy-pasted copies. |
| `src/lib/functions/conversation-markdown.function.ts` | **new** — `conversationToMarkdown(conversation)`. Extracted from a closure inside `useHistory` so it can be tested without a `Blob` intercept. |
| `src/hooks/useMeetingLogQueue.ts` | **new** — the queue page's logic, lifted. Page-side queue *reads*; not to be confused with `useMeetingLog.ts` (write-side enqueue). |
| `src/pages/meetings/index.tsx` | **new** — the unified page: action strip above a date-grouped conversation list. |
| `src/pages/meetings/components/` | **new** — `ConversationRow`, `QueueStrip`, `DateGroup`, plus the components moved from `pages/meeting-log/components/` and `pages/chats/components/`. |
| `src-tauri/src/db/migrations/conversation-title-source.sql` | **new** — migration 15, one additive column. |
| `src/lib/database/chat-history.action.ts` | Modified — three title-writing statements become guarded; one new manual-rename writer. |
| `src/hooks/useCompletion.ts` | Modified — six mint sites use the shared helper; `saveCurrentConversation` takes the turn's id; the diarized-batch path carries speaker fields. |
| `src/hooks/useHistory.ts` | Modified — the markdown generator moves out. |

---

## Slice 4 — the duplicate-conversation mint

### Task 1: The state-writer audit (precondition)

The substitution in Task 2 makes `currentConversationIdRef` the sole authority at two sites that currently read `state.currentConversationId`. That is only safe if every path writing `currentConversationId` into state also writes the ref in the same synchronous step. This task verifies that and fixes any gap. **It is a precondition, not a formality** — if a path sets state alone, `??=` would silently append a new conversation's turns onto the previous one.

**Files:**
- Verify: `src/hooks/useCompletion.ts`
- Create: `docs/superpowers/plans/notes/state-writer-audit.md` (findings record)

**Interfaces:**
- Consumes: nothing.
- Produces: a go/no-go for Task 2, plus a list of any sites needing repair.

- [ ] **Step 1: Enumerate every state writer**

```bash
grep -n "currentConversationId:" src/hooks/useCompletion.ts
```

Expected at plan time — 10 writers plus the type declaration and the return value:
`:98` (type), `:118` (initial state), `:588`, `:630`, `:717`, `:748`, `:888`, `:1085`, `:1223`, `:1372`, `:1402`, `:1495`, `:2247` (returned value).

- [ ] **Step 2: Enumerate every ref writer**

```bash
grep -n "currentConversationIdRef.current *=" src/hooks/useCompletion.ts
```

Expected: `:324`, `:572`, `:613`, `:699`, `:742` (null), `:883`, `:1081`, `:1361`, `:1396` (null), `:1581` (null).

- [ ] **Step 3: Pair them and record the result**

For each state writer, read ±10 lines and record whether a ref write accompanies it in the same synchronous block. Known pairings at plan time:

| State write | Ref write | Verdict |
|---|---|---|
| `:588` | `:572` | paired |
| `:630` | `:613` | paired |
| `:717` | `:699` | paired |
| `:748` (null) | `:742` (null) | paired |
| `:888` | `:883` | paired |
| `:1085` | `:1081` | paired |
| `:1223` | none in block | **benign** — id descends from the `:1080` mint, which wrote the ref at `:1081` |
| `:1372` | `:1361` | paired (`loadConversation` adopting an existing conversation) |
| `:1402` (null) | `:1396` (null) | paired |
| `:1495` | none | **this is defect (b)** — fixed by Task 3, not here |

Write the table into `docs/superpowers/plans/notes/state-writer-audit.md` with the line numbers you actually observed.

- [ ] **Step 4: Decide**

If every state write is paired, benign, or `:1495`, the audit passes — proceed to Task 2. If you find an **unpaired adopt-an-existing-conversation path** (one that sets `currentConversationId` to an id the ref does not hold, outside the reset paths), STOP: fix that site to write the ref in the same step, in its own commit, and note it in the audit file before continuing.

- [ ] **Step 5: Commit**

```bash
git add docs/superpowers/plans/notes/state-writer-audit.md
git commit -m "docs(completion): audit conversation-id state writers before the ref substitution"
```

---

### Task 2: `ensureConversationId` and the six mint sites

**Files:**
- Create: `src/lib/functions/conversation-id.function.ts`
- Modify: `src/lib/functions/index.ts`
- Modify: `src/hooks/useCompletion.ts:322-324, 571-572, 611-613, 697-699, 882-890, 1080-1087`
- Test: `src/tests/conversation-id.function.test.ts` (create)

**Interfaces:**
- Consumes: `generateConversationId` from `@/lib/chat-constants` (existing, `chat-constants.ts:79`).
- Produces: `ensureConversationId(ref: MutableRefObject<string | null>): string` — returns the ref's existing id if set, otherwise mints one, assigns it, and returns it. Used by Task 3.

- [ ] **Step 1: Write the failing test**

Create `src/tests/conversation-id.function.test.ts`:

```ts
import { describe, expect, it, vi } from "vitest";
import type { MutableRefObject } from "react";
import { ensureConversationId } from "@/lib/functions/conversation-id.function";

vi.mock("@/lib/chat-constants", () => ({
  generateConversationId: vi.fn(() => "chat-minted-1"),
}));

const refOf = (v: string | null): MutableRefObject<string | null> => ({ current: v });

describe("ensureConversationId", () => {
  it("mints and assigns when the ref is empty", () => {
    const ref = refOf(null);
    expect(ensureConversationId(ref)).toBe("chat-minted-1");
    expect(ref.current).toBe("chat-minted-1");
  });

  it("reuses the ref's id and does not mint again", async () => {
    const { generateConversationId } = await import("@/lib/chat-constants");
    const ref = refOf("chat-existing-9");
    expect(ensureConversationId(ref)).toBe("chat-existing-9");
    expect(ref.current).toBe("chat-existing-9");
    expect(generateConversationId).not.toHaveBeenCalled();
  });

  it("reads and writes in one synchronous step, so two calls agree", () => {
    const ref = refOf(null);
    const first = ensureConversationId(ref);
    const second = ensureConversationId(ref);
    expect(second).toBe(first);
  });
});
```

- [ ] **Step 2: Run it and watch it fail**

```bash
npx vitest run src/tests/conversation-id.function.test.ts
```

Expected: FAIL — cannot resolve `@/lib/functions/conversation-id.function`.

- [ ] **Step 3: Write the helper**

Create `src/lib/functions/conversation-id.function.ts`:

```ts
import type { MutableRefObject } from "react";
import { generateConversationId } from "@/lib/chat-constants";

/**
 * The one place a chat conversation id is minted.
 *
 * Module scope, not a function in a component body: three call sites live in
 * `useCallback(…, [])` callbacks whose empty dep arrays are load-bearing
 * (useCompletion.ts:593, "No dependencies - uses ref for conversation ID"). A
 * body function would trip react-hooks/exhaustive-deps, and adding it to the
 * deps would change the identity of addMeetingTranscriptEntry /
 * addMeetingTranscriptEntries / addSystemAudioTranscript on every render,
 * re-running every consumer that lists them — Audio.tsx:117 lists
 * addSystemAudioTranscript exactly so.
 *
 * Read and write happen in one synchronous step, before any await, so two
 * paths racing inside one tick cannot each mint an id.
 *
 * NOT for useSystemAudio: startCapture and startNewConversation mint
 * unconditionally on purpose, and that hook has no such ref.
 */
export function ensureConversationId(
  ref: MutableRefObject<string | null>
): string {
  ref.current ??= generateConversationId("chat");
  return ref.current;
}
```

Add to `src/lib/functions/index.ts`:

```ts
export * from "./conversation-id.function";
```

- [ ] **Step 4: Run it and watch it pass**

```bash
npx vitest run src/tests/conversation-id.function.test.ts
```

Expected: PASS, 3 tests.

- [ ] **Step 5: Substitute the four refactor-only sites**

These already read the ref and write it back, so the change is semantically identical. Add the import to `useCompletion.ts` (alongside the existing `@/lib` imports):

```ts
import { ensureConversationId } from "@/lib";
```

At `:322-324`, replace:

```ts
        const conversationId =
          currentConversationIdRef.current || generateConversationId("chat");
        currentConversationIdRef.current = conversationId;
```

with:

```ts
        const conversationId = ensureConversationId(currentConversationIdRef);
```

At `:571-572`, replace:

```ts
    const conversationId = currentConversationIdRef.current || generateConversationId("chat");
    currentConversationIdRef.current = conversationId;
```

with:

```ts
    const conversationId = ensureConversationId(currentConversationIdRef);
```

At `:611-613` and again at `:697-699`, replace:

```ts
      const conversationId =
        currentConversationIdRef.current || generateConversationId("chat");
      currentConversationIdRef.current = conversationId;
```

with:

```ts
      const conversationId = ensureConversationId(currentConversationIdRef);
```

- [ ] **Step 6: Substitute the two load-bearing sites**

At `:882-890`, replace:

```ts
      const conversationId = state.currentConversationId || generateConversationId("chat");
      currentConversationIdRef.current = conversationId;
      console.log("[Cost Tracking] Set conversation ID ref to:", conversationId);
      if (!state.currentConversationId) {
        setState((prev) => ({
          ...prev,
          currentConversationId: conversationId,
        }));
      }
```

with:

```ts
      const conversationId = ensureConversationId(currentConversationIdRef);
      console.log("[Cost Tracking] Set conversation ID ref to:", conversationId);
      // Functional and keyed on the live value, NOT `if (!state.currentConversationId)`:
      // after the substitution the id comes from the ref while that guard reads a
      // possibly-stale snapshot, and the two no longer share a source. Reachable:
      // clearMeetingTranscript does not clear state.input, so submit's memo does not
      // re-form, the snapshot still holds the pre-reset id, the guard is falsy, the
      // mirror never fires, and state.currentConversationId stays null — which sends
      // every enqueue to useMeetingLog's getActiveConversationId() recovery path.
      setState((prev) =>
        prev.currentConversationId === conversationId
          ? prev
          : { ...prev, currentConversationId: conversationId }
      );
```

At `:1080-1087`, replace:

```ts
      const conversationId = state.currentConversationId || generateConversationId("chat");
      currentConversationIdRef.current = conversationId;
      if (!state.currentConversationId) {
        setState((prev) => ({
          ...prev,
          currentConversationId: conversationId,
        }));
      }
```

with:

```ts
      const conversationId = ensureConversationId(currentConversationIdRef);
      // See the note at the sibling site in `submit`: functional, keyed on the live
      // value, because the guard would otherwise read a stale snapshot.
      setState((prev) =>
        prev.currentConversationId === conversationId
          ? prev
          : { ...prev, currentConversationId: conversationId }
      );
```

- [ ] **Step 7: Typecheck and lint**

```bash
npm run check:types
npm run lint
```

Expected: PASS. If `generateConversationId` is now unused in `useCompletion.ts`, remove it from that file's imports.

- [ ] **Step 8: Run the existing completion suite**

```bash
npx vitest run src/tests/useCompletion.meeting-assist.test.tsx
```

Expected: PASS. This suite mounts the hook and drives the transcript paths, so it is the regression check that the substitution preserved behaviour.

- [ ] **Step 9: Commit**

```bash
git add src/lib/functions/conversation-id.function.ts src/lib/functions/index.ts src/hooks/useCompletion.ts src/tests/conversation-id.function.test.ts
git commit -m "fix(completion): mint a conversation id in one place

Six inline mint sites collapse onto ensureConversationId. Four already read
the ref and wrote it back; :882 and :1080 read state.currentConversationId,
which submit's memo (deps at :1025-1032 exclude it) can hold null for minutes
after setState flushed - two paths then each mint their own id.

The setState mirror is kept but becomes functional and keyed on the live
value: guarding on the stale snapshot while reading the ref would leave
state.currentConversationId null and route every enqueue to the recovery path."
```

---

### Task 3: `saveCurrentConversation` takes the turn's id

`saveCurrentConversation` computes `state.currentConversationId || generateConversationId("chat")` at `:1433-1434` and **never writes the ref** — so it mints a second id against a conversation the ref already holds, then mirrors that bad id into state at `:1495`. That is the "small stub minted seconds from the real one" signature.

Making it write the ref would be wrong: its closure is captured at turn start, so a reset landing mid-turn would let the finishing turn pin the ref to a fresh id and seed the user's brand-new conversation with the previous turn. The id must instead arrive as an argument.

**Files:**
- Modify: `src/hooks/useCompletion.ts:1421-1434, 1002-1006, 1640-1760`
- Test: `src/tests/useCompletion.meeting-assist.test.tsx`

**Interfaces:**
- Consumes: `ensureConversationId` from Task 2.
- Produces: `saveCurrentConversation(userMessage, assistantResponse, attachedFiles, conversationId)` — a required fourth parameter.

- [ ] **Step 1: Read both call sites and the screenshot path**

```bash
grep -n "saveCurrentConversation" src/hooks/useCompletion.ts
```

Expected: declaration `:1421`, calls at `:1002` and `:1748`, dep-array entry `:1804`.

The `:1002` call is inside `submit`, which has `conversationId` in scope from the `:882` mint. **The `:1748` call is inside `handleScreenshotSubmit` (`:1640`), which has no `conversationId` in scope** — confirm this with:

```bash
awk 'NR>=1640 && NR<=1760 && /conversationId/' src/hooks/useCompletion.ts
```

Expected: no output. That path therefore needs its own `ensureConversationId` call, which is correct — a screenshot submit is a real turn and should join the current conversation if one exists.

- [ ] **Step 2: Write the failing test**

Add to `src/tests/useCompletion.meeting-assist.test.tsx`, following the file's existing `renderHook(() => useCompletion(), …)` scaffolding at `:139`:

```ts
it("reuses the established conversation id when a turn is saved", async () => {
  const { result } = renderHook(() => useCompletion(), { wrapper });

  // Establish an id through a ref-writing path that does not touch submit's deps.
  await act(async () => {
    result.current.addMeetingTranscript("Opening line", Date.now(), undefined, "microphone");
  });

  const established = result.current.currentConversationId;
  expect(established).toBeTruthy();

  // A saved turn must land on that conversation, not mint a second one.
  await act(async () => {
    await result.current.submit("What should I say?");
  });

  expect(result.current.currentConversationId).toBe(established);
  const savedIds = savedConversations.map((c) => c.id);
  expect(new Set(savedIds).size).toBe(1);
  expect(savedIds[0]).toBe(established);
});
```

`savedConversations` is the array the suite's existing `saveConversation` / `appendMessagesToConversation` mock records into — reuse whatever that file already defines rather than adding a second mock.

- [ ] **Step 3: Run it and watch it fail**

```bash
npx vitest run src/tests/useCompletion.meeting-assist.test.tsx -t "reuses the established conversation id"
```

Expected: FAIL — two distinct ids, because `saveCurrentConversation` minted its own.

- [ ] **Step 4: Add the parameter**

At `:1421-1426`, change the signature:

```ts
  const saveCurrentConversation = useCallback(
    async (
      userMessage: string,
      assistantResponse: string,
      _attachedFiles: AttachedFile[],
      conversationId: string
    ) => {
```

At `:1433-1434`, delete the local mint entirely:

```ts
      const conversationId =
        state.currentConversationId || generateConversationId("chat");
```

The parameter now supplies it. Leave the `:1495` state mirror as it is — it is correct once `conversationId` is the turn's real id.

- [ ] **Step 5: Update both call sites**

At `:1002-1006`, pass the id `submit` already computed:

```ts
          await saveCurrentConversation(
            input,
            fullResponse,
            state.attachedFiles,
            conversationId
          );
```

In `handleScreenshotSubmit`, mint once near the top of the callback (immediately after `currentRequestIdRef.current = requestId;`, matching the shape of the other turn-starting paths):

```ts
      const conversationId = ensureConversationId(currentConversationIdRef);
```

then at `:1748`:

```ts
              await saveCurrentConversation(prompt, fullResponse, [
                attachedFile,
              ], conversationId);
```

- [ ] **Step 6: Run the test and the suite**

```bash
npx vitest run src/tests/useCompletion.meeting-assist.test.tsx
```

Expected: PASS, including the new test.

- [ ] **Step 7: Typecheck**

```bash
npm run check:types
```

Expected: PASS. A missed call site surfaces here as "Expected 4 arguments, but got 3".

- [ ] **Step 8: Commit**

```bash
git add src/hooks/useCompletion.ts src/tests/useCompletion.meeting-assist.test.tsx
git commit -m "fix(completion): save a turn against the turn's own conversation id

saveCurrentConversation computed its own id from state.currentConversationId
and never wrote the ref, so it could mint a second id against a conversation
the ref already held - the stub-seconds-from-the-real-one signature in the
duplicate investigation.

It takes the id as an argument rather than writing the ref: its closure is
captured at turn start, so a reset landing mid-turn would otherwise pin the
ref to the finishing turn's fresh id and seed the new conversation with the
old turn's content."
```

---

## Slice 3 — speaker names in the transcript

### Task 4: The shared `speakerLabelFor` helper

`labelFor` exists twice, copy-pasted: `lib/odoo/meeting-log.ts:207` and `useCompletion.ts:1046`. The first carries a comment promising it mirrors the second "EXACTLY" — and that comment's line reference is already stale.

**Files:**
- Create: `src/lib/functions/speaker-label.function.ts`
- Modify: `src/lib/functions/index.ts`
- Modify: `src/lib/odoo/meeting-log.ts:200-216`
- Modify: `src/hooks/useCompletion.ts:1045-1052`
- Test: `src/tests/speaker-label.function.test.ts` (create)

**Interfaces:**
- Consumes: `TranscriptEntry` from `@/types/completion`.
- Produces: `speakerLabelFor(m: Pick<TranscriptEntry, "speaker" | "audioSource">): string | null` — used by Task 5 and by both existing callers.

- [ ] **Step 1: Write the failing test**

Create `src/tests/speaker-label.function.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { speakerLabelFor } from "@/lib/functions/speaker-label.function";

describe("speakerLabelFor", () => {
  it("prefers an explicit speaker label", () => {
    expect(
      speakerLabelFor({ speaker: { speakerLabel: "Sarah Chen" }, audioSource: "system" })
    ).toBe("Sarah Chen");
  });

  it("labels microphone audio You", () => {
    expect(speakerLabelFor({ audioSource: "microphone" })).toBe("You");
  });

  it("labels system audio Guest", () => {
    expect(speakerLabelFor({ audioSource: "system" })).toBe("Guest");
  });

  it("returns null when the source is unknown, rather than defaulting to Guest", () => {
    // A two-way form defaulting to Guest attributes the user's own unattributed
    // lines to the customer, in a note the customer can read.
    expect(speakerLabelFor({})).toBeNull();
  });

  it("accepts a ChatMessage shape, not only a TranscriptEntry", () => {
    expect(
      speakerLabelFor({ speaker: undefined, audioSource: "microphone" })
    ).toBe("You");
  });
});
```

- [ ] **Step 2: Run it and watch it fail**

```bash
npx vitest run src/tests/speaker-label.function.test.ts
```

Expected: FAIL — module not found.

- [ ] **Step 3: Write the helper**

Create `src/lib/functions/speaker-label.function.ts`:

```ts
import type { TranscriptEntry } from "@/types/completion";

/**
 * The one speaker-label resolver, shared by the Odoo note renderer, the meeting
 * context prompt, and the transcript download.
 *
 * Named `speakerLabelFor`, not `labelFor`: src/lib/index.ts star-exports
 * ./functions, ./database and ./odoo into one flat namespace, so a bare
 * `labelFor` is a collision waiting to happen.
 *
 * The three-way null is deliberate. A two-way form defaulting to "Guest"
 * attributes the user's own unattributed lines to the customer, in a note the
 * customer can read. Callers that must label every line supply their own
 * fallback from context.
 *
 * Typed on the structural subset so both a TranscriptEntry (.original) and a
 * ChatMessage (.content) satisfy it.
 */
export function speakerLabelFor(
  m: Pick<TranscriptEntry, "speaker" | "audioSource">
): string | null {
  return (
    m.speaker?.speakerLabel ||
    (m.audioSource === "microphone"
      ? "You"
      : m.audioSource === "system"
      ? "Guest"
      : null)
  );
}
```

Add to `src/lib/functions/index.ts`:

```ts
export * from "./speaker-label.function";
```

- [ ] **Step 4: Run it and watch it pass**

```bash
npx vitest run src/tests/speaker-label.function.test.ts
```

Expected: PASS, 5 tests.

- [ ] **Step 5: Point both existing callers at it**

In `src/lib/odoo/meeting-log.ts`, delete the whole `labelFor` block at `:200-216` (the doc comment and the function) and import instead. Note this module cannot import from `@/lib` (circular — `lib/index.ts` re-exports it), so import the file directly:

```ts
import { speakerLabelFor } from "@/lib/functions/speaker-label.function";
```

Then replace every `labelFor(` call in that file with `speakerLabelFor(`:

```bash
grep -n "labelFor(" src/lib/odoo/meeting-log.ts
```

In `src/hooks/useCompletion.ts`, delete the local `labelFor` at `:1045-1052` and use the shared one — it is already imported from `@/lib` if you add it to that import list. Replace the `labelFor(entry)` call below it with `speakerLabelFor(entry)`.

- [ ] **Step 6: Run the affected suites**

```bash
npx vitest run src/tests/odoo-meeting-log-push.test.ts src/tests/meeting-log-summary.test.ts src/tests/useCompletion.meeting-assist.test.tsx src/tests/speaker-label.function.test.ts
```

Expected: PASS. These cover the Odoo note renderer and the meeting-context prompt, which are the two behaviours the extraction must not change.

- [ ] **Step 7: Typecheck and lint**

```bash
npm run check:types
npm run lint
```

- [ ] **Step 8: Commit**

```bash
git add src/lib/functions/speaker-label.function.ts src/lib/functions/index.ts src/lib/odoo/meeting-log.ts src/hooks/useCompletion.ts src/tests/speaker-label.function.test.ts
git commit -m "refactor(transcript): one shared speakerLabelFor

The helper existed twice, copy-pasted, with a comment promising the copies
matched EXACTLY - and a line reference that had already gone stale. Typed on
Pick<TranscriptEntry, 'speaker' | 'audioSource'> so a ChatMessage satisfies it
too, which the transcript download needs."
```

---

### Task 5: Named speakers in the downloaded transcript

Every captured meeting message has role `user`, so `useHistory.ts:222` renders microphone and system audio identically as `## USER:`. The data to do better is already stored (migration 8) and already read (`chat-history.action.ts:241,335`) — except on one path.

**Files:**
- Create: `src/lib/functions/conversation-markdown.function.ts`
- Modify: `src/lib/functions/index.ts`
- Modify: `src/hooks/useHistory.ts:209-231, 120`
- Modify: `src/hooks/useCompletion.ts:615-620`
- Test: `src/tests/conversation-markdown.test.ts` (create)

**Interfaces:**
- Consumes: `speakerLabelFor` from Task 4; `ChatConversation` from `@/types/completion`.
- Produces: `conversationToMarkdown(conversation: ChatConversation): string`.

- [ ] **Step 1: Write the failing test**

Create `src/tests/conversation-markdown.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { conversationToMarkdown } from "@/lib/functions/conversation-markdown.function";
import type { ChatConversation } from "@/types/completion";

const conversation = (messages: ChatConversation["messages"]): ChatConversation => ({
  id: "conversation-1",
  title: "LCA Scoping",
  createdAt: 1_700_000_000_000,
  updatedAt: 1_700_000_100_000,
  messages,
});

describe("conversationToMarkdown", () => {
  it("names each speaker instead of labelling every line USER", () => {
    const md = conversationToMarkdown(
      conversation([
        { id: "m1", role: "user", content: "Scope of the LCA", timestamp: 1, audioSource: "microphone" },
        { id: "m2", role: "user", content: "And Scope 3?", timestamp: 2, audioSource: "system" },
        { id: "m3", role: "user", content: "Only upstream", timestamp: 3, audioSource: "system", speaker: { speakerLabel: "Sarah Chen" } },
        { id: "m4", role: "assistant", content: "Here is what you could say", timestamp: 4 },
        { id: "m5", role: "user", content: "typed question", timestamp: 5 },
      ])
    );

    expect(md).toContain("You: Scope of the LCA");
    expect(md).toContain("Guest: And Scope 3?");
    expect(md).toContain("Sarah Chen: Only upstream");
    expect(md).toContain("Assistant: Here is what you could say");
    expect(md).toContain("You: typed question");
    expect(md).not.toContain("USER:");
  });

  it("leaves no line unlabelled", () => {
    const md = conversationToMarkdown(
      conversation([
        { id: "m1", role: "user", content: "a", timestamp: 1 },
        { id: "m2", role: "assistant", content: "b", timestamp: 2 },
      ])
    );
    for (const line of md.split("\n").filter((l) => l.startsWith("## "))) {
      expect(line).toMatch(/^## [^:]+: /);
    }
  });

  it("labels a legacy pre-migration-8 row You, the documented limitation", () => {
    // speaker and audio_source are both null on rows written before migration 8,
    // so such a line is indistinguishable from typed chat. Accepted, not solved:
    // the data to do better does not exist. Asserted so the behaviour is a
    // decision on the record rather than a surprise.
    const md = conversationToMarkdown(
      conversation([{ id: "m1", role: "user", content: "legacy line", timestamp: 1 }])
    );
    expect(md).toContain("You: legacy line");
  });

  it("keeps the existing header", () => {
    const md = conversationToMarkdown(conversation([]));
    expect(md).toContain("# LCA Scoping");
    expect(md).toContain("**Messages:** 0");
  });
});
```

- [ ] **Step 2: Run it and watch it fail**

```bash
npx vitest run src/tests/conversation-markdown.test.ts
```

Expected: FAIL — module not found.

- [ ] **Step 3: Extract and fix the generator**

Create `src/lib/functions/conversation-markdown.function.ts`, carrying the header format over from `useHistory.ts:212-219` unchanged:

```ts
import type { ChatConversation, ChatMessage } from "@/types/completion";
import { speakerLabelFor } from "./speaker-label.function";

/**
 * The downloaded transcript.
 *
 * Extracted from a closure inside useHistory so the label behaviour can be
 * asserted directly instead of through a Blob/createObjectURL intercept.
 *
 * speakerLabelFor returns null for anything without an audioSource - assistant
 * replies and typed chat - so this adds the role fallback it deliberately
 * refuses to guess at. A legacy pre-migration-8 row has neither column and is
 * indistinguishable from typed chat; it renders "You:". That is a known
 * limitation, not an oversight: once addMeetingTranscriptEntries carries the
 * fields, no new rows join that class.
 */
function labelOf(message: ChatMessage): string {
  return (
    speakerLabelFor(message) ?? (message.role === "assistant" ? "Assistant" : "You")
  );
}

export function conversationToMarkdown(conversation: ChatConversation): string {
  let markdown = `# ${conversation.title}\n\n`;
  markdown += `**Created:** ${new Date(
    conversation.createdAt
  ).toLocaleString()}\n`;
  markdown += `**Updated:** ${new Date(
    conversation.updatedAt
  ).toLocaleString()}\n`;
  markdown += `**Messages:** ${conversation.messages.length}\n\n---\n\n`;

  conversation.messages.forEach((message, index) => {
    markdown += `## ${labelOf(message)}: ${message.content}\n`;

    if (index < conversation.messages.length - 1) {
      markdown += "\n";
    }
  });

  return markdown;
}
```

Add to `src/lib/functions/index.ts`:

```ts
export * from "./conversation-markdown.function";
```

- [ ] **Step 4: Run it and watch it pass**

```bash
npx vitest run src/tests/conversation-markdown.test.ts
```

Expected: PASS, 4 tests.

- [ ] **Step 5: Point `useHistory` at it**

Delete `generateConversationMarkdown` at `src/hooks/useHistory.ts:208-231` entirely. Add `conversationToMarkdown` to the existing `@/lib` import at `:2-6`, and at `:120` replace:

```ts
      const markdown = generateConversationMarkdown(conversation);
```

with:

```ts
      const markdown = conversationToMarkdown(conversation);
```

- [ ] **Step 6: Write the failing test for the diarized path**

`addMeetingTranscriptEntries` builds messages with no `speaker` and no `audioSource`, so those rows persist with both columns null and every guest line would export as `You:`. Add to `src/tests/useCompletion.meeting-assist.test.tsx`:

```ts
it("carries speaker and audioSource onto diarized batch messages", async () => {
  const { result } = renderHook(() => useCompletion(), { wrapper });

  await act(async () => {
    result.current.addMeetingTranscriptEntries([
      { original: "Guest line", timestamp: 1, audioSource: "system", speaker: { speakerLabel: "Sarah Chen" } },
      { original: "My line", timestamp: 2, audioSource: "microphone" },
    ]);
  });

  const history = result.current.conversationHistory;
  expect(history.at(-2)).toMatchObject({ audioSource: "system", speaker: { speakerLabel: "Sarah Chen" } });
  expect(history.at(-1)).toMatchObject({ audioSource: "microphone" });
});
```

- [ ] **Step 7: Run it and watch it fail**

```bash
npx vitest run src/tests/useCompletion.meeting-assist.test.tsx -t "carries speaker and audioSource"
```

Expected: FAIL — both fields `undefined`.

- [ ] **Step 8: Fix the diarized path**

At `src/hooks/useCompletion.ts:615-620`, replace:

```ts
      const userMessages: ChatMessage[] = validEntries.map((entry) => ({
        id: generateMessageId("user", entry.timestamp),
        role: "user" as const,
        content: entry.original,
        timestamp: entry.timestamp,
      }));
```

with:

```ts
      const userMessages: ChatMessage[] = validEntries.map((entry) => ({
        id: generateMessageId("user", entry.timestamp),
        role: "user" as const,
        content: entry.original,
        timestamp: entry.timestamp,
        // Matching addMeetingTranscript (:574-581) and addSystemAudioTranscript
        // (:701-708). Without these the row persists with both columns null and
        // the transcript export labels a guest's line "You:".
        speaker: entry.speaker,
        audioSource: entry.audioSource,
      }));
```

- [ ] **Step 9: Run both suites**

```bash
npx vitest run src/tests/useCompletion.meeting-assist.test.tsx src/tests/conversation-markdown.test.ts
```

Expected: PASS.

- [ ] **Step 10: Typecheck and commit**

```bash
npm run check:types
git add src/lib/functions/conversation-markdown.function.ts src/lib/functions/index.ts src/hooks/useHistory.ts src/hooks/useCompletion.ts src/tests/conversation-markdown.test.ts src/tests/useCompletion.meeting-assist.test.tsx
git commit -m "feat(transcript): name the speakers in the downloaded transcript

Every captured meeting message has role 'user', so mic and system audio both
rendered '## USER:'. The transcript now labels You / Guest / the tagged speaker
name, with a role fallback so no line is unlabelled.

Also fixes addMeetingTranscriptEntries, which stored neither speaker nor
audioSource - the diarization path's rows would have exported every guest line
as 'You:'. Legacy pre-migration-8 rows still do; the columns are null, so the
data to do better does not exist."
```

---

## Slice 2 — renaming a conversation

### Task 6: Migration 15 — `title_source`

**Files:**
- Create: `src-tauri/src/db/migrations/conversation-title-source.sql`
- Modify: `src-tauri/src/db/main.rs:97-104`
- Test: `src-tauri/src/db/migration_tests.rs`

**Interfaces:**
- Produces: `conversations.title_source TEXT NOT NULL DEFAULT 'auto'`, relied on by Tasks 7–9.

- [ ] **Step 1: Write the failing test**

Add to `src-tauri/src/db/migration_tests.rs`, inside the existing `mod` block, matching the four siblings at `:48`, `:66`, `:88`, `:105`:

```rust
    #[test]
    fn title_source_migration_is_version_15_and_points_at_its_own_file() {
        let all = migrations();
        let m = all
            .iter()
            .find(|m| m.description == "add_title_source_to_conversations")
            .expect("title source migration must be registered");
        assert_eq!(m.version, 15, "title source migration must be version 15");
        assert_eq!(
            m.sql,
            include_str!("migrations/conversation-title-source.sql"),
            "title source migration must embed migrations/conversation-title-source.sql"
        );
    }
```

- [ ] **Step 2: Run it and watch it fail**

```bash
cd src-tauri && cargo test --lib db::migration_tests
```

Expected: FAIL — the `include_str!` target does not exist (compile error), which is the correct first failure.

- [ ] **Step 3: Write the migration**

Create `src-tauri/src/db/migrations/conversation-title-source.sql`:

```sql
-- Conversation title provenance (migration 15).
--
-- NEVER EDIT THIS FILE AFTER RELEASE. sqlx checksums applied migrations; a
-- changed checksum fails Database.load, which is the single gate for chat
-- history, prompts, cost tracking and meeting context - the whole app's
-- persistence, not just this feature.
--
-- DEFAULT 'auto' leaves every existing row behaving exactly as it does now:
-- the automatic titlers keep winning until a human renames a conversation.
ALTER TABLE conversations ADD COLUMN title_source TEXT NOT NULL DEFAULT 'auto';
```

- [ ] **Step 4: Register it**

In `src-tauri/src/db/main.rs`, after the version-14 entry:

```rust
        Migration {
            version: 15,
            description: "add_title_source_to_conversations",
            sql: include_str!("migrations/conversation-title-source.sql"),
            kind: MigrationKind::Up,
        },
```

The description is verb-first to match all fourteen siblings (`add_speaker_to_messages` is the exact structural analogue) and is the lookup key in the test above — the two must agree.

- [ ] **Step 5: Run the tests**

```bash
cd src-tauri && cargo test --lib db::migration_tests
```

Expected: PASS, including `every_migration_file_is_registered` and the version-uniqueness checks.

- [ ] **Step 6: Note the dev-DB checksum risk**

Do not run the app yet. This project has a recurring checksum-drift problem on the development database. If `Database.load` fails after this migration, patch `_sqlx_migrations` via `node:sqlite` sweeping **every** version, not only 15 — and use forward slashes in the path, since a mangled path silently creates an empty DB.

- [ ] **Step 7: Commit**

```bash
git add src-tauri/src/db/migrations/conversation-title-source.sql src-tauri/src/db/main.rs src-tauri/src/db/migration_tests.rs
git commit -m "feat(db): add conversations.title_source (migration 15)

Additive, defaulted to 'auto', so every existing row behaves as it does now.
Its own commit so it can be reverted without touching the page merge."
```

---

### Task 7: Guard the three title writers

Three SQL statements write `conversations.title`, all unconditionally. Guarding only the obvious one leaves a rename reverted seconds later by the autosave.

**Files:**
- Modify: `src/lib/database/chat-history.action.ts:377-384, 485-492, 568-580`
- Test: `src/tests/chat-history.update-title.test.ts`, `src/tests/chat-history.rename-guard.test.ts` (create)

**Interfaces:**
- Consumes: `title_source` from Task 6.
- Produces: guarded writers. `updateConversationTitle` keeps its name and signature and becomes the automatic path.

- [ ] **Step 1: Update the existing SQL assertion**

`src/tests/chat-history.update-title.test.ts:37-40` asserts the exact statement and will break. Change the expectation to:

```ts
      expect(String(sql).replace(/\s+/g, " ").trim()).toBe(
        "UPDATE conversations SET title = ? WHERE id = ? AND title_source = 'auto'"
      );
```

- [ ] **Step 2: Write the failing tests for the split writers**

Create `src/tests/chat-history.rename-guard.test.ts`, following the mocked-`execute` shape of `chat-history.update-title.test.ts:6-8,22`:

```ts
import { beforeEach, describe, expect, it, vi } from "vitest";

const mockExecute = vi.fn();
const mockSelect = vi.fn();
vi.mock("@/lib/database/config", () => ({
  getDatabase: () => Promise.resolve({ execute: mockExecute, select: mockSelect }),
}));

const sqlOf = (call: unknown[]) => String(call[0]).replace(/\s+/g, " ").trim();
const titleWrites = () =>
  mockExecute.mock.calls.filter((c) => sqlOf(c).startsWith("UPDATE conversations SET title"));
const stampWrites = () =>
  mockExecute.mock.calls.filter((c) => sqlOf(c).startsWith("UPDATE conversations SET updated_at"));

beforeEach(() => {
  mockExecute.mockReset();
  mockSelect.mockReset();
  mockExecute.mockResolvedValue({ rowsAffected: 1 });
  mockSelect.mockResolvedValue([]);
});

describe("appendMessagesToConversation title guard", () => {
  it("splits the header write into an unconditional stamp and a guarded title", async () => {
    const { appendMessagesToConversation } = await import("@/lib/database/chat-history.action");
    await appendMessagesToConversation("conversation-1", "Autosave Title", 1234, []);

    expect(stampWrites()).toHaveLength(1);
    expect(sqlOf(stampWrites()[0])).toBe(
      "UPDATE conversations SET updated_at = ? WHERE id = ?"
    );
    expect(stampWrites()[0][1]).toEqual([1234, "conversation-1"]);

    expect(titleWrites()).toHaveLength(1);
    expect(sqlOf(titleWrites()[0])).toBe(
      "UPDATE conversations SET title = ? WHERE id = ? AND title_source = 'auto'"
    );
    expect(titleWrites()[0][1]).toEqual(["Autosave Title", "conversation-1"]);
  });

  it("never names updated_at in the guarded title statement", async () => {
    const { appendMessagesToConversation } = await import("@/lib/database/chat-history.action");
    await appendMessagesToConversation("conversation-1", "T", 1234, []);
    expect(sqlOf(titleWrites()[0])).not.toContain("updated_at");
  });

  it("still raises when the conversation is gone", async () => {
    const { appendMessagesToConversation } = await import("@/lib/database/chat-history.action");
    mockExecute.mockResolvedValueOnce({ rowsAffected: 0 });
    await expect(
      appendMessagesToConversation("missing", "T", 1234, [])
    ).rejects.toThrow("Conversation not found");
  });
});
```

- [ ] **Step 3: Run them and watch them fail**

```bash
npx vitest run src/tests/chat-history.rename-guard.test.ts
```

Expected: FAIL — one combined statement, so `stampWrites()` is empty.

- [ ] **Step 4: Split `appendMessagesToConversation`**

At `:485-492`, replace:

```ts
    const updateResult = await db.execute(
      "UPDATE conversations SET title = ?, updated_at = ? WHERE id = ?",
      [title, updatedAt, conversationId]
    );

    if (updateResult.rowsAffected === 0) {
      throw new Error("Conversation not found");
    }
```

with:

```ts
    // Split deliberately. The title write is guarded by title_source so a manual
    // rename survives - this path runs on EVERY autosave tick with the title
    // cached in conversationMetaCacheRef, so an unguarded write reverts a rename
    // seconds after it is made. The updated_at stamp must stay unconditional,
    // and it keeps the rowsAffected check: a guarded single statement would skip
    // the stamp and raise a spurious "not found" on every autosave after a rename.
    const updateResult = await db.execute(
      "UPDATE conversations SET updated_at = ? WHERE id = ?",
      [updatedAt, conversationId]
    );

    if (updateResult.rowsAffected === 0) {
      throw new Error("Conversation not found");
    }

    await db.execute(
      "UPDATE conversations SET title = ? WHERE id = ? AND title_source = 'auto'",
      [title, conversationId]
    );
```

- [ ] **Step 5: Split `updateConversation` the same way**

At `:377-384`, apply the identical treatment — unconditional `updated_at` first (keeping the `rowsAffected` check and the `throw`), then the guarded title write, with a one-line comment pointing at the sibling. Params are `[conversation.updatedAt, conversation.id]` and `[conversation.title, conversation.id]`.

- [ ] **Step 6: Guard `updateConversationTitle`**

At `:571-574`, change the statement to:

```ts
    const result = await db.execute(
      "UPDATE conversations SET title = ? WHERE id = ? AND title_source = 'auto'",
      [title, id]
    );
```

Update the doc comment at `:552-553`, which is now incomplete:

```ts
 * Returns false when no row matched — the conversation was deleted while the
 * title was being generated, OR the user has renamed it by hand
 * (title_source = 'manual'). Both mean "do not report a rename".
```

- [ ] **Step 7: Run every affected suite**

```bash
npx vitest run src/tests/chat-history.rename-guard.test.ts src/tests/chat-history.update-title.test.ts src/tests/chat-history.append-silent.test.ts src/tests/chat-history.speaker.test.ts src/tests/chat-history.create-rollback.test.ts src/tests/chat-history.title-adoption.test.ts src/tests/meeting-summarizer.title-sync.test.ts src/tests/conversation-title.test.ts
```

Expected: PASS. The `append-silent`, `speaker` and `create-rollback` suites drive the split functions and read `mockExecute.mock.calls[N]` **positionally** — splitting one statement into two shifts every later index. That breakage looks unrelated to titles; it is this change. Fix the indices, do not weaken the assertions.

- [ ] **Step 8: Commit**

```bash
git add src/lib/database/chat-history.action.ts src/tests/
git commit -m "fix(chat-history): stop an automatic titler overwriting a manual rename

Three SQL statements write conversations.title. Guarding only
updateConversationTitle would leave the autosave path
(appendMessagesToConversation, every tick, with a cached title) reverting a
rename seconds after it was made.

The guard is a SQL clause, not a read-then-write, so there is no check-then-act
window for a summarizer to win. The two header writes split so the updated_at
stamp stays unconditional and keeps its rowsAffected check."
```

---

### Task 8: `renameConversationManually`

**Files:**
- Modify: `src/lib/database/chat-history.action.ts` (add after `updateConversationTitle`)
- Test: `src/tests/chat-history.rename-guard.test.ts`

**Interfaces:**
- Produces: `renameConversationManually(id: string, title: string): Promise<boolean>` — used by Task 9 and Task 14.

- [ ] **Step 1: Write the failing tests**

Add to `src/tests/chat-history.rename-guard.test.ts`, mirroring the four cases `chat-history.update-title.test.ts:34-65` establishes for the sibling function:

```ts
describe("renameConversationManually", () => {
  it("writes both columns and leaves updated_at alone", async () => {
    const { renameConversationManually } = await import("@/lib/database/chat-history.action");
    await renameConversationManually("conversation-1", "Quarterly review with Acme");

    const [sql, params] = mockExecute.mock.calls[0];
    expect(String(sql).replace(/\s+/g, " ").trim()).toBe(
      "UPDATE conversations SET title = ?, title_source = 'manual' WHERE id = ?"
    );
    expect(params).toEqual(["Quarterly review with Acme", "conversation-1"]);
    expect(String(sql)).not.toContain("updated_at");
  });

  it("returns false when no row matched", async () => {
    const { renameConversationManually } = await import("@/lib/database/chat-history.action");
    mockExecute.mockResolvedValueOnce({ rowsAffected: 0 });
    await expect(renameConversationManually("gone", "T")).resolves.toBe(false);
  });

  it.each([
    ["", "T"],
    ["conversation-1", ""],
  ])("refuses id=%p title=%p without touching the database", async (id, title) => {
    const { renameConversationManually } = await import("@/lib/database/chat-history.action");
    await expect(renameConversationManually(id, title)).resolves.toBe(false);
    expect(mockExecute).not.toHaveBeenCalled();
  });

  it("propagates a rejected write rather than reporting success", async () => {
    const { renameConversationManually } = await import("@/lib/database/chat-history.action");
    mockExecute.mockRejectedValueOnce(new Error("database is locked"));
    await expect(renameConversationManually("conversation-1", "T")).rejects.toThrow("database is locked");
  });
});
```

- [ ] **Step 2: Run and watch fail**

```bash
npx vitest run src/tests/chat-history.rename-guard.test.ts -t renameConversationManually
```

Expected: FAIL — not exported.

- [ ] **Step 3: Implement it**

Add to `src/lib/database/chat-history.action.ts`, immediately after `updateConversationTitle`:

```ts
/**
 * Renames a conversation on the user's instruction, and records that a human
 * chose the name so no automatic titler can take it back.
 *
 * Deliberately does NOT touch updated_at. The conversation list sorts on it, so
 * bumping it would make the row jump date groups mid-edit and unmount the input
 * under a new heading, losing the caret.
 */
export async function renameConversationManually(
  id: string,
  title: string
): Promise<boolean> {
  if (!id || typeof id !== "string") {
    console.error("Invalid conversation id");
    return false;
  }
  if (!title || typeof title !== "string") {
    console.error("Invalid conversation title");
    return false;
  }

  const db = await getDatabase();

  try {
    const result = await db.execute(
      "UPDATE conversations SET title = ?, title_source = 'manual' WHERE id = ?",
      [title, id]
    );
    return result.rowsAffected > 0;
  } catch (error) {
    console.error(`Failed to rename conversation ${id}:`, error);
    throw error;
  }
}
```

- [ ] **Step 4: Run and watch pass**

```bash
npx vitest run src/tests/chat-history.rename-guard.test.ts
```

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/lib/database/chat-history.action.ts src/tests/chat-history.rename-guard.test.ts
git commit -m "feat(chat-history): add renameConversationManually

Sets title_source = 'manual' in the same statement as the title, so the guard
added alongside it cannot be raced. Leaves updated_at alone - the list sorts on
it, and a bump would move the row out from under the open editor."
```

---

### Task 9: Propagate a rename to both windows

The rename UI lives in the dashboard webview; `useCompletion`'s `conversationMetaCacheRef` — which feeds the autosave — lives in the overlay. `window.dispatchEvent` does not cross Tauri webviews, and the `storage` event does not fire in the window that wrote the value. **A commit must therefore fire both channels**; dropping either leaves one window stale.

**Files:**
- Create: `src/lib/chat-constants.ts` addition (the shared key) — or wherever `DOWNLOAD_SUCCESS_DISPLAY_MS` lives
- Modify: `src/hooks/useCompletion.ts:258-273`
- Test: `src/tests/useCompletion.meeting-assist.test.tsx`

**Interfaces:**
- Consumes: `renameConversationManually` from Task 8.
- Produces: `CONVERSATION_RENAMED_KEY` (exported constant), and an overlay listener that patches the meta cache. Task 14 calls the commit path.

- [ ] **Step 1: Export the shared key**

Add to `src/lib/chat-constants.ts`:

```ts
/**
 * localStorage key carrying a rename across Tauri webviews.
 *
 * Both the writer (the dashboard's rename commit) and the reader (the overlay's
 * storage listener) import THIS constant. A test that hardcodes the string
 * would pass against a writer that never writes it.
 */
export const CONVERSATION_RENAMED_KEY = "meetwings-conversation-renamed";
```

- [ ] **Step 2: Write the failing test**

Add to `src/tests/useCompletion.meeting-assist.test.tsx`:

```ts
it("patches the cached title when the other window renames a conversation", async () => {
  const { CONVERSATION_RENAMED_KEY } = await import("@/lib/chat-constants");
  const { result } = renderHook(() => useCompletion(), { wrapper });

  await act(async () => {
    result.current.addMeetingTranscript("Opening", Date.now(), undefined, "microphone");
  });
  const id = result.current.currentConversationId!;

  // Persist the conversation so a cache entry exists for this id.
  await act(async () => {
    await result.current.submit("hello");
  });

  await act(async () => {
    window.dispatchEvent(
      new StorageEvent("storage", {
        key: CONVERSATION_RENAMED_KEY,
        newValue: JSON.stringify({ id, title: "Renamed by hand", timestamp: Date.now() }),
      })
    );
  });

  // The next autosave must carry the new title, not the cached old one.
  await act(async () => {
    result.current.addMeetingTranscript("Another line", Date.now(), undefined, "microphone");
    await vi.advanceTimersByTimeAsync(MEETING_TRANSCRIPT_AUTOSAVE_INTERVAL);
  });

  const lastAppend = appendCalls.at(-1);
  expect(lastAppend?.title).toBe("Renamed by hand");
});
```

`appendCalls` is whatever the suite already records `appendMessagesToConversation` arguments into; reuse it. If the suite does not use fake timers, drive the autosave the way its existing autosave test at `:389` does rather than adding timer mocking.

- [ ] **Step 3: Run and watch fail**

```bash
npx vitest run src/tests/useCompletion.meeting-assist.test.tsx -t "patches the cached title"
```

Expected: FAIL — the append still carries the old title.

- [ ] **Step 4: Add the overlay listener**

In `src/hooks/useCompletion.ts`, beside the existing `conversation-title-updated` effect at `:258-273`, add a second `[]`-deped effect:

```ts
  // The rename UI lives in the DASHBOARD webview; this hook runs in the overlay.
  // window CustomEvents do not cross Tauri webviews (useHistory.ts:184 uses
  // localStorage for exactly this reason), so the in-window event above never
  // fires here for a dashboard rename - and without this the next autosave
  // writes the stale cached title back over the user's rename.
  useEffect(() => {
    const handleRenamedElsewhere = (event: StorageEvent) => {
      if (event.key !== CONVERSATION_RENAMED_KEY || !event.newValue) return;
      let payload: { id?: string; title?: string };
      try {
        payload = JSON.parse(event.newValue);
      } catch {
        return;
      }
      const { id, title } = payload;
      if (!id || typeof title !== "string") return;

      const cached = conversationMetaCacheRef.current;
      if (!cached) return;
      // PATCH, never invalidate. A cache miss sends the autosave into the
      // re-read branch, and getConversationById returns null on a FAILED read
      // as well as a missing row (chat-history.action.ts:345-351) - so a
      // transient error would invent a "Meeting transcript - <date>" title with
      // hasStoredTitle false, the one state that hands the conversation to the
      // AI titler. Invalidate only when the id does not match.
      conversationMetaCacheRef.current =
        cached.id === id
          ? { ...cached, title }
          : null;
    };

    window.addEventListener("storage", handleRenamedElsewhere);
    return () => window.removeEventListener("storage", handleRenamedElsewhere);
  }, []);
```

Import `CONVERSATION_RENAMED_KEY` from `@/lib`.

- [ ] **Step 5: Run and watch pass**

```bash
npx vitest run src/tests/useCompletion.meeting-assist.test.tsx
```

Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add src/lib/chat-constants.ts src/hooks/useCompletion.ts src/tests/useCompletion.meeting-assist.test.tsx
git commit -m "fix(completion): carry a rename across the webview boundary

The rename UI is in the dashboard; this hook's title cache is in the overlay,
and window events do not cross Tauri webviews - so without this the next
autosave writes the stale cached title back over the rename.

The handler patches the cache rather than invalidating it: a miss routes the
autosave through getConversationById, which cannot distinguish a failed read
from a missing row, and would invent a title and hand it to the AI titler."
```

---

## Slice 1 — the unified page

### Task 10: Lift the queue logic into `useMeetingLogQueue`

**Files:**
- Create: `src/hooks/useMeetingLogQueue.ts`
- Modify: `src/hooks/index.ts`
- Modify: `src/pages/meeting-log/index.tsx` (consume the hook; the page keeps rendering exactly as before)
- Test: `src/tests/meeting-log-page.test.tsx`

**Interfaces:**
- Produces: `useMeetingLogQueue()` returning the state and handlers the page renders from — `rows`, `groups`, `configState`, `stranded`, `loadError`, `busyId`, `reload`, and every action handler the page currently defines. **All handlers wrapped in `useCallback` and all returned values referentially stable**, because Task 13 memoises children on them.

- [ ] **Step 1: Read the page and inventory what moves**

```bash
awk 'NR>=380 && NR<=480 {printf "%4d|%s\n", NR, $0}' src/pages/meeting-log/index.tsx
```

Everything from the `loadToken` ref, the `reload` callback, the focus listener effect and the write-only mirror refs down to the action handlers moves into the hook. What stays in the page: JSX, `GROUPS`, `FAILURE_COPY` (a render concern), and the dialog state.

- [ ] **Step 2: Move the logic verbatim**

Create `src/hooks/useMeetingLogQueue.ts` with a header:

```ts
/**
 * Page-side queue READS for the meetings page.
 *
 * Not useMeetingLog.ts, which is the write side (enqueue and hold). The names
 * are close; the responsibilities do not overlap.
 *
 * Lifted verbatim from pages/meeting-log/index.tsx. Most of this file's length
 * is defensive and each part is a fixed bug: token-ordered reads so a focus
 * refresh cannot repaint rows an action already moved; write-only mirror refs so
 * the focus listener does not re-register a Tauri listener every render. Do not
 * "simplify" either.
 */
```

Move the code without behavioural edits. Wrap every returned handler in `useCallback` and the returned object in `useMemo` — the page currently defines them inline, which was fine for one consumer but defeats the memoised children in Task 13.

- [ ] **Step 3: Consume it from the existing page, unchanged**

`src/pages/meeting-log/index.tsx` now calls `useMeetingLogQueue()` at its top level and renders exactly as before. This is the step that proves the lift in isolation, before the merge changes anything visible.

- [ ] **Step 4: Run the page suite — this is the acceptance gate**

```bash
npx vitest run src/tests/meeting-log-page.test.tsx
```

Expected: **PASS with no edit to any assertion and no edit to any mock.** At this point the page renders identically, so a failure means the lift was not verbatim. Fix the lift, not the test.

- [ ] **Step 5: Commit**

```bash
git add src/hooks/useMeetingLogQueue.ts src/hooks/index.ts src/pages/meeting-log/index.tsx
git commit -m "refactor(meeting-log): lift the queue logic into useMeetingLogQueue

No behaviour change - the page renders identically and its suite passes with no
assertion or mock edited, which is what proves the lift was verbatim. Handlers
are useCallback-wrapped so the merged page can memoise its children on them."
```

---

### Task 11: The badge query

`listActionableRows` deliberately excludes `sent`, `cancelled` and `deleted`, so it cannot drive a "sent" badge. One new statement, resolved into a map.

**Files:**
- Modify: `src/lib/database/meeting-log.action.ts`
- Modify: `src/hooks/useMeetingLogQueue.ts`
- Test: `src/tests/meetings-page.badges.test.tsx` (create)

**Interfaces:**
- Produces: `listConversationBadgeRows(): Promise<Array<{ conversationId: string; status: MeetingLogStatus; instance: string }>>` and a pure `resolveBadge(rows, currentInstance)` returning `{ status, count } | null`.

- [ ] **Step 1: Write the failing tests**

Create `src/tests/meetings-page.badges.test.tsx` covering the four resolution rules as separate cases:

```ts
import { describe, expect, it } from "vitest";
import { resolveBadge } from "@/lib/odoo/meeting-log";

const row = (status: string, instance = "odoo-a") => ({ conversationId: "c1", status, instance } as any);

describe("resolveBadge", () => {
  it("badges an other-instance sent row", () => {
    expect(resolveBadge([row("sent", "odoo-old")], "odoo-a")).toMatchObject({ status: "sent" });
  });

  it("does NOT badge an other-instance failed row", () => {
    // Its actionable state belongs to the strip's other-database group: pushQueuedRow
    // refuses it at the instance check, so offering an action here would be a lie.
    expect(resolveBadge([row("failed", "odoo-old")], "odoo-a")).toBeNull();
  });

  it("resolves worst-status-wins across several rows", () => {
    expect(
      resolveBadge([row("sent"), row("pending"), row("failed"), row("held")], "odoo-a")
    ).toMatchObject({ status: "failed" });
  });

  it("shows a count when more than one row maps to the conversation", () => {
    expect(resolveBadge([row("sent"), row("sent")], "odoo-a")).toMatchObject({ status: "sent", count: 2 });
  });

  it.each(["cancelled", "deleted"])("renders no badge for %s", (status) => {
    // Both are meetings the user deliberately removed. Surfacing either as state
    // would resurrect a decision they already made.
    expect(resolveBadge([row(status)], "odoo-a")).toBeNull();
  });
});
```

- [ ] **Step 2: Run and watch fail**

```bash
npx vitest run src/tests/meetings-page.badges.test.tsx
```

Expected: FAIL — `resolveBadge` is not exported.

- [ ] **Step 3: Add the query**

In `src/lib/database/meeting-log.action.ts`, beside `QUEUE_SQL.listActionable`:

```ts
  listConversationBadges: `
SELECT conversation_id, status, instance
  FROM meeting_log_queue
 WHERE conversation_id IS NOT NULL`,
```

with a comment recording why there is no instance filter: `listActionable` does not filter by instance either — it uses `?1` only inside its `ORDER BY CASE`, leaving classification to `groupOf`. Filtering here would hide a `sent` row a previous Odoo configuration pushed successfully, which is exactly the history the badge exists to show.

- [ ] **Step 4: Add `resolveBadge`**

In `src/lib/odoo/meeting-log.ts`, beside `groupOf`:

```ts
const BADGE_RANK = ["failed", "unassigned", "sending", "pending", "held", "sent"] as const;

export function resolveBadge(
  rows: ReadonlyArray<{ status: string; instance: string }>,
  currentInstance: string
): { status: (typeof BADGE_RANK)[number]; count: number } | null {
  const eligible = rows.filter((r) =>
    r.instance === currentInstance
      ? (BADGE_RANK as readonly string[]).includes(r.status)
      : r.status === "sent"
  );
  if (eligible.length === 0) return null;

  const worst = BADGE_RANK.find((s) => eligible.some((r) => r.status === s));
  return worst ? { status: worst, count: eligible.length } : null;
}
```

`cancelled` and `deleted` are absent from `BADGE_RANK`, so they fall out by construction rather than by a special case.

- [ ] **Step 5: Call it inside the token guard**

In `useMeetingLogQueue`, add the badge read to `reload`'s existing `Promise.all` — **inside** the same `if (token !== loadToken.current) return;` guard. Outside it, a focus refresh could resolve after an action's re-read and repaint badges the action already moved, which is the exact race `loadToken` exists to prevent.

- [ ] **Step 6: Run and typecheck**

```bash
npx vitest run src/tests/meetings-page.badges.test.tsx src/tests/meeting-log-page.test.tsx
npm run check:types
```

The page suite needs the new function added to its hoisted `db` factory with a `beforeEach` `mockResolvedValue([])` default — otherwise it is `undefined` inside the wholesale `vi.mock("@/lib/database/meeting-log.action")` and `reload` throws. **Adding to the factory is a required amendment, not a stop signal**; rewriting an existing mock's behaviour is.

- [ ] **Step 7: Commit**

```bash
git add src/lib/database/meeting-log.action.ts src/lib/odoo/meeting-log.ts src/hooks/useMeetingLogQueue.ts src/tests/meetings-page.badges.test.tsx src/tests/meeting-log-page.test.tsx
git commit -m "feat(meetings): resolve a queue badge per conversation

listActionable excludes sent/cancelled/deleted by design, so it cannot drive a
sent badge. The new query has no instance filter, matching listActionable: an
other-instance row still contributes 'sent', because that is history worth
showing, but never an actionable state - pushQueuedRow would refuse it."
```

---

### Task 12: The `/meetings` page

**Files:**
- Create: `src/pages/meetings/index.tsx`, `src/pages/meetings/components/{ConversationRow,QueueStrip,DateGroup}.tsx`
- Move: `src/pages/meeting-log/components/*` and `src/pages/chats/components/View.tsx` into `src/pages/meetings/components/`
- Modify: `src/pages/index.ts`
- Test: `src/tests/meetings-page.test.tsx` (create)

**Interfaces:**
- Consumes: `useMeetingLogQueue` (Task 10), `resolveBadge` (Task 11), `useHistory` (existing).
- Produces: the `Meetings` page export.

- [ ] **Step 1: Write the failing tests**

Create `src/tests/meetings-page.test.tsx` covering the behaviours the spec fixes:

```ts
it("renders the conversation list with no strip and no badges when Odoo is unconfigured", …);
it("still reports the stranded count on a half-filled config", …);
it("keeps the conversation list rendered when the queue read fails", …);
it("filters the date-grouped list but never the strip", …);
it("renders a conversation_id IS NULL row in the strip with no link", …);
```

Write each assertion out in full against the rendered DOM; do not leave prose placeholders.

- [ ] **Step 2: Run and watch fail**

```bash
npx vitest run src/tests/meetings-page.test.tsx
```

- [ ] **Step 3: Build the page**

`src/pages/meetings/index.tsx` calls `useMeetingLogQueue()` **unconditionally at the top level** and renders `<ProviderConfigReader>` outside any conditional — the focus listener's `[]` effect and the mirror refs depend on mounting exactly once, and a conditional mount re-registers the Tauri listener across its lossy async `listen()` gap.

Layout: the action strip (rendered only when non-empty) above the always-rendered date-grouped list. Carry the date grouping over from `pages/chats/index.tsx:12-27` and the search from `:54-63`.

Error isolation is structural, not new error handling: `loadError` renders **above the strip only**, and the list is `useHistory`-owned state that `reload` never touches. `useHistory` is not modified.

- [ ] **Step 4: Move the components**

`git mv` each file so history follows it. `View.tsx` keeps the barrel name `ViewChat` so `routes/index.tsx` and the `useChatCompletion` wiring do not churn. `QueueRow` keeps its `meetingDateOf` / `targetNameOf` / `TranscriptView` exports, which `index.tsx:41-45` imports (note the `targetNameOf as targetNameOfSingle` alias).

- [ ] **Step 5: Update the barrel**

In `src/pages/index.ts`: add `Meetings`, remove `Chats` and `MeetingLog`, repoint `ViewChat` at the new location.

- [ ] **Step 6: Run and typecheck**

```bash
npx vitest run src/tests/meetings-page.test.tsx
npm run check:types
```

- [ ] **Step 7: Commit**

```bash
git add -A src/pages src/tests/meetings-page.test.tsx
git commit -m "feat(meetings): one page for conversations and the Odoo queue

The queue hook is called unconditionally at the page top level and the strip
renders from its state - calling it from inside the conditionally-rendered
strip would re-register the Tauri focus listener on every mount."
```

---

### Task 13: Routing, links, menu, and the memoisation

**Files:**
- Modify: `src/routes/index.tsx`, `src/hooks/useMenuItems.tsx:64-75`, `src/pages/context-memory/components/SummaryDetail.tsx:259`, `src/pages/odoo/index.tsx:559`
- Delete: `src/pages/chats/index.tsx`, `src/pages/meeting-log/index.tsx`
- Test: `src/tests/routes.redirects.test.tsx` (create), `src/tests/meeting-log-entry-points.test.tsx`

**Interfaces:**
- Consumes: the `Meetings` page from Task 12.

- [ ] **Step 1: Write the failing redirect test**

Create `src/tests/routes.redirects.test.tsx`. Test the piece with real logic — the `useParams` wrapper — as a component under `MemoryRouter`, and assert the two static redirects declaratively. **Do not mount `AppRoutes`**: it hardcodes `BrowserRouter` and eagerly imports every page, dragging in the whole odoo/chat-history module graph.

```tsx
it("forwards search and hash when redirecting a conversation view", () => {
  render(
    <MemoryRouter initialEntries={["/chats/view/conversation-7?tab=notes#m3"]}>
      <Routes>
        <Route path="/chats/view/:conversationId" element={<ChatViewRedirect />} />
        <Route path="/meetings/view/:conversationId" element={<Landed />} />
      </Routes>
    </MemoryRouter>
  );
  expect(screen.getByTestId("landed")).toHaveTextContent("/meetings/view/conversation-7?tab=notes#m3");
});
```

- [ ] **Step 2: Add the routes**

In `src/routes/index.tsx`, inside the `DashboardLayout` route:

```tsx
          <Route path="/meetings" element={<Meetings />} />
          <Route path="/meetings/view/:conversationId" element={<ViewChat />} />
          {/* Redirect old routes for backward compatibility */}
          <Route path="/chats" element={<Navigate to="/meetings" replace />} />
          <Route path="/meeting-log" element={<Navigate to="/meetings" replace />} />
          <Route path="/chats/view/:conversationId" element={<ChatViewRedirect />} />
```

`ChatViewRedirect` is a small wrapper, because `Navigate`'s `to` is a static string and cannot re-interpolate the param:

```tsx
function ChatViewRedirect() {
  const { conversationId } = useParams();
  const location = useLocation();
  return (
    <Navigate
      to={`/meetings/view/${conversationId}${location.search}${location.hash}`}
      replace
    />
  );
}
```

- [ ] **Step 3: Move the four hardcoded links and collapse the menu**

`SummaryDetail.tsx:259` and `pages/odoo/index.tsx:559` point at `/meetings`. In `useMenuItems.tsx:64-75`, the "Meeting log" and "Chats" entries collapse into one:

```tsx
    {
      icon: MessagesSquare,
      label: "Meetings",
      href: "/meetings",
      disabled: gateOnSetup,
    },
```

- [ ] **Step 4: Apply the memoisation**

In the page: `useMemo` the group + sort + filter into **one memo owned by the list child**, and split the strip and list into separate `React.memo` children. Pass each row **only its own badge value**, never the whole `Map` — the map is rebuilt on every `reload`, so passing it re-renders the entire list.

Record in a comment that `getAllConversations` attaching every message is a known cost that memoisation does not address; a `COUNT(*)`-shaped list read is the real remedy and is out of scope.

- [ ] **Step 5: Run the affected suites**

```bash
npx vitest run src/tests/routes.redirects.test.tsx src/tests/meetings-page.test.tsx src/tests/summary-detail.conversation-link.test.tsx src/tests/meeting-log-entry-points.test.tsx src/tests/odoo-target-new-chat-entry-points.test.tsx
```

Expected: PASS. The link suites need their expected URLs updated. Add the menu-collapse assertion to `meeting-log-entry-points.test.tsx`, where entry points are already tested.

- [ ] **Step 6: Delete the retired pages and typecheck**

```bash
git rm src/pages/chats/index.tsx src/pages/meeting-log/index.tsx
npm run check:types
npm run lint
```

- [ ] **Step 7: Commit**

```bash
git add -A
git commit -m "feat(meetings): route /meetings and retire the two old pages

/chats and /meeting-log redirect; /chats/view/:id needs a useParams wrapper
because Navigate's `to` is static, and it forwards search and hash so a
deep link is not silently truncated. The two menu entries become one."
```

---

### Task 14: The rename UI

**Files:**
- Modify: `src/pages/meetings/components/ConversationRow.tsx`, `src/pages/meetings/components/View.tsx`
- Test: `src/tests/meetings-page.test.tsx`

**Interfaces:**
- Consumes: `renameConversationManually` (Task 8), `CONVERSATION_RENAMED_KEY` (Task 9).

- [ ] **Step 1: Write the failing tests**

Assert: pencil on hover reveals the input; Enter commits and calls `renameConversationManually`; Escape cancels without writing; the commit dispatches `conversation-title-updated` **and** writes `CONVERSATION_RENAMED_KEY` with an `{ id, title, timestamp }` payload.

The `timestamp` is load-bearing, not decoration: `storage` does not fire when the written string is byte-identical to the stored one, so without a nonce, renaming the same conversation to the same title twice is silently dropped. Assert it is present and changes between two identical renames.

- [ ] **Step 2: Run and watch fail**

- [ ] **Step 3: Implement the inline rename**

Pencil on hover → input → Enter commits, Escape cancels. On commit, call `renameConversationManually`, then fire **both** channels.

- [ ] **Step 4: Implement the header rename and its listener**

`View.tsx` renders `messages?.title` read-only at `:89`. Add the rename control, and subscribe to `conversation-title-updated` with a `[]`-deped effect and a **functional, id-checked** updater:

```ts
setMessages((prev) => (prev && prev.id === id ? { ...prev, title } : prev));
```

Not a `[messages]`-deped listener: `setMessages` is shared with `useChatCompletion(conversationId, messages, setMessages)` at `:55-59`, which appends during a live completion, so a `[messages]` dep would re-register on every streamed chunk, and a `[]`-deped listener writing `{ ...messages, title }` from a stale closure would clobber everything appended since mount.

Give the load effect at `:61-67` an ignore flag — it has no cancellation and no id check, so an in-flight `getConversationById` can resolve after a title patch and overwrite it.

- [ ] **Step 5: Run the suites**

```bash
npx vitest run src/tests/meetings-page.test.tsx src/tests/useCompletion.meeting-assist.test.tsx
```

- [ ] **Step 6: Full scoped run and commit**

```bash
npm run check:types && npm run lint
git add -A
git commit -m "feat(meetings): rename a conversation from the list or the header

Commit fires both channels: the in-window CustomEvent for the dashboard, and
the localStorage key for the overlay, whose cache the storage event cannot
reach otherwise. The payload carries a timestamp because storage does not fire
on a byte-identical write - without it a repeat rename is silently dropped."
```

---

## Self-review

**Spec coverage.** Item 1 → Tasks 10–14. Item 2 → Tasks 6–9, 14. Item 3 → Tasks 4–5. Item 4 → Tasks 1–3. The spec's out-of-scope items (remount duplicates, historical row repair, the `COUNT(*)` list read) are recorded as such and have no tasks, correctly.

**Placeholder scan.** Task 12 Step 1 and Task 14 Step 1 name their test cases but do not write every assertion out in full — flagged in-line for the implementer to expand rather than left implicit. All code steps carry real code.

**Type consistency.** `speakerLabelFor(m: Pick<TranscriptEntry, "speaker" | "audioSource">)` is consumed with `ChatMessage` in Task 5 — satisfied structurally, since `ChatMessage` carries both fields (`types/completion.ts:56-59`). `ensureConversationId(ref)` takes the ref in Tasks 2 and 3. `saveCurrentConversation`'s fourth parameter is added in Task 3 and both call sites updated in the same task.

**Known gap surfaced during planning.** `handleScreenshotSubmit` (`useCompletion.ts:1640`) calls `saveCurrentConversation` at `:1748` with no `conversationId` in scope. Task 3 Step 5 mints one there rather than threading the spec's `:882` id, which does not reach that callback.
