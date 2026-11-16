import { Card, Updater, DragButton, CustomCursor, Button, WingIcon } from "@/components";
import {
  SystemAudio,
  Completion,
  AudioVisualizer,
  StatusIndicator,
  MinimizedPill,
  MeetingCard,
} from "./components";
import {
  useApp,
  useSetupStatus,
  useMeetingDetection,
  useMeetingCardHost,
  useTeamSync,
} from "@/hooks";
import { useApp as useAppContext } from "@/contexts";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { ErrorBoundary } from "react-error-boundary";
import { ErrorLayout } from "@/layouts";
import { getPlatform } from "@/lib";
import { AlertCircle, Minimize2 } from "lucide-react";
import { useEffect, useSyncExternalStore } from "react";
import {
  getMinimized,
  PILL_DIMENSIONS,
  setMinimized,
  subscribeToMinimized,
} from "@/lib/overlay-minimize.store";
import { getMeetingCard, pillWindowSize } from "@/lib/meeting-cards.store";
import { getCustomizableState, type OverlayPillStyle } from "@/lib/storage";

const App = () => {
  const { isHidden, systemAudio } = useApp();
  const {
    isComplete: setupComplete,
    isLoading: setupLoading,
    aiConfigured,
    sttConfigured,
  } = useSetupStatus();
  // Teams and Google Meet call detection. Self-gating: inert outside the `main` window and off
  // Windows. Takes no arguments and never touches capture state.
  useMeetingDetection();
  // Team deep links and re-syncs. Self-gating: inert outside the `main` window.
  useTeamSync();
  const { customizable, setOverlayPillStyle } = useAppContext();
  const platform = getPlatform();
  const minimized = useSyncExternalStore(subscribeToMinimized, getMinimized);
  const pillStyle = customizable.overlayPill.style;
  const card = useMeetingCardHost(pillStyle);

  const openDashboard = async () => {
    try {
      await invoke("open_dashboard");
    } catch (error) {
      console.error("Failed to open dashboard:", error);
    }
  };

  // The gate closes SYNCHRONOUSLY before the invoke: a transcript segment
  // arriving during the IPC round-trip fires the MutationObserver's
  // resizeWindow(false), which must not race the pill geometry. The catch
  // rolls the flag back so a failed minimize cannot leave a pill rendered
  // inside an un-minimized window. One paint of the pill in a still-full-width
  // window beats one paint of the full bar in a pill-sized one.
  const handleMinimize = async () => {
    // Re-entrancy guard, matching the pattern everywhere else in this feature
    // (the style listener, resizeWindow's gate): a second call while already
    // minimized would send another `restyle: false` invoke, and Rust would
    // re-snapshot the window's own pill geometry as the "pre-minimize" rect —
    // corrupting the restore target.
    if (getMinimized()) return;
    const dims = pillWindowSize(pillStyle, getMeetingCard());
    setMinimized(true);
    try {
      await invoke("minimize_overlay", {
        width: dims.width,
        height: dims.height,
        restyle: false,
      });
    } catch (error) {
      console.error("Failed to minimize overlay:", error);
      setMinimized(false);
    }
  };

  // Rust owns the minimized flag; this one is a mirror that dies with the
  // webview's JS heap. Anything that resets it — the error screen's reload
  // button, a WebView2 renderer restart — used to bring the app back with
  // `minimized` false while the WINDOW was still the bottom-right pill: the
  // full Card rendered into pill geometry, the MutationObserver stretched it
  // to the full bar width from the corner anchor, and the drag handle and minimize button
  // ended up off the right edge of the screen where nothing could reach them.
  // Reading the flag back on mount is what closes that gap; `set_window_height`
  // is gated in Rust too, so the observer cannot win the race while this
  // invoke is in flight.
  //
  // A reload also empties the card store while the window keeps its card-aware
  // size, so a minimized rehydrate restyles to the size for the CURRENT card
  // (none, after a reload). restyle: true never re-snapshots the restore rect.
  // The style is read from storage at use time: AppProvider starts at the
  // default style and loads the stored one in its own mount effect, which this
  // IPC round trip is not guaranteed to outlast.
  useEffect(() => {
    invoke<boolean>("is_overlay_minimized")
      .then((isMinimized) => {
        if (!isMinimized) return;
        setMinimized(true);
        const style = getCustomizableState().overlayPill.style;
        const dims = pillWindowSize(style, getMeetingCard());
        return invoke("minimize_overlay", {
          width: dims.width,
          height: dims.height,
          restyle: true,
        });
      })
      .catch((error) => {
        console.error("Failed to read the minimized state:", error);
      });
  }, []);

  // The dashboard settings window writes localStorage and emits
  // overlay-pill-style-changed (it renders in another webview; this one's
  // React state will not re-read storage on its own). Sync the context
  // state, and if minimized, restyle the pill in place — restyle: true is
  // what keeps Rust from re-snapshotting the pill's own corner geometry as
  // the "pre-minimize" rect.
  useEffect(() => {
    // The .catch is attached HERE, before the cleanup return, and resolves to
    // a no-op unlisten — an unhandled rejection would fail the suite, and a
    // .catch placed after the return statement would be dead code.
    const unlistenPromise = listen<{ style: OverlayPillStyle }>(
      "overlay-pill-style-changed",
      (event) => {
        const style = event.payload.style;
        setOverlayPillStyle(style);
        if (getMinimized()) {
          const dims = pillWindowSize(style, getMeetingCard());
          invoke("minimize_overlay", {
            width: dims.width,
            height: dims.height,
            restyle: true,
          }).catch((error) => {
            console.error("Failed to restyle minimized pill:", error);
          });
        }
      }
    ).catch((error) => {
      console.error("Failed to listen for pill style changes:", error);
      return () => {};
    });

    return () => {
      unlistenPromise.then((unlisten) => unlisten());
    };
    // [] deps, matching the useApp.ts listener precedent: setOverlayPillStyle
    // is an unmemoized provider function (new identity every provider render,
    // like setCursorType at src/contexts/app.context.tsx:728), so depending on
    // it would tear down and re-register the listener — with a gap — on every
    // provider render. The callback only touches stable bindings
    // (setOverlayPillStyle via closure over the render it was created in is
    // fine: it writes through setCustomizable, which is identity-stable, and
    // the storage writer; it never reads stale React state), so [] is safe.
  }, []);

  return (
    <ErrorBoundary
      fallbackRender={() => {
        return <ErrorLayout isCompact />;
      }}
      resetKeys={["app-error"]}
      onReset={() => {
        console.log("Reset");
      }}
    >
      <div
        className={`w-screen h-screen flex overflow-hidden justify-center items-start ${
          isHidden ? "hidden pointer-events-none" : ""
        }`}
      >
        {/* Inner minimized wrapper: hiding is a VISIBILITY change — the Card
            subtree (and useCompletion's 2400-line hook with it) stays
            mounted, or minimize would destroy the meeting transcript and
            re-run every mount effect on restore. isHidden is the OUTER
            wrapper, so hiding the app hides the pill too. The wrapper needs
            w-full: it is an auto-width flex item of the outer justify-center
            container, and without it the Card's w-full would resolve against
            a shrink-to-fit parent — a content-sized bar instead of the
            full-window one. */}
        <div className={minimized ? "hidden" : "w-full"}>
          {/* Above the bar, so a card never covers what sits under the
              overlay. The window still grows downward (useWindow sizes it), so
              the bar moves down by the card's height while one shows. */}
          {card && (
            <div className="mb-2">
              <MeetingCard card={card} />
            </div>
          )}
          <Card className="w-full flex flex-row items-center gap-2 p-2">
            {/* Setup Required Message (suppressed until setup status settles) */}
            {!setupLoading && !setupComplete && (
              <div className="flex flex-1 items-center gap-3 px-2">
                <AlertCircle className="h-5 w-5 text-yellow-500 flex-shrink-0" />
                <div className="flex flex-col min-w-0">
                  <span className="text-sm font-medium text-foreground">
                    Setup Required
                  </span>
                  <span className="text-xs text-muted-foreground truncate">
                    {!aiConfigured && !sttConfigured
                      ? "Configure & verify AI + Speech providers"
                      : !aiConfigured
                      ? "Configure & verify AI provider"
                      : !sttConfigured
                      ? "Configure & verify Speech-to-Text"
                      : "Verify your API connections"}
                  </span>
                </div>
                <Button
                  size="sm"
                  variant="outline"
                  className="ml-auto flex-shrink-0"
                  onClick={openDashboard}
                >
                  Open Setup
                </Button>
              </div>
            )}

            {/* Normal UI when setup is complete */}
            {!setupLoading && setupComplete && (
              <>
                <SystemAudio {...systemAudio} />
                {systemAudio?.capturing ? (
                  <div className="flex flex-row items-center gap-2 justify-between w-full">
                    <div className="flex flex-1 items-center gap-2">
                      <AudioVisualizer
                        stream={systemAudio?.stream}
                        isRecording={systemAudio?.capturing}
                      />
                    </div>
                    <div className="flex !w-fit items-center gap-2">
                      <StatusIndicator
                        setupRequired={systemAudio.setupRequired}
                        error={systemAudio.error}
                        isProcessing={systemAudio.isProcessing}
                        isAIProcessing={systemAudio.isAIProcessing}
                        capturing={systemAudio.capturing}
                      />
                    </div>
                  </div>
                ) : null}

                {/* flex-1 min-w-0, not w-full: the toolbar takes what the
                    window controls leave, and the contact picker truncates.
                    At min-content (meeting badge + a conversation's input
                    padding) the row is wider than the 500px window, and
                    overflow-hidden then clipped the LAST child: Minimize. */}
                <div
                  className={`${
                    systemAudio?.capturing
                      ? "hidden w-full fade-out transition-all duration-300"
                      : "flex-1 min-w-0 flex flex-row gap-1 items-center"
                  }`}
                >
                  <Completion isHidden={isHidden} systemAudio={systemAudio} />
                  <Button
                    size={"icon"}
                    className="cursor-pointer"
                    title="Open Settings"
                    onClick={openDashboard}
                  >
                    <WingIcon className="h-4 w-4" />
                  </Button>
                </div>
              </>
            )}

            <Updater />
            <DragButton />
            <Button
              size={"icon"}
              className="cursor-pointer"
              title="Minimize"
              aria-label="Minimize overlay"
              data-overlay-minimize-control="true"
              onClick={handleMinimize}
            >
              <Minimize2 className="h-4 w-4" />
            </Button>
          </Card>
        </div>
        {/* Compact card above the pill. The window grows upward from the
            bottom-right anchor (useMeetingCardHost sizes it); the pill keeps
            its exact box at the bottom-right. */}
        {minimized && card ? (
          <div className="w-full h-full flex flex-col items-end justify-end gap-2">
            <MeetingCard card={card} compact />
            <div className="shrink-0" style={PILL_DIMENSIONS[pillStyle]}>
              <MinimizedPill style={pillStyle} />
            </div>
          </div>
        ) : (
          minimized && <MinimizedPill style={pillStyle} />
        )}
        {/* Sibling of BOTH the Card wrapper and the pill, inside the isHidden
            one — exactly where it sat before the minimized wrapper existed.
            cursor.type defaults to "invisible", which sets --cursor-type:none
            on the whole overlay webview, so this drawn pointer is the only
            cursor the user has; inside the minimized wrapper it would vanish
            over the pill. Hiding the app still hides it, which is intended. */}
        {customizable.cursor.type === "invisible" && platform !== "linux" ? (
          <CustomCursor />
        ) : null}
      </div>
    </ErrorBoundary>
  );
};

export default App;
