import { memo, useState } from "react";
import { Button } from "@/components";
import { ESCALATE_AFTER_ATTEMPTS } from "@/lib/odoo/meeting-log";
import type { MeetingLogListRow, MeetingLogTarget, OdooContact } from "@/types";

/**
 * The expanded transcript, as four distinct outcomes rather than one nullable
 * string.
 *
 * Collapsing them means telling a user their meeting text was deliberately
 * destroyed when in fact a read failed and the text is still in the column.
 * `missing` is defensive only - nothing in the repo deletes a
 * meeting_log_queue row - and is kept as cover against a future hard delete.
 */
export type TranscriptView =
  | { state: "loading" }
  | { state: "error" }
  | { state: "missing" }
  | { state: "removed" }
  | { state: "text"; text: string };

export interface QueueRowProps {
  row: MeetingLogListRow;
  /** Resolved from the page's contact map, with the opportunity marker applied. */
  targetName: string;
  /** The fingerprint the page resolved this cycle, not the one it mounted with. */
  instance: string;
  busy: boolean;
  /**
   * Whether this row's claim has outlived STALE_CLAIM_MS, as of the page's
   * ticking clock. A boolean rather than the clock itself: a `now` prop changes
   * on every tick and would re-render all 200 rows to move one row's sentence.
   */
  stale: boolean;
  /**
   * The last action's outcome line, or `null`.
   *
   * A prop rather than something the page renders beside the row, so it is
   * inside one `<li>` - but that makes it a prop the row RENDERS, so the
   * comparator must cover it or the memo swallows every outcome message and
   * the page silently goes back to saying nothing.
   */
  outcome: string | null;
  /** `null` when collapsed. */
  transcript: TranscriptView | null;
  /**
   * The same cache `targetName` was already resolved from, handed down raw
   * this time so `targetNameOf` can resolve each of `row.targets`
   * individually - a single row can carry up to MAX_TARGETS different
   * contacts, not just the one `targetName` names.
   */
  contacts: Map<number, OdooContact>;
  onRetry: (row: MeetingLogListRow) => void;
  onAssign: (row: MeetingLogListRow) => void;
  onDelete: (row: MeetingLogListRow) => void;
  onToggleTranscript: (row: MeetingLogListRow) => void;
  onReloadTranscript: (row: MeetingLogListRow) => void;
  onRetryTarget: (row: MeetingLogListRow, target: MeetingLogTarget) => void;
  onRemoveTarget: (row: MeetingLogListRow, target: MeetingLogTarget) => void;
}

/**
 * `meeting_started_at ?? transcript_start_at`, never `created_at`.
 *
 * The shipped note body uses the same fallback (meeting-log-push.ts:272), and
 * two fallbacks for one nullable column let this page - and the delete confirm
 * - disagree with the date already live on the customer's chatter.
 */
export function meetingDateOf(row: MeetingLogListRow): string {
  return new Date(row.meeting_started_at ?? row.transcript_start_at).toLocaleString();
}

/**
 * `meeting_log_targets.name` -> the contact cache -> a generic placeholder.
 *
 * Every backfilled pre-14 target, and every target the page's current
 * `assignPayloadToTargets` bridge inserts (it always writes `name: null`),
 * has a NULL name and hits this chain in full.
 *
 * The SAME fallback shape as ContactPicker.tsx's `nameForTarget` - that
 * file's own comment names this function as its forward reference. Kept
 * separate rather than shared: the two operate on different types
 * (`SelectedTarget` there, `MeetingLogTarget` here) in different modules with
 * different owners, and ContactPicker.tsx is outside this task's files.
 */
function targetNameOf(target: MeetingLogTarget, contacts: Map<number, OdooContact>): string {
  if (target.name) return target.name;
  if (target.model === "res.partner") {
    return contacts.get(target.resId)?.name ?? `Contact #${target.resId}`;
  }
  return `Lead or opportunity #${target.resId}`;
}

function statusLine(
  row: MeetingLogListRow,
  busy: boolean,
  stale: boolean,
  otherDatabase: boolean,
  failedTargets: number
): string {
  if (busy) return "Sending…";
  // Closing the dashboard window mid-push destroys the JS context with no
  // `finally` reached. Recovery is the main window's reclaim at next launch,
  // which this page is forbidden to call - so "Sending…" here would be untrue
  // until the app restarts.
  if (stale) {
    // The retry promise is TRUE ONLY FOR THE CURRENT DATABASE. reclaimStale-
    // Sending's predicate is `status = 'sending' AND claimed_at < ?` with no
    // instance filter, so it does flip this row back to `pending` - but the
    // push that would follow comes from selectSweepable, which is scoped to
    // `instance = ?`. A row queued against a database the user has since
    // switched away from is reclaimed and then never swept, so promising a
    // retry on next launch is a promise nothing keeps.
    return otherDatabase
      ? "Interrupted. It will not be retried until Meetwings points back at that Odoo database."
      : "Interrupted. This will be retried the next time Meetwings starts.";
  }
  // BEFORE the status switch, and wins over EVERY branch below it - including
  // `failed`, whose "Could not be sent" is a Global Constraint violation on a
  // row with any sent target: it claims nothing reached Odoo when something
  // did. Mirrors groupOf's own precedence (meeting-log.ts) for the identical
  // reason: a row derives `pending` whenever any target is still retryable,
  // even beside a terminally failed sibling, so the parent's own status alone
  // cannot be trusted to describe a partly-failed row.
  if (failedTargets > 0) {
    return `${failedTargets} of ${row.targets?.length ?? 0} failed`;
  }
  switch (row.status) {
    case "sending":
      return "Sending…";
    case "failed":
      return "Could not be sent";
    case "unassigned":
      return "No contact chosen";
    case "held":
      return "Waiting - you can still undo this in the main window";
    case "pending":
      return row.attempts >= ESCALATE_AFTER_ATTEMPTS
        ? "Not sent yet, and out of automatic attempts"
        : "Waiting to be sent";
    default:
      return row.status;
  }
}

function transcriptBody(view: TranscriptView, onRetryRead: () => void) {
  switch (view.state) {
    case "loading":
      return <p className="text-xs text-muted-foreground">Reading the transcript…</p>;
    case "error":
      // Never "removed": a read that failed says nothing about the column.
      return (
        <div className="flex items-center gap-2">
          <p className="text-xs text-destructive">The transcript could not be read.</p>
          <Button size="sm" variant="outline" onClick={onRetryRead}>
            Try again
          </Button>
        </div>
      );
    case "missing":
      return (
        <p className="text-xs text-muted-foreground">This meeting is no longer in the queue.</p>
      );
    case "removed":
      return <p className="text-xs text-muted-foreground">Transcript removed</p>;
    case "text":
      return (
        <pre className="max-h-64 overflow-auto whitespace-pre-wrap break-words rounded-lg bg-muted p-3 text-xs">
          {view.text}
        </pre>
      );
  }
}

function QueueRowInner({
  row,
  targetName,
  instance,
  busy,
  stale,
  outcome,
  transcript,
  contacts,
  onRetry,
  onAssign,
  onDelete,
  onToggleTranscript,
  onReloadTranscript,
  onRetryTarget,
  onRemoveTarget,
}: QueueRowProps) {
  const [confirmingDelete, setConfirmingDelete] = useState(false);
  const [targetsExpanded, setTargetsExpanded] = useState(false);

  const otherDatabase = row.instance !== instance;
  const sending = row.status === "sending";
  // `sending` WINS OVER INSTANCE. deleteRow's CAS refuses `sending`, so an
  // enabled Delete on an other-database sending row is the do-nothing button
  // this page's rules exist to prevent.
  const canRetry =
    row.status === "failed" ||
    (row.status === "pending" && row.attempts >= ESCALATE_AFTER_ATTEMPTS);
  const canAssign = row.status === "unassigned" || row.status === "failed";

  const retryDisabled = busy || sending || otherDatabase || !canRetry;
  const assignDisabled = busy || sending || otherDatabase || !canAssign;
  const deleteDisabled = busy || sending;

  const targets = row.targets ?? [];
  const failedTargets = targets.filter((t) => t.status === "failed").length;
  // Mirrors removeQueueTarget's own allowlist (meeting-log-actions.ts): that
  // function refuses a target write unless the PARENT row is `pending` or
  // `failed`, so gating the buttons the same way keeps a `refused` outcome
  // race-only rather than a routine click result. Retry is gated on
  // `otherDatabase` too, on top of that - retryTarget flips the parent back
  // to `pending`, but selectSweepable never sweeps a foreign-instance row, so
  // a retry offered here is a promise nothing keeps, the same reason the
  // row-level Retry button is disabled for it.
  const targetActionsAllowed =
    !busy && (row.status === "pending" || row.status === "failed");

  const meetingDate = meetingDateOf(row);

  return (
    <li
      data-row-id={row.id}
      className="flex flex-col gap-2 rounded-xl border p-3"
    >
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <span className="text-sm font-medium">{targetName}</span>
        <span className="text-xs text-muted-foreground">{meetingDate}</span>
      </div>

      <p className="text-xs text-muted-foreground">
        {statusLine(row, busy, stale, otherDatabase, failedTargets)}
      </p>

      {/*
        Rendered from the COLUMN, verbatim, and in every group. queueErrorText
        is the one producer of that text and redacts at construction; rebuilding
        it here from a thrown object would bypass the choke point. Not gated on
        needs-attention: a retryable failure leaves the row `pending` below the
        escalation threshold, i.e. in waiting, and a gated error would make that
        failed retry render as an unexplained success.
      */}
      {row.last_error !== null && (
        <p className="text-xs text-destructive">
          <span>{row.last_error}</span>
          <span className="text-muted-foreground">{` (attempt ${row.attempts})`}</span>
        </p>
      )}

      {targets.length > 0 && (
        <div className="flex flex-col gap-1">
          <Button
            size="sm"
            variant="ghost"
            className="self-start"
            aria-expanded={targetsExpanded}
            onClick={() => setTargetsExpanded((prev) => !prev)}
          >
            {targetsExpanded ? "Collapse targets" : "Expand targets"}
          </Button>
          {/*
            The name and any error text are ALWAYS rendered, expand toggle or
            not - the same "never hide a real failure" rule row.last_error
            already follows above. Only the interactive half (the `group` role
            and the Retry/Remove buttons) is gated on `targetsExpanded`; that is
            what "re-renders when a target's status changes" (this file's test
            suite) depends on being independent of row.status/row.last_error,
            and what a partly-failed row needs to show WHICH target failed
            without the user clicking anything.
          */}
          {targets.map((t) => {
            const name = targetNameOf(t, contacts);
            const groupProps = targetsExpanded
              ? { role: "group" as const, "aria-label": name }
              : {};
            return (
              <div key={t.id} {...groupProps} className="flex flex-wrap items-center gap-2 text-xs">
                <span>{name}</span>
                {t.status === "failed" && (
                  <span className="text-destructive">{t.lastError ?? "Could not be sent"}</span>
                )}
                {targetsExpanded && targetActionsAllowed && t.status === "failed" && (
                  <>
                    <Button
                      size="sm"
                      variant="outline"
                      disabled={otherDatabase}
                      onClick={() => onRetryTarget(row, t)}
                    >
                      Retry this one
                    </Button>
                    <Button size="sm" variant="ghost" onClick={() => onRemoveTarget(row, t)}>
                      Remove
                    </Button>
                  </>
                )}
              </div>
            );
          })}
        </div>
      )}

      {confirmingDelete ? (
        <div className="flex flex-col gap-2">
          <p className="text-xs">
            {`Delete the meeting from ${meetingDate} with ${targetName}? Its transcript is removed straight away and this cannot be undone.`}
          </p>
          <div className="flex gap-2">
            <Button
              size="sm"
              variant="destructive"
              onClick={() => {
                setConfirmingDelete(false);
                onDelete(row);
              }}
            >
              Delete this meeting
            </Button>
            <Button size="sm" variant="outline" onClick={() => setConfirmingDelete(false)}>
              Cancel
            </Button>
          </div>
        </div>
      ) : (
        <div className="flex flex-wrap gap-2">
          <Button size="sm" disabled={retryDisabled} onClick={() => onRetry(row)}>
            Retry
          </Button>
          <Button
            size="sm"
            variant="outline"
            disabled={assignDisabled}
            onClick={() => onAssign(row)}
          >
            {row.status === "failed" ? "Reassign" : "Assign"}
          </Button>
          <Button
            size="sm"
            variant="outline"
            disabled={deleteDisabled}
            onClick={() => setConfirmingDelete(true)}
          >
            Delete
          </Button>
          <Button size="sm" variant="ghost" onClick={() => onToggleTranscript(row)}>
            {transcript ? "Hide transcript" : "Show transcript"}
          </Button>
        </div>
      )}

      {outcome !== null && (
        <p role="status" className="text-xs">
          {outcome}
        </p>
      )}

      {transcript && transcriptBody(transcript, () => onReloadTranscript(row))}
    </li>
  );
}

function sameTranscript(a: TranscriptView | null, b: TranscriptView | null): boolean {
  if (a === b) return true;
  if (!a || !b) return false;
  if (a.state !== b.state) return false;
  return a.state === "text" && b.state === "text" ? a.text === b.text : true;
}

/**
 * Length plus, per target, `id`/`status`/`lastError` - the same shape as
 * `sameTranscript` above. `name` itself is not compared: it is written once
 * at insert (meeting-log.action.ts's `insertTarget`) and never updated after,
 * so an unchanged `id` already proves an unchanged `name`.
 *
 * The RESOLVED name is compared instead, via `targetNameOf(t, contacts)` -
 * NOT `contacts` itself by reference. `contacts` is rebuilt into a brand-new
 * Map on every reload (index.tsx's `reload`), so comparing it directly would
 * fail on every row every time, the exact disaster this comparator exists to
 * prevent. Resolving through it and comparing the resulting STRING keeps the
 * "same-cycle re-read" purpose `targetName` already serves at the row level -
 * a target whose name only exists in the contact cache re-renders the moment
 * that cache actually resolves it, and not one reload cycle sooner.
 */
function sameTargets(
  a: MeetingLogTarget[] | undefined,
  b: MeetingLogTarget[] | undefined,
  contactsA: Map<number, OdooContact>,
  contactsB: Map<number, OdooContact>
): boolean {
  const listA = a ?? [];
  const listB = b ?? [];
  if (listA === listB) return true;
  if (listA.length !== listB.length) return false;
  return listA.every((t, i) => {
    const other = listB[i];
    return (
      t.id === other.id &&
      t.status === other.status &&
      t.lastError === other.lastError &&
      targetNameOf(t, contactsA) === targetNameOf(other, contactsB)
    );
  });
}

/**
 * EVERY PROP THE ROW RENDERS, not just the DB columns.
 *
 * React.memo's default shallow compare cannot work here: every refresh hands
 * each row a brand-new object read from SQLite, so it would fail on every row
 * every time. But a comparator narrowed to the DB columns is worse than none -
 * it returns "equal" when the user expands a row, so the transcript never
 * appears, and it compares away the contact map's `Contact #<id>` -> real-name
 * resolution, whose entire purpose is the same-cycle re-read, because
 * `contact_id` did not change.
 *
 * The callbacks are compared too. They are `useCallback(…, [])` on the page, so
 * this is free - and if one ever stops being stable, the memo degrading to
 * "always re-render" is the safe direction.
 */
function propsAreEqual(a: QueueRowProps, b: QueueRowProps): boolean {
  return (
    a.row.id === b.row.id &&
    a.row.status === b.row.status &&
    a.row.attempts === b.row.attempts &&
    a.row.last_error === b.row.last_error &&
    a.row.contact_id === b.row.contact_id &&
    a.row.lead_id === b.row.lead_id &&
    a.row.claimed_at === b.row.claimed_at &&
    a.row.instance === b.row.instance &&
    a.row.meeting_started_at === b.row.meeting_started_at &&
    a.row.transcript_start_at === b.row.transcript_start_at &&
    a.targetName === b.targetName &&
    a.instance === b.instance &&
    a.busy === b.busy &&
    a.stale === b.stale &&
    a.outcome === b.outcome &&
    sameTranscript(a.transcript, b.transcript) &&
    sameTargets(a.row.targets, b.row.targets, a.contacts, b.contacts) &&
    a.onRetry === b.onRetry &&
    a.onAssign === b.onAssign &&
    a.onDelete === b.onDelete &&
    a.onToggleTranscript === b.onToggleTranscript &&
    a.onReloadTranscript === b.onReloadTranscript &&
    a.onRetryTarget === b.onRetryTarget &&
    a.onRemoveTarget === b.onRemoveTarget
  );
}

export const QueueRow = memo(QueueRowInner, propsAreEqual);
