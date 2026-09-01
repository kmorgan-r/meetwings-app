import moment from "moment";
import { Badge, Card } from "@/components";

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
}

/**
 * One conversation in the date-grouped list.
 *
 * Takes PRIMITIVES, never the badge object or the badge map. `resolveBadge`
 * allocates a fresh `{ status, count }` per call and the map is rebuilt on every
 * `reload` - each focus refresh, each action's re-read - so an object prop would
 * hand every row a new identity even when its badge is unchanged. QueueRow
 * needed a custom `propsAreEqual` for exactly that reason; this shape means this
 * row will not.
 */
export function ConversationRow({
  id,
  title,
  messageCount,
  updatedAt,
  badgeStatus,
  badgeCount,
  onOpen,
}: ConversationRowProps) {
  return (
    <Card
      data-conversation-id={id}
      className="shadow-none select-none p-4 gap-0 group relative transition-all !bg-black/5 dark:!bg-white/5 hover:!border-primary/50 cursor-pointer"
      onClick={() => onOpen(id)}
    >
      <div className="flex items-center justify-between">
        <p className="line-clamp-1 text-sm mr-8">{title}</p>
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
