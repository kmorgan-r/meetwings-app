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

  const proposal = state.kind === "proposal" ? state : null;

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
    // Pre-check only when EVERY writable match fits. Auto-selecting an
    // arbitrary subset is the wrong-record risk this feature exists to avoid.
    setChecked(
      writable.length > 0 && writable.length <= freeSlots
        ? new Set(writable.map((m) => m.contact.id))
        : new Set()
    );
    setWriteResult(null);
    // `writableKey` stands in for `writable` on purpose - see the comment
    // above. Depending on `writable` itself would re-run this effect on every
    // render (a fresh array from the memo above) instead of only when its
    // contents actually change.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [writableKey, freeSlots]);

  /**
   * The popover closed. `ContactPicker` — and therefore this component — stays
   * MOUNTED when it does (see its `confirmingClear` reset keyed on `open`), so
   * without this every local flag survives into the next open.
   *
   * `writing` is the one that matters most: it had no reset path at all, and a
   * real force-close exists — `<Completion />`'s layout effect closes the picker
   * when `meetingLog.holding` flips true. Closed mid-write, `writing` stayed
   * true forever and the confirm button was dead on every subsequent open, for
   * an unrelated later meeting, with nothing saying why.
   */
  useEffect(() => {
    if (state.kind !== "idle") return;
    writingRef.current = false;
    setWriting(false);
    setChecked(new Set());
    setWriteResult(null);
  }, [state.kind]);

  if (state.kind === "idle") return null;

  const region = (children: React.ReactNode) => (
    <div className={REGION_CLASS} data-testid="calendar-proposal-region">
      {children}
    </div>
  );

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

    // SNAPSHOT the user's choice before the first await. `targets` mutates
    // under us as the loop lands rows, so re-reading `checkedWritable` mid-loop
    // would write whatever the recomputed set says rather than what the user
    // actually confirmed.
    const batch = [...checkedWritable];
    const written: string[] = [];
    const notWritten: string[] = [];
    let failure: "cap" | "other" | null = null;

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

    writingRef.current = false;
    setWriting(false);
    setWriteResult(
      failure === null
        ? null
        : `Added ${written.join(", ") || "none"}. ${
            failure === "cap"
              ? "The log is full, so"
              : "Something went wrong, so"
          } ${notWritten.join(", ")} ${notWritten.length === 1 ? "was" : "were"} not added.`
    );
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
