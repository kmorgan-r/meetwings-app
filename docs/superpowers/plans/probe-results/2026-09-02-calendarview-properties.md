# Probe 1 — calendarView properties under Calendars.ReadBasic

Run conditions: Graph Explorer, Graph v1.0, real Microsoft 365 tenant, `GET /me/calendarView` over an 8-day window, request header `Prefer: outlook.timezone="UTC"`. Run performed by the user on 2026-09-03; this document records that run's result, it was not re-executed here.

Note: the request's `$select` did not apply — the response `@odata.context` carried no projection — so the **full default event resource** was observed, a strictly stronger result than the probe asked for (every requested property was checked against that full payload, plus a few extras noted below).

ReadBasic was confirmed genuinely in force: `body` and `bodyPreview` were **both absent** from every event in the payload — that absence is the observable signature that the token was actually scoped to `Calendars.ReadBasic` and not something broader.

Present / absent, one line each:
- attendees: PRESENT (array; each entry has `type`, `status.response`, `status.time`, `emailAddress.name`, `emailAddress.address`)
- attendees[].type (does a booked room appear with type "resource"?): PRESENT as a property, but only the literal `"required"` value was observed across the window. No room mailbox was booked on any event in the window, so the `"resource"` value itself is UNVERIFIED LIVE — the property exists and is populated, but this run does not confirm what a room-resource attendee looks like. The resource-drop rule ships as designed and moves to manual acceptance.
- organizer: PRESENT (`organizer.emailAddress.name` / `.address`)
- organizer repeated inside attendees? (confirmation only — the union-and-dedupe rule is correct either way): BOTH SHAPES OBSERVED IN ONE TENANT. On an event the signed-in user organized, the organizer was NOT present in `attendees`. On an event organized by someone else, the organizer WAS present in `attendees`. The union-and-dedupe rule is therefore REQUIRED, not merely defensive.
- subject: PRESENT
- start / end (and the `timeZone` value returned with the Prefer header): PRESENT. `timeZone` came back `"UTC"` on every event, including events whose `originalStartTimeZone` was `"America/New_York"`, `"Eastern Standard Time"`, and `"Africa/Johannesburg"`. The `Prefer: outlook.timezone="UTC"` header works as intended; the later reject-if-not-UTC rule is exercising a real condition, not a vacuous one.
- isCancelled: PRESENT (boolean)
- isAllDay: PRESENT (boolean)
- responseStatus: PRESENT (`{ response, time }`)

Verdict: ALL-PRESENT
Decision for Task 9's GRAPH_SCOPES:
  "openid profile offline_access https://graph.microsoft.com/Calendars.ReadBasic"

## Additional live facts confirmed by this run (already handled correctly by the plan — recorded here, no code changed)

1. `responseStatus.response` returned the literal `"organizer"` on a self-organized event — a value outside the accepted/declined/tentativelyAccepted/notResponded/none set the plan enumerates. The plan rejects only on `"declined"`, so `"organizer"` survives, which is the correct outcome (you do not decline your own meeting). Confirmed by this run, not assumed.
2. Organizer-repeated-in-attendees is inconsistent within one tenant (see above). The plan's prose at `docs/superpowers/plans/2026-09-02-calendar-target-proposal.md:845` guesses "Graph generally does not repeat the organizer inside `attendees`" — that guess is half wrong with the right conclusion (the plan's union-and-dedupe rule already handles both shapes correctly). Recording the correction here; the plan file itself was not edited.
3. `emailAddress.name` was, on at least one attendee, byte-identical to `emailAddress.address`. This confirms exact normalized-email matching is the right approach over any display-name heuristic.
4. `calendarView` expands recurrence: recurring-series entries came back as `type: "occurrence"` with a `seriesMasterId` and an `occurrenceId`, each a standalone event with its own `start`/`end` — matching what the later window rules already assume.

Observed but outside the probe question:
- `hideAttendees` (boolean) exists on the event resource.
- `attendees[].status.response` is a per-attendee RSVP, distinct from the top-level `responseStatus`, which is the signed-in user's own. The declined-meeting filter reads the top-level `responseStatus`, which is correct.

## PII note

No real meeting subjects or real attendee email addresses are recorded in this document, per the plan's own never-log rule for subjects and addresses. Any example-shaped value referenced above (e.g. an "identical name/address" attendee) is described by shape only; no literal value was captured or is reproduced here. Where a concrete example would help, use an obviously-fake address such as `someone@example.test` — none was needed in this file.
