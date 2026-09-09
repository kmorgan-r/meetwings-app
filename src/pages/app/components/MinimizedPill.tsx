import { useSyncExternalStore } from "react";
import { invoke } from "@tauri-apps/api/core";
import { ChevronUp, Circle, Square } from "lucide-react";

import { WingIcon } from "@/components";
import {
  getPillActions,
  getPillData,
  setMinimized,
  subscribeToPillActions,
  subscribeToPillData,
} from "@/lib/overlay-minimize.store";
import { isAnyPopoverOpen, resizeWindow } from "@/hooks/useWindow";
import type { OverlayPillStyle } from "@/lib/storage";
import { cn } from "@/lib/utils";

const STATUS_DOT_COLORS: Record<string, string> = {
  capturing: "bg-green-500",
  error: "bg-red-500",
  idle: "bg-gray-400",
};

/**
 * The corner pill shown while the overlay is minimized. The window itself is
 * sized by Rust (`minimize_overlay`); this component fills it, so the variant
 * differences are content, not fixed pixel sizes.
 *
 * The pill chrome (background, border, rounding) sits on the CONTAINER, not on
 * the expand button: the record button is a SIBLING, because a <button> nested
 * in a <button> is invalid HTML and makes the inner click target unreliable.
 *
 * No `data-tauri-drag-region` anywhere on the pill: a drag region over the
 * click target makes the expand click unreliable, and dragging stays an
 * expanded-overlay affordance via the existing DragButton.
 */
export const MinimizedPill = ({ style }: { style: OverlayPillStyle }) => {
  const pillData = useSyncExternalStore(subscribeToPillData, getPillData);
  const { toggleRecording } = useSyncExternalStore(
    subscribeToPillActions,
    getPillActions
  );

  // The order is load-bearing (the spec's "Restore must re-derive the
  // height"): the gate stays CLOSED until Rust has actually restored the
  // geometry — a resizeWindow racing a half-restored window is the bug the
  // gate exists to prevent. Only then clear the flag and re-derive the
  // height from the CURRENT popover state instead of replaying the
  // minimize-time snapshot.
  const handleExpand = async () => {
    try {
      await invoke("restore_overlay");
    } catch (error) {
      // Flag NOT cleared: clearing after a failed restore would render the
      // full Card inside a pill-sized window. The pill stays; the user can
      // retry.
      console.error("Failed to restore overlay:", error);
      return;
    }
    setMinimized(false);
    resizeWindow(isAnyPopoverOpen());
  };

  return (
    <div
      className={cn(
        "w-full h-full flex items-center gap-0.5 p-0.5 rounded-xl",
        "bg-card/95 border border-border shadow-md"
      )}
    >
      <button
        type="button"
        aria-label="Expand Meetwings overlay"
        title="Expand"
        onClick={handleExpand}
        className={cn(
          "flex-1 min-w-0 h-full flex items-center justify-center gap-1.5",
          "rounded-[10px] cursor-pointer hover:bg-accent/90 transition-colors"
        )}
      >
        <span
          className={cn(
            "size-2 rounded-full flex-shrink-0",
            STATUS_DOT_COLORS[pillData.status] ?? STATUS_DOT_COLORS.idle
          )}
        />
        {style === "icon-only" && <WingIcon className="h-5 w-5" />}
        {style === "status-count" && (
          <>
            <span className="text-xs font-medium">{pillData.segmentCount}</span>
            <ChevronUp className="h-3.5 w-3.5 text-muted-foreground" />
          </>
        )}
        {style === "status-last-line" && (
          <span className="text-xs truncate max-w-[260px]">
            {pillData.lastLine || "Listening..."}
          </span>
        )}
      </button>

      {/* Absent, not disabled, while nothing is registered: <Completion /> is
          the only writer, and it withholds the action when no speech provider
          can serve a recording. A button that silently does nothing is worse
          than no button on a pill this small. */}
      {toggleRecording && (
        <button
          type="button"
          aria-label={
            pillData.recording ? "Stop meeting recording" : "Start meeting recording"
          }
          title={pillData.recording ? "Stop recording" : "Start recording"}
          onClick={toggleRecording}
          className={cn(
            "w-7 h-full flex-shrink-0 flex items-center justify-center",
            "rounded-[10px] cursor-pointer hover:bg-accent/90 transition-colors"
          )}
        >
          {pillData.recording ? (
            <Square className="h-3 w-3 fill-red-500 text-red-500" />
          ) : (
            <Circle className="h-3 w-3 fill-red-500/70 text-red-500/70" />
          )}
        </button>
      )}
    </div>
  );
};
