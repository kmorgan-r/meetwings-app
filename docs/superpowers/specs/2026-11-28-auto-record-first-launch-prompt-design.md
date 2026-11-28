# Ask once at launch to turn on auto-record

Status: proposed, awaiting owner approval (2026-11-28)
Branch: `feat/auto-record-first-launch-prompt`
Builds on: `2026-11-19-macos-meeting-detection-design.md` (auto-record stays off by default)

## 1. Why

Auto-record is off by default (spec 2026-11-19 §2, PR #117). On a tester's Mac (2026-11-28) detection worked, but it never
ran, because the toggle was off at both launches. `detection.log` has no `watcher start` line until the moment the toggle
was switched on, and the next Meet call then recorded and stopped on its own. To the user it looked like "Meetwings does
nothing". People don't find the toggle in Settings.

The owner rejected turning it on by default, for three reasons:

- it would record other people's calls without the user choosing to;
- every Windows user who never touched the toggle would start auto-recording after an update;
- on Mac, the permission prompts are tied to turning the toggle on.

Instead the owner chose to **ask once, at launch**, with a card under the bar.

## 2. Goals, non-goals, anti-goals

**Goals**
- Ask once at launch: anyone on macOS or Windows who has never set the toggle sees one prompt asking whether to turn auto-record on.
- **Turn on** does exactly what the Settings toggle does, including the Mac permission checks.
- **Not now** leaves auto-record off and never asks again. Settings stays the place to change it.

**Non-goals**
- On by default.
- Recording a call that is already under way when auto-record comes on. This is unchanged: the next call records.
- Whether Mac grants survive a relaunch on the unsigned build (check M2a). That is a separate investigation.
- Linux, which is not a detection platform.

**Anti-goals**
- Recording anyone before the user says yes.
- Asking again after an answer, or asking someone who already chose in Settings.
- A permission failure that leaves the user believing auto-record is on.

## 3. Approaches considered

| Approach | Trade-off | |
|---|---|---|
| **Card under the bar** | On screen as soon as Meetwings opens. Stays until answered. Same pattern as the amber Google card. Space is tight, so a failure shows one line and an "Open settings" button. | **Picked by the owner** |
| Welcome panel in the dashboard | Room for the full text and the existing Settings toggle with its notes. But it opens a big window at launch, which Meetwings never does today. | |
| Notification with buttons | Least work. It fades after a few seconds, so many people would miss it and never be asked again. | |

Timing was decided separately. The options were:

- at first launch (**picked by the owner**);
- right after the first recording started by hand ends (proposed: it comes in context, and the permissions are already granted);
- when a call is detected while auto-record is off (this needs call watching before consent, and changes the detection code on both platforms).

## 4. Behaviour

**Who sees it.** All of these must hold:

- the main window;
- macOS or Windows (`isMeetingDetectionPlatform()`);
- setup is complete, the same gate `<Completion />` uses;
- `STORAGE_KEYS.MEETING_AUTO_RECORD_ENABLED` is absent, so the user has never set the toggle and no start has failed (failures write `"false"`);
- the new key `STORAGE_KEYS.MEETING_AUTO_RECORD_OFFER` is absent.

On macOS, also: the support probe (`list_capture_sessions`, which never prompts) passes. *(My call:)* an unsupported macOS gets no offer, because the answer could only be a failure. Settings still shows the "needs macOS 14.2" note.

Existing users who never touched the toggle are asked on their first launch after updating.

**When it shows.** Once per launch, after the main window mounts and setup is complete. If it isn't answered (for example, the app quits while it is showing), it shows again at the next launch.

**The card.** It uses the existing card shell under the bar. It reveals a hidden bar, the way the amber card does (`reveal_overlay`), so it is actually seen.

```
┌──────────────────────────────────────────┐
│ ● Record your calls automatically?       │
│   Meetwings can start recording when you │
│   join a Google Meet call in Chrome, and │
│   stop when you leave.                   │
│                    [Not now]  [Turn on]  │
└──────────────────────────────────────────┘
```

*(My call, copy:)*

- Windows body: "…when you join a Teams or Google Meet call, and stop when you leave."
- If it fits, a muted footnote: "Let people know when you record." The Settings paragraph already carries the full consent text.

**Turn on**
- On Windows: save `"true"` and emit `meeting-detection-setting-changed {enabled:true}`. Then record the answer and clear the card.
- On macOS, `macToggleOnCheck()` runs: probe, then the mic prompt, then the system-audio prompt. Both buttons are disabled while it runs.
  - **It passes:** the same steps as Windows.
  - **It fails:** write the start failure, the same record the Settings toggle writes and shows, and leave auto-record off.
    - The card stays, with the failure's one-line reason, an **Open settings** button and **Not now**. Open settings uses `open_dashboard`, as the amber card does, and the Settings note there has the specific "Open … settings" button.
    - The answer is **not** recorded. The user retries from Settings, once the permission is allowed, and is asked again next launch if they leave the card unanswered.

**Not now.** Record the answer and clear the card. Nothing else changes.

**Settings changed while the card is up**, either way (`meeting-detection-setting-changed`): clear the card and record the answer.

**Other cards.** The store holds one card. *(My call:)*

- the offer is not shown while another card is up;
- any other card replaces it;
- a replaced offer is not shown again in that launch, and returns at the next one.

With auto-record off, auto-record's own cards cannot appear, so this is rare.

**Log.** `detection.log` gets `offer shown`, then `offer answer=on`, `offer answer=later` or `offer answer=failed:<kind>`. No personal data.

## 5. How it is built (decided)

- **Shared turn-on.** Extract the toggle-on logic from `MeetingAutoRecordToggle.tsx` into one function used by both the Settings toggle and the card, so the two cannot drift. It runs the Mac check if needed, saves, emits, and returns `StartFailure | null`.
- **New card kind.** Add `"offer"` to `MeetingCardState` in `meeting-cards.store.ts`, with fixed heights in `cardHeight` for full and compact, and render it in `MeetingCard.tsx`.
- **New storage key.** `MEETING_AUTO_RECORD_OFFER` in `STORAGE_KEYS`.
- **Windows.** Detection, the watcher and auto-record behaviour are unchanged. The only new Windows behaviour is the card itself.
- **Tests (Vitest, `src/tests/`):**
  - when the offer shows and when it doesn't (each condition);
  - Turn on: Windows, Mac passing, Mac failing;
  - Not now;
  - a Settings change clears it;
  - the card heights;
  - the existing toggle and Windows suites stay green.

## 6. Left to the builder

- Where the show-check runs, as long as it is the main window, after setup is complete and the card host is mounted.
- Exact layout and heights inside the existing card shell, and whether the footnote fits.
