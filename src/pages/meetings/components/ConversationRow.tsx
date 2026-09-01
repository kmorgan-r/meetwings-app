import { memo, useState } from "react";
import moment from "moment";
import { Badge, Card, Button, Input } from "@/components";
import { PencilIcon } from "lucide-react";

/**
 * The badge's copy, keyed by the status `resolveBadge` picked.
 *
 * Written from the READER's side, not the column's: `unassigned` is a queue
 * status but "Odoo unassigned" is not a sentence anyone acts on, and `held` and
 * `pending` are two mechanisms for the same fact - the meeting has not left yet.
 * `cancelled` and `deleted` are absent because `resolveBadge` never returns
 * them; both are meetings the user deliberately removed.
 */
const BADGE_COPY: Record<string, string> = {
  failed: "Odoo send failed",
  unassigned: "Needs a contact",
  sending: "Sending to Odoo",
  pending: "Waiting for Odoo",
  held: "Waiting for Odoo",
  sent: "Sent to Odoo",
};

export interface ConversationRowProps {
  id: string;
  title: string;
  messageCount: number;
  updatedAt: number;
  /** The resolved badge, flattened. */
  badgeStatus: string | null;
  badgeCount: number;
  onOpen: (id: string) => void;
  /** Whether THIS row is the one the page has open for an inline rename. */
  isRenaming: boolean;
  onStartRename: (id: string) => void;
  onCommitRename: (id: string, title: string) => void;
  onCancelRename: () => void;
}

/**
 * One conversation in the date-grouped list.
 *
 * Takes PRIMITIVES, never the badge object or the badge map. `resolveBadge`
 * allocates a fresh `{ status, count }` per call and the map is rebuilt on every
 * `reload` - each focus refresh, each action's re-read - so an object prop would
 * hand every row a new identity even when its badge is unchanged. QueueRow
 * needed a custom `propsAreEqual` for exactly that reason; this shape means this
 * row will not - the default shallow compare `memo` uses below is sufficient
 * because every prop here is either a primitive or one of `onOpen`,
 * `onStartRename`, `onCommitRename`, `onCancelRename`, which the page wraps in
 * `useCallback` with an empty dependency array.
 */
function ConversationRowInner({
  id,
  title,
  messageCount,
  updatedAt,
  badgeStatus,
  badgeCount,
  onOpen,
  isRenaming,
  onStartRename,
  onCommitRename,
  onCancelRename,
}: ConversationRowProps) {
  // Transient - reset from the `title` prop every time editing starts, so it
  // never needs to survive past the Enter/Escape that ends it, and does not
  // belong in the page's `renamingId` state.
  const [draft, setDraft] = useState(title);

  return (
    <Card
      data-conversation-id={id}
      className="shadow-none select-none p-4 gap-0 group relative transition-all !bg-black/5 dark:!bg-white/5 hover:!border-primary/50 cursor-pointer"
      onClick={() => {
        if (!isRenaming) onOpen(id);
      }}
    >
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-1 min-w-0 flex-1 mr-8">
          {isRenaming ? (
            <Input
              autoFocus
              value={draft}
              onChange={(e) => setDraft(e.target.value)}
              onClick={(e) => e.stopPropagation()}
              onKeyDown={(e) => {
                if (e.key === "Enter") {
                  e.preventDefault();
                  onCommitRename(id, draft);
                } else if (e.key === "Escape") {
                  e.preventDefault();
                  onCancelRename();
                }
              }}
              className="h-7 text-sm"
            />
          ) : (
            <>
              <p className="line-clamp-1 text-sm">{title}</p>
              <Button
                variant="ghost"
                size="icon"
                aria-label="Rename conversation"
                title="Rename conversation"
                // Always in the DOM, hidden by opacity rather than a
                // conditional render: hover is a CSS-only affordance here.
                className="size-5 shrink-0 opacity-0 group-hover:opacity-100"
                onClick={(e) => {
                  // Stops the click from also bubbling to the Card's onClick,
                  // which would otherwise read `isRenaming` from this render
                  // (still false) and navigate away the instant editing starts.
                  e.stopPropagation();
                  setDraft(title);
                  onStartRename(id);
                }}
              >
                <PencilIcon className="size-3" />
              </Button>
            </>
          )}
        </div>
        <div className="flex items-center gap-1">
          {badgeStatus !== null && (
            <Badge data-badge-status={badgeStatus} variant="outline" className="text-xs">
              {BADGE_COPY[badgeStatus] ?? badgeStatus}
              {badgeCount > 1 ? ` (${badgeCount})` : ""}
            </Badge>
          )}
          <Badge variant="outline" className="text-xs">
            {messageCount} messages
          </Badge>
          <Badge variant="outline" className="text-xs">
            {moment(updatedAt).format("hh:mm A")}
          </Badge>
        </div>
      </div>
    </Card>
  );
}

export const ConversationRow = memo(ConversationRowInner);
