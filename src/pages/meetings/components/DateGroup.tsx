import moment from "moment";
import type { ChatConversation } from "@/types";
import { ConversationRow } from "./ConversationRow";

export interface DateGroupProps {
  /** `YYYY-MM-DD`, the key the page grouped on. */
  dateKey: string;
  conversations: ChatConversation[];
  badges: ReadonlyMap<string, { status: string; count: number }>;
  onOpen: (id: string) => void;
  /** The conversation open for an inline rename, or `null`. See `ConversationList`'s doc comment. */
  renamingId: string | null;
  onStartRename: (id: string) => void;
  /** Resolves to whether the write landed - see ConversationRow. */
  onCommitRename: (id: string, title: string) => Promise<boolean>;
  onCancelRename: () => void;
}

/**
 * One day of the conversation list.
 *
 * The date heading is a <p>, not an <h2>: the queue strip owns the only <h2>s
 * on this page, and its own suite addresses its sections by heading level.
 */
export function DateGroup({
  dateKey,
  conversations,
  badges,
  onOpen,
  renamingId,
  onStartRename,
  onCommitRename,
  onCancelRename,
}: DateGroupProps) {
  return (
    <div className="flex flex-col gap-3">
      <p className="text-xs text-muted-foreground select-none font-medium">
        {moment(dateKey).format("ddd, MMM D")}
      </p>
      <div className="grid grid-cols-1 gap-3">
        {conversations.map((doc) => {
          // Flattened HERE, so a row never receives the map or the badge object
          // - both get a new identity on every reload.
          const badge = badges.get(doc.id) ?? null;
          return (
            <ConversationRow
              key={doc.id}
              id={doc.id}
              title={doc.title}
              messageCount={doc.messages.length}
              updatedAt={doc.updatedAt}
              badgeStatus={badge?.status ?? null}
              badgeCount={badge?.count ?? 0}
              onOpen={onOpen}
              isRenaming={doc.id === renamingId}
              onStartRename={onStartRename}
              onCommitRename={onCommitRename}
              onCancelRename={onCancelRename}
            />
          );
        })}
      </div>
    </div>
  );
}
