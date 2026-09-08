import { invoke } from "@tauri-apps/api/core";
import { getCurrentWebviewWindow } from "@tauri-apps/api/webviewWindow";
import { useCallback, useEffect } from "react";

import { getMinimized } from "@/lib/overlay-minimize.store";

// Helper function to check if any popover is open in the DOM. Exported: the
// restore sequence re-derives the window height from the CURRENT popover
// state (see the spec's "Restore must re-derive the height").
export const isAnyPopoverOpen = (): boolean => {
  const popoverContents = document.querySelectorAll(
    "[data-radix-popper-content-wrapper]"
  );
  return popoverContents.length > 0;
};

// Module-level, not a hook: the minimized pill calls this directly after
// restoring, and it must not require a useWindowResize() mount (which would
// register a SECOND MutationObserver + document drag listeners alongside
// the instance useCompletion already owns). The gate below is the whole
// feature: arriving transcript segments fire the MutationObserver
// continuously, and without this early-return the pill is yanked back to a
// 600px bar within milliseconds of being minimized. Both expanded values are
// gated - resizeWindow(false) is the stomp, and resizeWindow(true) would
// silently un-minimize the window when a popover opens.
export const resizeWindow = async (expanded: boolean): Promise<void> => {
  if (getMinimized()) return;
  try {
    const window = getCurrentWebviewWindow();

    if (!expanded && isAnyPopoverOpen()) {
      return;
    }

    const newHeight = expanded ? 600 : 54;

    await invoke("set_window_height", {
      window,
      height: newHeight,
    });
  } catch (error) {
    console.error("Failed to resize window:", error);
  }
};

// Thin wrapper: every existing caller (useCompletion, useSystemAudio,
// updater) keeps its `const { resizeWindow } = useWindowResize()` line and
// its effect deps unchanged. resizeWindow's identity is now permanently
// stable, which also makes those deps exact.
export const useWindowResize = () => {
  // Setup drag handling and popover monitoring
  useEffect(() => {
    let isDragging = false;

    const handleMouseDown = (e: MouseEvent) => {
      const target = e.target as HTMLElement;
      const isDragRegion = target.closest('[data-tauri-drag-region="true"]');

      if (isDragRegion) {
        isDragging = true;
      }
    };

    const handleMouseUp = async () => {
      if (isDragging) {
        isDragging = false;

        setTimeout(() => {
          if (!isAnyPopoverOpen()) {
            resizeWindow(false);
          }
        }, 100);
      }
    };

    const observer = new MutationObserver(() => {
      if (!isAnyPopoverOpen()) {
        resizeWindow(false);
      }
    });

    // Observe the body for changes to detect popover open/close
    observer.observe(document.body, {
      childList: true,
      subtree: true,
      attributes: true,
      attributeFilter: ["data-state"],
    });

    document.addEventListener("mousedown", handleMouseDown);
    document.addEventListener("mouseup", handleMouseUp);

    return () => {
      document.removeEventListener("mousedown", handleMouseDown);
      document.removeEventListener("mouseup", handleMouseUp);
      observer.disconnect();
    };
  }, []);

  return { resizeWindow };
};

interface UseWindowFocusOptions {
  onFocusLost?: () => void;
  onFocusGained?: () => void;
}

export const useWindowFocus = ({
  onFocusLost,
  onFocusGained,
}: UseWindowFocusOptions = {}) => {
  const handleFocusChange = useCallback(
    async (focused: boolean) => {
      if (focused && onFocusGained) {
        onFocusGained();
      } else if (!focused && onFocusLost) {
        onFocusLost();
      }
    },
    [onFocusLost, onFocusGained]
  );

  useEffect(() => {
    let unlisten: (() => void) | null = null;

    const setupFocusListener = async () => {
      try {
        const window = getCurrentWebviewWindow();

        // Listen to focus change events
        unlisten = await window.onFocusChanged(({ payload: focused }) => {
          handleFocusChange(focused);
        });
      } catch (error) {
        console.error("Failed to setup focus listener:", error);
      }
    };

    setupFocusListener();

    // Cleanup
    return () => {
      if (unlisten) {
        unlisten();
      }
    };
  }, [handleFocusChange]);
};
