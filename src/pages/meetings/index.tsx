import { useCallback, useMemo } from "react";
import { Link, useNavigate } from "react-router-dom";
import { Button, Empty, Input } from "@/components";
import { MessageCircleIcon, Search } from "lucide-react";
// LEAF paths, never "@/hooks" and never "./components".
//
// The hooks barrel star-exports useCompletion, useSystemAudio and a dozen more;
// the components barrel now carries View.tsx, which imports that same barrel.
// Either one would drag the whole chat-completion graph into this page's test
// suites, which mock only the leaves the queue needs.
import { useHistory } from "@/hooks/useHistory";
import { useMeetingLogQueue } from "@/hooks/useMeetingLogQueue";
import { PageLayout } from "@/layouts";
import { resolveBadge } from "@/lib/odoo/meeting-log";
import { AssignDialog } from "./components/AssignDialog";
import { ConversationList } from "./components/ConversationList";
import { ProviderConfigReader } from "./components/ProviderConfigReader";
import { QueueStrip } from "./components/QueueStrip";

function plural(n: number): string {
  return `${n} ${n === 1 ? "meeting is" : "meetings are"} waiting.`;
}

/**
 * The conversation history and the Odoo queue, on one page.
 *
 * Every queue read, action and piece of queue state lives in
 * `useMeetingLogQueue` (hooks/useMeetingLogQueue.ts) along with the comments
 * explaining why each is shaped the way it is. Nothing about the queue is
 * decided here.
 *
 * The conversation list is `useHistory`'s state and the queue never touches it.
 * That is the whole of the error isolation this page needs: `reload`'s single
 * catch sets `loadError`, `loadError` renders above the strip, and a queue that
 * cannot be read leaves a conversation history that was never queue data alone.
 */
export default function Meetings() {
  /*
    CALLED UNCONDITIONALLY, at the top level. The focus listener's `[]` effect
    and the write-only mirror refs depend on mounting exactly once; calling this
    from inside the conditionally-rendered strip would re-register the Tauri
    listener across its lossy async listen() gap on every mount.
  */
  const queue = useMeetingLogQueue();
  const conversations = useHistory();
  const navigate = useNavigate();

  /**
   * One badge per conversation, from the raw rows the hook read.
   *
   * Gated on a complete config: `instance` is "" until then, and every stored
   * row would count as another database's - which `resolveBadge` badges when it
   * says `sent`. A half-configured page must show no badges at all.
   */
  const badges = useMemo(() => {
    const resolved = new Map<string, { status: string; count: number }>();
    if (queue.configState !== "complete") return resolved;

    const byConversation = new Map<string, Array<{ status: string; instance: string }>>();
    for (const row of queue.badgeRows) {
      const bucket = byConversation.get(row.conversationId);
      if (bucket) bucket.push(row);
      else byConversation.set(row.conversationId, [row]);
    }
    for (const [conversationId, rows] of byConversation) {
      const badge = resolveBadge(rows, queue.instance);
      if (badge) resolved.set(conversationId, badge);
    }
    return resolved;
  }, [queue.badgeRows, queue.instance, queue.configState]);

  // Captured, so the dialog's onConfirm closes over a non-null row rather than
  // re-reading `queue.assignRow` behind a `!`.
  const assignRow = queue.assignRow;
  const search = conversations.search ?? "";

  // Stable across renders so `ConversationList`'s `React.memo` boundary holds:
  // an inline arrow here would give every render a fresh `onOpen` identity
  // and defeat the memo on every keystroke and every 30-second queue tick.
  const handleOpenConversation = useCallback(
    (id: string) => navigate(`/meetings/view/${id}`),
    [navigate]
  );

  return (
    <PageLayout
      title="Meetings"
      description="Your conversations, and the meetings waiting to reach Odoo."
    >
      {/*
        A LEAF, and OUTSIDE every conditional. AppProvider rebuilds its value
        every render and calls loadData() on cross-window `storage` events, so
        consuming the context in this shell would repaint the whole list; and
        mounted conditionally, `providerConfigRef` would be empty exactly when
        an action needs it.
      */}
      <ProviderConfigReader configRef={queue.providerConfigRef} />

      {/*
        ABOVE THE STRIP ONLY. This is the queue's failure, not the list's - the
        conversation history below is useHistory state that `reload` never
        writes, and blanking it here would be the merge inventing a new error
        path for data that has none.
      */}
      {queue.loadError !== null && (
        <p className="text-sm text-destructive">{queue.loadError}</p>
      )}

      {/*
        Records whose row is not on screen. Rendered ABOVE the groups so the one
        sentence `degraded` exists to produce is not below 200 rows, and
        persistent until dismissed - a toast here would be the same
        disappearing-message bug on a shorter timer.
      */}
      {queue.notices.length > 0 && (
        <section aria-label="Finished meetings" className="flex flex-col gap-2">
          <ul className="flex flex-col gap-2">
            {queue.notices.map((notice) => (
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
                  onClick={() => queue.setResult(notice.id, null)}
                  aria-label={`Dismiss the result for ${notice.label}`}
                >
                  Dismiss
                </Button>
              </li>
            ))}
          </ul>
        </section>
      )}

      {queue.configState !== "loading" && queue.configState !== "complete" && (
        <p className="text-sm">
          {`${plural(queue.stranded)} Finish setting Odoo up on the `}
          <Link to="/odoo" className="underline">
            Odoo page
          </Link>
          {" to see and send them."}
        </p>
      )}

      <QueueStrip
        rows={queue.rows}
        grouped={queue.grouped}
        contacts={queue.contacts}
        instance={queue.instance}
        busy={queue.busy}
        results={queue.results}
        transcript={queue.transcript}
        now={queue.now}
        handleRetry={queue.handleRetry}
        handleAssign={queue.handleAssign}
        handleDelete={queue.handleDelete}
        toggleTranscript={queue.toggleTranscript}
        readTranscript={queue.readTranscript}
        handleRetryTarget={queue.handleRetryTarget}
        handleRemoveTarget={queue.handleRemoveTarget}
      />

      {conversations.conversations.length === 0 ? (
        <Empty
          isLoading={conversations.isLoading}
          icon={MessageCircleIcon}
          title="No conversations found"
          description="Start a new conversation to get started"
        />
      ) : (
        <div className="flex flex-col gap-6 pb-8">
          <div className="relative mb-4 w-1/3">
            <Search className="absolute left-3 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" />
            <Input
              type="text"
              placeholder="Search conversations..."
              className="pl-9 focus-visible:ring-0 focus-visible:ring-offset-0"
              value={conversations.search}
              onChange={(e) => conversations.setSearch(e.target.value)}
            />
          </div>
          {/*
            The search filters THIS list and nothing above it. The strip is a
            worklist, not a view of the history: filtering it would hide the one
            thing on the page that will not resolve itself.

            Group, sort and filter are ONE memo owned by ConversationList
            itself, and that component is a React.memo boundary - see its own
            doc comment for why: the queue's 30-second stale-claim tick lives
            on this page (`queue.now`, consumed above by QueueStrip) and must
            not re-run this list's grouping just to redraw a clock.
          */}
          <ConversationList
            conversations={conversations.conversations}
            search={search}
            badges={badges}
            onOpen={handleOpenConversation}
            // No rename UI exists yet - see ConversationList's `renamingId`
            // doc comment for what will eventually set this.
            renamingId={null}
          />
        </div>
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
          instance={queue.instance}
          onConfirm={(payload) => queue.handleAssignConfirm(assignRow, payload)}
          onCancel={queue.handleAssignCancel}
        />
      )}
    </PageLayout>
  );
}
