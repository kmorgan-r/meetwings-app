import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { Button } from "@/components";
import { inferCompany, similarContacts } from "@/lib/calendar";
import { byRecency, MAX_TARGETS } from "@/lib/odoo";
// From @/types, NOT from the hook - see the placement note in
// src/types/calendar.ts. A page importing a type back out of a hook that
// depends on that page is the cycle this avoids.
import type {
  CalendarParticipant,
  CalendarProposalState,
  CreateContactResult,
  GraphErrorCode,
  OdooContact,
  SelectedTarget,
  SelectedTargets,
} from "@/types";

/**
 * FIXED height, not max-height.
 *
 * resizeWindow(true) is driven by a fixed flag list observed when the popover
 * OPENS, not by measured content height, and it is the only thing that grows a
 * window tauri.conf.json pins at 600x54 with "resizable": false. The proposal
 * arrives AFTER the popover opens because the Graph call is async, so content
 * that appears later has nothing to grow the window around it.
 *
 * A max-height would still let the footprint differ between two rows and
 * twelve. A fixed height with internal scrolling is what actually delivers the
 * identical-footprint rule the spec states in the same paragraph.
 */
const REGION_CLASS = "h-28 overflow-y-auto border-b pb-2 flex flex-col gap-1";

/** The Company filter's render cap. Five, not ContactPicker's hundred - this
 * control shares a 112px scroll region with two other fields. */
const MAX_COMPANY_ROWS = 5;

/**
 * The three codes where re-running the SAME call is the correct action: a
 * transient network failure, a rate limit, or a response Graph sent this time
 * that happened to be unparseable. Every other code gets a settings pointer
 * instead - see `CALENDAR_SETTINGS_REMEDY` below.
 *
 * The ONE list both the runtime check and `CALENDAR_SETTINGS_REMEDY`'s key
 * type derive from - see that constant's own comment for why a second,
 * separately-typed copy of this list is exactly the drift this closes.
 */
const RETRYABLE_CODES = [
  "GRAPH_NETWORK",
  "GRAPH_THROTTLED",
  "GRAPH_BAD_RESPONSE",
] as const satisfies readonly GraphErrorCode[];
type RetryableGraphErrorCode = (typeof RETRYABLE_CODES)[number];
const RETRYABLE_CODE_SET: ReadonlySet<GraphErrorCode> = new Set(RETRYABLE_CODES);

/**
 * Static copy, keyed on the code alone - NEVER server-supplied prose, a
 * subject or an address. src/lib/calendar/errors.ts already drops all three
 * at the boundary; this table exists so the region does not become the one
 * place that rule gets relaxed for the sake of being more specific.
 *
 * Retrying cannot fix any of these. GRAPH_AUTH_EXPIRED reaches here only
 * after mod.rs's refresh_and_adopt has already deleted the stored refresh
 * token (the AUTH_EXPIRED arm), so a second attempt just re-derives
 * GRAPH_NOT_CONNECTED - "Try again" promises a fix it cannot deliver.
 * GRAPH_NOT_CONNECTED, GRAPH_CONSENT_REQUIRED and GRAPH_NO_KEYCHAIN are
 * milder versions of the same gap. GRAPH_AUTH_REJECTED (a rejected stored
 * config) and GRAPH_AUTH_CANCELLED (not reachable from this fetch path today
 * - it is specific to the interactive graph_connect flow, not a background
 * token refresh) get the same treatment for the same reason: nothing this
 * component can re-run fixes either one.
 *
 * The `Exclude<RetryableGraphErrorCode>` key type is what makes this
 * exhaustive: a new `GraphErrorCode` that is not added to `RETRYABLE_CODES`
 * above fails to compile here until it is also given a remedy, rather than
 * silently falling through as neither. `RetryableGraphErrorCode` is DERIVED
 * from `RETRYABLE_CODES` (`(typeof RETRYABLE_CODES)[number]`), not a second,
 * separately-typed union - a code moved off that list without this Record
 * being updated used to type-check anyway (the lookup below was cast to
 * `keyof typeof CALENDAR_SETTINGS_REMEDY`, which reported `string`, not
 * `string | undefined`) and render an empty line beside "Open Settings".
 * With one shared source, that drift cannot compile.
 *
 * The consent copy deliberately matches /odoo's own admin-consent
 * instructions (index.tsx's connect handler) - same venue, same permission
 * name - so a user who sees this here and an administrator reading the fuller
 * instructions on /odoo are not told two different things.
 */
const CALENDAR_SETTINGS_REMEDY: Record<
  Exclude<GraphErrorCode, RetryableGraphErrorCode>,
  string
> = {
  GRAPH_NOT_CONNECTED: "Your calendar isn't connected. Connect it from the Odoo page's Calendar section.",
  GRAPH_CONSENT_REQUIRED:
    "Your organization must approve this app in the Microsoft Entra admin center before it can read your calendar (permission: Calendars.ReadBasic). Continue from the Odoo page's Calendar section.",
  GRAPH_AUTH_CANCELLED:
    "The calendar connection was not completed. Reconnect from the Odoo page's Calendar section.",
  GRAPH_AUTH_EXPIRED:
    "Your Microsoft sign-in expired, and the connection was reset. Reconnect from the Odoo page's Calendar section.",
  GRAPH_AUTH_REJECTED:
    "This calendar connection's settings are invalid. Reconnect from the Odoo page's Calendar section.",
  GRAPH_NO_KEYCHAIN:
    "The saved calendar connection could not be read from this device's secure storage. Reconnect from the Odoo page's Calendar section.",
};

export interface CalendarProposalProps {
  state: CalendarProposalState;
  /** The live multi-target list. Free slots are counted from THIS, not from
   * the match count: targets picked by hand before the proposal ran consume
   * slots (odoo-contacts.action.ts:279 countOthers). */
  targets: SelectedTargets;
  /**
   * ContactPicker's existing prop, owned by useOdooTarget. NOT
   * addSelectedTarget: calling the database layer from a component would
   * bypass the hook that owns `targets`, leaving the picker's own list, its
   * atCap at ContactPicker.tsx:284 and the "Logging to" box stale.
   */
  onAddTarget: (t: SelectedTarget) => Promise<{ ok: boolean; reason?: "cap" }>;
  /**
   * The whole cached contact list, not the proposal's matches.
   *
   * Three things here need it and none can use `proposal.matched`: the Company
   * filter (companies are not attendees), the Layer 2 similarity search (a
   * candidate is by definition somebody whose email did NOT match), and the
   * company inference.
   */
  contacts: OdooContact[];
  onCreateContact: (
    participant: CalendarParticipant,
    draft: { name: string; parentId: number | null }
  ) => Promise<CreateContactResult>;
  onPickCandidate: (eventId: string) => void;
  onRetry: () => void;
}

function timeRange(startMs: number, endMs: number): string {
  const fmt = (ms: number) =>
    new Date(ms).toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit" });
  return `${fmt(startMs)}–${fmt(endMs)}`;
}

/**
 * The Name field's starting value. A starting point the user is expected to
 * fix, not a guess presented as fact.
 *
 * Exported for its own test: the "Last, First" flip is the part most likely to
 * be wrong, and it is invisible from the outside once it has run.
 */
export function prefillName(participant: CalendarParticipant): string {
  const raw = (participant.name ?? "").trim();
  if (raw !== "") {
    const parts = raw.split(",");
    // A SINGLE comma only. "Doe, Jane, Jr" is not a Last, First name, and
    // guessing at it produces something the user then has to unmangle.
    const flipped =
      parts.length === 2 ? `${parts[1].trim()} ${parts[0].trim()}` : raw;
    return flipped.replace(/\s+/g, " ").trim();
  }
  // No display name at all - the population most likely to be unmatched. The
  // local part with its separators spaced is a better seed than a blank field,
  // and it is what gives Layer 2 tokens to work with.
  const local = participant.address.split("@")[0] ?? "";
  return local.replace(/[._-]+/g, " ").replace(/\s+/g, " ").trim();
}

export function CalendarProposal({
  state,
  targets,
  onAddTarget,
  contacts,
  onPickCandidate,
  onRetry,
}: CalendarProposalProps) {
  const [checked, setChecked] = useState<ReadonlySet<number>>(new Set());
  const [writeResult, setWriteResult] = useState<string | null>(null);
  const [writing, setWriting] = useState(false);
  const [createResult, setCreateResult] = useState<{ address: string; text: string } | null>(null);
  /**
   * The row whose form is open, keyed on the entry's RAW `participant.address`
   * - the same key the row's React key and data-testid already use. Never an
   * array index: the re-projection effect rebuilds `unmatched` whenever the
   * contact cache changes, so an index would silently point at a different
   * attendee.
   */
  const [openForm, setOpenForm] = useState<string | null>(null);
  /**
   * Snapshotted ONCE in the open handler, never derived from
   * `entry.participant` during render: `project()` calls `participantsOf`
   * fresh on every re-projection, so a reactive prefill would discard the
   * user's edits on a re-projection they did not cause.
   */
  const [draftName, setDraftName] = useState("");
  /** The chosen company's id, or null for "No company". Snapshotted at open
   * from inferCompany, then owned by the user. */
  const [draftParentId, setDraftParentId] = useState<number | null>(null);
  /** What is typed in the Company filter. Separate from `draftParentId`: the
   * user can be mid-search with a selection already made. */
  const [companyQuery, setCompanyQuery] = useState("");
  /**
   * Addresses the user resolved by picking an existing contact instead of
   * creating one, mapped to the contact they picked.
   *
   * A MAP, not a set: the row's label names that contact, and an address alone
   * cannot recover the name. `SelectedTarget` carries no address, and the
   * contact is by definition absent from `proposal.matched` - a different email
   * is Layer 2's whole premise.
   *
   * Cleared ONLY in the pre-check effect's isNewProposal branch and the
   * idle-reset effect. NOT on a freeSlots or writableKey change: a successful
   * Use click changes freeSlots by definition, so clearing there would
   * un-resolve the row on the very next commit.
   */
  const [resolvedByHand, setResolvedByHand] = useState<ReadonlyMap<string, OdooContact>>(new Map());
  /** The candidates for the open form, computed once when it opens. */
  const [candidates, setCandidates] = useState<OdooContact[]>([]);
  /**
   * ONE flag for both writes the form can start - `Create contact` and any
   * `Use <name>` button - because they contend for the same thing.
   *
   * `addSelectedTarget` is a non-atomic check-then-act: issued concurrently,
   * every call reads the same pre-write count, all pass, and MORE THAN
   * MAX_TARGETS rows land. `confirm` documents exactly this at
   * CalendarProposal.tsx:436-438 and writes sequentially because of it. Up to
   * three Use buttons render at once and the form stays open until the await
   * resolves, so without a shared guard two quick clicks ARE that race - a path
   * past the slot rule, which the Global Constraints forbid.
   */
  const [acting, setActing] = useState(false);
  /**
   * The synchronous half. `acting` is state and cannot refuse a second click
   * landing in the same tick, before React re-renders with `disabled`.
   *
   * Both handlers check this BEFORE their `try`, exactly as `confirm` returns
   * above its own try at :418/:435. That placement is load-bearing rather than
   * stylistic: a refused call that entered the `try` would run the `finally`
   * and clear `acting` while the FIRST write is still in flight, re-enabling
   * every button - the precise failure the hook's `busy` member exists to
   * prevent, reintroduced one layer up.
   */
  const actingRef = useRef(false);
  /**
   * Addresses whose last create returned `created-invisible`.
   *
   * Structural, not advisory. That outcome caches nothing (correctly - no row
   * may be fabricated), so `matchAttendees` keeps deriving `no-contact` for the
   * address forever and the row's own `Create in Odoo` button comes straight
   * back. Clicking it re-runs the create, and by that outcome's own premise the
   * Layer 1 search still cannot see the hidden partner - so the miss branch
   * fires and a SECOND invisible duplicate lands. The spec names that failure
   * and forbids it; closing the form does not prevent it, this does.
   *
   * Cleared on the same two triggers as `resolvedByHand`, and never by
   * re-deriving from `unmatched` - that set never changes for this address.
   */
  const [createdInvisible, setCreatedInvisible] = useState<ReadonlySet<string>>(new Set());

  /**
   * Capped at FIVE, not MAX_RENDERED_ROWS' hundred: the control lives in a
   * 112px scroll region beside two other fields.
   *
   * In a useMemo for the reason ContactPicker.tsx:262-265 uses one - the cache
   * routinely holds thousands of partners and this component re-renders on
   * every parent render.
   */
  const companyOptions = useMemo(() => {
    const needle = companyQuery.trim().toLocaleLowerCase();
    const companies = contacts.filter((c) => c.isCompany);
    const matched =
      needle === ""
        ? companies
        : companies.filter((c) => c.name.toLocaleLowerCase().includes(needle));
    return matched.slice(0, MAX_COMPANY_ROWS);
  }, [contacts, companyQuery]);
  /**
   * The same fact as `writing`, in a ref, because two different consumers need
   * it at two different times:
   *
   * - the reset effect below reads it DURING the write, and a state read there
   *   is a render-time snapshot that can lag the loop;
   * - `confirm` reads it to refuse re-entry, and the button's `disabled` alone
   *   only covers repeat clicks on that one control.
   */
  const writingRef = useRef(false);
  /**
   * Bumped every time the idle-reset effect below runs. `confirm` captures
   * this before its write loop and re-checks it after every `onAddTarget`
   * await: `useOdooTarget.addTarget` resolves a target's partner id against
   * whichever Odoo instance is CURRENT per call (useOdooTarget.ts:1038), so a
   * batch that keeps writing after an instance change would write the
   * remaining rows - ids that name partners in the OLD instance - into the
   * NEW one under those stale ids. A mismatch aborts the rest of the loop.
   */
  const epochRef = useRef(0);
  /**
   * Which meeting the CURRENTLY pre-checked selection belongs to - see the
   * pre-check effect below, which is the only reader/writer.
   */
  const lastProposalEventIdRef = useRef<string | null>(null);

  const proposal = state.kind === "proposal" ? state : null;
  const proposalEventId = proposal?.eventId ?? null;

  const { rows, writable, freeSlots } = useMemo(() => {
    const sorted = (proposal?.matched ?? [])
      .slice()
      .sort((a, b) => byRecency(a.contact, b.contact));
    const isSelected = (id: number) =>
      targets.some((t) => t.model === "res.partner" && t.resId === id);
    return {
      rows: sorted,
      // A match already in `targets` is rendered as already-selected, is not
      // checkable, and is EXCLUDED FROM THE WRITE ENTIRELY.
      writable: sorted.filter((m) => !isSelected(m.contact.id)),
      freeSlots: MAX_TARGETS - targets.length,
    };
  }, [proposal, targets]);

  const writableKey = writable.map((m) => m.contact.id).join(",");
  useEffect(() => {
    /**
     * `isNewProposal` is what makes this effect safe to also run for a
     * REPROJECTION - useCalendarProposal.ts re-running `matchAttendees`
     * against the SAME meeting when the contact cache changes underneath it
     * (a colleague toggle, an archive picked up by Refresh). That reprojection
     * changes `writable` - a colleague's row drops out of it entirely - which
     * changes `writableKey`, which re-fires this effect exactly like a write
     * completing does. The two cases need OPPOSITE handling:
     *
     * - a genuinely NEW proposal (a different `eventId` - the picker just
     *   opened, or the user picked a different candidate meeting) should
     *   pre-check every writable row that fits, same as always;
     * - the SAME proposal with a shrunk `writable` set - from a reprojection,
     *   or from a write landing (below) - must only ever DROP ids from
     *   `checked`, never add one back. Recomputing "pre-check every row that
     *   fits" here would silently RE-TICK a row the user had deliberately
     *   unchecked, for either cause. `eventId` unchanged is what tells the two
     *   apart; the ref survives across renders because `lastEventId` itself
     *   would just be reset to the wrong thing by the very re-render this
     *   effect responds to.
     *
     * Recorded UNCONDITIONALLY, before the write guard below returns: an
     * eventId transition that happens to land mid-write (an instance change
     * resets state to `idle`, which counts as a transition) must still be
     * captured, or a later same-eventId proposal on a still-mounted component
     * would read as "not new" and wrongly intersect against nothing.
     */
    const isNewProposal = proposalEventId !== lastProposalEventIdRef.current;
    lastProposalEventIdRef.current = proposalEventId;

    /**
     * NOT WHILE A WRITE IS RUNNING. This guard is the whole finding.
     *
     * `confirm` writes sequentially, and each successful `onAddTarget` updates
     * the parent's `targets` (useOdooTarget.addTarget -> applyTargets). Since
     * `targets` is a prop and a dependency of the memo above, every successful
     * write re-renders, recomputes `writable` without the row just added,
     * changes `writableKey`, and re-fires this effect - which then rebuilt the
     * pre-checked set from scratch, SILENTLY RE-CHECKING rows the user had
     * deliberately unchecked before clicking Add. The user watches boxes tick
     * themselves back on mid-write, clicks Add again trusting what is on
     * screen, and writes the attendee they excluded.
     *
     * That is a write to odoo_selected_targets the user did not authorise,
     * which is precisely what the confirm gate exists to make impossible.
     *
     * It also erased `writeResult`, so a partial-write failure could lose its
     * only surface to a `targets` update flushing after the loop.
     */
    if (writingRef.current) return;

    // A genuinely new proposal starts both latches over. NOT inside the
    // `setChecked` updater below - an updater must be pure (it can run more
    // than once for the same commit under StrictMode), and this component's
    // sibling already carries an explicit comment against nesting other
    // setters in one (ContactPicker.tsx:240-243).
    if (isNewProposal) {
      setResolvedByHand(new Map());
      setCreatedInvisible(new Set());
    }

    setChecked((prev) => {
      if (isNewProposal) {
        // Pre-check only when EVERY writable match fits. Auto-selecting an
        // arbitrary subset is the wrong-record risk this feature exists to
        // avoid.
        return writable.length > 0 && writable.length <= freeSlots
          ? new Set(writable.map((m) => m.contact.id))
          : new Set();
      }
      // SAME proposal, `writable` shrank for a reason that is not a write in
      // progress (a reprojection - see the block comment above). INTERSECT
      // ONLY: an id that vanished from `writable` is dropped, but nothing is
      // ever added back, so a row the user unchecked before the reprojection
      // stays unchecked after it.
      const writableIds = new Set(writable.map((m) => m.contact.id));
      const next = new Set<number>();
      for (const id of prev) if (writableIds.has(id)) next.add(id);
      // The slot rule still applies to what survives the intersect. A
      // reprojection never REMOVES a target (only a write does that, and
      // this branch already can't run mid-write - see the guard above), but
      // ADDING targets by hand in the same popover shrinks `freeSlots`
      // without touching `writable` or `writableKey` at all, so this effect
      // still fires (it depends on `freeSlots`) while every id already in
      // `checked` survives the intersect untouched - silently leaving MORE
      // rows checked than there is room to write. Confirm would then write
      // whichever ones land first by recency and cap-reject the rest: an
      // arbitrary subset, which is exactly what the pre-check's own "every
      // writable match fits, or none" rule (just above) exists to prevent.
      // Clearing instead of trimming to fit keeps this branch the same
      // shape as that rule: an auto-selected PARTIAL batch is never offered,
      // only "all" or "none".
      return next.size > freeSlots ? new Set() : next;
    });
    setWriteResult(null);
    // `writableKey` stands in for `writable` on purpose - see the comment
    // above. Depending on `writable` itself would re-run this effect on every
    // render (a fresh array from the memo above) instead of only when its
    // contents actually change.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [writableKey, freeSlots, proposalEventId]);

  /**
   * Flips `writingRef` back to `false`, but deferred to its OWN effect
   * declared after the pre-check effect above, rather than folded into
   * `confirm`'s `finally`. React runs a commit's effects in declaration
   * order, and the render where a write's LAST successful `onAddTarget`
   * lands is the SAME commit where `targets` (and therefore `writableKey`)
   * changes to reflect it: `setTargets` from inside that last call and
   * `confirm`'s own `setWriting(false)` land in the same batch. Resetting
   * the ref synchronously in `finally` flips it BEFORE that commit's effects
   * even run, so the pre-check effect above would see `writingRef.current
   * === false` on EXACTLY that render and re-derive `checked` from the
   * just-shrunk `writable` list - silently re-ticking whatever the user had
   * unchecked. Resetting it here instead means the pre-check effect (which
   * runs first) still sees the write as in progress on that render; only
   * after it has run does this effect unlock the ref for the NEXT write.
   */
  useEffect(() => {
    if (!writing) writingRef.current = false;
  }, [writing]);

  /**
   * `idle` while this component is still mounted and rendering - NOT "the
   * popover closed, so this never runs again" as it might look. Radix's
   * `Popover` unmounts its content on a normal close (no `forceMount` in
   * src/components/ui/popover.tsx, and `Presence` unmounts without one), and
   * `<Completion />` unmounts the whole picker subtree on a meeting-log hold
   * (completion/index.tsx swaps `<ContactPicker />` for `<MeetingLogStrip />`).
   * This effect exists for the cases that DO keep the component mounted while
   * idle: an Odoo instance change resets `useCalendarProposal`'s state to idle
   * while the picker stays open; the brief exit-animation window where Radix's
   * `Presence` keeps content mounted after `open` has already gone false; and
   * `config.state === "absent"` while `blockPresent` is still true from an
   * earlier connected session.
   *
   * `writing` is the one that matters most: without this it had no reset path
   * at all, and a write in flight when the instance changes would leave the
   * confirm button dead on every later open, for an unrelated later meeting,
   * with nothing saying why. Bumping `epochRef` here is what lets `confirm`
   * (below) tell that its own in-flight write has been abandoned.
   */
  useEffect(() => {
    if (state.kind !== "idle") return;
    epochRef.current += 1;
    writingRef.current = false;
    setWriting(false);
    // `actingRef`/`acting` need the SAME reset, for the same reason: without
    // it, an instance change while a `Use` click is pending strands both
    // flags `true` forever - the pending write's own `finally` checks
    // `epochRef` and skips its release once this bump has happened - and
    // every later `Use` button and `Add N to log` stays disabled for the
    // rest of the mount. No unlock-effect analog is needed here: the
    // batching hazard that motivates deferring `writingRef`'s reset to a
    // separate effect (below) does not apply, because the pre-check effect's
    // own guard reads `writingRef` only, never `actingRef`.
    actingRef.current = false;
    setActing(false);
    setChecked(new Set());
    setWriteResult(null);
    setResolvedByHand(new Map());
    setCreatedInvisible(new Set());
  }, [state.kind]);

  /**
   * Every exit from the form goes through here: Cancel, a landed write, and the
   * two effects in Task 9.
   *
   * `useCallback` with `[]` - it only calls state setters, whose identities
   * React guarantees are stable - so it can be listed in an effect's dependency
   * array without re-running that effect every render.
   */
  const closeForm = useCallback(() => {
    setOpenForm(null);
    setDraftName("");
    setDraftParentId(null);
    setCompanyQuery("");
    setCandidates([]);
  }, []);

  /**
   * Mirrors `openForm` so a post-await handler can read which row is open NOW
   * rather than which row was open when it started.
   *
   * Same pattern, and the same reason, as `targetsRef` at
   * useOdooTarget.ts:290-293: the value is needed by a callback that must keep a
   * stable identity, so it cannot take the state as a dependency.
   */
  const openFormRef = useRef<string | null>(null);
  useLayoutEffect(() => {
    openFormRef.current = openForm;
  });

  /**
   * Closes the form ONLY if the row it belongs to is still the open one.
   *
   * `epochRef` tracks idle resets, not row switches, so a write that resolves
   * after the user opened a DIFFERENT row would otherwise close that row and
   * discard its draft.
   *
   * The check reads a REF, not a `setOpenForm` updater. Nesting the sibling
   * setters inside an updater does work in React 19, but an updater must be
   * pure - it can run more than once for the same commit under StrictMode - and
   * this component's sibling already carries an explicit comment against
   * exactly that pattern (ContactPicker.tsx:240-243).
   */
  const closeIfStillOpen = useCallback(
    (address: string) => {
      if (openFormRef.current === address) closeForm();
    },
    [closeForm]
  );

  const region = (children: React.ReactNode) => (
    <div className={REGION_CLASS} data-testid="calendar-proposal-region">
      {children}
    </div>
  );

  // Reserved, not absent: see the doc comment on the idle-reset effect above
  // for the cases this component renders while genuinely idle.
  if (state.kind === "idle") return region(null);

  if (state.kind === "loading") {
    return region(<p className="text-[11px] text-muted-foreground">Checking your calendar…</p>);
  }
  if (state.kind === "no-meeting") {
    return region(
      <p className="text-[11px] text-muted-foreground">No meeting found right now.</p>
    );
  }
  if (state.kind === "error") {
    // The code only. Subjects, addresses and tokens were never put into the
    // error in the first place - see src/lib/calendar/errors.ts.
    const retryable = RETRYABLE_CODE_SET.has(state.code);
    return region(
      <>
        <p className="text-[11px] text-destructive">{state.code}</p>
        {!retryable && (
          <p className="text-[11px] text-muted-foreground">
            {
              CALENDAR_SETTINGS_REMEDY[
                state.code as keyof typeof CALENDAR_SETTINGS_REMEDY
              ]
            }
          </p>
        )}
        {retryable ? (
          <button
            type="button"
            data-testid="calendar-proposal-retry"
            className="text-[10px] uppercase tracking-wide text-muted-foreground hover:text-foreground self-start"
            onClick={onRetry}
          >
            Try again
          </button>
        ) : (
          // `open_dashboard` focuses/opens the dashboard webview at whatever
          // route it is already on - it does not deep-link to /odoo, so this
          // is labelled the same as ContactPicker's own "Odoo is not set up
          // yet" button (a few lines below in the same popover) rather than
          // promising a jump straight to the Calendar section.
          <button
            type="button"
            data-testid="calendar-proposal-open-settings"
            className="text-[10px] uppercase tracking-wide text-muted-foreground hover:text-foreground self-start"
            onClick={() => void invoke("open_dashboard")}
          >
            Open Settings
          </button>
        )}
      </>
    );
  }
  if (state.kind === "several") {
    return region(
      <>
        <p className="text-[10px] uppercase tracking-wide text-muted-foreground">
          Which meeting?
        </p>
        {state.candidates.map((candidate) => (
          <button
            key={candidate.id}
            type="button"
            data-testid={`calendar-candidate-${candidate.id}`}
            className="text-left text-[11px] hover:text-primary"
            onClick={() => onPickCandidate(candidate.id)}
          >
            {`${candidate.subject ?? "Untitled meeting"} · ${timeRange(candidate.startMs, candidate.endMs)}`}
          </button>
        ))}
      </>
    );
  }

  const checkedWritable = writable.filter((m) => checked.has(m.contact.id));
  const atCap = freeSlots <= 0;
  const overflowing = writable.length > freeSlots && !atCap;

  const confirm = async () => {
    // `actingRef` too - the other half of the same race. A `Use` click already
    // in flight is an unresolved `addSelectedTarget` against the same cap.
    if (writingRef.current || actingRef.current) return;
    writingRef.current = true;
    setWriting(true);

    // Captured so a mid-write instance change (bumped by the idle-reset
    // effect above) can be detected below.
    const epoch = epochRef.current;

    // SNAPSHOT the user's choice before the first await. `targets` mutates
    // under us as the loop lands rows, so re-reading `checkedWritable` mid-loop
    // would write whatever the recomputed set says rather than what the user
    // actually confirmed.
    const batch = [...checkedWritable];
    const written: string[] = [];
    const notWritten: string[] = [];
    let failure: "cap" | "other" | null = null;

    try {
      // SEQUENTIAL. addSelectedTarget is a non-atomic check-then-act; issued
      // concurrently every call reads the same pre-write count, all pass, and
      // more than MAX_TARGETS rows land.
      for (const match of batch) {
        if (failure !== null) {
          notWritten.push(match.contact.name);
          continue;
        }
        const result = await onAddTarget({
          model: "res.partner",
          resId: match.contact.id,
          name: match.contact.name,
        });
        // The instance changed while this call was in flight. The rest of
        // `batch` would land in the NEW instance under the OLD instance's
        // partner ids - abort with no further writes and no write-result
        // message; the popover already reset to idle underneath us.
        if (epochRef.current !== epoch) return;
        if (result.ok) {
          written.push(match.contact.name);
          continue;
        }
        // `reason` MATTERS. useOdooTarget.addTarget returns a bare `{ ok: false }`
        // from its catch for any thrown error - a busy database,
        // ODOO_NOT_CONFIGURED - and it has already shown the user a toast naming
        // the real cause. Reporting every failure as "the log is full" would
        // contradict that toast and send the user to remove destinations that
        // were never the problem.
        failure = result.reason === "cap" ? "cap" : "other";
        notWritten.push(match.contact.name);
      }

      if (epochRef.current === epoch) {
        setWriteResult(
          failure === null
            ? null
            : `${written.length === 0 ? "Nothing was added" : `Added ${written.join(", ")}`}. ${
                failure === "cap"
                  ? "The log is full, so"
                  : "Something went wrong, so"
              } ${notWritten.join(", ")} ${notWritten.length === 1 ? "was" : "were"} not added.`
        );
      }
    } finally {
      // `addTarget`'s contract says it never rejects (it catches its own
      // errors into `{ ok: false }`), but if it ever did, this is the
      // difference between a confirm button that's dead until the popover
      // closes and one that recovers - the same failure mode the idle-reset
      // effect exists to guard against.
      //
      // `writingRef.current` is deliberately NOT reset here - see the
      // "unlock" effect above for why doing it synchronously in this
      // `finally` block is exactly the bug that let a write silently
      // re-check a row the user had excluded.
      //
      // EPOCH-GUARDED too. Today an idle reset never re-fetches within the
      // same mount, so an abandoned loop's `setWriting(false)` currently
      // lands as a same-value no-op - but that is a cross-file invariant
      // (useCalendarProposal.ts's fetch effect stays blocked by
      // hasFetched.current once a reset has run), not something enforced
      // here. If a later change ever makes an instance change re-fetch, an
      // abandoned write A's `finally` would otherwise flip `writing` false
      // mid-write-B, the unlock effect would clear `writingRef`, and the
      // pre-check effect would re-tick whatever write B's user had
      // unchecked - the same hazard this whole guard exists to close. A
      // plain throw still recovers: it leaves `epochRef` unchanged, so the
      // guard passes and `writing` still resets.
      if (epochRef.current === epoch) setWriting(false);
    }
  };

  /**
   * Adds an existing contact as a target instead of creating a new partner.
   *
   * The click IS the confirm - adding an existing contact as a target is
   * exactly what the `Add N to log` gate already authorises the user to do one
   * row at a time - and it writes nothing to Odoo.
   */
  const resolveWithExisting = async (address: string, chosen: OdooContact) => {
    // BEFORE the try, so a refused second click can never reach the finally and
    // release the in-flight write's guard. See actingRef's own comment.
    //
    // `writingRef` TOO, not just `actingRef`. `confirm` calls the very same
    // `onAddTarget` against the very same five slots, and the two guards are
    // separate flags that do not read each other. With four targets already
    // logged, clicking `Add 1 to log` and then a `Use` button before the loop
    // lands issues two concurrent `addSelectedTarget` calls that both read
    // n = 4 < 5 and both insert - six rows. Guarding only against a second
    // click of this same control closes half the race.
    if (actingRef.current || writingRef.current) return;
    actingRef.current = true;
    setActing(true);

    const epoch = epochRef.current;
    try {
      const result = await onAddTarget({
        model: "res.partner",
        resId: chosen.id,
        name: chosen.name,
      });
      if (epochRef.current !== epoch) return;
      if (!result.ok) {
        // A cap rejection resolves nothing, because nothing was added.
        setCreateResult({
          address,
          text:
            result.reason === "cap"
              ? "The log is full. Remove a destination above first."
              : "Could not add that contact.",
        });
        return;
      }
      setResolvedByHand((prev) => new Map(prev).set(address, chosen));
      // Address-gated, not a bare closeForm() - see closeIfStillOpen.
      closeIfStillOpen(address);
    } finally {
      if (epochRef.current === epoch) {
        actingRef.current = false;
        setActing(false);
      }
    }
  };

  return region(
    <>
      <p className="text-[10px] uppercase tracking-wide text-muted-foreground">
        {proposal?.subject ?? "Untitled meeting"}
      </p>

      {(atCap || overflowing) && (
        <p className="text-[11px]" data-testid="calendar-proposal-notice">
          {atCap
            ? "The log is full. Remove a destination above to add anyone from this meeting."
            : `${writable.length} attendees matched — ${freeSlots} slot${
                freeSlots === 1 ? "" : "s"
              } left. Pick up to ${freeSlots}.`}
        </p>
      )}

      {rows.map((match) => {
        const selected = !writable.some((w) => w.contact.id === match.contact.id);
        return (
          <label key={match.contact.id} className="flex items-center gap-2 text-[11px]">
            <input
              type="checkbox"
              data-testid={`calendar-proposal-row-${match.contact.id}`}
              checked={selected || checked.has(match.contact.id)}
              disabled={selected || atCap}
              onChange={(e) =>
                setChecked((prev) => {
                  const next = new Set(prev);
                  if (e.target.checked) next.add(match.contact.id);
                  else next.delete(match.contact.id);
                  return next;
                })
              }
            />
            <span data-testid={`calendar-proposal-label-${match.contact.id}`}>
              {match.contact.name}
            </span>
            {selected && (
              <span
                data-testid={`calendar-proposal-selected-${match.contact.id}`}
                className="text-[10px] text-muted-foreground"
              >
                already added
              </span>
            )}
          </label>
        );
      })}

      {/*
        The label switches on `reason`. Task 4 computes `archived` precisely
        because it is NOT a softer "no-contact" - the partner record exists, it
        is just archived, and telling the user there is no contact for someone
        who is in their Odoo would send them to create a duplicate.
      */}
      {proposal?.unmatched.map((entry) => {
        const address = entry.participant.address;
        const resolved = resolvedByHand.get(address) ?? null;
        // Membership ALONE is a latch on a fact that can reverse - the user can
        // remove the target again from the "Logging to" list in the same
        // popover. Gate on the target still being present.
        const stillATarget =
          resolved !== null &&
          targets.some((t) => t.model === "res.partner" && t.resId === resolved.id);
        // `createdInvisible` is what actually enforces the spec's rule that a
        // created-invisible result must never be retried through the create
        // path. Closing the form does not: the outcome caches nothing, so the
        // row keeps deriving `no-contact` and this same button would come back
        // on the next render, one click away from a second hidden duplicate.
        const invisible = createdInvisible.has(address);
        const canCreate = entry.reason === "no-contact" && !stillATarget && !invisible;
        return (
          <div key={address} className="flex flex-col gap-1">
            <div className="flex items-center gap-2">
              {/*
                The testid and the muted class stay on the element carrying the
                TEXT. CalendarProposal.states.test.tsx asserts both on exactly
                this node, and the affordance must not disturb either.
              */}
              <p
                data-testid={`calendar-unmatched-${address}`}
                className="text-[11px] text-muted-foreground"
              >
                {stillATarget && resolved !== null
                  ? `${entry.participant.name ?? address} — added ${resolved.name}`
                  : invisible
                    ? // Say WHY there is no button, rather than showing a bare
                      // "no Odoo contact" the user cannot act on.
                      `${entry.participant.name ?? address} — created in Odoo, but not visible to this connection`
                    : `${entry.participant.name ?? address} — ${
                        entry.reason === "archived" ? "archived in Odoo" : "no Odoo contact"
                      }`}
              </p>
              {canCreate && (
                <button
                  type="button"
                  data-testid={`calendar-create-${address}`}
                  className="text-[10px] uppercase tracking-wide text-muted-foreground hover:text-foreground"
                  onClick={() => {
                    const parentId = inferCompany({
                      address: entry.participant.address,
                      contacts,
                    });
                    setOpenForm(address);
                    const seeded = prefillName(entry.participant);
                    // Computed on the SEEDED name, including the local-part
                    // fallback - participant.name is nullable, and an attendee
                    // with no display name is exactly the population most
                    // likely to be unmatched. Run once, at open: re-running per
                    // keystroke would flicker the list under a user typing in a
                    // 112px scroll region.
                    setCandidates(
                      similarContacts({
                        name: seeded,
                        address: entry.participant.address,
                        contacts,
                      })
                    );
                    setDraftName(seeded);
                    setDraftParentId(parentId);
                    // The label is the cached company's own name - there is no
                    // second source for it, which is why inferCompany only ever
                    // returns an id that names a cached isCompany contact.
                    setCompanyQuery(
                      parentId === null
                        ? ""
                        : (contacts.find((c) => c.id === parentId)?.name ?? "")
                    );
                  }}
                >
                  Create in Odoo
                </button>
              )}
            </div>
            {canCreate && openForm === address && (
              <div className="flex flex-col gap-1 pl-2" data-testid="calendar-create-form">
                {candidates.length > 0 && (
                  <>
                    <p className="text-[10px] uppercase tracking-wide text-muted-foreground">
                      Already in Odoo?
                    </p>
                    {candidates.map((c) => (
                      <button
                        key={c.id}
                        type="button"
                        data-testid={`calendar-create-use-${c.id}`}
                        className="text-left text-[11px] hover:text-primary disabled:opacity-50"
                        // Every Use button, the Create button below, and
                        // `Add N to log` all end in a write contending for the
                        // same five slots, so each disables on both flags.
                        disabled={acting || writing}
                        onClick={() => void resolveWithExisting(address, c)}
                      >
                        {`Use ${c.name}${c.email === null ? "" : ` · ${c.email}`}`}
                      </button>
                    ))}
                  </>
                )}
                <input
                  type="text"
                  data-testid="calendar-create-name"
                  className="text-[11px] border rounded px-1 py-0.5"
                  value={draftName}
                  onChange={(e) => setDraftName(e.target.value)}
                />
                {/* READ-ONLY, and not an input: this is the key the row was
                    matched on and the key the created partner is matched on
                    next time. */}
                <p className="text-[11px] text-muted-foreground" data-testid="calendar-create-email">
                  {address}
                </p>
                <input
                  type="text"
                  data-testid="calendar-create-company"
                  placeholder="Company (optional)"
                  className="text-[11px] border rounded px-1 py-0.5"
                  value={companyQuery}
                  onChange={(e) => {
                    setCompanyQuery(e.target.value);
                    // Typing invalidates the selection: the field must never
                    // show one company's name while carrying another's id.
                    setDraftParentId(null);
                  }}
                />
                {draftParentId === null && companyQuery.trim() === "" && (
                  <p
                    className="text-[10px] text-muted-foreground"
                    data-testid="calendar-create-company-none"
                  >
                    No company
                  </p>
                )}
                {draftParentId === null &&
                  companyQuery.trim() !== "" &&
                  companyOptions.map((company) => (
                    <button
                      key={company.id}
                      type="button"
                      data-testid={`calendar-create-company-option-${company.id}`}
                      className="text-left text-[11px] hover:text-primary"
                      onClick={() => {
                        setDraftParentId(company.id);
                        setCompanyQuery(company.name);
                      }}
                    >
                      {company.name}
                    </button>
                  ))}
                <div className="flex items-center gap-2">
                  <Button
                    size="sm"
                    className="h-6 text-[11px]"
                    data-testid="calendar-create-submit"
                    disabled={draftName.trim() === ""}
                  >
                    Create contact
                  </Button>
                  <button
                    type="button"
                    data-testid="calendar-create-cancel"
                    className="text-[10px] uppercase tracking-wide text-muted-foreground hover:text-foreground"
                    onClick={closeForm}
                  >
                    Cancel
                  </button>
                </div>
              </div>
            )}
          </div>
        );
      })}

      {createResult !== null && (
        <p className="text-[11px]" data-testid="calendar-create-result">
          {createResult.text}
        </p>
      )}

      {!atCap && (
        <Button
          size="sm"
          className="h-6 text-[11px] self-start"
          data-testid="calendar-proposal-confirm"
          disabled={writing || acting || checkedWritable.length === 0}
          onClick={() => void confirm()}
        >
          {`Add ${checkedWritable.length} to log`}
        </Button>
      )}

      {writeResult !== null && (
        <p className="text-[11px] text-destructive" data-testid="calendar-proposal-write-result">
          {writeResult}
        </p>
      )}
    </>
  );
}
