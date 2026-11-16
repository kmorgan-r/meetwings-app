# Team setup and silent updates — design

Date: 2026-11-15
Status: approved by owner 2026-11-15 (via /ship); spec-review findings applied

## Intent

Meetwings is going out to the owner's colleagues (a mix of Windows and Mac).
Today each colleague must paste an AI key, a speech key, a Notion token and
database links, and a Google Client ID + secret, then click to install every
update. The owner wants both to be "one click easy":

1. **Silent updates** — new versions install themselves, no click to accept.
2. **Team setup** — colleagues never copy keys. The owner keeps one private
   team-settings file; a colleague clicks one link once and the app fills
   everything in, and keeps it in sync from then on.

The company pays for one AI key, one speech key, one Notion integration and
one Google app, shared by everyone.

## Goals

- Publishing the GitHub draft release is the owner's only deploy step. Within
  a few hours every colleague's app is on the new version, untouched.
- An update never interrupts a recording or a meeting in progress.
- A colleague's full setup is: install, click the team link, confirm once in
  the app, click "allow" on Google's consent page. Nothing typed.
- The owner changes a key by replacing one file. Every colleague's app picks it
  up within a few hours (next start or next 4-hour tick), with no re-sent link
  and no new release.

## Non-goals

- Linux. Colleagues are on Windows and Mac. (Owner's call: "mix" answered
  "Windows, Mac, or a mix".) The Linux build keeps today's behaviour: the
  click-to-install button stays on Linux. (My call, from spec review: "every
  install gets silent updates" below means every Windows and Mac install.)
- Odoo settings in the team file — the owner did not list Odoo.
- Per-person access or revoking one colleague. Anyone holding the link can
  read the file; someone who leaves keeps what they received. Accepted.
- A server or proxy holding the keys. Colleagues' machines hold the keys.
- Sharing personal settings: audio devices, shortcuts, system prompts,
  chat history.

## Anti-goals (failure even if it "works")

- **Keys inside a build or a public release.** The repo and its releases are
  public (`gh repo view` → PUBLIC). No key, token or the team-file link may be
  compiled in, committed, or uploaded as a release asset — ever. There is no
  build-time input for team settings at all; they only ever arrive at runtime
  through the team link.
- **An update restarting the app mid-recording or mid-meeting**, losing audio
  or a transcript.
- **Raw secrets in logs, error messages or toasts.** Same rule the existing
  Notion and Google code already follows. The gist URL and the decryption key
  count as secrets too.
- **A team-file fetch wiping or half-writing working settings.** A failed,
  unreachable, undecryptable or invalid file must mean "keep the last good
  copy", silently on start. A successful fetch never blanks a working key.
- **Joining a file the colleague did not knowingly accept.** A link alone must
  never re-point the app's AI, speech or Notion traffic.

## Constraints and facts from the codebase

- Updater: `src/components/updater/index.tsx` — already calls `check()` from
  `@tauri-apps/plugin-updater` 2.9 automatically, once on mount
  (`:122-124`); install (`downloadAndInstall`, then `relaunch` after a 2 s
  `setTimeout`, `:107-112`) waits for a click. Mounted in the overlay at
  `src/pages/app/index.tsx:271`, **inside the overlay's `ErrorBoundary`**
  (`:160-168`), and it takes no props, so it cannot see recording state.
- **Relaunch is broken today.** `relaunch()` comes from
  `@tauri-apps/plugin-process` (`package.json:71`), but the Rust
  `tauri-plugin-process` is not in `src-tauri/Cargo.toml`, not registered in
  `src-tauri/src/lib.rs`, and has no capability permission. On Windows the
  NSIS installer restarts the app itself, which hides this; on Mac the app
  swap would land and the relaunch would fail, leaving the old version
  running.
- `src-tauri/tauri.conf.json`: endpoint is
  `https://github.com/kmorgan-r/meetwings-app/releases/latest/download/latest.json`;
  Windows `installMode` is `"passive"` (shows a progress bar).
- Releases ship **both** an NSIS setup and an MSI
  (`.github/workflows/publish.yml:71`), with `updaterJsonPreferNsis: true`
  (`:129`). Whether an MSI install can update silently without an admin
  prompt is unverified.
- Release flow: the publish workflow creates a **draft** release; drafts are
  not served by `releases/latest`, so nothing reaches colleagues until the
  owner publishes. `latest.json` is the publish gate. **There is no rollback:**
  unpublishing does not reach installed apps; a bad release is fixed only by
  publishing a higher version (roll forward).
- macOS builds are **not signed or notarized** (`publish.yml` release body
  tells users to "Allow Anyway"). On an unsigned app each new version may
  make macOS ask for the keychain password (Notion token, Google sign-in live
  in the keychain via `keyring`), and replacing an app in `/Applications` may
  ask for an admin password. Both come from the update itself, so today's
  click-to-install updates hit them too. The owner has no Mac to test on.
- Colleagues currently on 1.5.0 have the click-to-install updater. They must
  click **once more** to reach the first version with silent updates. After
  that, no clicks.
- **Second launches lose their arguments.** `tauri-plugin-single-instance` is
  registered first in `lib.rs:119` with `|app, _argv, _cwd|`: it drops argv
  and only shows the dashboard. Meetwings autostarts, so a clicked link
  usually reaches an app that is already running; on Windows the link URL
  arrives as a second launch's argument and would be lost.
- **Two JS contexts.** The overlay (`main`) and the `dashboard` webviews are
  both created at startup (`lib.rs:267-272`), each with its own copy of every
  module. `src/lib/storage/secure-provider-configs.ts` keeps a per-module
  cache and write queue (`:23-25`, `:39-40`) and rewrites the whole blob on
  save (`:181`, `:281`), so a stale save in one window can undo a write made
  in the other.
- **Mounted consumers read once.** `NotionSettingsCard.tsx:61-83` and
  `GoogleCalendarCard.tsx:27-50` copy storage into local state once on mount;
  `NotionSettingsCard` then saves its whole form (`:125`). AppContext reads
  provider selection and custom providers once. The overlay already learns
  dashboard changes only through emitted Tauri events (e.g.
  `overlay-pill-style-changed`, `pages/app/index.tsx:115-157`;
  `NOTION_CONFIG_CHANGED_EVENT`; `broadcastGoogleConnectionChanged`).
- **Setup gate needs keys configured, not verified.**
  `src/hooks/useSetupStatus.ts:185`: `isComplete = cloudMode ||
  (aiConfigured && sttConfigured)`; verification is advisory. Team-applied
  keys pass the gate as soon as AppContext sees them.
- **Detection flaps mid-call.** Capture reopens 5-15 minutes apart within one
  call (`src/config/constants.ts:161-165`), and a dropout longer than
  `CALL_END_GRACE_MS` (5 s) stops the recording (`:204-211`). A short "idle"
  window would see a live call as idle.
- Where today's settings live:
  - AI/speech selection: localStorage `curl_selected_ai_provider` /
    `curl_selected_stt_provider` (`src/config/constants.ts`); provider
    variables incl. API keys via `src/lib/storage/secure-provider-configs.ts`
    (`secureSet`). Custom providers: `curl_custom_ai_providers` /
    `curl_custom_speech_providers` (localStorage).
  - Notion token: OS keychain only, via `src/lib/notion/token.ts`
    (`notion_token_set`). Notion links, team times, your name: one blob in
    `src/lib/storage/notion-config.storage.ts` (`NotionConfig`), which can
    read as "unreadable" (`:101-118`); the first state read stamps
    `NOTION_SETUP_AT` (`:165-169`).
  - Google Client ID + secret: `src/lib/storage/google-config.storage.ts`
    (`secureSet`); sign-in via `google_connect`, whose only caller is the
    card's `handleConnect` (`GoogleCalendarCard.tsx:52-75`).
- **Shared Notion token and the recorder's name.** `src/lib/notion/send.ts`
  uses `config.yourName`, else the token owner's Notion name, else "You". A
  shared workspace integration has no owning person, so every colleague's
  notes would read "You" unless `yourName` is set per person.
- **Shared Notion token and page ownership — answered, it collides.**
  `isThisSendsPage` (`send.ts:225-231`) proves "this send's page" by creator
  (`me.id`), span within 60 s and bold title. With one shared token `me.id`
  is the same for every colleague, and the code's own comment (`:223-224`)
  says two devices on one token, identical titles and spans within 60 s
  "would still trash each other's pages". Such a page is also adopted
  (`:238-239`), skipped by the same-meeting merge (`:243`, `:249`), and
  trashed as an orphan in the recheck (`:287-293`). Fixed under Decided.
- Google scopes today: `openid email …calendar.events.readonly`
  (`src-tauri/src/google/auth.rs`). No `profile`, so no name in the sign-in.
- **Google app type.** If colleagues are on a Google Workspace domain, the
  Google Cloud app can be "Internal": no Google review, sign-ins don't
  expire. On personal Gmail it stays in "Testing": 100-user cap and sign-ins
  expire every 7 days. Owner to confirm which applies (setup doc, not code).
- No deep-link plugin is installed today.

## Decided

### Silent updates (build first)

- Check on app start and every 4 hours. (My call.)
- Download in the background, no UI.
- **Install gate, pinned** (my call, from spec review). Install only when all
  hold at the moment of the call:
  - no capture is running, read fresh at that moment (a module-level store
    or a Tauri query), never a React prop or state captured when a timer was
    scheduled. "Capturing" means ANY of: a capture session is open
    (`capturing` / `CAPTURING_CONVERSATION_ID`, `useSystemAudio.ts:815-817`
    — true in continuous mode even while Rust is idle, `:601-610`), the
    mic/VAD is open, or Rust reports capturing. Rust capture state alone is
    not enough (`meeting-auto-record.ts:70-80`), and Macs have no meeting
    detection to cover the gap;
  - no meeting is detected as active;
  - the last capture ended at least `MEETING_CONVERSATION_GAP_MS` (30 min)
    ago, or there was none since start. "Idle" means app recording activity,
    not OS keyboard/mouse input.

  The gate is re-checked after the download finishes and again immediately
  before install and before relaunch. It is one pure function (inputs:
  capturing, meeting active, last capture end, now → install or defer) so it
  can be unit-tested. A busy check defers; the pending update is re-tried on a
  short re-check until the gate opens.
- **Where it runs:** a headless scheduler (module singleton or hook), not the
  visible `Updater` component, mounted where an overlay render crash cannot
  unmount it (outside the overlay `ErrorBoundary`, or driven from Rust).
  Because there is no rollback, an updater that a broken release can kill
  would strand every colleague. One in-flight guard; the `Update` object held
  in a ref; timers cleared on unmount.
- **Relaunch:** add the Rust `tauri-plugin-process` (Cargo dependency,
  `.plugin(...)` registration, `process:allow-restart` capability) so
  `relaunch()` works on Mac. Acceptance: after a silent update the app is
  running the new version on each OS.
- Windows install fully silent (switch `installMode` from `passive` to a
  silent mode that still works for a per-user install).
- **MSI installs:** verify whether an MSI install updates silently with no
  admin prompt. If not, stop shipping the MSI (drop it from the release assets
  and website links) so every Windows colleague is on NSIS. (My call, from
  spec review.)
- **Every Windows and Mac install gets silent updates**, not only team
  members. (Owner's call: "yes anyone".) So the two pieces stay independent
  and silent updates ship first.
- Mac: same flow; app swaps itself and relaunches. Shipped untested on Mac
  (owner has no Mac). One Mac colleague reports what they see after the first
  silent update (see Acceptance and verification). If macOS asks for
  passwords, the follow-up is Apple Developer signing (~$99/yr), not part of
  this work; signing is expected to stop the per-version keychain prompts, but
  an `/Applications` admin prompt depends on file ownership and may remain.
  (My call.)
- **Failures** (my call, from spec review): a failed check or download is
  retried on the next 4-hour tick. A failed or cancelled install (including
  a cancelled macOS password prompt) is not retried automatically for that
  version until the next app start, so nobody is re-prompted every 4 hours.
  After any install failure the updater shows a retry button right away, so
  an always-running app is never stuck on the old version with no way out.
- After restart, a small "Updated to X.Y.Z" note. (My call.)
- The existing click-to-install button is removed on Windows and Mac; only
  the failure retry above remains.

Built first because it carries the team-setup release to colleagues with no
clicks.

### Team setup

- **One team file** the owner controls, holding: AI provider + model + key;
  speech provider + model + key; Notion token, Meetings link, Knowledge link,
  team times; Google Client ID + secret. If the selected provider is a custom
  (CURL) one, its definition travels too. (My call.) Keys travel only as
  provider variables; "Copy team settings" refuses a custom CURL template that
  contains a key literally, because templates live in localStorage.
- **Hosted as a secret GitHub Gist** (my call): the owner already uses
  GitHub, nothing to run.
- **The gist holds an encrypted blob, not readable JSON** (my call, from the
  builder check). GitHub's secret scanning may report recognisable keys in
  gists to OpenAI, Google, Notion and others, which can revoke them on sight,
  breaking every colleague at once. Encryption is authenticated (e.g.
  AES-256-GCM via WebCrypto, fresh IV per export), so a wrong key or a
  tampered blob fails to decrypt rather than yielding garbage. The decryption
  key travels only in the team link (e.g. the URL fragment), never in the
  gist and never in any fetched URL.
- **Owner flow** (my call, from spec review):
  1. The owner's app generates the encryption key once and keeps it in the
     owner's secure storage; every later "Copy team settings" reuses it, so
     existing links keep working.
  2. The owner creates one secret gist and pastes its id (or URL) into the
     app once; the app then shows the team link to send (gist id + key).
  3. To change a key: update settings in the owner's own app, press "Copy
     team settings", paste the result over the gist's file.
  4. The link names the gist id, not a revision, so colleagues always fetch
     the latest revision.
  5. A "Check team link" action fetches and decrypts the owner's own link, so
     the owner can confirm a paste worked.
  "Copy team settings" refuses to export when a required field is empty.
- **Joining:** a colleague clicks a team link that opens Meetwings and points
  it at the file.
  - The deep link works whether Meetwings is already running (single-instance
    plugin's `deep-link` integration forwards the URL to the running app) or
    not (URL read at launch). The URL is never logged.
  - The link parser is a strict allowlist: Meetwings scheme, a gist id of the
    expected shape, a key of the expected shape. Anything else is rejected.
    The app fetches only from GitHub's gist hosts over https.
  - **Confirm before the first apply**, and again before switching to a
    different gist: an in-app prompt names what will change (AI, speech,
    Notion and Google settings) and the source gist. (My call, from spec
    review.)
  - On confirm, the app fetches, validates and applies everything, then
    starts Google sign-in if not already connected. The link is stored like a
    secret (secure storage, never localStorage).
  - A failed first join (offline, bad link, decrypt or validation failure)
    shows a plain fixed-text error and stores nothing; the colleague clicks
    the link again.
- **When it re-fetches:** on every start, on every 4-hour update tick, and
  once more about a minute after a failed start fetch (the network may not be
  up yet at autostart). (My call, from spec review.)
- **Which window:** only the overlay (`main`) window fetches, applies and
  handles join links, self-gated by window label like `useMeetingDetection`,
  with a module-level in-flight guard. After an apply it emits one
  `team-settings-applied` Tauri event plus the existing
  `NOTION_CONFIG_CHANGED_EVENT` and `broadcastGoogleConnectionChanged`. On
  `team-settings-applied`, both windows reload `secure-provider-configs`
  caches and AppContext's provider state, and mounted `NotionSettingsCard` /
  `GoogleCalendarCard` re-read storage, so no stale form or cache can write
  old values back. (My call, from spec review.)
  The overlay is a 54 px bar that never takes focus and may be hidden or
  shrunk to the pill (`tauri.conf.json`; `lib.rs:119-140` warns a direct
  `show()` of `main` desyncs its toggle state), so nothing the colleague must
  read or answer appears there. The confirm prompt and the join errors show
  in the dashboard, which `main` opens (as a second launch already does) and
  notifies by event. The Settings paste box and "Check team link" send their
  request to `main` by event and show `main`'s reply. `main` stays the only
  window that fetches and applies.
- **What counts as a failure** — any of these applies nothing and keeps the
  last good settings (silent on start; fixed-text error on join and in the
  paste-link box):

  | Input | Result |
  |---|---|
  | network error, timeout, HTTP 404/5xx, gist deleted | keep last good |
  | decrypt fails (wrong/missing key, tampered blob) | keep last good |
  | not valid JSON, or fails the schema | keep last good |
  | `version` higher than this app understands | keep last good |
  | a required field missing or empty | keep last good |
  | a storage or keychain write fails mid-apply | stop the remaining writes; see Applying |

  Required: AI provider + key, speech provider + key, Notion token, Meetings
  link, Google Client ID + secret. Optional fields (Knowledge link, team
  times, models, custom definitions) that are absent leave the local value
  untouched.
- **Applying** (my call, from spec review): decrypt and validate the whole
  payload before writing anything. Then write secrets (keychain token,
  provider keys, Google config) before the configs that reference them. Write
  only fields whose value actually changed, so a no-op re-apply on each start
  writes nothing (no keychain churn, no verification reset, no premature
  `NOTION_SETUP_AT` stamp). The Notion blob is read-modify-write: team fields
  replaced, `yourName` kept; an unreadable blob is replaced by the team fields
  with `yourName` blank.
  A write that fails partway (e.g. a refused keychain prompt on an unsigned
  Mac) stops the remaining writes. On a first join, the app undoes what it
  already wrote and records no link and no "last synced", then shows the
  join error. On a later fetch it keeps what landed and records no "last
  synced"; the next fetch finishes the job, because only changed fields are
  written.
- **The file wins** (my call, owner did not object): anything the file
  covers is reset to the file's value on each successful fetch. Settings the
  file doesn't cover are untouched.
- **Google:** the connect logic moves out of `GoogleCalendarCard` into a
  shared non-React helper used by both the card and the join flow. The
  browser consent page opens only on join (or a click), never from an
  every-start re-apply. If a fetched file's Client ID differs from the stored
  one, the stored sign-in is cleared and the app shows "Reconnect Google"
  rather than opening a browser unprompted. (My call, from spec review.)
- **Name for Notion:** filled from the colleague's Google sign-in (add the
  `profile` scope), only when `yourName` is blank; a name the colleague typed
  is never overwritten. A sign-in made before the scope change, or one with no
  name claim, leaves `yourName` blank (pages fall back to "You", as today)
  until the next consent. New colleagues consent at join, so they get it.
  (My guess, owner agreed.)
- **Shared token page ownership** (my call, from spec review): add a
  per-install proof to `isThisSendsPage`. Each create writes this install's
  id (or the send's id) into the page, and a page counts as "this send's"
  only when that id matches. A teammate's page on the same call is then a
  normal same-meeting candidate: merged by the existing judge, never adopted
  or trashed. Where the id lives is the builder's call, with one constraint:
  the proof must work on a team database with no extra column (e.g. in the
  page body next to the bold title the candidate read already uses), never
  only in an optional property — today's optional columns are written only
  when they exist (`page-blocks.ts:223-228`).
- **"Recorded by" stays blank; who attended is what matters** (owner: "we
  should know who was in each meeting including the person who recorded, it's
  not as important who specifically recorded"). With a shared workspace
  integration `me()` has no owner user, so `page-blocks.ts` skips the
  "Recorded by" column — accepted, no email-matching work. Attendees already
  come from Google Calendar and include the recorder: `groupAttendees`
  (`src/lib/calendar/calendar-snapshot.ts`) keeps the own address in the Team
  group. This needs each colleague's Google connection, which joining sets
  up. Meetings not on the calendar still get no Attendees list (unchanged).
- **The owner's own app** is unaffected unless the owner joins their own
  team link.
- **Creating the file:** the "Copy team settings" action in the owner's app
  produces the file contents from the owner's current settings, so the owner
  never hand-writes JSON. (My call.)

## Acceptance and verification

Vitest (in `src/tests/`, mock seams: `tauriFetch`, `secureSet`, the keychain
invokes, the updater plugin) proves the decision logic:

- Install gate: busy capture defers; detected meeting defers; last capture
  under 30 min ago defers; idle installs; a recording that starts during the
  download or the wait is seen (gate re-read, not captured); 4-hour tick and
  re-check timers with fake timers; a failed check or download never installs
  or relaunches; failure backoff.
- Team file: each row of the failure table leaves storage byte-identical; a
  valid file applies every covered field and leaves uncovered settings
  (audio, shortcuts, Odoo, a typed `yourName`) untouched; a no-op re-apply
  writes nothing; a write failing mid-apply on first join leaves storage as
  it was and records no link; Copy → apply round trip; wrong key, tampered blob and a link
  without a key fail cleanly; export refuses empty required fields and a key
  inline in a CURL template.
- Link parser: valid link accepted; wrong scheme, non-gist host, http,
  malformed id or key rejected; the paste box uses the same parser.
- Secrets: with sentinel values for every key, the gist URL and the link key,
  force each error path (fetch, decrypt, parse, keychain write) and assert no
  sentinel appears in console output, thrown messages or toast text (pattern:
  `src/tests/odoo-redact.test.ts`, `src/tests/graph-redact.test.ts`).
- Shared token: two installs, same token, same title, overlapping spans —
  neither adopts or trashes the other's page, and the same-meeting path still
  merges (extends `src/tests/notion-send.test.ts`,
  `src/tests/notion-same-meeting.test.ts`).
- Notion name: blank gets the Google name; a typed name is kept; no name
  claim leaves it blank.

Only a real device proves the rest; Vitest mocks the updater and relaunch.
Release builds have no DevTools or console, so Settings shows a small status
line (app version, last update check, team settings last synced) as the
observable signal. (My call, from spec review.) Manual checklist, per OS:

1. Publish a test release: the app updates with no prompt, no admin/UAC
   dialog, and restarts on the new version (Windows: owner; Mac: one
   colleague reports, including any password prompt).
2. Start a recording, publish a release: no install until the recording has
   been over for 30 minutes.
3. Click a team link with Meetwings closed and decline the prompt; click it
   again with Meetwings running: the confirm prompt appears in the dashboard
   both times.
4. Join: settings fill in, Google consent opens once, and a recorded meeting
   reaches Notion with the colleague's name.
5. Disconnect the network and restart: settings stay as they were.

## Left to the builder

- File format and versioning (include a `version` field).
- Link format details: custom-scheme deep link (`tauri-plugin-deep-link`)
  with a paste-the-link fallback box in Settings — many mail/chat apps won't
  make a `meetwings://` link clickable. An https landing page that redirects
  is an alternative.
- Which Windows silent install mode works without an admin prompt.
- Whether to show "set by your team" next to team-managed fields.
- How a colleague leaves the team (clear the stored link).
