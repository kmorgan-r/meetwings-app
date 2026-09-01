import { memo, useMemo } from "react";
import moment from "moment";
import type { ChatConversation } from "@/types";
import { DateGroup } from "./DateGroup";

export interface ConversationListProps {
  conversations: ChatConversation[];
  search: string;
  badges: ReadonlyMap<string, { status: string; count: number }>;
  onOpen: (id: string) => void;
  /**
   * The conversation currently open for an inline rename, or `null`.
   *
   * Owned by the page (`pages/meetings/index.tsx`), not this component:
   * threaded through because the filter below drops a whole date group when
   * no title in it matches the search box, and the stored title can change
   * out from under an open editor with no user action: `useHistory`'s
   * `conversation-title-updated` listener patches `conversations` whenever a
   * background AI titler finishes. If that patch makes the group's only
   * match disappear, the group - and the row holding the open editor -
   * unmounts mid-edit. That is the same caret-loss failure
   * `renameConversationManually` guards against from the sort side by never
   * touching `updated_at`.
   */
  renamingId: string | null;
  onStartRename: (id: string) => void;
  /** Resolves to whether the write landed - see ConversationRow. */
  onCommitRename: (id: string, title: string) => Promise<boolean>;
  onCancelRename: () => void;
}

interface DateBucket {
  dateKey: string;
  conversations: ChatConversation[];
}

/**
 * The date-grouped conversation list, as its own `React.memo` boundary.
 *
 * Group, sort and search-filter are ONE `useMemo`, owned HERE rather than the
 * page. `useMeetingLogQueue`'s stale-claim clock (`now`) ticks every
 * `STALE_TICK_MS` and re-renders the page that owns it; without this
 * component - and the `memo` below - that tick would re-run this grouping,
 * sorting and filtering on every cycle, over every conversation
 * `getAllConversations` returned with every message attached, to redraw a
 * clock only the queue strip needs. `React.memo`'s default shallow compare is
 * enough: `conversations`, `search` and `renamingId` are primitives or the
 * page's own state, `badges` is the page's queue-derived map (rebuilt on
 * `reload`, not on the tick), and `onOpen`, `onStartRename`, `onCommitRename`
 * and `onCancelRename` are page-level `useCallback`s with an empty
 * dependency array.
 *
 * Known cost this does NOT address: `getAllConversations` attaches every
 * message to every conversation, and this component still receives that full
 * object graph on every real reload - a row only ever reads
 * `doc.messages.length`. A `COUNT(*)`-shaped list read is the actual remedy
 * and is out of scope for this change.
 */
function ConversationListInner({
  conversations,
  search,
  badges,
  onOpen,
  renamingId,
  onStartRename,
  onCommitRename,
  onCancelRename,
}: ConversationListProps) {
  const dateGroups = useMemo<DateBucket[]>(() => {
    const byDate = new Map<string, ChatConversation[]>();
    for (const doc of conversations) {
      const dateKey = moment(doc.updatedAt).format("YYYY-MM-DD");
      const bucket = byDate.get(dateKey);
      if (bucket) bucket.push(doc);
      else byDate.set(dateKey, [doc]);
    }

    const term = search.toLowerCase();
    return [...byDate.entries()]
      .sort(([a], [b]) => moment(b).diff(moment(a)))
      .filter(
        ([, docs]) =>
          term.length === 0 ||
          docs.some((doc) => doc.title.toLowerCase().includes(term)) ||
          // The row mid-rename survives the filter even with zero title
          // matches - see the `renamingId` doc comment above.
          (renamingId !== null && docs.some((doc) => doc.id === renamingId))
      )
      .map(([dateKey, docs]) => ({ dateKey, conversations: docs }));
  }, [conversations, search, renamingId]);

  return (
    <>
      {dateGroups.map(({ dateKey, conversations: docs }) => (
        <DateGroup
          key={dateKey}
          dateKey={dateKey}
          conversations={docs}
          badges={badges}
          onOpen={onOpen}
          renamingId={renamingId}
          onStartRename={onStartRename}
          onCommitRename={onCommitRename}
          onCancelRename={onCancelRename}
        />
      ))}
    </>
  );
}

export const ConversationList = memo(ConversationListInner);
