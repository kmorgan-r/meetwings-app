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
 * HOVER IS DELIBERATELY NOT `bg-accent`. In light mode --card is oklch(1 0 0)
 * and --accent is oklch(0.97 0 0) (global.css:49,59) - a 3% lightness delta
 * over a bg-card pill, which fires but cannot be seen; dark mode's 0.205 ->
 * 0.269 is barely better. So the two zones separate by HUE and by a real
 * delta instead: neutral `foreground/10` for expand, a red wash for record.
 * Hovering either also fades in the divider, which is what tells a first-time
 * user the pill is two targets at all, and dims the other zone so the signal
 * reads on a 28px control.
 *
 * A tooltip is not an option here: Radix portals to document.body, which
 * global.css:196 hides outright while minimized, and the window is 40px tall
 * so it would be clipped regardless. The native `title` stays - it is the one
 * thing that can paint outside the window - but at ~1s it cannot be the only
 * feedback.
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
        "group/pill w-full h-full flex items-center p-0.5 rounded-xl",
        "bg-card/95 border border-border shadow-md"
      )}
    >
      <button
        type="button"
        aria-label="Expand Meetwings overlay"
        title="Expand"
        onClick={handleExpand}
        className={cn(
          "group/expand pill-expand flex-1 min-w-0 h-full",
          "flex items-center justify-center gap-1.5",
          "rounded-[10px] cursor-pointer transition-all",
          "hover:bg-foreground/10 active:bg-foreground/15",
          "group-has-[.pill-record:hover]/pill:opacity-55",
          "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-inset"
        )}
      >
        <span
          className={cn(
            "size-2 rounded-full flex-shrink-0",
            STATUS_DOT_COLORS[pillData.status] ?? STATUS_DOT_COLORS.idle
          )}
        />
        {style === "icon-only" && (
          <WingIcon className="h-5 w-5 transition-transform group-active/expand:scale-90" />
        )}
        {style === "status-count" && (
          <>
            <span className="text-xs font-medium">{pillData.segmentCount}</span>
            <ChevronUp className="h-3.5 w-3.5 text-muted-foreground transition-transform group-active/expand:scale-90" />
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
        <>
          {/* The "there are two buttons here" cue. Hidden at rest so the pill
              stays a single calm shape, and it costs 1px rather than the
              window resize a real separator would need. */}
          <span
            aria-hidden="true"
            data-testid="pill-divider"
            className={cn(
              "w-px h-1/2 mx-0.5 flex-shrink-0 bg-border rounded-full",
              "opacity-0 group-hover/pill:opacity-100 transition-opacity"
            )}
          />
          <button
            type="button"
            aria-label={
              pillData.recording ? "Stop meeting recording" : "Start meeting recording"
            }
            title={pillData.recording ? "Stop recording" : "Start recording"}
            onClick={toggleRecording}
            className={cn(
              "group/record pill-record w-7 h-full flex-shrink-0",
              "flex items-center justify-center",
              "rounded-[10px] cursor-pointer transition-all",
              "hover:bg-red-500/15 active:bg-red-500/25",
              "group-has-[.pill-expand:hover]/pill:opacity-55",
              "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-inset"
            )}
          >
            {pillData.recording ? (
              <Square
                className={cn(
                  "h-3 w-3 fill-red-500 text-red-500",
                  "transition-transform group-active/record:scale-90"
                )}
              />
            ) : (
              <Circle
                className={cn(
                  "h-3 w-3 fill-red-500/70 text-red-500/70",
                  // transition-all, not transition-transform: this one moves
                  // fill and color on hover as well as scale on press.
                  "transition-all group-hover/record:fill-red-500",
                  "group-hover/record:text-red-500 group-active/record:scale-90"
                )}
              />
            )}
          </button>
        </>
      )}
    </div>
  );
};
