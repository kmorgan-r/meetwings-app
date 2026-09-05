# Manual acceptance — calendar-proposed Odoo targets

Nothing automated can cover any of these. A loopback browser round-trip
cannot be proven in jsdom, jsdom has no window bounds to check a popover's
footprint against, and the last two items verify a documented design
tradeoff rather than gate on one — see `MeetingLogStrip.tsx`'s own
acknowledgement of the same jsdom limitation.

- [ ] **Full connect flow in a real tenant, ending in a proposal.** Register an
      app with loopback-only redirect URIs, "Allow public client flows" = No,
      and the `/organizations` authority. Enter its client ID on `/odoo`,
      connect, consent, and confirm the picker proposes the attendees of a
      meeting happening now.
- [ ] **A meeting with a booked room.** `attendees[].type == "resource"` was
      never observed live during this feature's probe window — the Graph
      probe's mailbox had no room mailbox in its events — so the drop rule at
      `src/lib/calendar/match-attendees.ts:26` (`if (participant.type ===
      "resource") continue;`) ships unexercised against a real Graph
      response. Book a meeting that includes a conference room as an
      attendee, make it current, open the picker, and confirm the room does
      NOT appear as a proposed target — only people do.
- [ ] **Disconnect really disconnects.** After Disconnect, the keychain entry is
      gone AND a subsequent proposal fails rather than succeeding on a
      still-live in-memory access token. (Clearing only the keychain leaves a
      token that keeps working until its expiry.)
- [ ] **`invalid_grant` clears the stored token.** Revoke the app's consent in
      Entra (or change the account password), then open the picker. Expect
      `GRAPH_AUTH_EXPIRED`, the keychain entry GONE, and `/odoo` showing
      disconnected. The cargo tests cover `classify_token_error`'s output codes
      but nothing exercises the branch that acts on them — that wiring lives in
      an async `#[tauri::command]` making real network calls, so this is the
      only place it can be checked.
- [ ] **A transport failure RETAINS the token.** With a connected account whose
      access token has expired, cut the network and open the picker. Expect
      `GRAPH_NETWORK`, and — once the network is back — a working proposal with
      NO reconnect required. A test asserting only "auth failure clears the
      token" would lock in the exact defect this three-way split corrected, so
      the retain half has to be exercised too.
- [ ] **`GRAPH_CONSENT_REQUIRED` in a tenant that blocks third-party consent.**
      It is the NORMAL first result there, not an edge case. Confirm the page
      names the Microsoft Entra admin center, the app's own client ID, and the
      `Calendars.ReadBasic` permission an administrator has to grant — and that
      it does NOT hand out a constructed `adminconsent` link. A constructed one
      was removed deliberately: the v2 protocol requires a `redirect_uri` that
      exactly matches a REGISTERED URI, and this app registers loopback URIs on
      a random ephemeral port per attempt, so any such link would either fail
      validation or land the administrator on a dead socket. Then confirm the
      proposal block shows the same remedy, so the two agree.
- [ ] **Linux with no keychain service.** Stop the Secret Service, connect, and
      confirm: the connection is session-only, the UI says so plainly, NOTHING
      is written to disk, and relaunching requires re-authentication.
- [ ] **The popover's height is unchanged** whether the block is absent (no
      calendar connected), loading, showing two rows, or showing twelve. jsdom
      has no window bounds, so nothing automated can prove the block is even
      visible.

## Known, accepted tradeoff — verified for severity, not a pass/fail gate

`present = connected && rows.length > 0` in `useCalendarProposal.ts`, and
both `connected` (the `graph_status` read) and `rows` (the contact cache)
resolve asynchronously after mount. That means the reserved 112px calendar
region can appear inside a popover that is already open, and can disappear
from one that is already open — a real breach of "the popover's footprint
must not change after it opens." This is a deliberate design tradeoff
inherited from the hook (a late-appearing block beats no block at all for
the rest of that open session), not a defect for Task 16 to fix. The two
steps below make the breach observable so its actual severity is on record,
rather than left as something arguable from the code alone.

- [ ] **Open the picker within about a second of app launch** — before the
      connection status and the contact cache have had time to settle.
      Record whether the calendar region appears inside the popover AFTER it
      is already open, and how disruptive that appearance reads in practice
      (a layout nudge vs. something that reads as broken).
- [ ] **With the picker open, disconnect Microsoft Graph on `/odoo`.** Record
      whether the calendar region disappears from the already-open popover,
      and how disruptive that removal reads in practice.

Both steps are exploratory, not a condition to fail the release on: report
what was observed so the tradeoff's real-world severity is on record, not
just its theoretical existence.
