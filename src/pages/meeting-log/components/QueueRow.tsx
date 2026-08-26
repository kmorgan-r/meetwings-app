import { memo, useState } from "react";
import { Button } from "@/components";
import { ESCALATE_AFTER_ATTEMPTS, STALE_CLAIM_MS } from "@/lib/odoo/meeting-log";
import type { MeetingLogListRow } from "@/types";

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
  onRetry: (row: MeetingLogListRow) => void;
  onAssign: (row: MeetingLogListRow) => void;
  onDelete: (row: MeetingLogListRow) => void;
  onToggleTranscript: (row: MeetingLogListRow) => void;
  onReloadTranscript: (row: MeetingLogListRow) => void;
}

/**
 * `meeting_started_at ?? transcript_start_at`, never `created_at`.
 *
 * The shipped note body uses the same fallback (meeting-log-push.ts:272), and
 * two fallbacks for one nullable column let this page - and the delete confirm
 * - disagree with the date already live on the customer's chatter.
 */
function meetingDateOf(row: MeetingLogListRow): string {
  return new Date(row.meeting_started_at ?? row.transcript_start_at).toLocaleString();
}

function isStale(row: MeetingLogListRow, now: number): boolean {
  return (
    row.status === "sending" &&
    row.claimed_at !== null &&
    now - row.claimed_at > STALE_CLAIM_MS
  );
}

function statusLine(row: MeetingLogListRow, busy: boolean, now: number): string {
  if (busy) return "Sending…";
  // Closing the dashboard window mid-push destroys the JS context with no
  // `finally` reached. Recovery is the main window's reclaim at next launch,
  // which this page is forbidden to call - so "Sending…" here would be untrue
  // until the app restarts.
  if (isStale(row, now)) {
    return "Interrupted. This will be retried the next time Meetwings starts.";
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
  outcome,
  transcript,
  onRetry,
  onAssign,
  onDelete,
  onToggleTranscript,
  onReloadTranscript,
}: QueueRowProps) {
  const [confirmingDelete, setConfirmingDelete] = useState(false);
  const now = Date.now();

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

      <p className="text-xs text-muted-foreground">{statusLine(row, busy, now)}</p>

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
    a.outcome === b.outcome &&
    sameTranscript(a.transcript, b.transcript) &&
    a.onRetry === b.onRetry &&
    a.onAssign === b.onAssign &&
    a.onDelete === b.onDelete &&
    a.onToggleTranscript === b.onToggleTranscript &&
    a.onReloadTranscript === b.onReloadTranscript
  );
}

export const QueueRow = memo(QueueRowInner, propsAreEqual);
