import { memo, useState } from "react";
import { Button } from "@/components";
// The LEAF path, never "@/hooks". That barrel star-exports useCompletion,
// useSystemAudio and a dozen more, so importing it here would drag their whole
// module graph into this page's test suites.
import { GROUPS, PAGE_CAP, targetNameOf, useMeetingLogQueue } from "@/hooks/useMeetingLogQueue";
import { isClaimStale, type QueueGroup } from "@/lib/odoo/meeting-log";
import type { MeetingLogListRow } from "@/types";
import { QueueRow } from "./QueueRow";

/**
 * Bounded on purpose. A 201-row read proves only that AT LEAST ONE row is
 * hidden, and under group-rank ordering these are the 200 highest-priority
 * rows, not the most recent - the whole point of that ordering is that an old
 * needs-attention row outranks 200 newer unassigned ones.
 */
const REMAINDER_LINE = "Showing 200 of the meetings waiting — more are hidden.";

type Queue = ReturnType<typeof useMeetingLogQueue>;

/**
 * Picked from the hook's return rather than restated, so the two cannot drift.
 */
export type QueueStripProps = Pick<
  Queue,
  | "rows"
  | "grouped"
  | "contacts"
  | "instance"
  | "busy"
  | "results"
  | "transcript"
  | "now"
  | "handleRetry"
  | "handleAssign"
  | "handleDelete"
  | "toggleTranscript"
  | "readTranscript"
  | "handleRetryTarget"
  | "handleRemoveTarget"
>;

function plural(n: number): string {
  return `${n} ${n === 1 ? "meeting is" : "meetings are"}`;
}

/**
 * Which of a group's rows the strip actually shows.
 *
 * Only `waiting` is narrowed, and only because the merged page has a second
 * surface those rows already reach: `held`, `pending` and `sending` resolve to
 * a badge on the conversation row, which is where an in-flight meeting belongs
 * once the queue and the history are one list.
 *
 * The two exceptions are not decoration:
 *
 * - A row with NO `conversation_id` has no conversation row to badge onto -
 *   `listConversationBadges` filters those out at the SQL - so dropping it here
 *   would make a queued meeting invisible and undeletable. It is reachable:
 *   useMeetingLog.ts's `conversationId ?? getActiveConversationId()` can be
 *   null.
 * - A row still holding a RESULT is counted by the hook's `inlineIds`, which is
 *   derived from the grouped buckets and decides what does NOT get promoted
 *   into the notice region. Hiding such a row would land its outcome sentence
 *   in neither place - the exact message loss the results map exists to prevent
 *   (a `no-op` retry leaves a `failed` row `pending`, i.e. here).
 */
function stripRowsFor(
  key: Exclude<QueueGroup, null>,
  grouped: QueueStripProps["grouped"],
  results: QueueStripProps["results"]
): MeetingLogListRow[] {
  const all = grouped.get(key) ?? [];
  if (key !== "waiting") return all;
  return all.filter((row) => row.conversation_id === null || results.has(row.id));
}

/**
 * The worklist above the conversation list. Renders nothing when it is empty.
 *
 * Returning null IS the "rendered only when non-empty" rule - a page-side
 * emptiness check would have to restate `stripRowsFor` to get the same answer.
 *
 * Wrapped in `React.memo` below with the default shallow compare, not a
 * custom comparator: every prop here is either `useMeetingLogQueue` state
 * (`rows`, `contacts`, `busy`, `results`, `transcript` are plain `useState`
 * values, and `grouped` is its own `useMemo`) or one of its `useCallback`
 * handlers, so nothing about this component changes identity just because the
 * page re-rendered for some OTHER reason - a search keystroke, a badge
 * recompute. `now` is the one prop that genuinely changes every
 * `STALE_TICK_MS`, and the memo correctly lets that re-render through; it
 * exists to stop everything else from doing the same.
 */
function QueueStripInner({
  rows,
  grouped,
  contacts,
  instance,
  busy,
  results,
  transcript,
  now,
  handleRetry,
  handleAssign,
  handleDelete,
  toggleTranscript,
  readTranscript,
  handleRetryTarget,
  handleRemoveTarget,
}: QueueStripProps) {
  // Collapsed by DEFAULT, and local to this component: the other-database group
  // is a backlog nobody on this Odoo database can act on until they point back
  // at the other one, so it must not push the rows that do need them off the
  // top of the page. State here rather than in the hook - it is presentation,
  // and it must survive every reload the hook drives.
  const [otherExpanded, setOtherExpanded] = useState(false);

  const sections = GROUPS.map(({ key, title }) => ({
    key,
    title,
    rows: stripRowsFor(key, grouped, results),
  })).filter((section) => section.rows.length > 0);

  // The remainder line outlives an empty strip: a queue that is bounded must
  // say so even in the (contrived) case where all 201 rows badge instead.
  if (sections.length === 0 && rows.length <= PAGE_CAP) return null;

  const rowsOf = (groupRows: MeetingLogListRow[]) => (
    <ul className="flex flex-col gap-2">
      {groupRows.map((row) => (
        <QueueRow
          key={row.id}
          row={row}
          targetName={targetNameOf(row, contacts)}
          instance={instance}
          busy={busy.has(row.id)}
          stale={isClaimStale(row, now)}
          outcome={results.get(row.id)?.text ?? null}
          transcript={transcript?.id === row.id ? transcript.view : null}
          contacts={contacts}
          onRetry={handleRetry}
          onAssign={handleAssign}
          onDelete={handleDelete}
          onToggleTranscript={toggleTranscript}
          onReloadTranscript={readTranscript}
          onRetryTarget={handleRetryTarget}
          onRemoveTarget={handleRemoveTarget}
        />
      ))}
    </ul>
  );

  return (
    <>
      {sections.map(({ key, title, rows: groupRows }) => (
        <section
          key={key}
          aria-labelledby={`meeting-log-${key}`}
          className="flex flex-col gap-2"
        >
          <h2 id={`meeting-log-${key}`} className="text-sm font-semibold">
            {title}
          </h2>
          {key === "other-database" ? (
            <>
              {/*
                One line, not 200 rows. Hiding it outright is how a backlog is
                lost, so it is stated and reachable - but nothing here can be
                sent while the credentials point elsewhere, and pushQueuedRow
                refuses every one of them at its instance check.
              */}
              <p className="text-sm text-muted-foreground">
                {`${plural(groupRows.length)} queued for a different Odoo database. Nothing here is sent until Meetwings points back at it.`}
              </p>
              <Button
                size="sm"
                variant="ghost"
                className="self-start"
                aria-expanded={otherExpanded}
                onClick={() => setOtherExpanded((prev) => !prev)}
              >
                {otherExpanded ? "Hide these meetings" : "Show these meetings"}
              </Button>
              {otherExpanded && rowsOf(groupRows)}
            </>
          ) : (
            rowsOf(groupRows)
          )}
        </section>
      ))}

      {rows.length > PAGE_CAP && (
        <p className="text-xs text-muted-foreground">{REMAINDER_LINE}</p>
      )}
    </>
  );
}

export const QueueStrip = memo(QueueStripInner);
