import { Card, Updater, DragButton, CustomCursor, Button, WingIcon } from "@/components";
import {
  SystemAudio,
  Completion,
  AudioVisualizer,
  StatusIndicator,
} from "./components";
import { useApp, useSetupStatus } from "@/hooks";
import { useApp as useAppContext } from "@/contexts";
import { invoke } from "@tauri-apps/api/core";
import { ErrorBoundary } from "react-error-boundary";
import { ErrorLayout } from "@/layouts";
import { getPlatform } from "@/lib";
import { AlertCircle } from "lucide-react";

const App = () => {
  const { isHidden, systemAudio } = useApp();
  const { customizable } = useAppContext();
  const { isComplete: setupComplete, aiConfigured, sttConfigured } = useSetupStatus();
  const platform = getPlatform();

  const openDashboard = async () => {
    try {
      await invoke("open_dashboard");
    } catch (error) {
      console.error("Failed to open dashboard:", error);
    }
  };

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
        <Card className="w-full flex flex-row items-center gap-2 p-2">
          {/* Setup Required Message */}
          {!setupComplete && (
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
          {setupComplete && (
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
                <Completion isHidden={isHidden} />
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
        </Card>
        {customizable.cursor.type === "invisible" && platform !== "linux" ? (
          <CustomCursor />
        ) : null}
      </div>
    </ErrorBoundary>
  );
};

export default App;
