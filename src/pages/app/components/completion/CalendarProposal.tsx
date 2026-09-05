import { useEffect, useMemo, useRef, useState } from "react";
import { Button } from "@/components";
import { MAX_TARGETS } from "@/lib/odoo";
// From @/types, NOT from the hook - see the placement note in
// src/types/calendar.ts. A page importing a type back out of a hook that
// depends on that page is the cycle this avoids.
import type {
  CalendarProposalState,
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
  onPickCandidate: (eventId: string) => void;
  onRetry: () => void;
}

/** lastMeetingAt descending, nulls last, ties by name. The field is nullable
 * (types/odoo.ts:37) and a contact never logged to must not sort ahead of one
 * that was. */
function byRecency(a: OdooContact, b: OdooContact): number {
  if (a.lastMeetingAt !== b.lastMeetingAt) {
    if (a.lastMeetingAt === null) return 1;
    if (b.lastMeetingAt === null) return -1;
    return b.lastMeetingAt - a.lastMeetingAt;
  }
  return a.name.localeCompare(b.name);
}

function timeRange(startMs: number, endMs: number): string {
  const fmt = (ms: number) =>
    new Date(ms).toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit" });
  return `${fmt(startMs)}–${fmt(endMs)}`;
}

export function CalendarProposal({
  state,
  targets,
  onAddTarget,
  onPickCandidate,
  onRetry,
}: CalendarProposalProps) {
  const [checked, setChecked] = useState<ReadonlySet<number>>(new Set());
  const [writeResult, setWriteResult] = useState<string | null>(null);
  const [writing, setWriting] = useState(false);
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
      return next;
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
    setChecked(new Set());
    setWriteResult(null);
  }, [state.kind]);

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
    return region(
      <>
        <p className="text-[11px] text-destructive">{state.code}</p>
        <button
          type="button"
          data-testid="calendar-proposal-retry"
          className="text-[10px] uppercase tracking-wide text-muted-foreground hover:text-foreground self-start"
          onClick={onRetry}
        >
          Try again
        </button>
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
    if (writingRef.current) return;
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
      {proposal?.unmatched.map((entry) => (
        <p
          key={entry.participant.address}
          data-testid={`calendar-unmatched-${entry.participant.address}`}
          className="text-[11px] text-muted-foreground"
        >
          {`${entry.participant.name ?? entry.participant.address} — ${
            entry.reason === "archived" ? "archived in Odoo" : "no Odoo contact"
          }`}
        </p>
      ))}

      {!atCap && (
        <Button
          size="sm"
          className="h-6 text-[11px] self-start"
          data-testid="calendar-proposal-confirm"
          disabled={writing || checkedWritable.length === 0}
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
