import { InfoIcon, MicIcon } from "lucide-react";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
  Button,
} from "@/components";
import { AutoSpeechVAD } from "./AutoSpeechVad";
import { UseCompletionReturn } from "@/types";
import { useApp } from "@/contexts";

export const Audio = ({
  micOpen,
  setMicOpen,
  enableVAD,
  setEnableVAD,
  submit,
  setState,
  meetingAssistMode,
  addMeetingTranscript,
  updateTranscriptTranslation,
}: UseCompletionReturn) => {
  const { selectedSttProvider, pluelyApiEnabled, selectedAudioDevices, sttLanguage } =
    useApp();

  const speechProviderStatus = selectedSttProvider.provider;
  const canUseVoice = pluelyApiEnabled || speechProviderStatus;

  return (
    <div className="flex items-center gap-1">
      {/* Mic Button with Popover */}
      <Popover open={micOpen} onOpenChange={setMicOpen}>
        <PopoverTrigger asChild>
          {canUseVoice && enableVAD ? (
            <AutoSpeechVAD
              key={selectedAudioDevices.input}
              submit={submit}
              setState={setState}
              setEnableVAD={setEnableVAD}
              microphoneDeviceId={selectedAudioDevices.input}
              meetingAssistMode={meetingAssistMode}
              addMeetingTranscript={addMeetingTranscript}
              updateTranscriptTranslation={updateTranscriptTranslation}
              sttLanguage={sttLanguage}
            />
          ) : (
            <Button
              size="icon"
              onClick={() => {
                if (canUseVoice) {
                  setEnableVAD(!enableVAD);
                }
              }}
              className="cursor-pointer"
              title={canUseVoice ? "Toggle voice input" : "Configure speech provider first"}
            >
              <MicIcon className="h-4 w-4" />
            </Button>
          )}
        </PopoverTrigger>

        <PopoverContent
          align="end"
          side="bottom"
          className={`w-80 p-3 ${canUseVoice ? "hidden" : ""}`}
          sideOffset={8}
        >
          <div className="text-sm select-none">
            <div className="font-semibold text-orange-600 mb-1">
              Speech Provider Configuration Required
            </div>
            <p className="text-muted-foreground">
              {!speechProviderStatus ? (
                <>
                  <div className="mt-2 flex flex-row gap-1 items-center text-orange-600">
                    <InfoIcon size={16} />
                    {selectedSttProvider.provider ? null : (
                      <p>PROVIDER IS MISSING</p>
                    )}
                  </div>

                  <span className="block mt-2">
                    Please go to settings and configure your speech provider to
                    enable voice input.
                  </span>
                </>
              ) : null}
            </p>
          </div>
        </PopoverContent>
      </Popover>

    </div>
  );
};
