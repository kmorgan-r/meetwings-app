import { useCallback, useMemo, useState } from "react";
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
import { renameConversationManually } from "@/lib/database/chat-history.action";
import { CONVERSATION_RENAMED_KEY } from "@/lib/chat-constants";
import { safeLocalStorage } from "@/lib/storage/helper";
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

  /**
   * Conversation id -> title, for the strip's rows.
   *
   * Read off the SAME `useHistory` state the list below renders, not a second
   * query: `getAllConversations` is unbounded, so every conversation a queue
   * row can point at is already here, and a rename committed on either surface
   * repaints both through useHistory's own `conversation-title-updated`
   * listener. A queue-side read would drift from the list the moment one of
   * them refreshed.
   */
  const conversationTitles = useMemo(() => {
    const titles = new Map<string, string>();
    for (const conversation of conversations.conversations) {
      titles.set(conversation.id, conversation.title);
    }
    return titles;
  }, [conversations.conversations]);

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

  // The one conversation currently open for an inline rename, or none. Lives
  // here rather than in ConversationList/ConversationRow because a rename in
  // progress must survive ConversationList's own search-filter re-render -
  // see that component's `renamingId` doc comment.
  const [renamingId, setRenamingId] = useState<string | null>(null);

  /**
   * The QUEUE ROW - by row id, never by conversation id - whose conversation
   * name is open for an inline rename.
   *
   * Its own state rather than a share of `renamingId`, because both surfaces
   * can show the same conversation at once: one pencil click would then open
   * an `autoFocus` editor on the strip row AND on the card below it, and the
   * later mount would steal the focus from the one the user clicked.
   *
   * By ROW id for the same reason one step down: two queue rows can carry the
   * same `conversation_id` (the duplicate-mint pairs already in the database),
   * and keying on the conversation would open an editor on every one of them.
   */
  const [renamingQueueRowId, setRenamingQueueRowId] = useState<string | null>(null);

  // Stable identities, like `handleOpenConversation` above: ConversationList
  // and ConversationRow are `React.memo` boundaries this page must not defeat.
  const handleStartRename = useCallback((id: string) => {
    setRenamingId(id);
  }, []);

  const handleCancelRename = useCallback(() => {
    setRenamingId(null);
  }, []);

  const handleStartQueueRename = useCallback((rowId: string) => {
    setRenamingQueueRowId(rowId);
  }, []);

  const handleCancelQueueRename = useCallback(() => {
    setRenamingQueueRowId(null);
  }, []);

  /**
   * The write, shared by both surfaces. Owns everything about the rename
   * EXCEPT closing the editor, which is the one part that differs - each
   * surface tracks its own open editor, and a single path that closed both
   * would cancel an unrelated edit in the other one.
   *
   * REPORTS ITS OUTCOME rather than returning void. Every way this can fail -
   * an empty name, a conversation deleted under the editor, a database that
   * refuses the write - used to end in the same silent `return`, so a rename
   * that never happened looked exactly like one that did.
   */
  const commitRename = useCallback(async (id: string, title: string): Promise<boolean> => {
    const trimmed = title.trim();
    if (!trimmed) return false;

    // `false` means no row matched - the conversation was deleted between
    // render and commit. Announcing a rename that did not happen would patch
    // the overlay's cache with a title no row holds. `renameConversation-
    // Manually` RETHROWS a database error rather than returning false, so the
    // catch is what keeps that from becoming an unhandled rejection nobody
    // sees.
    let renamed = false;
    try {
      renamed = await renameConversationManually(id, trimmed);
    } catch (error) {
      console.error("Failed to rename conversation:", error);
      return false;
    }
    if (!renamed) return false;

    // BOTH channels. The in-window CustomEvent is for this webview -
    // useHistory's own listener patches `conversations` from it. The
    // localStorage key is for the overlay webview, which a window event
    // cannot reach at all. The timestamp is a nonce: the `storage` event does
    // not fire on a byte-identical write, so renaming to the same title twice
    // would otherwise never reach the overlay the second time.
    window.dispatchEvent(
      new CustomEvent("conversation-title-updated", {
        detail: { id, title: trimmed },
      })
    );
    safeLocalStorage.setItem(
      CONVERSATION_RENAMED_KEY,
      JSON.stringify({ id, title: trimmed, timestamp: Date.now() })
    );
    return true;
  }, []);

  // The editor is closed BEFORE the write settles, not after: a second Enter
  // firing mid-flight must not start a second commit, and the row should not
  // sit open across the await regardless of how the write resolves.
  const handleCommitRename = useCallback(
    (id: string, title: string) => {
      setRenamingId(null);
      return commitRename(id, title);
    },
    [commitRename]
  );

  // Takes the CONVERSATION id, like the list's: `renamingQueueRowId` is what
  // identifies the open editor, but the write is against the conversation.
  //
  // Closes the editor ONLY on a write that landed. A failed rename leaves the
  // row open with what the user typed still in it, beside the row's own error
  // line - losing their text to a silent close is how a save failure reads as
  // "it just does not save". Re-entrancy is handled in the row instead, which
  // disables both commit paths while one is in flight.
  const handleCommitQueueRename = useCallback(
    async (id: string, title: string) => {
      const renamed = await commitRename(id, title);
      if (renamed) setRenamingQueueRowId(null);
      return renamed;
    },
    [commitRename]
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
        conversationTitles={conversationTitles}
        renamingRowId={renamingQueueRowId}
        onStartRename={handleStartQueueRename}
        onCommitRename={handleCommitQueueRename}
        onCancelRename={handleCancelQueueRename}
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
            renamingId={renamingId}
            onStartRename={handleStartRename}
            onCommitRename={handleCommitRename}
            onCancelRename={handleCancelRename}
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
