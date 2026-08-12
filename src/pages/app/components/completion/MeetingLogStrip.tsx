import { Button } from "@/components";

/**
 * The undo affordance, in the 54px meeting bar.
 *
 * NOT a popover, and NOT in the expanded region: the window is 600px wide and
 * non-resizable (tauri.conf.json:17-22), resizeWindow changes HEIGHT only
 * (useWindow.ts:22), and the expanded region is Input.tsx's PopoverContent -
 * portaled out of <Completion />'s subtree, and closed on the pill-off path
 * (useCompletion.ts:1850) at the exact commit the hold begins.
 *
 * <Completion /> swaps this in for the ContactPicker trigger while holding, so
 * it costs no extra width. Imports from @/components are limited to Button -
 * settings-page.meeting-auto-record.test.tsx mocks that module with a fixed
 * export list.
 *
 * jsdom has no window bounds, so NO test here can prove this is visible. The
 * live check is a required acceptance criterion; see the plan's manual list.
 */
export const MeetingLogStrip = ({
  holding,
  contactName,
  onUndo,
  undoBlockedMessage,
}: {
  holding: boolean;
  contactName: string | null;
  onUndo: () => void;
  undoBlockedMessage: string | null;
}) => {
  if (!holding && !undoBlockedMessage) return null;

  return (
    <div
      data-testid="meeting-log-strip"
      className="flex flex-row items-center gap-2 min-w-0 text-xs"
    >
      {undoBlockedMessage ? (
        <span className="truncate text-muted-foreground">{undoBlockedMessage}</span>
      ) : (
        <>
          <span className="truncate text-muted-foreground">
            {contactName ? `Logging to ${contactName}` : "Logging this meeting"}
          </span>
          <Button type="button" size="sm" variant="ghost" onClick={onUndo}>
            Undo
          </Button>
        </>
      )}
    </div>
  );
};
