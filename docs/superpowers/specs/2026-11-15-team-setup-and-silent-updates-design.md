# Team setup and silent updates — design

Date: 2026-11-15
Status: approved by owner 2026-11-15 (via /ship)

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
- A colleague's full setup is: install, click the team link, click "allow" on
  Google's consent page. Nothing typed.
- The owner changes a key by replacing one file. Every colleague's app picks it
  up on its next start, with no re-sent link and no new release.

## Non-goals

- Linux. Colleagues are on Windows and Mac. (Owner's call: "mix" answered
  "Windows, Mac, or a mix".) The Linux build keeps today's behaviour.
- Odoo settings in the team file — the owner did not list Odoo.
- Per-person access or revoking one colleague. Anyone holding the link can
  read the file; someone who leaves keeps what they received. Accepted.
- A server or proxy holding the keys. Colleagues' machines hold the keys.
- Sharing personal settings: audio devices, shortcuts, system prompts,
  chat history.

## Anti-goals (failure even if it "works")

- **Keys inside a build or a public release.** The repo and its releases are
  public (`gh repo view` → PUBLIC). No key, token or the team-file link may be
  compiled in, committed, or uploaded as a release asset — ever.
- **An update restarting the app mid-recording or mid-meeting**, losing audio
  or a transcript.
- **Raw secrets in logs, error messages or toasts.** Same rule the existing
  Notion and Google code already follows.
- **A failed or unreachable team-file fetch wiping working settings.** Offline
  must mean "keep the last good copy", silently.

## Constraints and facts from the codebase

- Updater: `src/components/updater/index.tsx` — already calls `check()` from
  `@tauri-apps/plugin-updater` 2.9 automatically; install
  (`downloadAndInstall`, then `relaunch`) waits for a click. Mounted in the
  overlay at `src/pages/app/index.tsx:271`.
- `src-tauri/tauri.conf.json`: endpoint is
  `https://github.com/kmorgan-r/meetwings-app/releases/latest/download/latest.json`;
  Windows `installMode` is `"passive"` (shows a progress bar).
- Release flow: the publish workflow creates a **draft** release; drafts are
  not served by `releases/latest`, so nothing reaches colleagues until the
  owner publishes. `latest.json` is the publish gate.
- macOS builds are **not signed or notarized** (`publish.yml` release body
  tells users to "Allow Anyway"). On an unsigned app each new version may
  make macOS ask for the keychain password (Notion token, Google sign-in live
  in the keychain via `keyring`), and replacing an app in `/Applications` may
  ask for an admin password. Both come from the update itself, so today's
  click-to-install updates hit them too. The owner has no Mac to test on.
- Colleagues currently on 1.5.0 have the click-to-install updater. They must
  click **once more** to reach the first version with silent updates. After
  that, no clicks.
- Where today's settings live:
  - AI/speech selection: localStorage `curl_selected_ai_provider` /
    `curl_selected_stt_provider` (`src/config/constants.ts`); provider
    variables incl. API keys via `src/lib/storage/secure-provider-configs.ts`
    (`secureSet`). Custom providers: `curl_custom_ai_providers` /
    `curl_custom_speech_providers`.
  - Notion token: OS keychain only, via `src/lib/notion/token.ts`
    (`notion_token_set`). Notion links, team times, your name:
    `src/lib/storage/notion-config.storage.ts` (`NotionConfig`).
  - Google Client ID + secret: `src/lib/storage/google-config.storage.ts`
    (`secureSet`); sign-in via `google_connect` (`GoogleCalendarCard.tsx`).
- **Shared Notion token and the recorder's name.** `src/lib/notion/send.ts`
  uses `config.yourName`, else the token owner's Notion name, else "You". A
  shared workspace integration has no owning person, so every colleague's
  notes would read "You" unless `yourName` is set per person.
- **Shared Notion token and page ownership.** `send.ts` (comment above
  `isThisSendsPage`) proves a page is "this send's" partly by creator match.
  With one shared token every colleague is the same creator. The builder
  must check that two colleagues recording the same call cannot overwrite or
  trash each other's pages (the Google same-meeting logic is meant to merge
  them into one page — verify, don't assume).
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
- Install only when no recording is running and the app has been idle a few
  minutes. A recording or detected meeting in progress defers the install
  until it ends. (My call on "idle a few minutes".)
- Windows install fully silent (switch `installMode` from `passive` to a
  silent mode that still works for a per-user install).
- **Every install gets silent updates**, not only team members. (Owner's
  call: "yes anyone".) So the two pieces stay independent and silent updates
  ship first.
- Mac: same flow; app swaps itself and relaunches. Shipped untested on Mac
  (owner has no Mac). One Mac colleague reports what they see after the first
  silent update. If macOS asks for passwords, signing the app with an Apple
  Developer account (~$99/yr) is the follow-up, not part of this work. (My
  call.)
- After restart, a small "Updated to X.Y.Z" note. (My call.)
- The existing click-to-install button is removed; error state may keep a
  retry.

Built first because it carries the team-setup release to colleagues with no
clicks.

### Team setup

- **One team file** the owner controls, holding: AI provider + model + key;
  speech provider + model + key; Notion token, Meetings link, Knowledge link,
  team times; Google Client ID + secret. If the selected provider is a custom
  (CURL) one, its definition travels too. (My call.)
- **Hosted as a secret GitHub Gist** (my call): the owner already uses
  GitHub, nothing to run. The link is the secret.
- **The gist holds an encrypted blob, not readable JSON** (my call, from the
  builder check). GitHub's secret scanning may report recognisable keys in
  gists to OpenAI, Google, Notion and others, which can revoke them on sight,
  breaking every colleague at once. The decryption key travels only in the
  team link (e.g. the URL fragment), never in the gist. Cost: the owner can't
  edit the file in the browser. To change a key, the owner updates their own
  app's settings, presses "Copy team settings", and pastes the result over
  the gist.
- **Joining:** a colleague clicks a team link that opens Meetwings and points
  it at the file. The app fetches it, applies everything, then opens Google's
  consent page if not already connected. The file's URL is stored like a
  secret (secure storage, never localStorage).
- **Every start:** the app re-fetches and applies. Fetch fails → keep last
  good settings, no error shown to the colleague.
- **The file wins** (my call, owner did not object): anything the file
  covers is reset to the file's value on each successful fetch. Settings the
  file doesn't cover are untouched.
- **Name for Notion:** filled from the colleague's Google sign-in (add the
  `profile` scope), only when `yourName` is blank. (My guess, owner agreed.)
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
- **Creating the file:** a "Copy team settings" action in the owner's app
  produces the file contents from the owner's current settings, so the owner
  never hand-writes JSON. (My call.)

## Left to the builder

- File format and versioning (include a `version` field).
- Link format: custom-scheme deep link (`tauri-plugin-deep-link`) with a
  paste-the-link fallback box in Settings — many mail/chat apps won't make a
  `meetwings://` link clickable. An https landing page that redirects is an
  alternative.
- Exact "busy" signal for deferring installs (recording state lives around
  `src/hooks/useSystemAudio.ts` and meeting auto-record).
- Which Windows silent install mode works without an admin prompt.
- Whether to show "set by your team" next to team-managed fields.
- How a colleague leaves the team (clear the stored link).
- How to verify on a real Mac and a real Windows machine; release builds
  have no DevTools or console logs.
