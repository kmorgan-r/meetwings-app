# First-Launch Auto-Record Prompt Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** On macOS and Windows, ask once at launch, with a card under the bar, whether to turn auto-record on. Ask only users who have never set the toggle.

**Architecture:** The Settings toggle's turn-on logic moves into one shared function. A new `"offer"` card kind in `meeting-cards.store.ts` renders in `MeetingCard.tsx`. A small offer module owns the show conditions, the answer and the log lines. A main-window hook triggers it once setup is complete.

**Tech Stack:** React 19, TypeScript, Tauri 2 (`invoke`/`emit`/`listen`), Vitest with Testing Library. Everything is frontend; there is no Rust change.

**Spec:** `docs/superpowers/specs/2026-11-28-auto-record-first-launch-prompt-design.md`

## Global Constraints

- Platforms: shown only where `isMeetingDetectionPlatform()` is true (macOS, Windows). Never on Linux.
- Shown only if `STORAGE_KEYS.MEETING_AUTO_RECORD_ENABLED` is absent AND the new `STORAGE_KEYS.MEETING_AUTO_RECORD_OFFER` (`"meeting_auto_record_offer"`) is absent.
- On macOS, also only if `invoke("list_capture_sessions", await currentWatchLists())` resolves.
- Copy (verbatim):
  - title: `Record your calls automatically?`
  - Mac body: `Meetwings can start recording when you join a Google Meet call in Chrome, and stop when you leave.`
  - Windows body: `Meetwings can start recording when you join a Teams or Google Meet call, and stop when you leave.`
  - footnote: `Let people know when you record.`
  - buttons: `Not now`, `Turn on`; on failure, `Not now`, `Open settings`.
- Log lines (verbatim prefixes): `offer shown`, `offer answer=on`, `offer answer=later`, `offer answer=settings`, `offer answer=failed:<StartFailureKind>`.
- Windows detection, the watcher and auto-record behaviour are unchanged. All existing suites must pass unmodified.
- Turn on must do exactly what the Settings toggle does. On a Mac that is `macToggleOnCheck()` and then save plus emit `meeting-detection-setting-changed {enabled:true}`.

## Review Focus

1. **Double-clicking Turn on**, or clicking it during the Mac prompts, must run only one permission flow. `acceptAutoRecordOffer` no-ops while the card is busy. Test in Task 3.
2. **An unexpected throw inside turn-on** must not leave the card stuck busy. It shows `OFFER_FAILED_MESSAGE` and logs `failed:start-error`. Test in Task 3.
3. **A bar that is hidden or minimized at launch** must still reveal the card (`reveal_overlay`). Test in Task 2.
4. **A double mount** (StrictMode) or a second true→false→true flip of `ready` must show and log the offer once per launch. Test in Task 5.
5. **Our own accept's `meeting-detection-setting-changed` event** must not overwrite answer `on` with `settings`. A Settings change made while no offer is showing must do nothing. Test in Task 3.

---

### Task 1: Shared turn-on, used by the Settings toggle

**Files:**
- Create: `src/lib/auto-record-setting.ts`
- Modify: `src/pages/settings/components/MeetingAutoRecordToggle.tsx:164-199` (`saveAndAnnounce`, `handleSwitchChange`)
- Test: `src/tests/auto-record-setting.test.ts`

**Interfaces:**
- Produces:
  - `announceAutoRecordSetting(enabled: boolean): Promise<void>`: sets `MEETING_AUTO_RECORD_ENABLED` to `String(enabled)`, then emits `meeting-detection-setting-changed {enabled}`. A rejected emit is caught and logged with `console.error`, never thrown.
  - `turnOnAutoRecord(): Promise<StartFailure | null>`: on macOS it calls `clearStartFailure()` and then `macToggleOnCheck()`. A failure is written with `writeStartFailure` and returned, and nothing is saved or emitted. Otherwise, and on Windows, it calls `announceAutoRecordSetting(true)` and returns `null`.

- [ ] **Step 1: Write the failing tests.** Mock as in `src/tests/MeetingAutoRecordToggle.mac.test.tsx:1-66`: the platform, mac-permissions, `@/lib` `safeLocalStorage`, `invoke` and `emit`.

```ts
it("windows: saves true, emits, never asks for permissions", async () => {
  platform = "windows";
  expect(await turnOnAutoRecord()).toBeNull();
  expect(stored[STORAGE_KEYS.MEETING_AUTO_RECORD_ENABLED]).toBe("true");
  expect(emit).toHaveBeenCalledWith("meeting-detection-setting-changed", { enabled: true });
  expect(requestMicAccess).not.toHaveBeenCalled();
});
it("mac: probe, mic, system audio pass -> saves true and emits", async () => {
  platform = "macos"; invoke.mockResolvedValue([]); requestMicAccess.mockResolvedValue(true);
  requestSystemAudioAccess.mockResolvedValue(null);
  expect(await turnOnAutoRecord()).toBeNull();
  expect(stored[STORAGE_KEYS.MEETING_AUTO_RECORD_ENABLED]).toBe("true");
});
it("mac: mic denied -> returns mic-denied, writes failure, saves and emits nothing", async () => {
  platform = "macos"; invoke.mockResolvedValue([]); requestMicAccess.mockResolvedValue(false);
  const f = await turnOnAutoRecord();
  expect(f).toEqual({ kind: "mic-denied", message: MIC_DENIED_MESSAGE });
  expect(JSON.parse(stored[STORAGE_KEYS.MEETING_AUTO_RECORD_START_FAILURE]).kind).toBe("mic-denied");
  expect(stored[STORAGE_KEYS.MEETING_AUTO_RECORD_ENABLED]).toBeUndefined();
  expect(emit).not.toHaveBeenCalled();
});
it("announceAutoRecordSetting(false) saves false and emits enabled:false", async () => {
  await announceAutoRecordSetting(false);
  expect(stored[STORAGE_KEYS.MEETING_AUTO_RECORD_ENABLED]).toBe("false");
  expect(emit).toHaveBeenCalledWith("meeting-detection-setting-changed", { enabled: false });
});
```

- [ ] **Step 2: Run the tests and confirm they fail.** Run `npx vitest run src/tests/auto-record-setting.test.ts`. Expected: FAIL, because the module `@/lib/auto-record-setting` is not found.

- [ ] **Step 3: Implement both functions** in `src/lib/auto-record-setting.ts`, as specified in Interfaces.

- [ ] **Step 4: Refactor the toggle to call them.** Its local UI state updates stay in the component:
  - `setIsEnabled`, `setStatus({kind:"pending"})`, and `setStartFailure(failure)` on a returned failure;
  - `setRequesting` around the Mac path.

  `saveAndAnnounce` becomes the state update plus `announceAutoRecordSetting`. The Mac toggle-on path uses `turnOnAutoRecord()`.

- [ ] **Step 5: Run the new and the existing toggle suites.** Run `npx vitest run src/tests/auto-record-setting.test.ts src/tests/MeetingAutoRecordToggle.mac.test.tsx src/tests/MeetingAutoRecordToggle.note.test.tsx src/tests/settings-page.meeting-auto-record.test.tsx`. Expected: all PASS. The existing three files are unmodified.

- [ ] **Step 6: Commit.**

```bash
git add src/lib/auto-record-setting.ts src/pages/settings/components/MeetingAutoRecordToggle.tsx src/tests/auto-record-setting.test.ts
git commit -m "refactor(auto-record): share the toggle-on logic"
```

---

### Task 2: The offer card in the store, plus reveal

**Files:**
- Modify: `src/lib/meeting-cards.store.ts` (the `MeetingCardState` union, new functions, `cardHeight`)
- Modify: `src/hooks/useMeetingCardHost.ts:28-36` (the reveal effect)
- Test: `src/tests/meeting-cards.store.test.ts`, `src/tests/meeting-card-window.test.tsx`

**Interfaces:**
- Produces:
  - `MeetingCardState` gains `| { kind: "offer"; busy: boolean; error: string | null }`.
  - `showOffer(now?: number): boolean`: puts `{kind:"offer", busy:false, error:null}` in the slot with no timer, only when the slot is `null`. Returns whether it did.
  - `setOfferState(s: { busy: boolean; error: string | null }): void`: does nothing unless the slot holds an offer.
  - `dismissOffer(): void`: clears the slot only if it holds an offer.
  - `cardHeight` for an offer:
    - full: `error ? 136 : 104`;
    - compact: `error ? 152 : 120`.

    These are starting values. Task 4 may change them to match the rendered pixels, and must update this test in the same commit.

- [ ] **Step 1: Write the failing tests** in `meeting-cards.store.test.ts`:

```ts
it("showOffer fills an empty slot only", () => {
  expect(showOffer()).toBe(true);
  expect(getMeetingCard()).toEqual({ kind: "offer", busy: false, error: null });
  expect(showOffer()).toBe(false); // already up: idempotent
  resetMeetingCardsForTests(); showStopNotice("silence");
  expect(showOffer()).toBe(false);
  expect(getMeetingCard()?.kind).toBe("ended");
});
it("any other card replaces the offer; dismissOffer leaves other cards alone", () => {
  showOffer(); showAmber({ variant: "reconnect", episode: 1 });
  expect(getMeetingCard()?.kind).toBe("amber");
  dismissOffer();
  expect(getMeetingCard()?.kind).toBe("amber");
});
it("setOfferState updates only an offer; error grows the card", () => {
  showOffer(); setOfferState({ busy: true, error: null });
  expect(getMeetingCard()).toMatchObject({ busy: true });
  const plain = cardHeight(getMeetingCard(), false);
  setOfferState({ busy: false, error: "x" });
  expect(cardHeight(getMeetingCard(), false)).toBeGreaterThan(plain);
});
```

In `meeting-card-window.test.tsx`, following its existing amber reveal case:

```ts
it("an offer card reveals the overlay", async () => {
  act(() => { store.showOffer(); });
  await flush();
  expect(h.invoke).toHaveBeenCalledWith("reveal_overlay");
});
```

- [ ] **Step 2: Run the tests and confirm they fail.** Run `npx vitest run src/tests/meeting-cards.store.test.ts src/tests/meeting-card-window.test.tsx`. Expected: FAIL, because `showOffer` is not exported.

- [ ] **Step 3: Implement the store functions and `cardHeight` case.** In `useMeetingCardHost`, the reveal effect fires on a new amber episode OR on a card changing to `kind === "offer"`. Key the effect on `card?.kind === "offer" ? "offer" : amberEpisode`.

- [ ] **Step 4: Run both files.** Run the same command as Step 2. Expected: PASS. Then run `npx tsc --noEmit`. Expected: clean, apart from `MeetingCard.tsx`'s non-exhaustive switch. If TS flags that switch, add `case "offer": return null;` as a placeholder that Task 4 replaces.

- [ ] **Step 5: Commit.**

```bash
git add src/lib/meeting-cards.store.ts src/hooks/useMeetingCardHost.ts src/pages/app/components/MeetingCard.tsx src/tests/meeting-cards.store.test.ts src/tests/meeting-card-window.test.tsx
git commit -m "feat(cards): add the auto-record offer card kind"
```

---

### Task 3: The offer module

**Files:**
- Create: `src/lib/auto-record-offer.ts`
- Modify: `src/config/constants.ts` (`STORAGE_KEYS.MEETING_AUTO_RECORD_OFFER: "meeting_auto_record_offer"`)
- Test: `src/tests/auto-record-offer.test.ts`

**Interfaces:**
- Consumes: `turnOnAutoRecord` (Task 1); `showOffer`, `setOfferState`, `dismissOffer` and `getMeetingCard` (Task 2).
- Produces:
  - `OFFER_TITLE`, `OFFER_BODY: Record<"macos" | "windows", string>`, `OFFER_FOOTNOTE` and `OFFER_FAILED_MESSAGE = "Couldn't turn on auto-record. Try again in Settings."`. The other copy is verbatim from Global Constraints.
  - `shouldOfferAutoRecord(): Promise<boolean>`: the Global Constraints conditions. A rejected probe returns `false`.
  - `maybeShowAutoRecordOffer(): Promise<void>`: if `shouldOfferAutoRecord()` and `showOffer()` both return true, logs `offer shown`.
  - `acceptAutoRecordOffer(): Promise<void>`:
    - No-op unless the slot holds an offer with `busy: false`.
    - Sets busy, then awaits `turnOnAutoRecord()`.
    - On `null`: saves the offer key as `"on"`, `dismissOffer()`, logs `offer answer=on`.
    - On a failure: `setOfferState({busy:false, error: failure.message})` and logs `offer answer=failed:<kind>`. The key stays unset.
    - On a throw: `setOfferState({busy:false, error: OFFER_FAILED_MESSAGE})` and logs `offer answer=failed:start-error`.
  - `declineAutoRecordOffer(): void`: saves `"later"`, `dismissOffer()`, logs `offer answer=later`.
  - `answerOfferFromSettings(): void`: only if the slot holds an offer with `busy: false`. Saves `"settings"`, `dismissOffer()`, logs `offer answer=settings`.

- [ ] **Step 1: Write the failing tests.** Use the same mocks as Task 1, plus `vi.mock("@/lib/auto-record-setting")` for the accept cases. `detectionLog` is already a global `vi.fn()` (`src/tests/setup.ts:6`). Call `resetMeetingCardsForTests()` in `beforeEach`.

```ts
describe("shouldOfferAutoRecord", () => {
  it.each([
    ["linux", {}, false],
    ["windows", {}, true],
    ["windows", { [K.MEETING_AUTO_RECORD_ENABLED]: "false" }, false],
    ["windows", { [K.MEETING_AUTO_RECORD_ENABLED]: "true" }, false],
    ["windows", { [K.MEETING_AUTO_RECORD_OFFER]: "later" }, false],
  ])("%s %j -> %s", async (p, s, want) => {
    platform = p as never; stored = { ...s };
    expect(await shouldOfferAutoRecord()).toBe(want);
  });
  it("mac: true only when the probe resolves", async () => {
    platform = "macos"; invoke.mockResolvedValueOnce([]);
    expect(await shouldOfferAutoRecord()).toBe(true);
    invoke.mockRejectedValueOnce("Auto-record needs macOS 14.2 or later");
    expect(await shouldOfferAutoRecord()).toBe(false);
  });
});
it("maybeShow: shows and logs once; does nothing when another card is up", async () => {
  platform = "windows";
  await maybeShowAutoRecordOffer(); await maybeShowAutoRecordOffer();
  expect(vi.mocked(detectionLog).mock.calls.filter(([l]) => l === "offer shown")).toHaveLength(1);
  resetMeetingCardsForTests(); vi.mocked(detectionLog).mockClear(); showStopNotice("silence");
  await maybeShowAutoRecordOffer();
  expect(detectionLog).not.toHaveBeenCalled();
});
it("accept ok: key on, card gone, logged", async () => {
  showOffer(); turnOn.mockResolvedValue(null);
  await acceptAutoRecordOffer();
  expect(stored[K.MEETING_AUTO_RECORD_OFFER]).toBe("on");
  expect(getMeetingCard()).toBeNull();
  expect(detectionLog).toHaveBeenCalledWith("offer answer=on");
});
it("accept failure: card stays with the message, not busy, key unset", async () => {
  showOffer(); turnOn.mockResolvedValue({ kind: "mic-denied", message: MIC_DENIED_MESSAGE });
  await acceptAutoRecordOffer();
  expect(getMeetingCard()).toEqual({ kind: "offer", busy: false, error: MIC_DENIED_MESSAGE });
  expect(stored[K.MEETING_AUTO_RECORD_OFFER]).toBeUndefined();
  expect(detectionLog).toHaveBeenCalledWith("offer answer=failed:mic-denied");
});
it("accept throw: not stuck busy", async () => {           // Review Focus 2
  showOffer(); turnOn.mockRejectedValue(new Error("boom"));
  await acceptAutoRecordOffer();
  expect(getMeetingCard()).toEqual({ kind: "offer", busy: false, error: OFFER_FAILED_MESSAGE });
});
it("double accept runs one turn-on", async () => {          // Review Focus 1
  showOffer(); let release!: (v: null) => void;
  turnOn.mockReturnValue(new Promise((r) => (release = r)));
  const a = acceptAutoRecordOffer(); const b = acceptAutoRecordOffer();
  release(null); await Promise.all([a, b]);
  expect(turnOn).toHaveBeenCalledTimes(1);
});
it("decline: key later, card gone, enabled untouched", () => {
  showOffer(); declineAutoRecordOffer();
  expect(stored[K.MEETING_AUTO_RECORD_OFFER]).toBe("later");
  expect(stored[K.MEETING_AUTO_RECORD_ENABLED]).toBeUndefined();
  expect(getMeetingCard()).toBeNull();
});
it("settings answer: ignored while busy and when no offer is up", () => {   // Review Focus 5
  answerOfferFromSettings();
  expect(stored[K.MEETING_AUTO_RECORD_OFFER]).toBeUndefined();
  showOffer(); setOfferState({ busy: true, error: null }); answerOfferFromSettings();
  expect(getMeetingCard()?.kind).toBe("offer");
  setOfferState({ busy: false, error: null }); answerOfferFromSettings();
  expect(stored[K.MEETING_AUTO_RECORD_OFFER]).toBe("settings");
  expect(getMeetingCard()).toBeNull();
});
```

- [ ] **Step 2: Run the tests and confirm they fail.** Run `npx vitest run src/tests/auto-record-offer.test.ts`. Expected: FAIL, because the module is not found.

- [ ] **Step 3: Implement** `src/lib/auto-record-offer.ts` and the storage key, as specified in Interfaces.

- [ ] **Step 4: Run the tests and confirm they pass.** Run the same command. Expected: PASS.

- [ ] **Step 5: Commit.**

```bash
git add src/lib/auto-record-offer.ts src/config/constants.ts src/tests/auto-record-offer.test.ts
git commit -m "feat(auto-record): offer module for the first-launch prompt"
```

---

### Task 4: Render the offer card

**Files:**
- Modify: `src/pages/app/components/MeetingCard.tsx`: an `OfferCard` component next to `AmberCard`, replacing the Task 2 placeholder case.
- Test: `src/tests/meeting-card.test.tsx`

**Interfaces:**
- Consumes: the `OFFER_*` copy, `acceptAutoRecordOffer` and `declineAutoRecordOffer` (Task 3); `setOfferState` (Task 2).

**What to build:**
- `OfferCard({ card, compact })` uses the existing `SHELL` and `data-testid="meeting-card"`, with `data-kind="offer"`.
- It shows the title, `OFFER_BODY[isMacOS() ? "macos" : "windows"]` and the footnote. When `card.error` is set, the error is shown in `text-destructive`.
- Buttons:
  - with no error: `Not now` (decline) and `Turn on` (accept);
  - with an error: `Not now` and `Open settings`, which calls `invoke("open_dashboard")` the way the amber `openSettings` does;
  - every button is disabled while `card.busy`.
- Heights must match `cardHeight`. Adjust Task 2's values and their test in this commit if the render differs.

- [ ] **Step 1: Write the failing tests** in `meeting-card.test.tsx`, using its `Harness`. Mock `@/lib/platform`, and mock `@/lib/auto-record-offer`'s accept and decline as `vi.fn()`, keeping the real copy constants.

```ts
it("offer: mac copy, Turn on calls accept, Not now calls decline", () => {
  platform = "macos"; act(() => { showOffer(); }); render(<Harness />);
  expect(screen.getByText(OFFER_TITLE)).toBeTruthy();
  expect(screen.getByText(OFFER_BODY.macos)).toBeTruthy();
  fireEvent.click(screen.getByRole("button", { name: "Turn on" }));
  expect(accept).toHaveBeenCalledTimes(1);
  fireEvent.click(screen.getByRole("button", { name: "Not now" }));
  expect(decline).toHaveBeenCalledTimes(1);
});
it("offer: windows copy", () => {
  platform = "windows"; act(() => { showOffer(); }); render(<Harness />);
  expect(screen.getByText(OFFER_BODY.windows)).toBeTruthy();
});
it("offer: busy disables both buttons", () => {
  act(() => { showOffer(); setOfferState({ busy: true, error: null }); }); render(<Harness />);
  for (const b of screen.getAllByRole("button")) expect((b as HTMLButtonElement).disabled).toBe(true);
});
it("offer: error shows the message and Open settings opens the dashboard", () => {
  act(() => { showOffer(); setOfferState({ busy: false, error: "Mic blocked" }); }); render(<Harness />);
  expect(screen.getByText("Mic blocked")).toBeTruthy();
  expect(screen.queryByRole("button", { name: "Turn on" })).toBeNull();
  fireEvent.click(screen.getByRole("button", { name: "Open settings" }));
  expect(h.invoke).toHaveBeenCalledWith("open_dashboard");
});
```

- [ ] **Step 2: Run the tests and confirm they fail.** Run `npx vitest run src/tests/meeting-card.test.tsx`. Expected: FAIL, because the offer copy is not found.

- [ ] **Step 3: Implement `OfferCard`** and its `case "offer"`.

- [ ] **Step 4: Run the card files.** Run `npx vitest run src/tests/meeting-card.test.tsx src/tests/meeting-cards.store.test.ts src/tests/meeting-card-window.test.tsx`. Expected: PASS.

- [ ] **Step 5: Commit.**

```bash
git add src/pages/app/components/MeetingCard.tsx src/tests/meeting-card.test.tsx src/lib/meeting-cards.store.ts src/tests/meeting-cards.store.test.ts
git commit -m "feat(cards): render the auto-record offer card"
```

---

### Task 5: Trigger it at launch

**Files:**
- Create: `src/hooks/useAutoRecordOffer.ts`; export it from `src/hooks/index.ts`
- Modify: `src/pages/app/index.tsx`. After `useMeetingCardHost(pillStyle)`, add `useAutoRecordOffer(!setupLoading && setupComplete);`
- Test: `src/tests/useAutoRecordOffer.test.tsx`

**Interfaces:**
- Consumes: `maybeShowAutoRecordOffer` and `answerOfferFromSettings` (Task 3).
- Produces: `useAutoRecordOffer(ready: boolean): void`.
  - Inert unless `getCurrentWindow().label === "main"`, imported from `@tauri-apps/api/window` the way `useMeetingDetection` does.
  - Calls `maybeShowAutoRecordOffer()` at most once per hook instance, the first time `ready` is true. Guard it with a ref.
  - Registers `listen("meeting-detection-setting-changed", () => answerOfferFromSettings())`, with the cancelled-flag cleanup pattern from `useMeetingDetection.ts:131-138`.

- [ ] **Step 1: Write the failing tests.** Mock `@tauri-apps/api/window` (label from a variable), `@tauri-apps/api/event`'s `listen` (the listener-map pattern from the toggle test), and `@/lib/auto-record-offer`.

```ts
it("not ready: nothing; ready: shows once, even across re-renders and flips", async () => {  // Review Focus 4
  const { rerender } = renderHook(({ r }) => useAutoRecordOffer(r), { initialProps: { r: false } });
  expect(maybeShow).not.toHaveBeenCalled();
  rerender({ r: true }); rerender({ r: false }); rerender({ r: true });
  expect(maybeShow).toHaveBeenCalledTimes(1);
});
it("non-main window: inert", () => {
  label = "dashboard"; renderHook(() => useAutoRecordOffer(true));
  expect(maybeShow).not.toHaveBeenCalled();
  expect(listen).not.toHaveBeenCalled();
});
it("a setting change routes to answerOfferFromSettings", async () => {
  renderHook(() => useAutoRecordOffer(true)); await flush();
  fire("meeting-detection-setting-changed", { enabled: true });
  expect(answerFromSettings).toHaveBeenCalledTimes(1);
});
```

- [ ] **Step 2: Run the tests and confirm they fail.** Run `npx vitest run src/tests/useAutoRecordOffer.test.tsx`. Expected: FAIL, because the module is not found.

- [ ] **Step 3: Implement the hook** and wire it into the app page.

- [ ] **Step 4: Run the tests and confirm they pass.** Run the same command. Expected: PASS.

- [ ] **Step 5: Commit.**

```bash
git add src/hooks/useAutoRecordOffer.ts src/hooks/index.ts src/pages/app/index.tsx src/tests/useAutoRecordOffer.test.tsx
git commit -m "feat(auto-record): ask once at launch"
```

---

### Task 6: Full checks and a check on the Mac

- [ ] **Step 1: Run the project checks.** Run `npm run lint`, `npm run type-check` and `npx vitest run`, then, in `src-tauri/`, `cargo test`, `cargo clippy -- -D warnings` and `cargo fmt --check`. Expected:
  - lint: 0 errors;
  - type-check: clean;
  - vitest: all pass, with the pre-existing counts plus the new tests;
  - cargo: unchanged, all pass.
- [ ] **Step 2: Check it in a dev build on the Mac.**
  - Quit the installed Meetwings, then run `npm run tauri dev`. The dev webview has its own localStorage, so both keys start absent.
  - Expected: after setup, the card appears under the bar with the Mac copy.
  - Click **Turn on**. The macOS mic and system-audio prompts appear, the toggle in Settings reads on, `detection.log` shows `offer shown`, then `offer answer=on`, then `watcher start`.
  - Relaunch. The card does not appear.
- [ ] **Step 3: Check Not now in a fresh dev profile.** Clear the dev origin's two keys from devtools. Expected: Not now hides the card and it doesn't return on relaunch.
