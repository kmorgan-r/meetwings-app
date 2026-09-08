import { Card, Updater, DragButton, CustomCursor, Button, WingIcon } from "@/components";
import {
  SystemAudio,
  Completion,
  AudioVisualizer,
  StatusIndicator,
  MinimizedPill,
} from "./components";
import { useApp, useSetupStatus, useMeetingDetection } from "@/hooks";
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
import type { OverlayPillStyle } from "@/lib/storage";

const App = () => {
  const { isHidden, systemAudio } = useApp();
  const {
    isComplete: setupComplete,
    isLoading: setupLoading,
    aiConfigured,
    sttConfigured,
  } = useSetupStatus();
  // Teams call detection. Self-gating: inert outside the `main` window and off
  // Windows. Takes no arguments and never touches capture state.
  useMeetingDetection();
  const { customizable, setOverlayPillStyle } = useAppContext();
  const platform = getPlatform();
  const minimized = useSyncExternalStore(subscribeToMinimized, getMinimized);
  const pillStyle = customizable.overlayPill.style;

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
  // inside an un-minimized window. One paint of the pill in a still-600px
  // window beats one paint of the full bar in a pill-sized one.
  const handleMinimize = async () => {
    const dims = PILL_DIMENSIONS[pillStyle];
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
          const dims = PILL_DIMENSIONS[style];
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

                <div
                  className={`${
                    systemAudio?.capturing
                      ? "hidden w-full fade-out transition-all duration-300"
                      : "w-full flex flex-row gap-2 items-center"
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
              onClick={handleMinimize}
            >
              <Minimize2 className="h-4 w-4" />
            </Button>
          </Card>
          {customizable.cursor.type === "invisible" && platform !== "linux" ? (
            <CustomCursor />
          ) : null}
        </div>
        {minimized && <MinimizedPill style={pillStyle} />}
      </div>
    </ErrorBoundary>
  );
};

export default App;
