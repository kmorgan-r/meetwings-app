# Team Setup and Silent Updates Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Windows and Mac installs update themselves without a click (never during a recording or meeting). Colleagues join one encrypted team-settings file with one link and one in-app confirm, and the app keeps their settings in sync with it.

**Architecture:** Part A (Tasks 1-4) moves the updater into a headless scheduler in the `main` window's App body, outside the overlay ErrorBoundary. A pure install gate guards it, reading a module-level activity store plus Rust capture state. Part B (Tasks 5-14) adds `src/lib/team/`: link parser, AES-GCM crypto, file schema/export, gist fetch, change-only apply with first-join rollback, and sync. A main-window controller owns fetch/apply and deep links, and talks to the dashboard by Tauri events. Small changes in Google connect (profile name) and Notion send (per-send page ref) make the shared credentials safe to use.

**Tech Stack:** React 19 + TypeScript, Tauri 2 (Rust), `@tauri-apps/plugin-updater` 2.9, `@tauri-apps/plugin-process`, `tauri-plugin-deep-link` 2, `@tauri-apps/plugin-http`, WebCrypto (AES-256-GCM), Vitest (happy-dom).

**Spec:** `docs/superpowers/specs/2026-11-15-team-setup-and-silent-updates-design.md`

## Global Constraints

- No key, token, gist id or team link in source, builds, commits, release assets or build-time inputs. Team settings arrive only at runtime through the team link.
- Never put raw secrets in `console.*`, thrown messages, toasts or UI text. Secrets here are: provider keys, Notion token, Google secret, gist id/URL, link key, the link itself. Team modules log fixed strings plus a `TeamErrorCode` only, and never pass a caught error object to `console`.
- Only the `main` window fetches, applies and handles deep links: gate on `getCurrentWindow().label === "main"`, like `useMeetingDetection`.
- Network: team fetch goes only to `https://api.github.com/gists/<gistId>` with `maxRedirections: 0`. The key never appears in any fetched URL.
- Install gate wait: `MEETING_CONVERSATION_GAP_MS` (30 min, `src/config/constants.ts`). Update tick: 4 h. Pending-install re-check: 5 min. Team start retry: 60 s, once.
- Linux: the silent updater is inert and today's click-to-install `Updater` behaviour stays unchanged.
- Odoo settings, audio devices, shortcuts, system prompts and chat history are never written by team code.
- Imports use `@/`. Files are kebab-case. Tests go in `src/tests/*.test.ts(x)`.
- Verification commands: `npx vitest run <files>`, `npm run type-check` (the script is `type-check`, not `check:types`), `cargo test --manifest-path src-tauri/Cargo.toml <filter>`. tsconfig does not type-check `src/tests/`, so run test files, don't only type-check.
- Fixed error copy only, via `TEAM_COPY` (Task 6) and the existing `GOOGLE_COPY`.
- Tests and localStorage: `src/tests/setup.ts:38-46` replaces `localStorage` with inert `vi.fn()` stubs. Any test that seeds or reads localStorage calls `installMemoryLocalStorage()` (created in Task 3). That backs the stubs with a Map, following the precedent in `src/tests/customizable.storage.test.ts:11-21`.
- Timer tests: use `vi.useFakeTimers()` and `await vi.advanceTimersByTimeAsync(ms)`, never the sync `advanceTimersByTime`, so the async chains (check → download → gate → install) flush.
- Module state: every module with module-level state exports a `__reset…ForTests()` helper, and tests call it in `beforeEach`.

## Review Focus

1. **Rust capture query fails** (`get_capture_status` rejects): the gate must treat it as capturing and defer, never install. Test in Task 3.
2. **A team link pasted with whitespace, a trailing newline or `<...>` wrapping** (mail clients do this): it is accepted after trimming. Anything else stays rejected. Test in Task 5.
3. **The gist has an extra file (README), or the blob has a trailing newline** (GitHub's editor adds one): the fetch picks the single `mwt1.` file and trims it. Test in Task 7.
4. **The link is clicked twice while the confirm prompt is open**: one prompt, holding the latest link, and nothing applied until confirm. Test in Task 13.
5. **A newer version ships after an install failed**: the failed-version block covers only that version, so the newer one installs automatically. Test in Task 3.

---

## Part A — Silent updates

### Task 1: Install gate and recording-activity store

**Files:**
- Create: `src/lib/updater/install-gate.ts`
- Create: `src/lib/updater/recording-activity.store.ts`
- Modify: `src/hooks/useSystemAudio.ts` (add an effect next to `:815-817`)
- Modify: `src/hooks/useCompletion.ts` (add an effect near `micOpen`/`enableVAD`, `:131-132`)
- Test: `src/tests/install-gate.test.ts`, `src/tests/recording-activity-store.test.ts`

**Interfaces:**
- Produces:
  - `interface GateInput { capturing: boolean; meetingActive: boolean; lastCaptureEndedAt: number | null; now: number }`
  - `canInstallNow(input: GateInput): boolean`
  - `type CaptureSource = "system-audio" | "mic"`
  - `setCaptureActive(source: CaptureSource, active: boolean, now?: number): void`. `now` defaults to `Date.now()`.
  - `setMeetingActive(active: boolean): void`
  - `getActivitySnapshot(): { capturing: boolean; meetingActive: boolean; lastCaptureEndedAt: number | null }`
  - `useReportCaptureActivity(source: CaptureSource, active: boolean): void`. A hook running `useEffect(() => { setCaptureActive(source, active); return () => setCaptureActive(source, false); }, [source, active])`. Its deps are only `source` and `active`, so a re-render that changes anything else (a conversation switch) never stamps a false end.
  - `__resetActivityForTests(): void`

- [ ] **Step 1: Write the failing tests**

```ts
// install-gate.test.ts (GAP = MEETING_CONVERSATION_GAP_MS)
const base = { capturing: false, meetingActive: false, lastCaptureEndedAt: null, now: 1_000_000_000 };
it("installs when idle with no capture since start", () => expect(canInstallNow(base)).toBe(true));
it("defers while capturing", () => expect(canInstallNow({ ...base, capturing: true })).toBe(false));
it("defers while a meeting is detected", () => expect(canInstallNow({ ...base, meetingActive: true })).toBe(false));
it("defers until the last capture ended 30 min ago", () => {
  expect(canInstallNow({ ...base, lastCaptureEndedAt: base.now - GAP + 1 })).toBe(false);
  expect(canInstallNow({ ...base, lastCaptureEndedAt: base.now - GAP })).toBe(true);
});

// recording-activity-store.test.ts (beforeEach __resetActivityForTests)
it("stays capturing while any source is active and stamps the end when the last stops", () => {
  setCaptureActive("system-audio", true, 10); setCaptureActive("mic", true, 20);
  setCaptureActive("system-audio", false, 30);
  expect(getActivitySnapshot()).toMatchObject({ capturing: true, lastCaptureEndedAt: null });
  setCaptureActive("mic", false, 40);
  expect(getActivitySnapshot()).toMatchObject({ capturing: false, lastCaptureEndedAt: 40 });
});
it("an inactive source set inactive again does not stamp", () => {
  setCaptureActive("mic", false, 50);
  expect(getActivitySnapshot().lastCaptureEndedAt).toBeNull();
});
it("meeting state is independent of capture", () => {
  setMeetingActive(true);
  expect(getActivitySnapshot()).toMatchObject({ meetingActive: true, capturing: false });
});
it("useReportCaptureActivity stamps the end on true -> false and on unmount, not on unrelated re-renders", () => {
  // renderHook(({ active, other }) => { useReportCaptureActivity("system-audio", active); return other; }, { initialProps: { active: true, other: 1 } })
  // rerender({ active: true, other: 2 }) -> lastCaptureEndedAt still null; rerender({ active: false, other: 2 }) -> stamped;
  // a second hook instance active -> unmount -> capturing false
});
```

- [ ] **Step 2: Run to verify they fail**

Run: `npx vitest run src/tests/install-gate.test.ts src/tests/recording-activity-store.test.ts`
Expected: FAIL, modules not found.

- [ ] **Step 3: Implement `canInstallNow` and the store**

The gate is `!capturing && !meetingActive && (lastCaptureEndedAt === null || now - lastCaptureEndedAt >= MEETING_CONVERSATION_GAP_MS)`. The store is a module-level `Set<CaptureSource>` plus `meetingActive` and `lastCaptureEndedAt`. It stamps `lastCaptureEndedAt = now` only when the set goes from non-empty to empty.

- [ ] **Step 4: Wire the two hooks**

In `useSystemAudio.ts`, call `useReportCaptureActivity("system-audio", capturing)` as its own hook call. Do not fold it into the existing `[capturing, conversation.id]` effect. That effect's cleanup would fire on a conversation switch mid-capture and stamp a false end.

In `useCompletion.ts`, call `useReportCaptureActivity("mic", micOpen || enableVAD)`.

- [ ] **Step 5: Run tests and type-check**

Run: `npx vitest run src/tests/install-gate.test.ts src/tests/recording-activity-store.test.ts && npm run type-check`
Expected: PASS, no type errors.

- [ ] **Step 6: Commit**

```bash
git add src/lib/updater src/hooks/useSystemAudio.ts src/hooks/useCompletion.ts src/tests/install-gate.test.ts src/tests/recording-activity-store.test.ts
git commit -m "feat(updater): add install gate and recording-activity store"
```

### Task 2: Process plugin, quiet Windows install, NSIS only

**Files:**
- Modify: `src-tauri/Cargo.toml` (deps near `:31-32`)
- Modify: `src-tauri/src/lib.rs:157` (plugin chain)
- Modify: `src-tauri/capabilities/default.json`, `src-tauri/capabilities/cross-platform.json`
- Modify: `src-tauri/tauri.conf.json:56-58`
- Modify: `.github/workflows/publish.yml:69-71` (Windows matrix row)

**Interfaces:**
- Produces: `relaunch()` from `@tauri-apps/plugin-process` works on every OS (consumed by Task 3).

- [ ] **Step 1: Add the Rust process plugin**

In `Cargo.toml`, add `tauri-plugin-process = "2"`. In `lib.rs`, add `.plugin(tauri_plugin_process::init())` right after `.plugin(tauri_plugin_updater::Builder::new().build())`. Add `"process:allow-restart"` to the `permissions` array of both capability files.

- [ ] **Step 2: Make the Windows install silent**

In `tauri.conf.json`, set `plugins.updater.windows.installMode` to `"quiet"`. NSIS installs per-user by default, so quiet needs no admin.

- [ ] **Step 3: Stop shipping the MSI**

The MSI is per-machine, so a quiet update would need a UAC prompt. In the Windows matrix row of `publish.yml`, set `args: "--bundles nsis"` and reduce `bundles` to the single pair `src-tauri/target/release/bundle/nsis/*-setup.exe:Meetwings-windows-x64-setup.exe`. Then grep the workflow for any other `msi` reference and remove it.

- [ ] **Step 4: Verify**

Run: `cargo check --manifest-path src-tauri/Cargo.toml`
Expected: compiles. `tauri-build` validates capability permission names, so a typo in `process:allow-restart` fails here.
Run: `node -e "for (const f of ['src-tauri/tauri.conf.json','src-tauri/capabilities/default.json','src-tauri/capabilities/cross-platform.json']) JSON.parse(require('fs').readFileSync(f,'utf8'))"`
Expected: no output.
Run: `grep -n "msi" .github/workflows/publish.yml`
Expected: no matches.

- [ ] **Step 5: Commit**

```bash
git add src-tauri/Cargo.toml src-tauri/Cargo.lock src-tauri/src/lib.rs src-tauri/capabilities src-tauri/tauri.conf.json .github/workflows/publish.yml
git commit -m "feat(updater): register process plugin, quiet NSIS install, drop MSI"
```

Owner action, outside the code: remove the MSI download link from meetwings.com. Anyone who installed from the MSI reinstalls once with the setup.exe.

### Task 3: Headless silent-updater scheduler and retry button

**Files:**
- Create: `src/lib/updater/silent-updater.ts`
- Create: `src/hooks/useSilentUpdater.ts` (export it from `src/hooks/index.ts`)
- Modify: `src/pages/app/index.tsx:38` (call the hook in the App body, next to `useMeetingDetection()`, outside the ErrorBoundary)
- Modify: `src/components/updater/index.tsx`
- Modify: `src/config/constants.ts` (`STORAGE_KEYS.UPDATER_LAST_CHECK_AT: "updater_last_check_at"`)
- Create: `src/tests/memory-local-storage.ts` (test helper, shared by Tasks 3, 4, 6, 8 and 9)
- Test: `src/tests/silent-updater.test.ts`, `src/tests/updater-retry-button.test.tsx`, `src/tests/use-silent-updater.test.tsx`

**Interfaces:**
- Consumes: `canInstallNow`, `GateInput`, `getActivitySnapshot`, `setMeetingActive` (Task 1). `relaunch` (Task 2).
- Produces:
  - `installMemoryLocalStorage(): Map<string, string>` in `src/tests/memory-local-storage.ts`. It points the global stubs' `getItem`/`setItem`/`removeItem`/`clear` at a fresh Map via `mockImplementation` and returns the Map, so tests can seed, assert and enumerate.
  - `UPDATE_TICK_MS = 4 * 60 * 60 * 1000`, `INSTALL_RECHECK_MS = 5 * 60 * 1000`, `CHECK_TIMEOUT_MS = 60 * 1000`
  - `__resetSilentUpdaterForTests(): void`
  - `type SilentUpdaterStatus = { kind: "idle" } | { kind: "waiting"; version: string } | { kind: "relaunch-pending"; version: string } | { kind: "install-failed"; version: string }`
  - `interface SilentUpdaterDeps { check: () => Promise<Update | null>; relaunch: () => Promise<void>; readGateInput: () => Promise<GateInput>; now: () => number }`
  - `startSilentUpdater(deps?: Partial<SilentUpdaterDeps>): () => void` (returns stop)
  - `retryInstall(): void`
  - `getSilentUpdaterStatus(): SilentUpdaterStatus`, `subscribeSilentUpdater(cb: () => void): () => void` (for `useSyncExternalStore`)
  - `readGateInput(): Promise<GateInput>`, the default dep
  - `useSilentUpdater(): void`

Behaviour, pinned:
- `start`: run `tick()` now, then `setInterval(tick, UPDATE_TICK_MS)`.
- One `busy` flag covers a check, a download, an install and a relaunch. A re-check timer that fires while `busy` is set reschedules itself.
- `tick`: skip if `busy`, or if an installed update awaits relaunch (the re-check timer owns that). Otherwise call `check()`. The default dep is `() => check({ timeout: CHECK_TIMEOUT_MS })`, so a stalled request rejects instead of holding `busy` forever. On success, write `STORAGE_KEYS.UPDATER_LAST_CHECK_AT = String(now())`. On `null`, stop there. If `update.version` equals `failedVersion` or the held update's version, do nothing. Otherwise `await update.download()` (no hard cap on the download), replace the held `Update`, and call `attemptInstall()`. So a newer release replaces one still waiting for the gate.
- `attemptInstall`: clear any pending re-check timer, then read `readGateInput()`. Closed: status `waiting`, `setTimeout(attemptInstall, INSTALL_RECHECK_MS)`. Open: `await update.install()`. If install rejects (including a cancelled macOS password prompt): `failedVersion = version`, drop the held update, status `install-failed`. The next tick then checks again, and only that one version stays blocked (Review Focus 5). After install, mark the update installed and run `attemptRelaunch`.
- `attemptRelaunch`: read the gate. Closed: status `relaunch-pending`, retry on the re-check timer. Open: `await relaunch()`. If that rejects: status `install-failed`, update still marked installed.
- A check or download rejection logs `console.error("[updater] check/download failed")` and waits for the next tick.
- `failedVersion` lives in memory only, so it is cleared by the next app start.
- `retryInstall()`: if the held update is already installed, run `attemptRelaunch()` only, which means no second install and no second Mac password prompt. Otherwise clear `failedVersion`, set status `idle`, and run `tick()`.
- Status is a module variable. It is replaced only on a real transition, and only then are subscribers notified. `getSilentUpdaterStatus()` returns that variable itself, never a fresh object, because `useSyncExternalStore` loops on a new snapshot reference (precedent: `src/lib/overlay-minimize.store.ts:77-83`).
- `stop()`: clear the interval and timeouts, reset `busy` and the held update, and bump a generation counter. Every continuation after an `await` checks the generation and returns at once if it is stale. That covers `finally` blocks too, so a stale continuation never touches module state, including the next generation's `busy`. StrictMode mounts twice. The first mount's download cannot be cancelled and is discarded.
- `readGateInput()`: `capturing = snapshot.capturing || rust`, where `rust = await invoke<boolean>("get_capture_status")`. A rejected invoke counts as `true` (fail closed). Use `snapshot.meetingActive`, `snapshot.lastCaptureEndedAt`, and `now = Date.now()`.
- `useSilentUpdater`: an effect that returns early unless `getCurrentWindow().label === "main"` and `!isLinux()`. It registers three listeners with the cancelled-flag pattern from `useMeetingAutoRecord.ts:891-898`: `listen("meeting-detected", () => setMeetingActive(true))`, `listen("meeting-ended", () => setMeetingActive(false))`, and `listen("meeting-watcher-stopped", () => setMeetingActive(false))`. The last one is there because a watcher that stops mid-call emits no `meeting-ended`, and the flag would otherwise block updates until restart. The effect then calls `startSilentUpdater()`. Its cleanup stops the updater and unlistens.
- `Updater` component: on Linux, render today's component unchanged (move it to an inner `LinuxUpdater`). Elsewhere, render `UpdateRetryButton`. It reads status through `useSyncExternalStore` and returns `null` unless the status is `install-failed`. Then it shows a small icon `Button` (`RefreshCw`) with `title`/`aria-label` `` `Update to ${version} failed - retry` ``, and `onClick={retryInstall}`. The non-Linux path never calls `check()`.

- [ ] **Step 1: Write the failing scheduler tests**

Use fake timers (Global Constraints). In `beforeEach`, call `__resetSilentUpdaterForTests()` and `installMemoryLocalStorage()`. `fakeUpdate(version)` is `{ version, download: vi.fn().mockResolvedValue(undefined), install: vi.fn().mockResolvedValue(undefined) }`. Pass `check`, `relaunch`, `readGateInput` and `now` as deps. Gate helpers: `idle` returns `{capturing:false, meetingActive:false, lastCaptureEndedAt:null, now}`, `busy` returns `{...idle, capturing:true}`.

```ts
it("idle: downloads, installs, relaunches in order and stamps the last check", async () => {
  // check -> u; gate idle
  // expect u.download before u.install before relaunch (invocationCallOrder); localStorage updater_last_check_at === String(now)
});
it("busy: downloads but defers install, then installs on the re-check once idle", async () => {
  // gate busy, then idle; expect install not called; advance INSTALL_RECHECK_MS; expect install + relaunch
});
it("re-reads the gate after the download (a recording that started during download is seen)", async () => {
  // download resolves; readGateInput first called after download resolves (call order) and returns busy; expect no install
});
it("defers the relaunch when a recording starts between install and relaunch", async () => {
  // gate: idle, then busy, then idle; expect install once, relaunch not called, status relaunch-pending; advance re-check; expect relaunch
});
it("a failed check installs nothing and retries on the next tick", async () => {
  // check rejects once then resolves null; expect no download/install/relaunch; advance UPDATE_TICK_MS; check called twice
});
it("a failed download installs nothing; the next tick retries", async () => { /* download rejects */ });
it("a failed install is not retried for that version until retryInstall", async () => {
  // install rejects; status install-failed; next tick: check called again, returns same version -> download not called again;
  // retryInstall() -> download + install called again
});
it("a newer version after a failed install installs automatically", async () => {
  // Review Focus 5: 1.6.0 install rejects; next tick returns 1.6.1 -> download + install for 1.6.1
});
it("a newer release while waiting for the gate replaces the held update", async () => {
  // gate busy; 1.6.0 downloaded, waiting; next tick returns 1.6.1 -> downloaded; gate idle on re-check -> install only 1.6.1
});
it("a rejected relaunch shows install-failed and retryInstall relaunches without reinstalling", async () => {
  // relaunch rejects once; status install-failed; retryInstall(); expect install called once total, relaunch twice
});
it("a tick while a check or download is in flight is skipped", async () => {
  // download pending (unresolved promise); advance UPDATE_TICK_MS; check called once
});
it("stop() cancels pending timers", async () => { /* stop, advance 2*UPDATE_TICK_MS, check called once */ });
it("stop() mid-download installs nothing", async () => {
  // download pending; stop(); resolve download; flush; expect install and relaunch not called
});
it("StrictMode start/stop/start: the stale generation is discarded", async () => {
  // first check() pending; stop(); start again (second check resolves u2); resolve first with u1;
  // expect only u2.download/install; status not touched by u1
});
it("the status getter returns a stable reference", () => {
  expect(getSilentUpdaterStatus()).toBe(getSilentUpdaterStatus());
});
it("the default check dep passes CHECK_TIMEOUT_MS", async () => {
  // mock @tauri-apps/plugin-updater check; start with no check dep; expect check called with { timeout: CHECK_TIMEOUT_MS }
});
it("readGateInput fails closed when get_capture_status rejects", async () => {
  // Review Focus 1: mock invoke reject; expect (await readGateInput()).capturing === true
});
it.each([
  [false, false, false], [true, false, true], [false, true, true], [true, true, true],
])("readGateInput: store %s, rust %s -> capturing %s", async (store, rust, expected) => { /* setCaptureActive / invoke mock */ });
```

```tsx
// use-silent-updater.test.tsx (mock listen, getCurrentWindow, isLinux, invoke; renderHook)
it("does nothing outside the main window", ...)                      // label "dashboard" -> listen not called
it("does nothing on Linux", ...)                                     // isLinux -> true -> listen not called
it("tracks meeting state from the three events", ...)
// fire meeting-detected -> getActivitySnapshot().meetingActive true; meeting-ended -> false;
// detected again, then meeting-watcher-stopped -> false
it("unmount stops the updater and unlistens", ...)                   // every unlisten mock called
```

- [ ] **Step 2: Write the failing retry-button tests**

```tsx
it("renders nothing while idle", ...)                      // container empty
it("shows a retry button after an install failure and retries on click", ...)
// drive the status to install-failed via the module (mock silent-updater exports), click, expect retryInstall called
it("on Linux renders the legacy updater and never the retry button", ...)   // mock isLinux() -> true
```

- [ ] **Step 3: Run to verify they fail**

Run: `npx vitest run src/tests/silent-updater.test.ts src/tests/updater-retry-button.test.tsx src/tests/use-silent-updater.test.tsx`
Expected: FAIL.

- [ ] **Step 4: Implement `silent-updater.ts`, `useSilentUpdater`, the `Updater` split, the App call and `installMemoryLocalStorage`**

- [ ] **Step 5: Run tests and type-check**

Run: `npx vitest run src/tests/silent-updater.test.ts src/tests/updater-retry-button.test.tsx src/tests/use-silent-updater.test.tsx && npm run type-check`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add src/lib/updater/silent-updater.ts src/hooks/useSilentUpdater.ts src/hooks/index.ts src/pages/app/index.tsx src/components/updater/index.tsx src/config/constants.ts src/tests/memory-local-storage.ts src/tests/silent-updater.test.ts src/tests/updater-retry-button.test.tsx src/tests/use-silent-updater.test.tsx
git commit -m "feat(updater): silent background updates gated on recording activity"
```

### Task 4: "Updated to" note and Settings status line

**Files:**
- Create: `src/lib/updater/version-note.ts`
- Create: `src/pages/settings/components/AppStatusLine.tsx` (export it from `./components` index)
- Modify: `src/hooks/useSilentUpdater.ts` (record the version on mount in `main`, Linux included, before the Linux early return)
- Modify: `src/pages/settings/index.tsx` (render `<AppStatusLine />` last)
- Modify: `src/config/constants.ts` (`STORAGE_KEYS.APP_LAST_VERSION: "app_last_version"`, `STORAGE_KEYS.APP_UPDATED_TO: "app_updated_to"`, `STORAGE_KEYS.TEAM_LAST_SYNCED_AT: "team_last_synced_at"`)
- Test: `src/tests/version-note.test.ts`, `src/tests/app-status-line.test.tsx`, `src/tests/use-silent-updater.test.tsx` (extend)

**Interfaces:**
- Produces:
  - `recordAppVersion(current: string, now: number): void`. If a stored last version exists and differs from `current`, write `APP_UPDATED_TO = JSON.stringify({ version: current, at: now })`. Always write `APP_LAST_VERSION = current`.
  - `readUpdatedNote(current: string): { version: string; at: number } | null`. Returns `null` unless the stored note's version equals `current`.
  - `STORAGE_KEYS.TEAM_LAST_SYNCED_AT`, written by Task 9.

The note goes in the Settings status line, not the overlay. The overlay is a 54 px bar and release builds have no console. (My call; spec "small note".)

- [ ] **Step 1: Write the failing tests**

```ts
it("first install records the version and shows no note", ...)        // recordAppVersion("1.6.0") -> readUpdatedNote("1.6.0") === null
it("same version again shows no note", ...)
it("a changed version shows the note once for that version", ...)       // stored 1.5.0 -> record 1.6.0 -> note {version:"1.6.0", at}
it("a stale note for another version is ignored", ...)                  // note 1.6.0, readUpdatedNote("1.6.1") === null
```
```tsx
// app-status-line.test.tsx (mock invoke get_app_version -> "1.6.0")
it("shows version, last update check and team sync when present", ...)
// text contains "Meetwings 1.6.0", "Last update check", "Team settings synced"; "never" when the check key is absent
it("hides the team line when never synced", ...)
it("shows 'Updated to 1.6.0' when the note matches", ...)
it("refreshes on a storage event from another window", ...)            // dispatch new StorageEvent("storage", { key: "updater_last_check_at" })
// use-silent-updater.test.tsx (extend)
it("records the app version in main on Linux too, and not in other windows", ...)
// isLinux true -> invoke("get_app_version") called, listen not called; label "dashboard" -> get_app_version not called
```

Both files call `installMemoryLocalStorage()` in `beforeEach`.

- [ ] **Step 2: Run to verify they fail**

Run: `npx vitest run src/tests/version-note.test.ts src/tests/app-status-line.test.tsx src/tests/use-silent-updater.test.tsx`
Expected: FAIL.

- [ ] **Step 3: Implement the functions, the component (dates via `toLocaleString()`, re-read on `window` `storage` events) and the hook call `invoke<string>("get_app_version").then(v => recordAppVersion(v, Date.now())).catch(() => {})`**

- [ ] **Step 4: Run tests and type-check**

Run: `npx vitest run src/tests/version-note.test.ts src/tests/app-status-line.test.tsx src/tests/use-silent-updater.test.tsx && npm run type-check`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/lib/updater/version-note.ts src/pages/settings src/hooks/useSilentUpdater.ts src/config/constants.ts src/tests/version-note.test.ts src/tests/app-status-line.test.tsx src/tests/use-silent-updater.test.tsx
git commit -m "feat(settings): app status line with update and team sync times"
```

---

## Part B — Team setup

### Task 5: Team link parser and AES-GCM crypto

**Files:**
- Create: `src/lib/team/team-link.ts`, `src/lib/team/team-crypto.ts`
- Test: `src/tests/team-link.test.ts`, `src/tests/team-crypto.test.ts`

**Interfaces:**
- Produces:
  - `interface TeamLink { gistId: string; key: string }`
  - `parseTeamLink(raw: string): TeamLink | null`
  - `buildTeamLink(link: TeamLink): string` returns `` `meetwings://team/${gistId}#${key}` ``
  - `parseGistRef(raw: string): string | null`. Accepts a bare id or `https://gist.github.com/<user>/<id>` (optional trailing `/`), and returns the id.
  - `shortGistId(gistId: string): string` returns the first 6 characters, for UI only.
  - `generateTeamKey(): string`: 32 random bytes, base64url without padding (43 chars).
  - `encryptTeamPayload(plaintext: string, key: string): Promise<string>` returns `` `mwt1.${b64url(iv12)}.${b64url(ciphertext)}` ``
  - `decryptTeamPayload(blob: string, key: string): Promise<string | null>` returns `null` on any failure and never throws.

Pinned shapes:
- Gist id: `/^[0-9a-f]{20,32}$/`.
- Key: `/^[A-Za-z0-9_-]{43}$/`.
- Parser: trim; strip one surrounding `<`…`>` pair; then match the whole string against `/^meetwings:\/\/team\/([0-9a-f]{20,32})\/?#([A-Za-z0-9_-]{43})$/`. The regex is the allowlist. Do not use `new URL()`. Parser errors never echo the input.
- Crypto: `crypto.subtle` AES-GCM with a 256-bit raw key and a fresh 12-byte IV from `crypto.getRandomValues` per call. If happy-dom lacks `crypto.subtle`, add `// @vitest-environment node` to the crypto test file.

- [ ] **Step 1: Write the failing tests**

```ts
const ID = "a".repeat(32), KEY = "A".repeat(43), LINK = `meetwings://team/${ID}#${KEY}`;
it("accepts a valid link", () => expect(parseTeamLink(LINK)).toEqual({ gistId: ID, key: KEY }));
it("accepts a trailing slash before the fragment", () => expect(parseTeamLink(`meetwings://team/${ID}/#${KEY}`)).not.toBeNull());
it("accepts surrounding whitespace, newline and <> wrapping", () => {   // Review Focus 2
  expect(parseTeamLink(`  ${LINK}\n`)).not.toBeNull();
  expect(parseTeamLink(`<${LINK}>`)).not.toBeNull();
});
it.each([
  ["http scheme", `http://team/${ID}#${KEY}`],
  ["gist web URL", `https://gist.github.com/u/${ID}`],
  ["wrong host", `meetwings://evil/${ID}#${KEY}`],
  ["no key", `meetwings://team/${ID}`],
  ["short key", `meetwings://team/${ID}#${KEY.slice(1)}`],
  ["uppercase id", `meetwings://team/${ID.toUpperCase()}#${KEY}`],
  ["short id", `meetwings://team/abc#${KEY}`],
  ["query", `meetwings://team/${ID}?x=1#${KEY}`],
  ["inner newline", `meetwings://team/${ID}\n#${KEY}`],
])("rejects %s", (_n, raw) => expect(parseTeamLink(raw)).toBeNull());
it("build -> parse round trip", () => expect(parseTeamLink(buildTeamLink({ gistId: ID, key: KEY }))).toEqual({ gistId: ID, key: KEY }));
it("parseGistRef takes a bare id or a gist URL", () => {
  expect(parseGistRef(ID)).toBe(ID);
  expect(parseGistRef(`https://gist.github.com/someone/${ID}/`)).toBe(ID);
  expect(parseGistRef("https://example.com/x")).toBeNull();
});

// team-crypto.test.ts
it("round trips", async () => { const k = generateTeamKey(); expect(await decryptTeamPayload(await encryptTeamPayload("hi", k), k)).toBe("hi"); });
it("uses a fresh IV each time", async () => { /* two encryptions of the same text differ */ });
it("generateTeamKey matches the key shape", () => expect(generateTeamKey()).toMatch(/^[A-Za-z0-9_-]{43}$/));
it("wrong key -> null", ...); it("tampered ciphertext -> null", ...);   // flip one char of the last segment
it("missing mwt1 prefix -> null", ...); it("malformed key -> null without throwing", ...);
```

- [ ] **Step 2: Run to verify they fail**

Run: `npx vitest run src/tests/team-link.test.ts src/tests/team-crypto.test.ts`
Expected: FAIL.

- [ ] **Step 3: Implement both modules**

- [ ] **Step 4: Run tests and type-check**

Run: `npx vitest run src/tests/team-link.test.ts src/tests/team-crypto.test.ts && npm run type-check`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/lib/team/team-link.ts src/lib/team/team-crypto.ts src/tests/team-link.test.ts src/tests/team-crypto.test.ts
git commit -m "feat(team): strict team link parser and AES-GCM payload crypto"
```

### Task 6: Team file schema, validation and owner export

**Files:**
- Create: `src/lib/team/team-file.ts`
- Test: `src/tests/team-file.test.ts`

**Interfaces:**
- Consumes: `AI_PROVIDERS` (`@/config/ai-providers.constants`), `SPEECH_TO_TEXT_PROVIDERS` (`@/config/stt.constants`), `parseSavedAiSelection` (`@/lib/storage/ai-providers`), `loadNotionToken` (`@/lib/notion/token`), `loadNotionConfig`, `parseNotionDatabaseId`, `Weekday` (`@/lib/storage/notion-config.storage`), `loadGoogleConfigState` (`@/lib/storage/google-config.storage`), `curl2Json` (`@bany/curl-to-json`), `TYPE_PROVIDER`.
- Produces:
  - `TEAM_FILE_VERSION = 1`
  - `interface TeamProviderSettings { provider: string; variables: Record<string, string>; custom?: TYPE_PROVIDER }`
  - `interface TeamFileV1 { version: 1; ai: TeamProviderSettings; stt: TeamProviderSettings; notion: { token: string; meetingsDbUrl: string; knowledgeDbUrl?: string; teamTimes?: Partial<Record<Weekday, string>> }; google: { clientId: string; clientSecret: string } }`
  - `type TeamErrorCode = "TEAM_LINK_INVALID" | "TEAM_FETCH_FAILED" | "TEAM_DECRYPT_FAILED" | "TEAM_FILE_INVALID" | "TEAM_FILE_TOO_NEW" | "TEAM_FIELD_MISSING" | "TEAM_WRITE_FAILED" | "TEAM_KEY_INLINE"`
  - `TEAM_COPY: Record<TeamErrorCode, string>`, fixed text, e.g. `TEAM_FETCH_FAILED: "Couldn't reach the team settings. Check your connection and try the link again."`
  - `type TeamResult<T> = { ok: true; value: T } | { ok: false; code: TeamErrorCode }`
  - `parseTeamFile(json: string): TeamResult<TeamFileV1>`
  - `validateTeamFile(file: TeamFileV1): TeamErrorCode | null`
  - `exportTeamSettings(): Promise<TeamResult<TeamFileV1>>`

Pinned rules:
- `parseTeamFile`:
  - Bad JSON or a non-object → `TEAM_FILE_INVALID`.
  - `version`: not a number → `TEAM_FILE_INVALID`. `> 1` → `TEAM_FILE_TOO_NEW`. `!== 1` → `TEAM_FILE_INVALID`.
  - Types: wrong types (`variables` must be `Record<string,string>`; `teamTimes` keys must be `Weekday` with string values) → `TEAM_FILE_INVALID`.
  - Unknown extra fields are ignored.
  - Then `validateTeamFile`.
- `validateTeamFile`:
  - **Required fields.** Each of these must be non-empty after trim, else `TEAM_FIELD_MISSING`: `ai.provider`, `ai.variables.api_key`, `stt.provider`, `stt.variables.api_key`, `notion.token`, `notion.meetingsDbUrl`, `google.clientId`, `google.clientSecret`.
  - **Notion link.** `parseNotionDatabaseId(meetingsDbUrl) === null` → `TEAM_FILE_INVALID`.
  - **Provider known.** A provider must be a built-in id, or have `custom` with `custom.id === provider`, string `name`/`curl`/`responseContentPath`, boolean `isStreaming`, and a `curl` that `curl2Json` parses. Anything else → `TEAM_FILE_INVALID`.
- `exportTeamSettings`:
  - **AI provider.** Parse `STORAGE_KEYS.SELECTED_AI_PROVIDER` with `parseSavedAiSelection`, using `[...AI_PROVIDERS, ...custom list parsed from STORAGE_KEYS.CUSTOM_AI_PROVIDERS]`. Copy all its `variables`. Include `custom` when the id is in the custom list.
  - **STT provider.** Same steps for STT, using `SELECTED_STT_PROVIDER` / `CUSTOM_SPEECH_PROVIDERS` / `SPEECH_TO_TEXT_PROVIDERS`.
  - **Notion.** `token` comes from `loadNotionToken()`. Links and `teamTimes` come from `loadNotionConfig()`. Never export `yourName`. Omit `knowledgeDbUrl` when blank.
  - **Google.** The `complete` config from `loadGoogleConfigState()`. Otherwise use empty strings, which then fail as `TEAM_FIELD_MISSING`.
  - **Inline key.** Return `TEAM_KEY_INLINE` for each included `custom` whose `curl` lacks `{{API_KEY}}`, or contains the non-empty `variables.api_key` value literally.
  - **Validate.** Finally run `validateTeamFile`.

- [ ] **Step 1: Write the failing tests**

Mock `@/lib/notion/token`, `@/lib/storage/notion-config.storage` (keep the real `parseNotionDatabaseId` via `vi.importActual`) and `@/lib/storage/google-config.storage`. Seed localStorage through `installMemoryLocalStorage()` (Task 3). `ownerSeed()` writes the selected AI (`openai`, `{api_key:"sk-owner", model:"gpt-x"}`), the selected STT, a token, Notion config `{meetingsDbUrl: <valid notion url>, knowledgeDbUrl:"", teamTimes:{monday:"09:00"}, yourName:"Owner"}` and a complete Google config. `Weekday` keys are full names (`src/lib/storage/notion-config.storage.ts:14-21`).

```ts
it("exports owner settings that parse back identically and carry no yourName", async () => {
  ownerSeed(); const r = await exportTeamSettings(); expect(r.ok).toBe(true);
  const back = parseTeamFile(JSON.stringify((r as any).value)); expect(back).toEqual(r);
  expect(JSON.stringify(r)).not.toContain("Owner"); expect((r as any).value.notion.knowledgeDbUrl).toBeUndefined();
});
it.each(["ai key", "notion token", "google config"])("export refuses when %s is empty -> TEAM_FIELD_MISSING", ...);
it("export refuses a custom provider whose curl has the key inline", ...);         // curl without {{API_KEY}} -> TEAM_KEY_INLINE
it("export refuses a custom provider whose curl contains the key value", ...);     // has {{API_KEY}} AND "sk-owner" -> TEAM_KEY_INLINE
it("export includes the custom definition for a selected custom provider", ...);
it("parse: invalid JSON -> TEAM_FILE_INVALID", ...);
it("parse: version 2 -> TEAM_FILE_TOO_NEW; version '1' -> TEAM_FILE_INVALID", ...);
it("parse: whitespace-only notion token -> TEAM_FIELD_MISSING", ...);
it("parse: unknown provider without custom -> TEAM_FILE_INVALID", ...);
it("parse: custom id that does not match provider -> TEAM_FILE_INVALID", ...);
it("parse: meetings link that is not a Notion database -> TEAM_FILE_INVALID", ...);
it("parse: unknown extra fields are ignored", ...);
```

- [ ] **Step 2: Run to verify they fail**

Run: `npx vitest run src/tests/team-file.test.ts`
Expected: FAIL.

- [ ] **Step 3: Implement `team-file.ts`**

- [ ] **Step 4: Run tests and type-check**

Run: `npx vitest run src/tests/team-file.test.ts && npm run type-check`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/lib/team/team-file.ts src/tests/team-file.test.ts
git commit -m "feat(team): team file schema, validation and owner export"
```

### Task 7: Gist fetch

**Files:**
- Create: `src/lib/team/team-fetch.ts`
- Test: `src/tests/team-fetch.test.ts`

**Interfaces:**
- Consumes: `TeamResult`, `TeamErrorCode` (Task 6), `fetch` from `@tauri-apps/plugin-http`.
- Produces: `GIST_API_BASE = "https://api.github.com/gists/"`, `TEAM_FETCH_TIMEOUT_MS = 15_000`, `fetchTeamBlob(gistId: string): Promise<TeamResult<string>>`

Pinned:
- **Id check.** A gist id that fails `/^[0-9a-f]{20,32}$/` → `TEAM_LINK_INVALID` with no request.
- **Request.** `tauriFetch(GIST_API_BASE + gistId, { method: "GET", headers: { Accept: "application/vnd.github+json", "X-GitHub-Api-Version": "2022-11-28" }, maxRedirections: 0, connectTimeout: TEAM_FETCH_TIMEOUT_MS, signal })`.
- **Overall bound.** `connectTimeout` does not cover a response that stalls after connecting, and `syncTeam` calls are serialized, so one hang would block every later sync, a confirm-join included. Race the whole request and body read against a `TEAM_FETCH_TIMEOUT_MS` timer. When the timer wins, abort the `AbortController` behind `signal` and return `TEAM_FETCH_FAILED`.
- **Fetch failures.** All of these → `TEAM_FETCH_FAILED`: a throw, the timeout, any status other than 200, a body that is not JSON, or a JSON body whose `files` is not a non-null object.
- **File pick.** Skip entries whose `content` is not a string. Take the files whose `content.trim()` starts with `"mwt1."`. Exactly one → return its trimmed content. Zero, more than one, or `truncated === true` on the chosen file → `TEAM_FILE_INVALID`.
- **No logging.** Nothing is logged with the id or URL.

- [ ] **Step 1: Write the failing tests**

```ts
const ID = "b".repeat(32);
it("returns the blob and calls only the gist API with redirects off", async () => {
  // mock fetch -> 200 { files: { "team.txt": { content: "mwt1.x.y", truncated: false } } }
  // expect value "mwt1.x.y"; expect fetch called with (GIST_API_BASE + ID, objectContaining({ maxRedirections: 0,
  //   connectTimeout: TEAM_FETCH_TIMEOUT_MS, headers: objectContaining({ Accept: "application/vnd.github+json" }) }))
});
it.each([404, 500, 301])("status %i -> TEAM_FETCH_FAILED", ...);
it("network error -> TEAM_FETCH_FAILED", ...);
it("a response that never finishes -> TEAM_FETCH_FAILED after TEAM_FETCH_TIMEOUT_MS and the signal is aborted", ...);  // fake timers; json() never resolves
it("200 with a body that is not JSON -> TEAM_FETCH_FAILED", ...);
it.each([{}, { files: null }, { files: "x" }])("200 with malformed files %j -> TEAM_FETCH_FAILED, no throw", ...);
it("a file whose content is not a string is skipped", ...);       // { a: { content: null }, b: { content: "mwt1.x.y" } } -> "mwt1.x.y"
it("picks the mwt1 file next to a README and trims the trailing newline", ...);  // Review Focus 3
it("two mwt1 files -> TEAM_FILE_INVALID", ...);
it("no files -> TEAM_FILE_INVALID", ...); it("truncated file -> TEAM_FILE_INVALID", ...);
it("malformed gist id -> TEAM_LINK_INVALID and no request", ...);
```

- [ ] **Step 2: Run to verify they fail**

Run: `npx vitest run src/tests/team-fetch.test.ts`
Expected: FAIL.

- [ ] **Step 3: Implement `fetchTeamBlob`**

- [ ] **Step 4: Run tests and type-check**

Run: `npx vitest run src/tests/team-fetch.test.ts && npm run type-check`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/lib/team/team-fetch.ts src/tests/team-fetch.test.ts
git commit -m "feat(team): fetch the encrypted team blob from a secret gist"
```

### Task 8: Change-only apply with first-join rollback

**Files:**
- Create: `src/lib/team/team-apply.ts`
- Create: `src/tests/team-test-utils.ts` (shared storage fakes, reused by Tasks 9 and 13)
- Modify: `src/lib/storage/secure-provider-configs.ts:20-21` (export `AI_CONFIGS_KEY`, `STT_CONFIGS_KEY`)
- Test: `src/tests/team-apply.test.ts`

**Interfaces:**
- Consumes: `TeamFileV1`, `TeamErrorCode` (Task 6). `buildTeamLink`, `TeamLink` (Task 5). `resetSecureProviderConfigsCache`, `AI_CONFIGS_KEY`, `STT_CONFIGS_KEY`. `secureGet`, `secureSet`, `secureDelete` (`@/lib/secure-storage`). `loadNotionToken`, `saveNotionToken`, `clearNotionToken`. `loadNotionConfig`, `saveNotionConfig`, `SECURE_NOTION_CONFIG_KEY`. `loadGoogleConfigState`, `saveGoogleConfig`, `SECURE_GOOGLE_CONFIG_KEY`. `safeLocalStorage`, `STORAGE_KEYS`. `installMemoryLocalStorage` (Task 3, tests only).
- Produces:
  - `TEAM_LINK_SECURE_KEY = "team_link"`. It lives here, not in `team-sync`, so the link write can be an undoable apply step without an import cycle. Task 9 imports it.
  - `interface ApplyOutcome { changed: boolean; googleClientChanged: boolean }`
  - `type ApplyResult = { ok: true; value: ApplyOutcome } | { ok: false; code: TeamErrorCode; landed: boolean; googleClientChanged: boolean }`. `landed` is true when a write stays in storage after the failure.
  - `applyTeamFile(file: TeamFileV1, opts: { firstJoin: false } | { firstJoin: true; link: TeamLink }): Promise<ApplyResult>`
  - The test util: `createTeamStorageFake()` returns `{ secure: Map<string, string>; local: Map<string, string>; keychain: { token: string | null }; invoke: (cmd: string, args?: any) => Promise<unknown>; secureModule: { secureGet; secureSet; secureDelete; secureHas }; snapshot(): string; failWhen(pred: (op: string, key?: string) => boolean): void }`. `local` is the Map returned by `installMemoryLocalStorage()`, which the fake calls itself. `failWhen` covers localStorage writes too (`op` `"localSet"` / `"localRemove"`). Test files wire it with `vi.hoisted` + `vi.mock("@/lib/secure-storage")` and `vi.mock("@tauri-apps/api/core")`. The fake `invoke` handles `notion_token_get`, `notion_token_set`, `notion_token_clear`, `notion_keychain_available` and `google_disconnect`. `snapshot()` is the JSON of the secure map, every `local` entry and the token.

Algorithm, pinned:
1. **Snapshot before any write.** Read the Notion token, the raw `AI_CONFIGS_KEY`/`STT_CONFIGS_KEY`/`SECURE_GOOGLE_CONFIG_KEY`/`SECURE_NOTION_CONFIG_KEY`/`TEAM_LINK_SECURE_KEY` values, `loadGoogleConfigState()`, `loadNotionConfig()` (a throw means unreadable, treated as `null`), and the raw localStorage `CUSTOM_AI_PROVIDERS`, `CUSTOM_SPEECH_PROVIDERS`, `SELECTED_AI_PROVIDER`, `SELECTED_STT_PROVIDER`. If a snapshot read throws → `TEAM_WRITE_FAILED`, nothing written, `landed: false`. Never call `loadNotionConfigState` (it stamps `NOTION_SETUP_AT`).
2. **Targets.**
   - AI variables: the merge base is the stored selection's `variables` when `SELECTED_AI_PROVIDER` parses and its provider equals `file.ai.provider`. AppContext keeps the live values of the active provider there and writes the secure blob only on switch-away (`app.context.tsx:526-534`, `:581-596`). Otherwise the base is `storedAiConfigs[file.ai.provider] ?? {}`. Then `aiVars = { ...base, ...file.ai.variables }`. STT the same way.
   - AI secure blob: `JSON.stringify({ ...storedAiConfigs, [file.ai.provider]: aiVars })`, where `storedAiConfigs` is the snapshot's raw value parsed (unparseable or `null` → `{}`). Never write it through `saveSecureAIConfig`. That function rewrites the whole blob from the window's in-memory cache (`secure-provider-configs.ts:94-97`, `:168-181`). `main` loaded that cache at startup, so an unattended sync would revert keys the user saved since then in the dashboard. STT the same way.
   - Custom lists: upsert `{ ...file.ai.custom, isCustom: true }` by id only when `custom` is present.
   - Selections: `{ provider, variables: aiVars }`.
   - Notion blob: `{ ...(current ?? EMPTY), meetingsDbUrl, knowledgeDbUrl: file value ?? current, teamTimes: file value ?? current, yourName: current?.yourName ?? "" }`.
3. **Steps.** Build an ordered list of `{ run, undo }`, including only steps whose target differs from the snapshot (compare with `JSON.stringify`). Order: secrets first, then configs that reference them.
   1. Notion token: run `saveNotionToken`; undo restores the old one or calls `clearNotionToken`.
   2. AI secure blob: run `secureSet(AI_CONFIGS_KEY, target)`; undo restores the raw value (`secureSet`, or `secureDelete` if it was `null`).
   3. STT secure blob: same as AI.
   4. Google config: run `saveGoogleConfig`; undo restores the raw value.
   5. Custom AI list: localStorage; undo restores the raw value or removes the key.
   6. Custom STT list: same as AI.
   7. Selected AI: localStorage; undo restores the raw value.
   8. Selected STT: same as AI.
   9. Notion blob: run `saveNotionConfig`; undo restores the raw value.
   10. Team link, only when `firstJoin`: `secureSet(TEAM_LINK_SECURE_KEY, buildTeamLink(opts.link))`; undo restores the raw value (a switch) or deletes it. It is last, so a stored link always means every setting landed.
4. **Run in order.** After any run, success or failure, call `resetSecureProviderConfigsCache()` when step 2 or 3 ran, so the next reader reloads the raw blob. On the first rejection:
   - If `firstJoin`, run the undos of the completed steps in reverse, each in its own try/catch. `landed` is true only if an undo itself failed.
   - If not `firstJoin`, keep what landed: `landed` is true when any step completed.
   - Return `TEAM_WRITE_FAILED`. Later steps are not attempted.
5. **Google client change.** `googleClientChanged` is true when the old Google state was `complete`, its `clientId !== file.google.clientId`, and step 4 completed and was not undone. In that case call `invoke("google_disconnect")` best effort, after all steps succeed or, on a later-sync failure, after the failing step. A first-join rollback restores the old client, so there is no disconnect.
6. **Result.** Return `{ ok: true, value: { changed: steps.length > 0, googleClientChanged } }`, or the failure with `landed` and `googleClientChanged`.

- [ ] **Step 1: Write the failing tests**

```ts
it("applies every covered field on an empty install", ...)
// token, AI secure config incl api_key, SELECTED_AI_PROVIDER {provider, variables}, STT both, google config, notion blob {meetingsDbUrl, yourName: ""}
it("keeps a typed yourName and leaves uncovered settings untouched", ...)
// pre-seed notion yourName "Ana", localStorage system_prompt "x", secure "odoo_config" "y" -> all unchanged
it("a no-op re-apply writes nothing", ...)
// apply twice; spy secureSet / localStorage.setItem / invoke("notion_token_set") call counts after the 2nd === after the 1st
it("re-applies only the field a colleague edited (file wins)", ...)
// apply, change AI key locally, apply again -> only AI secure + selection writes happen
it("absent optional fields keep local values", ...)
// local knowledgeDbUrl + teamTimes + model; file without them -> kept
it("first join: a write failing mid-apply restores storage byte-identically", ...)
// failWhen(op === "secureSet" && key === AI_CONFIGS_KEY); before = snapshot(); result TEAM_WRITE_FAILED; snapshot() === before
it("first join: a failing link write rolls back every setting and stores no link", ...)
// failWhen(op === "secureSet" && key === TEAM_LINK_SECURE_KEY); snapshot() === before; landed false
it("later sync: a failing write keeps earlier writes, attempts no later ones and reports landed", ...)
// firstJoin false; failWhen google config write -> token + AI + STT written; selections and notion blob untouched; landed true
it("later sync: a failure after the Google step still clears the old sign-in", ...)
// firstJoin false; new clientId; failWhen notion blob write -> google_disconnect called; result googleClientChanged true
it("writes the raw provider blob, not the stale in-memory cache", ...)
// loadSecureAIConfigs() caches {}; then secure AI_CONFIGS_KEY gets {groq:{api_key:"g"}} behind the cache's back;
// apply openai -> stored blob has both groq and openai; resetSecureProviderConfigsCache called
it("merges on top of the active selection's variables", ...)
// SELECTED_AI_PROVIDER {provider:"openai", variables:{model:"local-m"}}; blob openai {model:"old"}; file without model -> model "local-m"
it("replaces an unreadable notion blob with team fields and a blank yourName", ...)
it("a changed Google client id clears the sign-in; the same id does not", ...)
it("never stamps NOTION_SETUP_AT", ...)
```

- [ ] **Step 2: Run to verify they fail**

Run: `npx vitest run src/tests/team-apply.test.ts`
Expected: FAIL.

- [ ] **Step 3: Implement `applyTeamFile` and the test util; export the two config keys**

- [ ] **Step 4: Run tests (plus the existing secure-config suite) and type-check**

Run: `npx vitest run src/tests/team-apply.test.ts src/tests/secure-provider-configs.test.ts && npm run type-check`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/lib/team/team-apply.ts src/lib/storage/secure-provider-configs.ts src/tests/team-test-utils.ts src/tests/team-apply.test.ts
git commit -m "feat(team): change-only apply with first-join rollback"
```

### Task 9: Sync orchestration and secret-redaction tests

**Files:**
- Create: `src/lib/team/team-sync.ts`
- Modify: `src/config/constants.ts` (`TEAM_SETTINGS_APPLIED_EVENT = "team-settings-applied"`, a new top-level export)
- Test: `src/tests/team-sync.test.ts`, `src/tests/team-redact.test.ts`

**Interfaces:**
- Consumes: `parseTeamLink`, `buildTeamLink`, `decryptTeamPayload`, `encryptTeamPayload` (Task 5). `parseTeamFile`, `exportTeamSettings` (Task 6). `fetchTeamBlob` (Task 7). `applyTeamFile`, `ApplyOutcome`, `ApplyResult`, `TEAM_LINK_SECURE_KEY` (Task 8). `NOTION_CONFIG_CHANGED_EVENT`, `broadcastGoogleConnectionChanged`, `STORAGE_KEYS.TEAM_LAST_SYNCED_AT` (Task 4).
- Produces:
  - `TEAM_OWNER_KEY_SECURE_KEY = "team_owner_key"`, `TEAM_OWNER_GIST_SECURE_KEY = "team_owner_gist_id"`. Re-export `TEAM_LINK_SECURE_KEY`.
  - `TEAM_SETTINGS_APPLIED_EVENT = "team-settings-applied"`, a new top-level export in `src/config/constants.ts`. That file has no other event constants. The existing ones live in their storage modules.
  - `loadStoredTeamLink(): Promise<TeamLink | null>`, which parses the stored link with `parseTeamLink`
  - `loadOwnerTeamLink(): Promise<TeamLink | null>`, built from the owner key and gist id
  - `fetchTeamFile(link: TeamLink): Promise<TeamResult<TeamFileV1>>`. Steps: `fetchTeamBlob`, then decrypt (`null` → `TEAM_DECRYPT_FAILED`), then `parseTeamFile`.
  - `syncTeam(link: TeamLink, opts: { firstJoin: boolean }): Promise<ApplyResult>`. A fetch failure returns `{ ok: false, code, landed: false, googleClientChanged: false }`.
  - `leaveTeam(): Promise<void>`. Deletes `TEAM_LINK_SECURE_KEY` and removes `TEAM_LAST_SYNCED_AT`. Settings stay as they are.
  - `__resetTeamSyncForTests(): void`, which resets the promise chain.

`syncTeam`, pinned:
- **Serialized and never rejects.** Calls queue through a module promise chain, `chain = chain.then(run, run)`, so two calls never overlap and one failure never poisons the next. The body is wrapped in try/catch. An unexpected throw maps to `TEAM_WRITE_FAILED` with `landed: true`, because the caller cannot know what landed.
- **Fetch fails** → return the code. Nothing is written.
- **Apply.** `applyTeamFile(file, firstJoin ? { firstJoin: true, link } : { firstJoin: false })`. The link write is the last apply step, so its failure rolls back the whole join.
- **Apply fails** → return the failure and do not stamp last synced. If `landed`, emit the events below anyway, so other windows drop stale caches and forms.
- **On success:**
  1. Set `TEAM_LAST_SYNCED_AT = String(Date.now())`.
  2. If `changed`, emit the events.
- **Events.** Emit `TEAM_SETTINGS_APPLIED_EVENT` and `NOTION_CONFIG_CHANGED_EVENT`, and call `broadcastGoogleConnectionChanged()`. Each is best effort.
- **Logging.** Only `console.warn("[team] sync failed:", code)`.

- [ ] **Step 1: Write the failing sync tests**

Use `createTeamStorageFake` (Task 8) and mock `@tauri-apps/plugin-http` `fetch` and `@tauri-apps/api/event` `emit`. Call `__resetTeamSyncForTests()` in `beforeEach`. Build a real encrypted blob with a test key from a valid `TeamFileV1`.

```ts
it.each([
  ["HTTP 404", setup404], ["network error", setupNetworkError], ["wrong key", setupWrongKey],
  ["not JSON inside", setupGarbagePayload], ["version 2", setupVersion2], ["missing required field", setupMissingToken],
])("%s leaves storage byte-identical and stores no link", async (_n, setup) => {
  const before = fake.snapshot(); setup(); const r = await syncTeam(link, { firstJoin: true });
  expect(r.ok).toBe(false); expect(fake.snapshot()).toBe(before);
});
it("first join success stores the link, stamps last synced and emits the three events once", ...);
it("a no-op re-sync stamps last synced and emits nothing", ...);
it("later sync: an apply failure stamps no last synced and still emits the events when something landed", ...);
// seed TEAM_LAST_SYNCED_AT absent; firstJoin false; failWhen notion blob write -> key still absent; emit TEAM_SETTINGS_APPLIED_EVENT called
it("two concurrent syncs run one after the other", ...);   // second fetch starts only after the first resolves
it("a sync whose body throws resolves TEAM_WRITE_FAILED and the next sync still runs", ...);
// mock applyTeamFile to throw once -> first result {ok:false, code:"TEAM_WRITE_FAILED"}; second syncTeam resolves normally
it("leaveTeam deletes the link and last-synced and keeps settings", ...);
it("Copy -> apply round trip reproduces the owner's settings", ...);
// owner storage -> exportTeamSettings -> encryptTeamPayload -> gist mock returns blob -> wipe storage -> syncTeam -> AI/STT/notion/google equal owner's
```

- [ ] **Step 2: Write the failing redaction test**

Follow the pattern in `src/tests/odoo-redact.test.ts`. Use sentinels such as `SENTINEL_AI_KEY_7f3`, `SENTINEL_STT_KEY_9a1`, `SENTINEL_NOTION_TOKEN_2c8`, `SENTINEL_GOOGLE_SECRET_5d4`, and a sentinel gist id (hex) and link key (43 chars). Spy on `console.error/warn/log/info/debug`. Force each error path:
- fetch rejects with `new Error("GET https://api.github.com/gists/<sentinel id> failed")`
- decrypt fails
- parse fails
- `notion_token_set` rejects with an error whose message contains the token sentinel

```ts
it.each(paths)("%s leaks no sentinel to console or the result", async (_n, force) => {
  force(); const r = await syncTeam(sentinelLink, { firstJoin: true });
  const out = JSON.stringify(r) + allConsoleArgs();
  for (const s of SENTINELS) expect(out).not.toContain(s);
});
```

- [ ] **Step 3: Run to verify they fail**

Run: `npx vitest run src/tests/team-sync.test.ts src/tests/team-redact.test.ts`
Expected: FAIL.

- [ ] **Step 4: Implement `team-sync.ts` and add the event constant**

- [ ] **Step 5: Run tests and type-check**

Run: `npx vitest run src/tests/team-sync.test.ts src/tests/team-redact.test.ts && npm run type-check`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add src/lib/team/team-sync.ts src/config/constants.ts src/tests/team-sync.test.ts src/tests/team-redact.test.ts
git commit -m "feat(team): sync orchestration that keeps the last good settings on failure"
```

### Task 10: Google profile name and shared connect helper

**Files:**
- Modify: `src-tauri/src/google/auth.rs:7` (scopes) and add `name_from_id_token` next to `email_from_id_token` (`:66`)
- Modify: `src-tauri/src/google/mod.rs:349-431` (`google_connect` return type)
- Modify: `src-tauri/src/graph/mod.rs:886` (add the new struct to the credential-scan `payloads` vec)
- Modify: `src/types/calendar.ts:88` (add `GoogleConnectResult` next to `GraphStatus`)
- Modify: `src/lib/calendar/google-connect.ts`
- Modify: `src/pages/odoo/components/GoogleCalendarCard.tsx:52-75`
- Test: Rust tests in `auth.rs`. `src/tests/google-connect.test.ts`, `src/tests/google-calendar-card.test.tsx` (keep them passing).

**Interfaces:**
- Produces:
  - Rust: `GOOGLE_SCOPES = "openid email profile https://www.googleapis.com/auth/calendar.events.readonly"`. `pub fn name_from_id_token(id_token: &str) -> Option<String>`: the `name` claim via `oauth::id_token_claims`, trimmed, `None` when absent, blank or not a string. `#[serde(rename_all = "camelCase")] pub struct GoogleConnectResult { pub connected: bool, pub session_only: bool, pub name: Option<String> }`, returned by `google_connect` from `state.status()` plus the name.
  - TS: `interface GoogleConnectResult { connected: boolean; sessionOnly: boolean; name: string | null }`
  - `connectGoogle(config: GoogleConfig): Promise<{ ok: true; status: GraphStatus } | { ok: false; code: GoogleErrorCode }>`. It runs `saveGoogleConfig(config)`, then `invoke<GoogleConnectResult>("google_connect", { clientId, clientSecret })`, then on success `fillYourNameIfBlank(result.name)`. It calls `broadcastGoogleConnectionChanged()` in `finally`. Errors map through `toGoogleCode`.
  - `reconnectGoogle()` keeps its signature. It loads the saved config, returns `GOOGLE_AUTH_REJECTED` when it is not `complete`, and otherwise delegates to `connectGoogle`.
  - `fillYourNameIfBlank(name: string | null): Promise<void>` (exported for tests). It never rejects. It does nothing when `name` is blank, when `loadNotionConfig()` throws or returns `null`, or when `yourName.trim() !== ""`. Otherwise it runs `saveNotionConfig({ ...cfg, yourName: name.trim() })`, then emits `NOTION_CONFIG_CHANGED_EVENT` (best effort). A mounted Notion card picks the name up (Task 12). It does not emit `TEAM_SETTINGS_APPLIED_EVENT`. On a plain manual connect, that event would make the Notion card fully reload and wipe the user's unsaved link edits. A save failure logs `console.warn("[google] name fill failed")` and is swallowed, so a successful connect never turns into an error.

- [ ] **Step 1: Write the failing Rust tests in `auth.rs`**

```rust
#[test] fn scopes_include_profile() { assert!(GOOGLE_SCOPES.split(' ').any(|s| s == "profile")); }
#[test] fn name_from_id_token_reads_the_name_claim() { /* token with {"name":" Ana Lima "} -> Some("Ana Lima") */ }
#[test] fn name_from_id_token_is_none_without_a_usable_name() { /* absent, "", "   ", 42 -> None */ }
```
Build test tokens the same way the existing `email_from_id_token` tests do.

- [ ] **Step 2: Run to verify they fail**

Run: `cargo test --manifest-path src-tauri/Cargo.toml google::auth`
Expected: FAIL.

- [ ] **Step 3: Implement the Rust changes and add `GoogleConnectResult` to the `payloads` scan vec**

Run: `cargo test --manifest-path src-tauri/Cargo.toml google:: graph::tests`
Expected: PASS, including `no_exposed_command_return_type_serializes_a_credential`.

- [ ] **Step 4: Write the failing TS tests (extend `google-connect.test.ts`)**

```ts
it("fills a blank yourName from the Google name and tells other windows", ...)
// invoke google_connect -> {connected:true, sessionOnly:false, name:"Ana"}; notion cfg yourName "" -> saved "Ana"; emit called with NOTION_CONFIG_CHANGED_EVENT, never TEAM_SETTINGS_APPLIED_EVENT
it("a failing name save still returns ok", ...)        // saveNotionConfig rejects -> connectGoogle resolves { ok: true }
it("keeps a typed yourName", ...)
it("leaves yourName blank when the sign-in has no name", ...)
it("skips the name when the notion config is unreadable but still connects", ...)
it("a rejected connect returns the code, still broadcasts, and writes no name", ...)
it("reconnectGoogle delegates to connectGoogle with the saved config", ...)
```

- [ ] **Step 5: Implement the helper and switch `GoogleCalendarCard.handleConnect` to `connectGoogle(form.config)`**

`handleConnect` now: classify the form (incomplete → `INCOMPLETE`), set busy, call `connectGoogle`, then on ok `setStatus(r.status)`, else `setError(GOOGLE_COPY[r.code])`, then clear busy. The inline `invoke` and `broadcast()` calls go, because the helper does both.

- [ ] **Step 6: Run tests and type-check**

Run: `npx vitest run src/tests/google-connect.test.ts src/tests/google-calendar-card.test.tsx && npm run type-check`
Expected: PASS. Update card test assertions that pinned the old inline invoke order, without changing what they prove.

- [ ] **Step 7: Commit**

```bash
git add src-tauri/src/google src-tauri/src/graph/mod.rs src/types/calendar.ts src/lib/calendar/google-connect.ts src/pages/odoo/components/GoogleCalendarCard.tsx src/tests/google-connect.test.ts src/tests/google-calendar-card.test.tsx
git commit -m "feat(google): profile scope fills a blank Notion name; shared connect helper"
```

### Task 11: Per-send page ref for shared Notion tokens

**Files:**
- Modify: `src/lib/notion/page-blocks.ts` (add the ref helpers)
- Modify: `src/lib/notion/same-meeting.ts:21-33` (`Candidate`), `:158-186` (`readCandidate`)
- Modify: `src/lib/notion/send.ts:220-231` (`isThisSendsPage`), `:259-264` (create), `:275` (body)
- Test: `src/tests/notion-page-blocks.test.ts`, `src/tests/notion-same-meeting.test.ts`, `src/tests/notion-send.test.ts` (extend)

**Interfaces:**
- Produces:
  - `SEND_REF_PREFIX = "Meetwings ref "`
  - `sendRefOf(sendId: string): string` returns `sendId.replace(/-/g, "").toLowerCase().slice(0, 12)`. Send ids are `crypto.randomUUID()` (`src/lib/notion/actions.ts:78`), so the result is always 12 hex characters.
  - `sendRefBlock(sendId: string): NotionBlockInput`: a `paragraph` with one rich-text item, content `SEND_REF_PREFIX + sendRefOf(sendId)`, annotation `color: "gray"`
  - `Candidate.sendRef: string | null`. Set from `children[0]` only: a `paragraph` whose plain text matches `/^Meetwings ref ([0-9a-f]{12})$/`. Otherwise `null`.

Pinned:
- In `send.ts`, build `const blocks = [sendRefBlock(sendId), ...buildPageBlocks(summary, attendees)]` once. Use it for both the create (`batchBlocks(blocks)[0]`) and `appendResumable(..., blocks, ...)`, so the resume compare stays block-for-block.
- `isThisSendsPage(c) = s.create_started_at !== null && (c.sendRef !== null ? c.sendRef === sendRefOf(sendId) : legacyRule(c))`. `legacyRule` is today's creator + 60 s span + bold title check, unchanged, for pages made before this change.
- Replace the `ponytail:` collision comment (`:223-224`). The new comment says marked pages are proven by ref and unmarked legacy pages keep the old rule. Add a `ponytail:` note: a send interrupted across an app update resumes against legacy blocks and fails as `NOTION_PAGE_CHANGED`. The 30-minute install gate makes this rare.
- `boldTitleOf` and `headingsOf` are unaffected: the ref paragraph sits before the "Meeting Notes" heading and is not a `heading_3`.

- [ ] **Step 1: Write the failing tests**

```ts
// notion-page-blocks.test.ts
it("sendRefOf strips dashes and keeps 12 lowercase hex", () => expect(sendRefOf("ABCDEF12-3456-7890-abcd-ef1234567890")).toBe("abcdef123456"));
it("sendRefBlock is a gray paragraph with the prefix", ...);
// notion-same-meeting.test.ts
it("reads sendRef from the first block", ...); it("sendRef is null without a marker", ...); it("a marker that is not first is ignored", ...);
// notion-send.test.ts
it("the create writes the ref block first", ...);   // createPage children[0] equals sendRefBlock(sendId)
it("two installs on one token never adopt or trash each other's page, and the judge still merges", ...);
// same me.id, same title, same span; existing candidate carries another send's ref ->
// not patched as own page, trashPage not called for it in the recheck, sameMeeting called -> finish "already"
it("an unmarked legacy page of this send is still adopted", ...);
```
Update existing `notion-send` assertions that pin the exact create/append block lists to expect the leading ref block.

- [ ] **Step 2: Run to verify they fail**

Run: `npx vitest run src/tests/notion-page-blocks.test.ts src/tests/notion-same-meeting.test.ts src/tests/notion-send.test.ts`
Expected: FAIL.

- [ ] **Step 3: Implement**

- [ ] **Step 4: Run tests and type-check**

Run: `npx vitest run src/tests/notion-page-blocks.test.ts src/tests/notion-same-meeting.test.ts src/tests/notion-send.test.ts && npm run type-check`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/lib/notion src/tests/notion-page-blocks.test.ts src/tests/notion-same-meeting.test.ts src/tests/notion-send.test.ts
git commit -m "fix(notion): prove page ownership by per-send ref so shared tokens don't collide"
```

### Task 12: Settings consumers reload on `team-settings-applied`

**Files:**
- Modify: `src/contexts/app.context.tsx` (new listener effect near `:499-521`)
- Modify: `src/pages/odoo/components/NotionSettingsCard.tsx:61-83`
- Modify: `src/pages/odoo/components/GoogleCalendarCard.tsx:27-50`
- Test: `src/tests/team-settings-applied-consumers.test.tsx`

**Interfaces:**
- Consumes: `TEAM_SETTINGS_APPLIED_EVENT` (Task 9), `GOOGLE_CONNECTION_CHANGED_EVENT`, `resetSecureProviderConfigsCache`, `loadSecureAIConfigs`, `loadSecureSTTConfigs`.
- Produces: no new exports.

Pinned:
- AppContext: `listen(TEAM_SETTINGS_APPLIED_EVENT, async () => { resetSecureProviderConfigsCache(); await Promise.all([loadSecureAIConfigs(), loadSecureSTTConfigs()]); loadData(); })`. Register it with the cancelled-flag pattern and `[]` deps (same reasoning as `pages/app/index.tsx:149-156`).
- NotionSettingsCard: move the mount load into `reload()`. Call it on mount and on `TEAM_SETTINGS_APPLIED_EVENT`. Never fully reload on `NOTION_CONFIG_CHANGED_EVENT`: the card emits that itself on every token save, and a reload would wipe unsaved link edits. On that event, re-read only `yourName`, and adopt it only when the form's `yourName` is blank. This is how a Google name fill (Task 10) reaches an open card without touching anything typed.
- GoogleCalendarCard: move the mount load into `reload()`. Call it on mount and on `TEAM_SETTINGS_APPLIED_EVENT`. On `GOOGLE_CONNECTION_CHANGED_EVENT`, refresh only `status` via `google_status`, never the Client ID and secret fields. The card broadcasts that event itself on connect and disconnect, and Tauri delivers it to the emitting window too, so a form reload there would wipe unsaved edits.

- [ ] **Step 1: Write the failing tests**

Mock `listen` to capture handlers by event name.

```tsx
it("AppContext reloads provider selection and secure caches on team-settings-applied", ...)
// consumer renders selectedAIProvider.provider; change localStorage SELECTED_AI_PROVIDER; fire handler -> new provider shown; resetSecureProviderConfigsCache called
it("NotionSettingsCard re-reads storage on team-settings-applied", ...)     // meetings link input shows the new value
it("NotionSettingsCard on notion-config-changed fills a blank name and keeps typed edits", ...)
// type into the meetings link input; stored yourName "Ana"; fire handler -> link edit kept, name "Ana";
// with a typed name "Bo" -> stays "Bo"
it("GoogleCalendarCard re-reads config and status on team-settings-applied", ...)
it("GoogleCalendarCard on google-connection-changed refreshes status only", ...)
// type into Client ID; fire handler -> google_status re-queried, typed Client ID kept
```

- [ ] **Step 2: Run to verify they fail**

Run: `npx vitest run src/tests/team-settings-applied-consumers.test.tsx`
Expected: FAIL.

- [ ] **Step 3: Implement**

- [ ] **Step 4: Run tests (plus both card suites) and type-check**

Run: `npx vitest run src/tests/team-settings-applied-consumers.test.tsx src/tests/notion-settings-card.test.tsx src/tests/google-calendar-card.test.tsx && npm run type-check`
Expected: PASS. `notion-settings-card` has a known full-suite flake that passes alone.

- [ ] **Step 5: Commit**

```bash
git add src/contexts/app.context.tsx src/pages/odoo/components/NotionSettingsCard.tsx src/pages/odoo/components/GoogleCalendarCard.tsx src/tests/team-settings-applied-consumers.test.tsx
git commit -m "feat(team): app context and settings cards re-read after a team apply"
```

### Task 13: Deep link and the main-window team controller

**Files:**
- Modify: `src-tauri/Cargo.toml` (`tauri-plugin-deep-link = "2"`; `tauri-plugin-single-instance = { version = "2", features = ["deep-link"] }`)
- Modify: `src-tauri/src/lib.rs:119-140` (register `.plugin(tauri_plugin_deep_link::init())` right after the single-instance plugin) and `setup` (`:261`)
- Modify: `src-tauri/tauri.conf.json` (`plugins."deep-link": { "desktop": { "schemes": ["meetwings"] } }`)
- Modify: both capability files (`"deep-link:default"`)
- Modify: `package.json` (`npm install @tauri-apps/plugin-deep-link@^2`)
- Create: `src/lib/team/team-controller.ts`
- Create: `src/hooks/useTeamSync.ts` (export from `src/hooks/index.ts`)
- Modify: `src/pages/app/index.tsx` (call `useTeamSync()` in the App body next to `useSilentUpdater()`)
- Test: `src/tests/team-controller.test.ts`

**Interfaces:**
- Consumes: `parseTeamLink`, `shortGistId` (Task 5). `TeamErrorCode` (Task 6). `fetchTeamFile`, `syncTeam`, `leaveTeam`, `loadStoredTeamLink`, `loadOwnerTeamLink` (Task 9). `reconnectGoogle` (Task 10). `onOpenUrl`, `getCurrent` (`@tauri-apps/plugin-deep-link`).
- Produces:
  - `TEAM_STATE_EVENT = "team-state"`, `TEAM_ACTION_EVENT = "team-action"`, `TEAM_REFRESH_MS = 4 * 60 * 60 * 1000`, `TEAM_START_RETRY_MS = 60_000`
  - `interface TeamUiState { joined: boolean; pending: { gistShort: string; switching: boolean } | null; busy: boolean; error: TeamErrorCode | null; errorSeq: number; check: { ok: true } | { ok: false; code: TeamErrorCode } | null; googleNeedsConnect: boolean }`. `errorSeq` goes up by one every time `error` is set, so the same error twice still toasts twice (Task 14).
  - `__resetTeamControllerForTests(): void`, which clears the pending link and resets state.
  - `type TeamAction = { type: "state-request" } | { type: "join"; link: string } | { type: "confirm" } | { type: "decline" } | { type: "leave" } | { type: "check-owner-link" } | { type: "connect-google" }`
  - `startTeamController(): () => void`
  - `useTeamSync(): void`. A label-gated effect (only `main`) that calls `startTeamController()` and returns its stop.

Rust, pinned:
- In `setup`, `#[cfg(any(windows, target_os = "linux"))]` calls `app.deep_link().register_all()` (`use tauri_plugin_deep_link::DeepLinkExt`). On error, `tracing::warn!("deep link register failed: {e}")`. That message carries no URL.
- The existing single-instance callback already opens the dashboard on a second launch. With the `deep-link` feature, the URL is forwarded to `onOpenUrl` in the running app. Never log argv.

Controller, pinned:
- **`start` order.** Register these in this order:
  1. `listen(TEAM_ACTION_EVENT)`.
  2. `onOpenUrl(urls => handleIncomingLink(urls[0]))`.
  3. `getCurrent()`, which handles a cold-start URL.
  4. The startup sync, if a link is stored: `syncTeam(stored, { firstJoin: false })`. On `TEAM_FETCH_FAILED`, retry once after `TEAM_START_RETRY_MS`.
  5. `setInterval(refresh, TEAM_REFRESH_MS)`.
  6. At start, set `joined` from the stored link. Set `googleNeedsConnect = joined && !(await invoke<GraphStatus>("google_status")).connected`.
  7. `emit(TEAM_STATE_EVENT, state)`, so a dashboard that asked for state before step 6 gets the real `joined` and `googleNeedsConnect` values. Emit again when the startup sync settles.
- **Generation counter.** As in Task 3: `stop()` bumps it and clears timers and listeners.
- **Async registration.** `listen` and `onOpenUrl` resolve after a delay. Register both through one helper, `register(promise)`. When the promise resolves after `stop()`, so the generation is stale, it calls the returned unlisten at once. Otherwise it keeps the unlisten for `stop()`. Without this, the first StrictMode mount leaks handlers, and a `confirm` would run `syncTeam(firstJoin: true)` twice. Precedent: `useMeetingAutoRecord.ts:891-898`.
- **Never throw, never stick.** Every action handler, timer callback and start step runs in try/catch/finally. A throw sets `error = "TEAM_WRITE_FAILED"` and logs `console.warn("[team] controller step failed")`, never the error object. `finally` clears `busy` and emits state. A rejected `google_status` counts as not connected everywhere.
- **Error clearing.** Each incoming link and each user action (`join`, `confirm`, `leave`, `check-owner-link`, `connect-google`) sets `error = null` first. Every place that sets a non-null `error` also bumps `errorSeq`.
- **`handleIncomingLink(raw)`.**
  - Invalid → `error = "TEAM_LINK_INVALID"`, `invoke("open_dashboard")`, emit state.
  - Same gist id and key as the stored link → `syncTeam(link, { firstJoin: false })` with no prompt.
  - Otherwise → keep the parsed link in a module variable (never in state). Set `pending = { gistShort: shortGistId(id), switching: stored !== null }`, `invoke("open_dashboard")`, emit state.
  - A second link while pending replaces the pending link. Nothing is applied.
- **Actions.**
  - `confirm`: no pending → ignore. Else `busy`, `syncTeam(pending, { firstJoin: true })`, clear pending. On failure → `error = code`. On success → `joined = true`. Then set `busy = false` and emit state *before* any Google sign-in. `google_connect` blocks until the browser callback, and the prompt must not sit open and busy over settings that have already landed. Then, if `google_status` is not connected, `await reconnectGoogle()`: not ok → `googleNeedsConnect = true`, else `false`.
  - `decline`: clear pending.
  - `leave`: `leaveTeam()`, `joined = false`, `googleNeedsConnect = false`.
  - `check-owner-link`: `loadOwnerTeamLink()`. `null` → `check = { ok: false, code: "TEAM_LINK_INVALID" }`. Else `fetchTeamFile(link)` → `check = { ok: true }` or the code. Nothing is applied.
  - `connect-google`: `reconnectGoogle()`, then `googleNeedsConnect = !ok`.
  - `join`: `handleIncomingLink(link)`.
  - `state-request`: emit state.
  - Every action ends with `emit(TEAM_STATE_EVENT, state)`.
- **Refresh results.** A tick or startup sync whose result carries `googleClientChanged` (on either branch, see `ApplyResult`) sets `googleNeedsConnect = true` and never calls `reconnectGoogle`, so no browser opens unprompted.

- [ ] **Step 1: Write the failing controller tests**

Mock `@tauri-apps/plugin-deep-link`, `@tauri-apps/api/event` (capture `listen` handlers, record `emit`), `@tauri-apps/api/core` `invoke`, `@/lib/team/team-sync` and `@/lib/calendar/google-connect`. Use fake timers, with `advanceTimersByTimeAsync` for the retry and refresh tests. Call `__resetTeamControllerForTests()` in `beforeEach`.

```ts
it("cold start link -> pending prompt, dashboard opened, nothing applied", ...)       // getCurrent -> [LINK]
it("warm link via onOpenUrl -> pending prompt", ...)
it("confirm joins with firstJoin true and starts Google sign-in when not connected", ...)
it("decline clears the prompt and applies nothing", ...)
it("the stored link clicked again re-syncs without a prompt", ...)
it("a different gist while joined sets switching", ...)
it("an invalid link shows TEAM_LINK_INVALID, opens the dashboard and never logs the link", ...)   // sentinel in raw link, console spies
it("a second link while the prompt is open keeps one prompt with the latest link", ...)          // Review Focus 4; confirm -> syncTeam called once with the 2nd link
it("start: stored link syncs; a fetch failure retries once after 60 s, then waits for the 4 h tick", ...)
it("a refresh that changes the Google client sets googleNeedsConnect and opens no browser", ...)
it("check-owner-link reports ok or the code and applies nothing", ...)
it("stop() clears timers and listeners", ...)
it("a listener that resolves after stop() is unlistened at once and never handles an event", ...)
// hold the listen/onOpenUrl promises; stop(); resolve them -> each unlisten called; fire a confirm action -> syncTeam not called
it("start emits state after google_status resolves", ...)        // stored link; last emit has joined true, googleNeedsConnect per google_status
it("confirm emits a non-busy state before Google sign-in starts", ...)
// reconnectGoogle pending -> an emitted state has pending null, busy false, joined true
it("a confirm whose sync fails sets the error, clears pending and leaves joined false", ...)
it("a confirm followed by a failed Google sign-in sets googleNeedsConnect", ...)
it("a throwing action clears busy and reports TEAM_WRITE_FAILED", ...)   // syncTeam rejects -> state busy false, error TEAM_WRITE_FAILED
it("a rejected google_status counts as not connected", ...)
it("the same error twice bumps errorSeq twice", ...)                     // two invalid links -> errorSeq +2
it("leave and connect-google update joined and googleNeedsConnect", ...)
it("the same gist with a different key prompts", ...)
it("confirm with nothing pending is ignored", ...)
it("getCurrent() null or [] starts with no prompt", ...)
it("the 4 h tick re-syncs the stored link", ...)                         // advanceTimersByTimeAsync(TEAM_REFRESH_MS) -> syncTeam called with firstJoin false
it("useTeamSync does nothing outside the main window", ...)   // getCurrentWindow().label "dashboard" -> startTeamController not called
```

- [ ] **Step 2: Run to verify they fail**

Run: `npx vitest run src/tests/team-controller.test.ts`
Expected: FAIL.

- [ ] **Step 3: Implement the Rust/config changes, install the JS plugin, then implement the controller and hook**

Run: `cargo check --manifest-path src-tauri/Cargo.toml`
Expected: compiles. Capability names are validated.

- [ ] **Step 4: Run tests and type-check**

Run: `npx vitest run src/tests/team-controller.test.ts && npm run type-check`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src-tauri/Cargo.toml src-tauri/Cargo.lock src-tauri/src/lib.rs src-tauri/tauri.conf.json src-tauri/capabilities package.json package-lock.json src/lib/team/team-controller.ts src/hooks/useTeamSync.ts src/hooks/index.ts src/pages/app/index.tsx src/tests/team-controller.test.ts
git commit -m "feat(team): meetwings:// deep link and main-window team controller"
```

### Task 14: Dashboard team UI (join prompt and Team card)

**Files:**
- Create: `src/hooks/useTeamState.ts` (export from `src/hooks/index.ts`)
- Create: `src/components/TeamJoinPrompt.tsx` (export from `src/components/index.ts`)
- Modify: `src/layouts/DashboardLayout.tsx` (mount `<TeamJoinPrompt />` once)
- Create: `src/components/TeamJoinBox.tsx` (export from `src/components/index.ts`): the paste box plus the "Join" button
- Create: `src/pages/settings/components/TeamSettingsCard.tsx` (export from `./components` index)
- Modify: `src/pages/settings/index.tsx` (render `<TeamSettingsCard />` right after `<Theme />`)
- Modify: `src/pages/dev/index.tsx` (the `/api-setup` page: render `<TeamJoinBox />` above the "Required" section while `!state?.joined`). `DashboardLayout.tsx:17-21` redirects every other route to `/api-setup` until AI and speech are set up. A new colleague whose mail client does not make `meetwings://` clickable could otherwise never reach the paste box in Settings.
- Test: `src/tests/team-join-prompt.test.tsx`, `src/tests/team-settings-card.test.tsx`, `src/tests/use-team-state.test.tsx`

**Interfaces:**
- Consumes: `TEAM_STATE_EVENT`, `TEAM_ACTION_EVENT`, `TeamUiState`, `TeamAction` (Task 13). `parseTeamLink`, `parseGistRef`, `buildTeamLink` (Task 5). `generateTeamKey`, `encryptTeamPayload` (Task 5). `exportTeamSettings`, `TEAM_COPY` (Task 6). `TEAM_OWNER_KEY_SECURE_KEY`, `TEAM_OWNER_GIST_SECURE_KEY` (Task 9). `secureGet`/`secureSet`. `Dialog*`, `Button`, `Input` from `@/components`. `toast` from `sonner`.
- Produces: `useTeamState(): [TeamUiState | null, (a: TeamAction) => void]`. It listens to `TEAM_STATE_EVENT` and emits `{ type: "state-request" }` only after that `listen` promise resolves. Emitting earlier would let the reply arrive before the handler exists, the race documented at `useMeetingDetection.ts:68-77`. It uses the cancelled-flag pattern, so a listener that resolves after unmount is unlistened at once. It sends actions with `emit(TEAM_ACTION_EVENT, a)`. Main's end-of-start emit (Task 13) covers a dashboard that asked before main's controller was listening.

UI, pinned (all copy is fixed text):
- **TeamJoinPrompt.**
  - A `Dialog` that opens when `state.pending` is set.
  - Title: "Use your team's settings?"
  - Body: `` `This replaces your AI, speech, Notion and Google settings with the ones in team file ${gistShort}…. Only accept a link from someone you trust.` `` When `switching`, it adds "You'll leave your current team settings."
  - Buttons: "Use team settings" sends `confirm`; "Not now" sends `decline`.
  - When `state.errorSeq` differs from the last value this component saw and `state.error` is non-null, call `toast.error(TEAM_COPY[state.error])`. That includes the first state received, so a cold-start invalid link still toasts. Keying on `errorSeq`, not on the `error` value, means the same bad link clicked twice toasts twice.
- **TeamJoinBox.** Paste box (`Input`) plus a "Join" button. It runs `parseTeamLink` locally: invalid → show `TEAM_COPY.TEAM_LINK_INVALID` and send nothing. Valid → send `{ type: "join", link }`. It is rendered on the API Setup page and in the member half of the card.
- **TeamSettingsCard, member half.**
  - Status line: "Using your team's settings" when `joined`, else "Not using team settings".
  - `<TeamJoinBox />`.
  - "Leave team" button when `joined`. "Reconnect Google" button when `googleNeedsConnect` (sends `connect-google`). Shows `TEAM_COPY[state.error]` when set.
- **TeamSettingsCard, owner half.** A collapsed section, "Share your settings with your team":
  - No owner key → "Create team key" button: `generateTeamKey()` → `secureSet(TEAM_OWNER_KEY_SECURE_KEY)`. No regenerate control exists, so existing links keep working.
  - Gist field with helper text "Create a secret gist at gist.github.com and paste its link here". On save, `parseGistRef` → invalid → fixed error; valid → `secureSet(TEAM_OWNER_GIST_SECURE_KEY, id)`.
  - "Copy team settings": `exportTeamSettings()`. Failure → `TEAM_COPY[code]` and the clipboard is not touched. Success → `encryptTeamPayload(JSON.stringify(file), key)` → `navigator.clipboard.writeText(blob)` → "Copied. Paste it over the file in your gist."
  - "Copy team link": enabled only when both key and gist id exist. Runs `buildTeamLink`, copies to the clipboard, shows "Team link copied."
  - "Check team link": sends `check-owner-link`, then renders `state.check` as "Team link works." or `TEAM_COPY[code]`.

- [ ] **Step 1: Write the failing tests**

Mock `@tauri-apps/api/event` (capture the `team-state` handler, record `emit`), `@/lib/secure-storage`, `@/lib/team/team-file` (`exportTeamSettings`) and `navigator.clipboard`.

```tsx
// team-join-prompt.test.tsx
it("is closed without a pending join", ...)
it("opens on a pending state and sends confirm / decline", ...)
it("mentions leaving the current team when switching", ...)
it("toasts the fixed copy when an error arrives", ...)
it("toasts again when the same error arrives with a new errorSeq, and not on a re-render with the same errorSeq", ...)
// use-team-state.test.tsx
it("emits state-request only after the state listener resolves", ...)   // hold the listen promise; emit not called; resolve -> emit called
it("a listener resolving after unmount is unlistened at once", ...)
// team-settings-card.test.tsx
it("requests state on mount", ...)                                   // emit(TEAM_ACTION_EVENT, {type:"state-request"})
it("an invalid pasted link shows fixed copy and sends nothing", ...)
it("a valid pasted link sends join", ...)
it("Copy team settings refuses with fixed copy and leaves the clipboard alone", ...)   // exportTeamSettings -> {ok:false, code:"TEAM_FIELD_MISSING"}
it("Copy team settings copies an mwt1 blob that does not contain the key", ...)        // sentinel api key not in clipboard text
it("Copy team link stays disabled until a gist id is saved; a gist URL is accepted", ...)
it("Check team link renders the controller's result", ...)
it("Reconnect Google appears only when googleNeedsConnect", ...)
```

- [ ] **Step 2: Run to verify they fail**

Run: `npx vitest run src/tests/team-join-prompt.test.tsx src/tests/team-settings-card.test.tsx src/tests/use-team-state.test.tsx`
Expected: FAIL.

- [ ] **Step 3: Implement the hook, prompt, join box, card and the three mounts**

- [ ] **Step 4: Run tests and type-check**

Run: `npx vitest run src/tests/team-join-prompt.test.tsx src/tests/team-settings-card.test.tsx src/tests/use-team-state.test.tsx && npm run type-check`
Expected: PASS.

- [ ] **Step 5: Run every test file this plan touched**

Run: `npx vitest run src/tests/install-gate.test.ts src/tests/recording-activity-store.test.ts src/tests/silent-updater.test.ts src/tests/updater-retry-button.test.tsx src/tests/use-silent-updater.test.tsx src/tests/use-team-state.test.tsx src/tests/version-note.test.ts src/tests/app-status-line.test.tsx src/tests/team-link.test.ts src/tests/team-crypto.test.ts src/tests/team-file.test.ts src/tests/team-fetch.test.ts src/tests/team-apply.test.ts src/tests/team-sync.test.ts src/tests/team-redact.test.ts src/tests/google-connect.test.ts src/tests/google-calendar-card.test.tsx src/tests/notion-page-blocks.test.ts src/tests/notion-same-meeting.test.ts src/tests/notion-send.test.ts src/tests/team-settings-applied-consumers.test.tsx src/tests/notion-settings-card.test.tsx src/tests/team-controller.test.ts src/tests/team-join-prompt.test.tsx src/tests/team-settings-card.test.tsx src/tests/secure-provider-configs.test.ts`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add src/hooks/useTeamState.ts src/hooks/index.ts src/components/TeamJoinPrompt.tsx src/components/TeamJoinBox.tsx src/components/index.ts src/layouts/DashboardLayout.tsx src/pages/settings src/pages/dev/index.tsx src/tests/team-join-prompt.test.tsx src/tests/team-settings-card.test.tsx src/tests/use-team-state.test.tsx
git commit -m "feat(team): dashboard join prompt and Team settings card"
```

---

## Device checklist (owner, after merge; not automatable)

Vitest mocks the updater, relaunch and deep links. Only a real install proves these. Read results from the Settings status line, because release builds have no console.

1. Publish a test release. The app updates with no prompt and no UAC dialog, and comes back on the new version. Windows: the owner checks this. Mac: one colleague reports, including any password prompt. If the quiet NSIS update does not relaunch on Windows, switch `installMode` back to `"passive"` (a progress bar, still no click).
2. Start a recording, then publish a release. Nothing installs until 30 minutes after the recording ends.
3. With Meetwings closed, click a team link and decline the prompt. With it running, click the link again. The confirm prompt appears in the dashboard both times.
4. Join. Settings fill in, Google consent opens once, and a recorded meeting reaches Notion under the colleague's name.
5. Disconnect the network and restart. Settings stay as they were.

Owner setup, once: create the team key, then the secret gist, then Copy team settings, paste it into the gist, Check team link, and send the link. If colleagues are on Google Workspace, set the Google Cloud app to "Internal" (no 7-day sign-in expiry).
