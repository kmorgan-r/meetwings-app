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
- **`src/lib/index.ts` star-exports `./functions`, `./database` and `./odoo` into one flat namespace.** Every new exported name must be unique across all of `src/lib`. Verified free at plan time: `speakerLabelFor`, `conversationToMarkdown`, `ensureConversationId`, `renameConversationManually`, `resolveBadge`, `listConversationBadgeRows`, `CONVERSATION_RENAMED_KEY`.
- **Path alias is `@/`.** Files are kebab-case, components PascalCase, hooks `use*` camelCase, helper modules in `src/lib/functions/` use the `*.function.ts` suffix.
- **Commit boundaries are the four items, in task order.** Migration 15 lands inside Task 6 so it can be reverted without touching the page merge.
- **Run tests scoped to the files you touched**, e.g. `npx vitest run src/tests/foo.test.ts`. Never a bare `npx vitest run` — this repo has pre-existing unrelated failures and a full-suite run will not tell you whether your change is sound.
- **The typecheck script is `npm run type-check`** (`tsc --noEmit`). There is no `check:types`.
- **`tsconfig.json` excludes `src/tests/**`**, so `type-check` never validates test files. A wrong argument count or a bad type in a test compiles and runs; only the assertion catches it. Conversely `noUnusedLocals: true` **is** enforced on source, so an import left unused after an edit is a hard failure.
- **Line numbers in this plan are plan-time.** Anchor every edit on the quoted snippet, not the number. Earlier tasks shift later ones by a few lines; if a number does not match, re-grep for the snippet and proceed — do not stop.
- **`src/tests/useCompletion.meeting-assist.test.tsx` mocks `@/lib` with a hand-written factory** (`:49-79`) listing exactly the names `useCompletion.ts` imports today. **Any new name added to `useCompletion.ts`'s `@/lib` import is `undefined` inside that suite** unless the factory is amended in the same task. This is the single most likely way to break a "PASS" expectation in this plan; each affected task carries an explicit step.
- That suite's wrapper is `strictModeWrapper` (`:91-93`) — there is no `wrapper`. Its `generateConversationId` mock returns the constant `"conversation-1"` (`:66`), pinned by `EXISTING_CONVERSATION` and the `getConversationById` assertions, so **a test asserting "only one distinct id" is vacuous there**; use `mockReturnValueOnce` for per-call ids instead of changing the default.

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

**These two blocks are byte-identical, including indentation**, so a single exact-match edit will report "not unique" and fail. Anchor each edit on a surrounding unique line — the preceding comment differs (`// Also add to conversation history as user messages (for display)` at `:610` vs `// Also add to conversation history` at `:696`) — or use a replace-all that expects exactly two occurrences.

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
npm run type-check
npm run lint
```

Expected: PASS. If `generateConversationId` is now unused in `useCompletion.ts`, remove it from that file's imports.

- [ ] **Step 7b: Amend the suite's `@/lib` mock factory — required, not optional**

`src/tests/useCompletion.meeting-assist.test.tsx:49-79` replaces the whole `@/lib` barrel with a factory listing exactly the names the hook imports today. `ensureConversationId` is not among them, so without this step it is `undefined` inside the hook and the suite dies with `ensureConversationId is not a function` on the first `addMeetingTranscript` — nothing to do with your change.

Add to the factory's returned object, delegating to its own `generateConversationId` so per-test `mockReturnValueOnce` overrides still drive it:

```ts
    ensureConversationId: vi.fn((ref: { current: string | null }) => {
      ref.current ??= mockGenerateConversationId();
      return ref.current;
    }),
```

where `mockGenerateConversationId` is the same `vi.fn` the factory assigns to `generateConversationId` (hoist it to a local inside the factory closure so both entries share one instance).

- [ ] **Step 8: Run the existing completion suite**

```bash
npx vitest run src/tests/useCompletion.meeting-assist.test.tsx
```

Expected: PASS. This suite mounts the hook and drives the transcript paths, so it is the regression check that the substitution preserved behaviour.

- [ ] **Step 9: Commit**

```bash
git add src/lib/functions/conversation-id.function.ts src/lib/functions/index.ts src/hooks/useCompletion.ts src/tests/conversation-id.function.test.ts src/tests/useCompletion.meeting-assist.test.tsx
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

- [ ] **Step 2a: Make the suite able to express the defect at all**

Three properties of `src/tests/useCompletion.meeting-assist.test.tsx` make a naive version of this test useless. Fix them first, in their own commit, and confirm the suite still passes.

1. **The context mock returns a fresh object per render** (`:20-28`), so `selectedAIProvider` changes identity every render and `submit` is rebuilt — the stale closure the defect needs can never form. Hoist the return value:

```ts
const APP_CONTEXT = {
  selectedAIProvider: { provider: null },
  allAiProviders: [],
  systemPrompt: "",
  screenshotConfiguration: { enabled: false, mode: "manual" },
  setScreenshotConfiguration: vi.fn(),
};
vi.mock("@/contexts", () => ({ useApp: () => APP_CONTEXT }));
```

2. **`generateConversationId` is mocked to the constant `"conversation-1"`** (`:66`). Every mint returns the same string, so "assert only one distinct id" passes with the bug fully intact. Do **not** change the factory default — `EXISTING_CONVERSATION`, the `saveConversation` resolved value and `expect(getConversationById).toHaveBeenCalledWith("conversation-1")` at `:221` all pin it. Override per-test with `mockReturnValueOnce`.

   **And reset it in `beforeEach`, or the one-shots leak.** The suite's own comment at `:393-397` records the hazard: `vi.clearAllMocks()` clears call records but **not** queued one-shot behaviours. In the fixed (green) state the second queued id is deliberately never consumed — that is the whole point — so it survives into the next test, where the first mint picks it up and every `"conversation-1"` pin breaks. Add to the suite's `beforeEach`, matching the `mockReset()` precedent at `:398`/`:405`:

```ts
    vi.mocked(generateConversationId).mockReset();
```

   Vitest restores the factory's `vi.fn(() => "conversation-1")` implementation on reset, so the pinned default survives.

4. **Add `generateConversationId` to the suite's import list** at `:6-14`. The new tests call `vi.mocked(generateConversationId)`, and it is not currently imported. `tsconfig.json` excludes `src/tests/**`, so this surfaces as a runtime `ReferenceError`, not a type error.

3. **Verify `ensureConversationId` is present in the `@/lib` factory** — it was added in **Task 2 Step 7b**, which owns that amendment because its own Step 8 gate depends on it. If it is missing (a task ran out of order, or a worktree was reset), add it there rather than here, so the two tasks do not write competing versions of the same factory key.

Run the suite unchanged afterwards — it must still pass:

```bash
npx vitest run src/tests/useCompletion.meeting-assist.test.tsx
```

```bash
git add src/tests/useCompletion.meeting-assist.test.tsx
git commit -m "test(completion): stabilise the app-context mock so a stale closure can form"
```

- [ ] **Step 2b: Write the failing test**

```ts
it("reuses the established conversation id when a turn is saved", async () => {
  vi.mocked(generateConversationId)
    .mockReturnValueOnce("chat-a")
    .mockReturnValueOnce("chat-b");
  enableProviderGate();
  mockStreamedResponse("ok");

  const { result } = renderHook(() => useCompletion(), { wrapper: strictModeWrapper });

  // Capture submit BEFORE the render that establishes the id. Comparing it to
  // itself afterwards would be tautological - the point is that it survives the
  // state change.
  const submitBefore = result.current.submit;

  // Establish an id through a ref-writing path that does not touch submit's deps.
  await act(async () => {
    result.current.addMeetingTranscript("Opening line", undefined, "microphone");
  });
  const established = result.current.currentConversationId;
  expect(established).toBe("chat-a");

  // THE PRECONDITION. The defect only reproduces if submit's useCallback
  // identity survived the render that set the id - otherwise the closure is
  // fresh, it reads the current state, and this degrades into a same-tick test
  // that passes against unfixed code. With APP_CONTEXT hoisted (Step 2a) and
  // addMeetingTranscript touching none of submit's five deps, this holds for
  // the right reason.
  expect(result.current.submit).toBe(submitBefore);

  await act(async () => {
    await result.current.submit("What should I say?");
  });

  // A saved turn must land on the established conversation, not mint "chat-b".
  const savedIds = vi.mocked(saveConversation).mock.calls.map(([c]) => c.id);
  expect(savedIds).not.toContain("chat-b");
  expect(savedIds.at(-1)).toBe("chat-a");
  expect(result.current.currentConversationId).toBe("chat-a");

  // The ref is private, so observe it through a following ref-reading path.
  await act(async () => {
    result.current.addMeetingTranscript("Later line", undefined, "microphone");
  });
  expect(result.current.currentConversationId).toBe("chat-a");
});
```

Note `enableProviderGate()` and `mockStreamedResponse("ok")` (`:105-115`): without them `submit` returns early at the provider gate, `saveCurrentConversation` never runs, and the test passes vacuously. `addMeetingTranscript` takes **three** arguments — `(transcript, speakerInfo?, audioSource?)` — not four.

- [ ] **Step 3: Run it and watch it fail**

```bash
npx vitest run src/tests/useCompletion.meeting-assist.test.tsx -t "reuses the established conversation id"
```

Expected: FAIL — `savedIds` contains `"chat-b"`, because `saveCurrentConversation` minted its own id from stale state.

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

- [ ] **Step 4b: Replace the SECOND stale read — this is the one that clobbers titles**

`saveCurrentConversation` reads `state.currentConversationId` **twice**. Fixing only the mint leaves the second read stale, and the failure is worse than the duplicate it replaces. At `:1459-1469`:

```ts
      // Get existing conversation if updating
      let existingConversation = null;
      if (state.currentConversationId) {
        try {
          existingConversation = await getConversationById(
            state.currentConversationId
          );
        } catch (error) {
          console.error("Failed to get existing conversation:", error);
        }
      }
```

With the id now correct but the lookup still reading stale-null state, `existingConversation` stays `null`, so at `:1471-1475` `title` falls back to `generateConversationTitle(userMessage)` — the raw first message — and `saveConversation` writes it over the conversation's real name. Worse, `:1508`'s `if (!existingConversation?.title) requestAITitle(...)` then re-fires the AI titler on a conversation that already has a name. Replace both reads with the parameter:

```ts
      // Get existing conversation if updating. Reads the turn's own id, not
      // state: state.currentConversationId is stale-null in exactly the
      // scenario this parameter exists to fix, and a null lookup here silently
      // renames the conversation to its first message and re-fires the titler.
      let existingConversation = null;
      if (conversationId) {
        try {
          existingConversation = await getConversationById(conversationId);
        } catch (error) {
          console.error("Failed to get existing conversation:", error);
        }
      }
```

- [ ] **Step 4c: Drop the now-unused dep**

At `:1520`, `state.currentConversationId` is no longer read anywhere in the callback:

```ts
    [state.currentConversationId, queueConversationWrite, requestAITitle] // Note: conversationHistory removed - using conversationHistoryRef
```

(The real line carries that trailing comment; keep it.)

becomes:

```ts
    [queueConversationWrite, requestAITitle]
```

This is the React payoff, not tidying: today that dep gives `saveCurrentConversation` a new identity on every conversation change, which churns `handleScreenshotSubmit` (which lists it at `:1804`), which re-runs the effects at `useChatCompletion.ts:617` and `:664` — and those register `listen("captured-selection")` and assign `unlisten` after an `await`, the same lossy-async-gap leak documented at `pages/meeting-log/index.tsx:478-481`.

- [ ] **Step 4d: Prune the import**

If `generateConversationId` now has no remaining use in `useCompletion.ts` (Task 2 removed the other six), remove it from the `@/lib` import. `noUnusedLocals: true` makes this a hard `type-check` failure, not a warning.

```bash
grep -n "generateConversationId" src/hooks/useCompletion.ts
```

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

In `handleScreenshotSubmit` (`:1640`), mint once near the top of the callback, matching the shape of the other turn-starting paths. Anchor the edit inside that callback's body — `currentRequestIdRef.current = requestId;` alone appears at `:878`, `:1077` and `:1663`, so an exact-match edit on it reports "not unique":

```ts
      const conversationId = ensureConversationId(currentConversationIdRef);
```

then at `:1748`:

```ts
              await saveCurrentConversation(prompt, fullResponse, [
                attachedFile,
              ], conversationId);
```

- [ ] **Step 5b: Add the three remaining required duplicate cases**

The spec marks four cases "all required"; Step 2b writes one. Add the rest to the same suite, each with the `mockReturnValueOnce` id regime and the provider gate:

```ts
it("pins the meeting-context mint site to the established id", async () => {
  // NOT a red-then-green test, and the plan should not pretend otherwise:
  // submitWithMeetingContext lists state.currentConversationId in its own deps
  // (:1253), so it re-forms on every id change and its closure is never stale.
  // It also never calls saveCurrentConversation - it has its own inline save at
  // :1218. So it cannot reproduce either defect (a) or (b). This pins the :1080
  // substitution from Task 2 against regression; expect it green from the start.
  vi.mocked(generateConversationId).mockReturnValueOnce("chat-a").mockReturnValueOnce("chat-b");
  enableProviderGate();
  mockStreamedResponse("ok");
  const { result } = renderHook(() => useCompletion(), { wrapper: strictModeWrapper });

  await act(async () => {
    result.current.addMeetingTranscript("Opening", undefined, "microphone");
  });
  await act(async () => {
    await result.current.submitWithMeetingContext("summarise");
  });

  expect(result.current.currentConversationId).toBe("chat-a");
});

it("mints a fresh id after the conversation is reset", async () => {
  // The guard against a ??= regression pinning the app to one conversation.
  vi.mocked(generateConversationId).mockReturnValueOnce("chat-a").mockReturnValueOnce("chat-b");
  const { result } = renderHook(() => useCompletion(), { wrapper: strictModeWrapper });

  await act(async () => {
    result.current.addMeetingTranscript("First meeting", undefined, "microphone");
  });
  expect(result.current.currentConversationId).toBe("chat-a");

  await act(async () => {
    await result.current.startNewConversation();
  });
  await act(async () => {
    result.current.addMeetingTranscript("Second meeting", undefined, "microphone");
  });

  expect(result.current.currentConversationId).toBe("chat-b");
});

it("keeps state.currentConversationId populated after a chat-only turn", async () => {
  // The setState mirror at :882/:1080. If it stops firing, every enqueue falls to
  // useMeetingLog's getActiveConversationId() recovery and writes the
  // conversation_id IS NULL rows the merged page then has to render.
  //
  // Deliberately NO mockStreamedResponse: beforeEach installs an empty generator,
  // so fullResponse is empty, the save block at :1000 is skipped, and
  // saveCurrentConversation never runs. That leaves the :882 mirror as the ONLY
  // writer of state.currentConversationId - so deleting the mirror fails this
  // test. With a streamed response, :1495 would set it and the test would pass
  // with the mirror gone.
  enableProviderGate();
  const { result } = renderHook(() => useCompletion(), { wrapper: strictModeWrapper });

  await act(async () => {
    await result.current.submit("hello");
  });

  expect(result.current.currentConversationId).toBe("conversation-1");
});

it("mints a fresh id after the delete fallback resets the conversation", async () => {
  // The other reset path (:1570-1583): the conversationDeleted listener clears
  // the refs and calls startNewConversation. Its detail is a BARE ID STRING,
  // not { id } - see useHistory.ts:167-171.
  vi.mocked(generateConversationId).mockReturnValueOnce("chat-a").mockReturnValueOnce("chat-b");
  const { result } = renderHook(() => useCompletion(), { wrapper: strictModeWrapper });

  await act(async () => {
    result.current.addMeetingTranscript("First meeting", undefined, "microphone");
  });
  expect(result.current.currentConversationId).toBe("chat-a");

  await act(async () => {
    window.dispatchEvent(new CustomEvent("conversationDeleted", { detail: "chat-a" }));
  });
  await act(async () => {
    result.current.addMeetingTranscript("After the delete", undefined, "microphone");
  });

  expect(result.current.currentConversationId).toBe("chat-b");
});
```

- [ ] **Step 5c: The system-audio negative test**

`useSystemAudio` is deliberately excluded from this fix, and this test is what keeps it excluded. Create `src/tests/useSystemAudio.new-conversation.test.tsx`.

**It needs a mock header — the hook does not mount bare.** `useSystemAudio()` calls `useApp()` at `:106`, which throws `"useApp must be used within a AppProvider"` (`app.context.tsx:806-808`), plus `useWindowResize`/`useGlobalShortcuts` from `@/hooks` and a Tauri `listen(...)` in a mount effect at `:207`:

```tsx
vi.mock("@/contexts", () => ({
  useApp: () => ({
    selectedSttProvider: null,
    allSttProviders: [],
    selectedAIProvider: { provider: null },
    allAiProviders: [],
    systemPrompt: "",
    selectedAudioDevices: {},
    sttLanguage: "en",
  }),
}));
vi.mock("@/hooks", () => ({
  useWindowResize: () => ({ resizeWindow: vi.fn() }),
  useGlobalShortcuts: () => ({}),
}));
vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn().mockResolvedValue(true) }));
vi.mock("@tauri-apps/api/event", () => ({ listen: vi.fn().mockResolvedValue(vi.fn()) }));
```

**Leave `@/lib` unmocked**, as `meeting-log-page.test.tsx:72-77` deliberately does. This test asserts two ids *differ*, and the meeting-assist suite's constant-`"conversation-1"` mock would make that impossible; the real `generateConversationId` supplies distinct ids, which is exactly what is under test.

```tsx
it("mints a distinct id for each new conversation", async () => {
  const { result } = renderHook(() => useSystemAudio());

  await act(async () => { result.current.startNewConversation(); });
  const first = result.current.conversation.id;

  await act(async () => { result.current.startNewConversation(); });
  const second = result.current.conversation.id;

  expect(second).not.toBe(first);
});
```

Drive `startNewConversation` (`useSystemAudio.ts:875`), **not** `startCapture` — the latter opens with `invoke("check_system_audio_access")` and needs Tauri and media mocks for a hook this change does not touch. `.tsx` because it mounts a hook, matching the house convention.

- [ ] **Step 6: Run the test and the suite**

```bash
npx vitest run src/tests/useCompletion.meeting-assist.test.tsx src/tests/useSystemAudio.new-conversation.test.tsx
```

Expected: PASS, including all four new cases.

- [ ] **Step 7: Typecheck**

```bash
npm run type-check
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
      speakerLabelFor({ speaker: { speakerId: "diarization_A", speakerLabel: "Sarah Chen" }, audioSource: "system" })
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

In `src/hooks/useCompletion.ts`, delete the local `labelFor` at `:1045-1052`. Import the helper **by leaf path**, not via `@/lib`:

```ts
import { speakerLabelFor } from "@/lib/functions/speaker-label.function";
```

The leaf path matters: the meeting-assist suite mocks the whole `@/lib` barrel with a fixed factory, so a barrel import would be `undefined` there. The file already sets this precedent at `:32-38` with `@/lib/functions/meeting-summarizer` and `@/lib/functions/conversation-title`.

Then replace **every** `labelFor(` call site — there are four, at `:1057`, `:1067`, and twice at `:1070`:

```bash
grep -n "labelFor(" src/hooks/useCompletion.ts
```

- [ ] **Step 6: Run the affected suites**

```bash
npx vitest run src/tests/odoo-meeting-log-push.test.ts src/tests/odoo-meeting-log-render.test.ts src/tests/meeting-log-summary.test.ts src/tests/useCompletion.meeting-assist.test.tsx src/tests/speaker-label.function.test.ts
```

Expected: PASS. `odoo-meeting-log-render.test.ts` is the direct suite for `renderTranscript` / `buildNoteBody` — the behaviour the extraction must not change — and is the one most likely to catch a mistake here.

- [ ] **Step 7: Typecheck and lint**

```bash
npm run type-check
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
- Modify: `src/hooks/useHistory.ts:208-231` (the `// Helper functions` comment through the generator; leave `generateFilename` at `:233`), `:120`
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
        { id: "m3", role: "user", content: "Only upstream", timestamp: 3, audioSource: "system", speaker: { speakerId: "diarization_A", speakerLabel: "Sarah Chen" } },
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
  const { result } = renderHook(() => useCompletion(), { wrapper: strictModeWrapper });

  await act(async () => {
    result.current.addMeetingTranscriptEntries([
      { original: "Guest line", timestamp: 1, audioSource: "system", speaker: { speakerId: "diarization_A", speakerLabel: "Sarah Chen" } },
      { original: "My line", timestamp: 2, audioSource: "microphone" },
    ]);
  });

  const history = result.current.conversationHistory;
  expect(history.at(-2)).toMatchObject({ audioSource: "system", speaker: { speakerId: "diarization_A", speakerLabel: "Sarah Chen" } });
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
npm run type-check
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

- [ ] **Step 2: Create the SQL file FIRST, then run the test**

Order matters here. `include_str!` on a missing file is a **compile error** that kills the whole `db::migration_tests` module — so running the test before the file exists cannot distinguish "file missing" from "wrong version", and the new assertions never execute. Write the `.sql` file (Step 3), then run:

```bash
cd src-tauri && cargo test --lib db::migration_tests
```

Expected: FAIL on a real assertion — `title source migration must be registered` — because the file exists but `migrations()` has no entry for it. That is the red phase this test is for.

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
- Modify: `src/lib/database/chat-history.action.ts:377-384, 485-492, 571-574` (and the doc comment at `:552-553`)
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

// chat-history.action.ts:3 imports safeLocalStorage from "@/lib". Without this
// stub, importing the action pulls the whole flat barrel - ./functions,
// ./database, ./odoo and the Tauri plugin modules - into the test graph. Every
// sibling suite (update-title, append-silent, speaker, create-rollback,
// title-adoption) carries the same block for the same reason.
vi.mock("@/lib", () => ({
  safeLocalStorage: {
    getItem: vi.fn(() => null),
    setItem: vi.fn(),
    removeItem: vi.fn(),
  },
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

- [ ] **Step 4b: Write the failing tests for the other two guarded writers**

Step 5 and Step 6 must not be implemented untested. Add to the same file:

```ts
describe("updateConversation title guard", () => {
  it("splits the header write the same way", async () => {
    const { updateConversation } = await import("@/lib/database/chat-history.action");
    await updateConversation({
      id: "conversation-1",
      title: "Save Title",
      messages: [],
      createdAt: 1,
      updatedAt: 1234,
    });

    expect(sqlOf(stampWrites()[0])).toBe(
      "UPDATE conversations SET updated_at = ? WHERE id = ?"
    );
    expect(sqlOf(titleWrites()[0])).toBe(
      "UPDATE conversations SET title = ? WHERE id = ? AND title_source = 'auto'"
    );
    expect(sqlOf(titleWrites()[0])).not.toContain("updated_at");
  });

  it("still raises when the conversation is gone", async () => {
    const { updateConversation } = await import("@/lib/database/chat-history.action");
    mockExecute.mockResolvedValueOnce({ rowsAffected: 0 });
    await expect(
      updateConversation({ id: "missing", title: "T", messages: [], createdAt: 1, updatedAt: 1 })
    ).rejects.toThrow("Conversation not found");
  });
});

describe("applySummaryTitleToConversation", () => {
  it("returns false without throwing when the guard matches no row", async () => {
    // CHARACTERISATION, not red-then-green: it already delegates to
    // updateConversationTitle (:602-623) and already returns false on zero rows.
    // Expect it green from the start. The load-bearing half is the SQL
    // assertion below - that the delegation now carries the guard clause.
    const { applySummaryTitleToConversation } = await import("@/lib/database/chat-history.action");
    mockExecute.mockResolvedValueOnce({ rowsAffected: 0 });
    await expect(
      applySummaryTitleToConversation("conversation-1", "Summary Title")
    ).resolves.toBe(false);
    expect(sqlOf(titleWrites()[0])).toContain("title_source = 'auto'");
  });
});
```

Run them and watch them fail before implementing:

```bash
npx vitest run src/tests/chat-history.rename-guard.test.ts
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

Update **two** doc comments. First `:552-553`, which is now incomplete:

```ts
 * Returns false when no row matched — the conversation was deleted while the
 * title was being generated, OR the user has renamed it by hand
 * (title_source = 'manual'). Both mean "do not report a rename".
```

Then `applySummaryTitleToConversation`'s comment at `:595-597`, which now asserts the opposite of what is true:

> That is safe because every title in the system is machine-generated: the only
> writer besides conversation creation is the AI titler. If a manual rename is
> ever added, this needs a provenance check so it can't overwrite one.

The manual rename now exists, and the provenance check is the `AND title_source = 'auto'` clause this function inherits by delegating to `updateConversationTitle`. Rewrite it to record that the change landed, rather than leaving it predicting a change that already happened.

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
  // No enableProviderGate/mockStreamedResponse: submit is never called here, and
  // enableProviderGate mutates a mock the beforeEach comment (:129-135) keeps clean.
  const { result } = renderHook(() => useCompletion(), { wrapper: strictModeWrapper });

  // The meta cache is only populated by a successful save, so do one first.
  await act(async () => {
    result.current.setMeetingAssistMode(true);
    result.current.addMeetingTranscript("Opening", undefined, "microphone");
  });
  await act(async () => {
    await result.current.flushUnsavedMeetingTranscript();
  });
  const id = result.current.currentConversationId!;

  await act(async () => {
    window.dispatchEvent(
      new StorageEvent("storage", {
        key: CONVERSATION_RENAMED_KEY,
        newValue: JSON.stringify({ id, title: "Renamed by hand", timestamp: Date.now() }),
      })
    );
  });

  // The next append must carry the new title, not the cached old one.
  await act(async () => {
    result.current.addMeetingTranscript("Another line", undefined, "microphone");
  });
  await act(async () => {
    await result.current.flushUnsavedMeetingTranscript();
  });

  // appendMessagesToConversation(conversationId, title, updatedAt, newMessages)
  // is positional - the title is [1], not a `.title` property.
  const lastAppend = vi.mocked(appendMessagesToConversation).mock.calls.at(-1);
  expect(lastAppend?.[1]).toBe("Renamed by hand");
});

it("ignores a rename for a different conversation", async () => {
  // A rename of conversation B must not disturb the overlay's cache for A.
  // Nulling it here would send the next autosave into the re-read branch, where
  // getConversationById cannot distinguish a failed read from a missing row.
  const { result } = renderHook(() => useCompletion(), { wrapper: strictModeWrapper });

  await act(async () => {
    result.current.setMeetingAssistMode(true);
    result.current.addMeetingTranscript("Opening", undefined, "microphone");
  });
  await act(async () => {
    await result.current.flushUnsavedMeetingTranscript();
  });
  const originalTitle = vi.mocked(saveConversation).mock.calls.at(-1)?.[0].title;

  await act(async () => {
    window.dispatchEvent(
      new StorageEvent("storage", {
        key: CONVERSATION_RENAMED_KEY,
        newValue: JSON.stringify({ id: "some-other-conversation", title: "Not mine", timestamp: Date.now() }),
      })
    );
  });

  await act(async () => {
    result.current.addMeetingTranscript("Another line", undefined, "microphone");
  });
  await act(async () => {
    await result.current.flushUnsavedMeetingTranscript();
  });

  const lastAppend = vi.mocked(appendMessagesToConversation).mock.calls.at(-1);
  expect(lastAppend?.[1]).toBe(originalTitle);
});
```

**Spec reconciliation.** The spec's testing table says "a mismatched id invalidates instead". That was wrong and this plan deliberately departs from it: invalidation on a mismatch is the bug described in the handler comment above. The behaviour here — mismatch is a no-op, mirroring the shipped in-window handler at `:261-264` — is correct, and the test above pins it. Update the spec's row when this lands so the two agree.

Import `CONVERSATION_RENAMED_KEY` from `@/lib/chat-constants` at the top of the file — that module is **not** mocked in this suite, so the test and the hook must both resolve the real constant. (The hook imports it by leaf path for the same reason; see Step 4.)

**Do not reach for fake timers.** The autosave is not time-driven: `MEETING_TRANSCRIPT_AUTOSAVE_INTERVAL = 4` is a *segment count* (`config/constants.ts:133`), and the effect fires on `meetingTranscript.length >= lastSaved + 4` (`useCompletion.ts:458-469`), gated on `meetingAssistMode`. This suite installs no fake timers, so `vi.advanceTimersByTimeAsync` would throw. Driving `flushUnsavedMeetingTranscript` directly is both correct and deterministic.

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
      // A rename for a DIFFERENT conversation is a no-op, mirroring the shipped
      // in-window handler at :261-264. Nulling the cache here would be a bug:
      // renaming conversation B in the dashboard while the overlay is mid-meeting
      // on A would drop A's entry, sending the next autosave into the re-read
      // branch - and getConversationById returns null on a FAILED read as well as
      // a missing row (chat-history.action.ts:345-351), so a transient error
      // invents a "Meeting transcript - <date>" title with hasStoredTitle false,
      // the one state that hands the conversation to the AI titler.
      if (!cached || cached.id !== id) return;
      conversationMetaCacheRef.current = { ...cached, title };
    };

    window.addEventListener("storage", handleRenamedElsewhere);
    return () => window.removeEventListener("storage", handleRenamedElsewhere);
  }, []);
```

Import it by leaf path — `import { CONVERSATION_RENAMED_KEY } from "@/lib/chat-constants";` — **not** from `@/lib`. The meeting-assist suite replaces the whole barrel with a fixed factory, so a barrel import is `undefined` there and the listener's key comparison short-circuits on every event. The test imports the same real constant from the same leaf path, so neither side restates the string.

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
- Produces: `useMeetingLogQueue()` returning everything the page's JSX reads. The full surface, enumerated so nothing is stranded:
  - **State:** `rows`, `rendered`, `grouped`, `configState`, `stranded`, `loadError`, `busy` (a `Set<string>` at `:329` — there is no `busyId`), `contacts`, `results`, `notices`, `transcript`, `pinned`, `instance`, `now`, `hasClaim`, `inlineIds`.
  - **Dialog state:** `assignRow` and `setAssignRow` move **into** the hook, alongside the three handlers that drive them (`handleAssign` calls `setAssignRow`; `handleAssignConfirm` depends on `runRowAction`). The page renders `<AssignDialog>` from the returned `assignRow`. An earlier draft said dialog state "stays in the page" while moving its handlers — both cannot hold.
  - **`providerConfigRef`**, which the page JSX passes to `<ProviderConfigReader configRef={providerConfigRef} />` at `:900` and `handleRetry:603` reads. If the ref moves into the hook it must be returned, or the leaf writes a ref nobody reads.
  - **Handlers**, with their existing dep arrays unchanged: `setResult`, `refineResult`, `runRowAction`, `handleRetry`, `handleDelete`, `handleAssign`, `handleAssignConfirm`, `handleAssignCancel`, `runTargetAction`, `handleRetryTarget`, `handleRemoveTarget`, `readTranscript`, `toggleTranscript`, `reload`.
  - **Not returned:** `capped` (`:801`) is a local inside `rendered`'s memo that the page never reads. `isEmpty` (`:888`) is just `rendered.length === 0` — re-derive it page-side.
  - **Moves hook-side with its callers** (not render-only, despite living near the copy maps): `FAILURE_COPY` (`:99`), `describeFailure` (`:111`) and `outcomeCopy` (`:164`). `runRowAction:567` and `runTargetAction:722` call `describeFailure` directly and `setResult:559` calls `outcomeCopy`, so leaving them in the page module makes the hook reference undefined identifiers.
  - **Stays page-side** (genuinely render-only): `GROUPS` (`:75-82`), `REMAINDER_LINE` (`:73`), `plural` (`:221`, used by the JSX at `:949`), and the JSX itself. `PAGE_CAP` (`:60`) is read by the page JSX at `:992` *and* by `rendered`'s memo at `:801` — export it from the hook module, or return `hasMore: rows.length > PAGE_CAP` and keep the constant hook-side. The `STALE_TICK_MS` `now` tick (`:836`) goes hook-side, since `hasClaim` derives from it.

- [ ] **Step 1: Read the page and inventory what moves**

```bash
awk 'NR>=380 && NR<=480 {printf "%4d|%s\n", NR, $0}' src/pages/meeting-log/index.tsx
```

Everything from the `loadToken` ref, the `reload` callback, the focus listener effect and the write-only mirror refs down to the action handlers moves into the hook. What stays in the page: JSX, `GROUPS`, `FAILURE_COPY` (a render concern), and the dialog state.

- [ ] **Step 2: Move the logic verbatim — do NOT add memoisation**

**Correction to an earlier draft of this plan, which claimed the page "defines them inline". It does not.** All thirteen handlers are already `useCallback`-wrapped with deliberately minimal dep arrays that read live state through the write-only mirror refs: `setResult:500 []`, `refineResult:519 []`, `runRowAction:529`, `handleRetry:593`, `handleDelete:615`, `handleAssign:648 []`, `handleAssignConfirm:663 [runRowAction]`, `handleAssignCancel:683 []`, `runTargetAction:700`, `handleRetryTarget:742`, `handleRemoveTarget:749`, `readTranscript:756`, `toggleTranscript:780`. `rendered:800`, `hasClaim:827`, `grouped:840`, `inlineIds:866` and `notices:880` are already `useMemo`'d.

**Move each block byte-for-byte with its existing dep array. Add no new memoisation and re-derive no dep array** — inventing deps is exactly how a stale-closure regression enters, and the Step 4 gate would not reliably catch a wrong one.

Two things must survive unchanged and are easy to "tidy" by accident:

- The **dep-array-less `useLayoutEffect` at `:468-474`** that syncs the mirror refs. It must run after *every* render, and it must stay `useLayoutEffect`.
- The **`[]`-deped focus effect at `:476-492`** with its `cancelled` flag and its `getCurrentWebviewWindow().onFocusChanged` — not `useWindowFocus`, per the comment at `:479-482`, whose lossy async gap leaks the first StrictMode mount's listener.

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

Move the code without behavioural edits. Do **not** wrap the returned object in a `useMemo` either — that would mean inventing a ~30-entry dep array, which is the same hazard as re-deriving a handler's deps.

- [ ] **Step 3: Consume it from the existing page, unchanged**

`src/pages/meeting-log/index.tsx` now calls `useMeetingLogQueue()` at its top level and renders exactly as before. This is the step that proves the lift in isolation, before the merge changes anything visible.

**Import it by leaf path**, not from the barrel:

```ts
import { useMeetingLogQueue } from "@/hooks/useMeetingLogQueue";
```

`src/hooks/index.ts` star-exports `useCompletion`, `useSystemAudio`, `useMeetingAudio` and more; the page imports nothing from `@/hooks` today, and `meeting-log-page.test.tsx:72-77` deliberately does not mock `@/lib`. A barrel import drags that whole graph into the suite and fails the acceptance gate for a reason that has nothing to do with the lift. Add the barrel entry for later consumers, but do not use it here.

- [ ] **Step 4: Run the page suite — this is the acceptance gate**

```bash
npx vitest run src/tests/meeting-log-page.test.tsx
```

Expected: **PASS with no edit to any assertion and no edit to any mock.** At this point the page renders identically, so a failure means the lift was not verbatim. Fix the lift, not the test.

This is the **only** point in the plan where that absolute framing is true. Task 12 retargets the same suite at a genuinely different component, where mock additions and some assertion changes are expected — see Task 12 Step 5b.

- [ ] **Step 4b: Typecheck**

```bash
npm run type-check && npm run lint
```

Vitest transforms with esbuild and does no type checking, so a stranded identifier (a copy helper left page-side while its caller moved) would otherwise surface at Step 4 as a runtime `ReferenceError` — which the instruction above would send you to debug as a bad lift. Typecheck first; it names the real cause.

- [ ] **Step 5: Commit**

```bash
git add src/hooks/useMeetingLogQueue.ts src/hooks/index.ts src/pages/meeting-log/index.tsx
git commit -m "refactor(meeting-log): lift the queue logic into useMeetingLogQueue

No behaviour change - the page renders identically and its suite passes with no
assertion or mock edited, which is what proves the lift was verbatim. Every
handler keeps the useCallback and dep array it already had; none were
re-derived."
```

---

### Task 11: The badge query

`listActionableRows` deliberately excludes `sent`, `cancelled` and `deleted`, so it cannot drive a "sent" badge. One new statement, resolved into a map.

**Files:**
- Modify: `src/lib/database/meeting-log.action.ts`
- Modify: `src/hooks/useMeetingLogQueue.ts`
- Test: `src/tests/meetings-page.badges.test.ts` (create)

**Interfaces:**
- Produces: `listConversationBadgeRows(): Promise<Array<{ conversationId: string; status: MeetingLogStatus; instance: string }>>` and a pure `resolveBadge(rows, currentInstance)` returning `{ status, count } | null`.

- [ ] **Step 1: Write the failing tests**

Create `src/tests/meetings-page.badges.test.ts` (`.ts`, not `.tsx` — it tests a pure function, matching `odoo-meeting-log-groups.test.ts`) covering the four resolution rules as separate cases:

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
npx vitest run src/tests/meetings-page.badges.test.ts
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

- [ ] **Step 3b: Write the exported wrapper — the query string alone is not callable**

`QUEUE_SQL` holds SQL text; every caller goes through an exported async function. Add one beside `listActionableRows` (`meeting-log.action.ts:1014`), doing the snake_case → camelCase mapping its siblings all do:

```ts
/**
 * Every queue row that names a conversation, for the meetings page's badges.
 *
 * Deliberately NOT listActionableRows: that one is scoped to the actionable
 * statuses and so can never report 'sent', which is most of what a badge says.
 * No instance filter, matching listActionable - classification is the caller's
 * job via resolveBadge.
 */
export async function listConversationBadgeRows(): Promise<
  Array<{ conversationId: string; status: MeetingLogStatus; instance: string }>
> {
  const db = await getDatabase();
  const rows = await db.select<Record<string, unknown>[]>(
    QUEUE_SQL.listConversationBadges
  );
  return rows.map((r) => ({
    conversationId: r.conversation_id as string,
    status: r.status as MeetingLogStatus,
    instance: r.instance as string,
  }));
}
```

The name must match everywhere it is referenced: `listConversationBadgeRows` for the function, `QUEUE_SQL.listConversationBadges` for the SQL.

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
npx vitest run src/tests/meetings-page.badges.test.ts src/tests/meeting-log-page.test.tsx
npm run type-check
```

The page suite needs the new function added to its hoisted `db` factory with a `beforeEach` `mockResolvedValue([])` default — otherwise it is `undefined` inside the wholesale `vi.mock("@/lib/database/meeting-log.action")` and `reload` throws. **Adding to the factory is a required amendment, not a stop signal**; rewriting an existing mock's behaviour is.

- [ ] **Step 7: Commit**

```bash
git add src/lib/database/meeting-log.action.ts src/lib/odoo/meeting-log.ts src/hooks/useMeetingLogQueue.ts src/tests/meetings-page.badges.test.ts src/tests/meeting-log-page.test.tsx
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

Create `src/tests/meetings-page.test.tsx`. **Author the tests before any implementation** — the titles below are the required cases, and each needs its assertions written out against the rendered DOM.

Mocks this file needs (model them on `meeting-log-page.test.tsx:10-77`, which mocks leaf modules and deliberately never mocks `@/lib`):

- `@/lib/database/meeting-log.action` — the queue reads, including `listConversationBadgeRows` from Task 11
- `@/lib/database/chat-history.action` — `getAllConversations`, which `useHistory` calls
- `@/lib/odoo/meeting-log-actions`, `@/lib/database/odoo-contacts.action`, `@/lib/storage/odoo-config.storage` — as the queue-page suite does
- `@tauri-apps/api/webviewWindow` — the focus listener

Required cases:

```ts
it("renders the conversation list with no strip and no badges when Odoo is unconfigured", …);
// configState !== "complete": assert the conversation titles ARE in the DOM and
// no QueueRow / badge is.

it("still reports the stranded count on a half-filled config", …);
// countActionableQueued() returns > 0 with an incomplete config: assert the count
// is rendered.

it("keeps the conversation list rendered when the queue read fails", …);
// Reject the queue read: assert loadError renders AND the conversation titles
// are still present. This is the isolation the spec requires.

it("filters the date-grouped list but never the strip", …);
// Type a search matching one conversation: assert the other conversation is gone
// and every strip row is still present.

it("renders a conversation_id IS NULL row in the strip with no link", …);
// A queue row with conversation_id null: assert it renders and has no <a>/Link
// to a conversation.
```

- [ ] **Step 2: Run and watch fail**

```bash
npx vitest run src/tests/meetings-page.test.tsx
```

- [ ] **Step 3: Build the page**

`src/pages/meetings/index.tsx` calls `useMeetingLogQueue()` **unconditionally at the top level** and renders `<ProviderConfigReader>` outside any conditional — the focus listener's `[]` effect and the mirror refs depend on mounting exactly once, and a conditional mount re-registers the Tauri listener across its lossy async `listen()` gap.

Layout: the action strip (rendered only when non-empty) above the always-rendered date-grouped list. Carry the date grouping over from `pages/chats/index.tsx:12-27` and the search from `:54-63`.

Error isolation is structural, not new error handling: `loadError` renders **above the strip only**, and the list is `useHistory`-owned state that `reload` never touches. `useHistory` is not modified.

- [ ] **Step 4: Move ALL the components, not just `View.tsx`**

`src/pages/chats/components/` holds **seven** files, not one:

```
AudioRecorder.tsx  ChatAudio.tsx  ChatFiles.tsx  ChatScreenshot.tsx
DeleteConfirmation.tsx  View.tsx  index.ts
```

`View.tsx:30-36` imports `{ DeleteConfirmationDialog, ChatAudio, ChatScreenshot, ChatFiles, AudioRecorder } from "."` — its sibling barrel. Moving `View.tsx` alone breaks that import, and the five siblings become orphans once `chats/index.tsx` goes (nothing else in `src/` imports them).

`git mv` all seven, plus the four from `pages/meeting-log/components/`, so history follows each file. Two `index.ts` barrels cannot both land in one directory — write a single merged `src/pages/meetings/components/index.ts` by hand from the two.

`View.tsx` keeps the barrel name `ViewChat` so `routes/index.tsx` and the `useChatCompletion` wiring do not churn. `QueueRow` keeps its `meetingDateOf` / `targetNameOf` / `TranscriptView` exports, which the page imports (note the `targetNameOf as targetNameOfSingle` alias).

- [ ] **Step 5: Update the barrel and the routes together**

**These cannot be split across commits.** Removing `Chats`/`MeetingLog` from `src/pages/index.ts` while `routes/index.tsx:12,19,30,44` still imports and mounts them leaves a repo that does not build — and the Step 6 typecheck would fail inside this task. **Task 12 owns all of it**; Task 13 owns links, menu and memoisation only.

First create `src/routes/ChatViewRedirect.tsx`. It needs its own module because `Navigate`'s `to` is a static string and cannot re-interpolate the param — and because defined inside `routes/index.tsx` it would be unimportable by its test, since that file's top-level `import {...} from "@/pages"` eagerly loads every page:

```tsx
import { Navigate, useLocation, useParams } from "react-router-dom";

export function ChatViewRedirect() {
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

Then, in `src/routes/index.tsx`, swap `Chats` and `MeetingLog` for `Meetings` in the `@/pages` import, add `import { ChatViewRedirect } from "./ChatViewRedirect";`, and replace the two old routes with:

```tsx
          <Route path="/meetings" element={<Meetings />} />
          <Route path="/meetings/view/:conversationId" element={<ViewChat />} />
          {/* Redirect old routes for backward compatibility */}
          <Route path="/chats" element={<Navigate to="/meetings" replace />} />
          <Route path="/meeting-log" element={<Navigate to="/meetings" replace />} />
          <Route path="/chats/view/:conversationId" element={<ChatViewRedirect />} />
```

`/dev-space` at `:46` is the house pattern the two static redirects copy.

Then:

- `src/pages/index.ts`: add `Meetings`, remove `Chats` and `MeetingLog`, repoint `ViewChat` at `./meetings/components/View`.
- Delete `src/pages/chats/` and `src/pages/meeting-log/` entirely (`git rm -r`), now that nothing imports them.

- [ ] **Step 5b: Retarget the queue-page suite — assertions WILL change here**

`src/tests/meeting-log-page.test.tsx:110-111` imports `MeetingLog from "@/pages/meeting-log"` and `{ AssignDialog, QueueRow } from "@/pages/meeting-log/components"` — both just moved. `tsconfig.json` excludes `src/tests/**`, so `type-check` will **not** catch this; only running the suite will.

**This is not the Task 10 gate, and the "no assertion, no mock edited" rule does not apply here.** Task 10 pointed the suite at the same component at a new path; this points it at a *different* component. Expected and allowed:

- **A new mock is required.** The unified page mounts `useHistory`, which calls `getAllConversations` from `@/lib` in an effect. This suite deliberately mocks neither `@/lib` nor `@/lib/database/chat-history.action` (`:72-77`), so add a leaf mock for `@/lib/database/chat-history.action` with `getAllConversations` → `mockResolvedValue([])`. Without it the call reaches `@tauri-apps/plugin-sql` under jsdom.
- **The placement assertions change**, exactly as enumerated in Task 10's acceptance criterion: assertions that a `held`/`pending`/`sending` row appears in a queue group, and the other-database group's full-row rendering. Known concrete sites: `:339`, `:993`, `:1294` (`"No meetings waiting to be logged."`) and `:1198` (`"Finish setting Odoo up on the"`), all gated on `configState === "complete"`, which is where the merged page's behaviour differs — the list is always rendered, the strip only when non-empty.
- **Still frozen:** token ordering, focus-listener registration, action outcomes, `FAILURE_COPY` strings, and the `LIMIT 201` / `PAGE_CAP` / `REMAINDER_LINE` paging. An edit to any of those is still the stop-and-re-scope signal.

- [ ] **Step 6: Run and typecheck**

```bash
npx vitest run src/tests/meetings-page.test.tsx src/tests/meeting-log-page.test.tsx
npm run type-check
```

Expected: PASS, and the repo builds. If `type-check` reports an unused import, prune it — `noUnusedLocals: true`.

- [ ] **Step 7: Commit**

```bash
git add -A
git commit -m "feat(meetings): one page for conversations and the Odoo queue

The queue hook is called unconditionally at the page top level and the strip
renders from its state - calling it from inside the conditionally-rendered
strip would re-register the Tauri focus listener on every mount.

Barrel, routes and page deletions land together: splitting them would leave a
commit that does not build."
```

---

### Task 13: Links, menu, and the memoisation

Routes, the `ChatViewRedirect` module, the pages barrel and the page deletions all landed in **Task 12** — they could not be split from the moves without leaving a non-building commit. This task covers what is left.

**Files:**
- Modify: `src/hooks/useMenuItems.tsx:64-75`, `src/pages/context-memory/components/SummaryDetail.tsx:259`, `src/pages/odoo/index.tsx:559`, `src/pages/meetings/index.tsx` (memoisation)
- Test: `src/tests/routes.redirects.test.tsx` (create), `src/tests/meeting-log-entry-points.test.tsx`

**Interfaces:**
- Consumes: the `Meetings` page and `ChatViewRedirect` from Task 12.

- [ ] **Step 1: Cover the redirect wrapper with a regression test**

`ChatViewRedirect` already exists (Task 12 Step 5), so this is a regression test, not a red-then-green cycle — it should pass on the first run. If it fails, the wrapper is wrong and that is the finding.

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

- [ ] **Step 2: Move the four hardcoded links and collapse the menu**

`SummaryDetail.tsx:259` and `pages/odoo/index.tsx:559` point at `/meetings`. In `useMenuItems.tsx:64-75`, the "Meeting log" and "Chats" entries collapse into one:

```tsx
    {
      icon: MessagesSquare,
      label: "Meetings",
      href: "/meetings",
      disabled: gateOnSetup,
    },
```

Remove `ClipboardListIcon` from the lucide import at `useMenuItems.tsx:20` — it was the retired "Meeting log" entry's icon and is now unused. `noUnusedLocals: true` makes that a hard `type-check` failure (TS6133), not a warning.

- [ ] **Step 3: Apply the memoisation**

`useMemo` the group + sort + filter into **one memo owned by the list child**, and split the strip and list into separate `React.memo` children.

**Pass primitives across the memo boundary, not objects.** Each row receives `badgeStatus: string | null` and `badgeCount: number` — never the badge object and never the `Map`. `resolveBadge` allocates a fresh `{ status, count }` per call and the map is rebuilt on every `reload` (each focus refresh, each action re-read), so an object prop gives every row a new identity even when its badge is unchanged, and `React.memo`'s shallow compare fails list-wide — the exact cost this step exists to avoid. The in-repo precedent is explicit: `QueueRow.tsx:441,482` needed a custom `propsAreEqual` because "every refresh hands [new identities]".

**Enumerate the list child's props and check each one is stable.** `useHistory` returns a fresh object literal every render, and its handlers are **not** `useCallback`-wrapped — `handleViewConversation:105`, `handleDownloadConversation:109`, `handleDeleteConfirm:153`, `confirmDelete:157`, `handleDownload:195` are all recreated per render. Passing any of them, or the `useHistory` object itself, defeats the boundary. The spec says `useHistory` is not modified, so wrap each handler the rows need in a page-level `useCallback` before it crosses.

**Exclude the row being renamed from the filter.** The one memo owns the filter, and the chats filter (`pages/chats/index.tsx:54-63`) drops a whole date group when no title in it matches — so renaming while a search is active can unmount the open editor mid-edit. That is the same caret-loss failure Task 8's "don't touch `updated_at`" note guards against from the sort side.

Record in a comment that `getAllConversations` attaching every message is a known cost that memoisation does not address; a `COUNT(*)`-shaped list read is the real remedy and is out of scope.

- [ ] **Step 4: Run the affected suites**

```bash
npx vitest run src/tests/routes.redirects.test.tsx src/tests/meetings-page.test.tsx src/tests/summary-detail.conversation-link.test.tsx src/tests/meeting-log-entry-points.test.tsx src/tests/odoo-target-new-chat-entry-points.test.tsx
```

Expected: PASS. The link suites need their expected URLs updated. Add the menu-collapse assertion to `meeting-log-entry-points.test.tsx`, where entry points are already tested.

- [ ] **Step 5: Typecheck and lint**

The retired pages were already deleted in Task 12 Step 5; nothing to remove here.

```bash
npm run type-check
npm run lint
```

Expected: PASS. If `ClipboardListIcon` was left in the lucide import, this is where TS6133 surfaces.

- [ ] **Step 6: Commit**

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

**Where the header control mounts.** `View.tsx:89` passes the title through `PageLayout`'s `title` prop, which is typed `title: string` (`src/layouts/PageLayout.tsx:13`) — an inline editable control does not fit it. Mount the rename control in **`rightSlot`**, which already takes arbitrary JSX (`View.tsx:91`), rather than widening `PageLayout` and `Header` to `ReactNode`. If you prefer widening, add both files to this task's Files list first.

**Interfaces:**
- Consumes: `renameConversationManually` (Task 8), `CONVERSATION_RENAMED_KEY` (Task 9).

- [ ] **Step 1: Write the failing tests**

**Author these before implementing.** Required cases, each written out against the DOM:

```ts
it("reveals the editor on the pencil and commits on Enter", …);
// userEvent.hover the row, click the pencil, type, press Enter:
// expect(renameConversationManually).toHaveBeenCalledWith(id, "New name")

it("cancels on Escape without writing", …);
// expect(renameConversationManually).not.toHaveBeenCalled()

it("fires both channels on a successful commit", …);
// Spy window.dispatchEvent and localStorage.setItem.
// Assert a "conversation-title-updated" CustomEvent AND a setItem on
// CONVERSATION_RENAMED_KEY whose parsed payload is { id, title, timestamp }.

it("fires neither channel when the row no longer exists", …);
// renameConversationManually resolves false: assert no dispatch, no setItem.

it("uses a fresh timestamp for a repeated identical rename", …);
// Rename to the same title twice; parse both payloads and assert the
// timestamps differ. storage does not fire on a byte-identical write, so
// without the nonce the second rename never reaches the overlay.
```

- [ ] **Step 2: Run and watch fail**

- [ ] **Step 3: Implement the inline rename**

Pencil on hover → input → Enter commits, Escape cancels. On commit, call `renameConversationManually` and fire **both** channels **only when it resolves `true`**. It returns `Promise<boolean>`, and `false` means no row matched — the conversation was deleted between render and commit. Announcing a rename that did not happen would patch the overlay's cache with a title no row holds.

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
npm run type-check && npm run lint
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
