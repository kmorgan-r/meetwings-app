import { Link } from "react-router-dom";
import { Button } from "@/components";
// The LEAF path, never "@/hooks". That barrel star-exports useCompletion,
// useSystemAudio and a dozen more, so importing it here would drag their whole
// module graph into this page's test suite - which mocks only the leaves it
// needs and would fail for reasons that have nothing to do with this page.
import {
  GROUPS,
  PAGE_CAP,
  targetNameOf,
  useMeetingLogQueue,
} from "@/hooks/useMeetingLogQueue";
import { PageLayout } from "@/layouts";
import { isClaimStale } from "@/lib/odoo/meeting-log";
import { AssignDialog, ProviderConfigReader, QueueRow } from "./components";

const REMAINDER_LINE = "Showing 200 of the meetings waiting — more are hidden.";

function plural(n: number): string {
  return `${n} ${n === 1 ? "meeting is" : "meetings are"} waiting.`;
}

/**
 * The queue page. Render only.
 *
 * Every read, every action and every piece of state it shows lives in
 * `useMeetingLogQueue` (hooks/useMeetingLogQueue.ts), along with the comments
 * explaining why each is shaped the way it is. Nothing is decided here.
 */
export default function MeetingLog() {
  const {
    rows,
    rendered,
    grouped,
    configState,
    stranded,
    loadError,
    busy,
    contacts,
    results,
    notices,
    transcript,
    instance,
    now,
    assignRow,
    providerConfigRef,
    setResult,
    handleRetry,
    handleDelete,
    handleAssign,
    handleAssignConfirm,
    handleAssignCancel,
    handleRetryTarget,
    handleRemoveTarget,
    readTranscript,
    toggleTranscript,
  } = useMeetingLogQueue();

  const isEmpty = rendered.length === 0;

  return (
    <PageLayout
      title="Meeting log"
      description="Meetings waiting to reach Odoo, and the ones that need you."
    >
      {/*
        A LEAF. AppProvider rebuilds its value every render and calls loadData()
        on cross-window `storage` events, so consuming the context in this shell
        would repaint a 200-row list that does not depend on it.
      */}
      <ProviderConfigReader configRef={providerConfigRef} />

      {loadError !== null && <p className="text-sm text-destructive">{loadError}</p>}

      {/*
        Records whose row is not on screen. Rendered ABOVE the groups so the one
        sentence `degraded` exists to produce is not below 200 rows, and
        persistent until dismissed - a toast here would be the same
        disappearing-message bug on a shorter timer.
      */}
      {notices.length > 0 && (
        <section aria-label="Finished meetings" className="flex flex-col gap-2">
          <ul className="flex flex-col gap-2">
            {notices.map((notice) => (
              <li
                key={notice.id}
                data-notice-id={notice.id}
                className="flex items-start justify-between gap-3 rounded-xl border p-3"
              >
                <div className="flex flex-col gap-1">
                  <span className="text-xs text-muted-foreground">{notice.label}</span>
                  <span className="text-sm">{notice.text}</span>
                </div>
                <Button
                  size="sm"
                  variant="ghost"
                  onClick={() => setResult(notice.id, null)}
                  aria-label={`Dismiss the result for ${notice.label}`}
                >
                  Dismiss
                </Button>
              </li>
            ))}
          </ul>
        </section>
      )}

      {configState !== "loading" && configState !== "complete" && (
        <p className="text-sm">
          {`${plural(stranded)} Finish setting Odoo up on the `}
          <Link to="/odoo" className="underline">
            Odoo page
          </Link>
          {" to see and send them."}
        </p>
      )}

      {configState === "complete" && isEmpty && (
        <p className="text-sm text-muted-foreground">No meetings waiting to be logged.</p>
      )}

      {configState === "complete" &&
        GROUPS.map(({ key, title }) => {
          const groupRows = grouped.get(key) ?? [];
          if (groupRows.length === 0) return null;
          return (
            <section key={key} aria-labelledby={`meeting-log-${key}`} className="flex flex-col gap-2">
              <h2 id={`meeting-log-${key}`} className="text-sm font-semibold">
                {title}
              </h2>
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
            </section>
          );
        })}

      {/*
        Bounded on purpose. A 201-row read proves only that AT LEAST ONE row is
        hidden, and under group-rank ordering these are the 200 highest-priority
        rows, not the most recent - the whole point of that ordering is that an
        old needs-attention row outranks 200 newer unassigned ones.
      */}
      {configState === "complete" && rows.length > PAGE_CAP && (
        <p className="text-xs text-muted-foreground">{REMAINDER_LINE}</p>
      )}

      {/*
        MOUNTED ONLY WHILE OPEN, and keyed on the row. Rendered unconditionally
        behind an `open` prop, its one-client-per-session ref would live as long
        as this page does - and the page stays mounted, because the dashboard
        webview is hidden rather than destroyed.
      */}
      {assignRow !== null && (
        <AssignDialog
          key={assignRow.id}
          row={assignRow}
          instance={instance}
          onConfirm={(payload) => handleAssignConfirm(assignRow, payload)}
          onCancel={handleAssignCancel}
        />
      )}
    </PageLayout>
  );
}
