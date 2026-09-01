import { memo, useState } from "react";
import moment from "moment";
import { Badge, Card, Button, Input } from "@/components";
import { CheckIcon, PencilIcon, XIcon } from "lucide-react";

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
  /**
   * The resolved badge, flattened. `badgeCount` counts the rows actually IN
   * `badgeStatus`, not every badge-eligible row on the conversation - the two
   * are rendered as one phrase, so see `resolveBadge` for why.
   */
  badgeStatus: string | null;
  badgeCount: number;
  onOpen: (id: string) => void;
  /** Whether THIS row is the one the page has open for an inline rename. */
  isRenaming: boolean;
  onStartRename: (id: string) => void;
  /**
   * Resolves to whether the rename actually landed. A refused write keeps the
   * editor open with the user's text still in it rather than closing over it -
   * the same contract QueueRow's commit has.
   */
  onCommitRename: (id: string, title: string) => Promise<boolean>;
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
 * `onStartRename`, `onCommitRename`, `onCancelRename`, all of which hold their
 * identity across the page's re-renders: three are `useCallback`s with an empty
 * dependency array, and `onCommitRename` is deped on `commitRename`, which is
 * itself `[]`-deped.
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
  // never needs to survive past the commit/cancel that ends it, and does not
  // belong in the page's `renamingId` state.
  const [draft, setDraft] = useState(title);
  // Guards re-entrancy: the editor now stays open across the write, so Enter
  // and the tick button could otherwise both fire again mid-flight.
  const [savingName, setSavingName] = useState(false);
  const [nameError, setNameError] = useState<string | null>(null);

  const saveName = async () => {
    if (savingName) return;
    if (!draft.trim()) {
      setNameError("A conversation needs a name.");
      return;
    }
    setSavingName(true);
    setNameError(null);
    try {
      const renamed = await onCommitRename(id, draft);
      // The page closes this editor on success, so anything reaching here
      // failed: no row matched, or the write threw. Either way the typed name
      // stays on screen rather than vanishing - losing it to a silent close is
      // how a save failure reads as "it just does not save".
      if (!renamed) setNameError("That name could not be saved.");
    } finally {
      setSavingName(false);
    }
  };

  const cancelName = () => {
    setNameError(null);
    onCancelRename();
  };

  return (
    <Card
      data-conversation-id={id}
      className="shadow-none select-none p-4 gap-0 group relative transition-all !bg-black/5 dark:!bg-white/5 hover:!border-primary/50 cursor-pointer"
      onClick={() => {
        if (!isRenaming) onOpen(id);
      }}
    >
      <div className="flex items-center justify-between">
        <div className="flex min-w-0 flex-1 mr-8 flex-col gap-1">
          <div className="flex items-center gap-1 min-w-0">
            {isRenaming ? (
              <>
                <Input
                  autoFocus
                  value={draft}
                  disabled={savingName}
                  onChange={(e) => setDraft(e.target.value)}
                  onClick={(e) => e.stopPropagation()}
                  onKeyDown={(e) => {
                    if (e.key === "Enter") {
                      e.preventDefault();
                      void saveName();
                    } else if (e.key === "Escape") {
                      e.preventDefault();
                      cancelName();
                    }
                  }}
                  className="h-7 text-sm"
                />
                {/*
                  Enter alone is not an affordance - nothing on screen says the
                  name was saved that way. The same tick/cross pair, and the
                  same keyboard hints, as the strip row above and
                  InlineTextEditor.tsx elsewhere in this app.
                */}
                <Button
                  variant="ghost"
                  size="icon"
                  aria-label="Save the name"
                  title="Save (Enter)"
                  disabled={savingName}
                  className="size-6 shrink-0"
                  onClick={(e) => {
                    e.stopPropagation();
                    void saveName();
                  }}
                >
                  <CheckIcon className="size-3" />
                </Button>
                <Button
                  variant="ghost"
                  size="icon"
                  aria-label="Cancel renaming"
                  title="Cancel (Esc)"
                  disabled={savingName}
                  className="size-6 shrink-0"
                  onClick={(e) => {
                    e.stopPropagation();
                    cancelName();
                  }}
                >
                  <XIcon className="size-3" />
                </Button>
              </>
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
                    setNameError(null);
                    onStartRename(id);
                  }}
                >
                  <PencilIcon className="size-3" />
                </Button>
              </>
            )}
          </div>
          {nameError !== null && (
            <p
              className="text-xs text-destructive"
              onClick={(e) => e.stopPropagation()}
            >
              {nameError}
            </p>
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
