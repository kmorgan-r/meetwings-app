import { useCallback, useMemo, useRef } from "react";
import { InfoIcon, MicIcon, LoaderCircleIcon, Users } from "lucide-react";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
  Button,
} from "@/components";
import { AutoSpeechVAD } from "./AutoSpeechVad";
import { UseCompletionReturn } from "@/types";
import { useApp } from "@/contexts";
import { useMeetingAudio, useTranslation, useSpeakerDiarization } from "@/hooks";
import { STORAGE_KEYS } from "@/config";

export const Audio = ({
  micOpen,
  setMicOpen,
  enableVAD,
  setEnableVAD,
  submit,
  setState,
  meetingAssistMode,
  addMeetingTranscript,
  addSystemAudioTranscript,
  updateTranscriptTranslation,
  updateEntrySpeaker,
  meetingTranscript,
}: UseCompletionReturn) => {
  const { selectedSttProvider, allSttProviders, pluelyApiEnabled, selectedAudioDevices, sttLanguage } =
    useApp();
  const { translate, isEnabled: translationEnabled } = useTranslation();

  // Phase 3: Check if diarization is enabled
  const diarizationEnabled = useMemo(() => {
    if (typeof window === "undefined") return false;
    return localStorage.getItem(STORAGE_KEYS.SPEAKER_DIARIZATION_ENABLED) === "true";
  }, []);

  const assemblyAIKey = useMemo(() => {
    if (typeof window === "undefined") return "";
    return localStorage.getItem(STORAGE_KEYS.ASSEMBLYAI_API_KEY) || "";
  }, []);

  // Keep meetingTranscript in a ref for the getTranscriptEntries callback
  const meetingTranscriptRef = useRef(meetingTranscript);
  meetingTranscriptRef.current = meetingTranscript;

  // Phase 3: Speaker diarization hook
  // Note: resetRegistry is available for future use when meeting ends
  const { createAudioBuffer } = useSpeakerDiarization({
    apiKey: assemblyAIKey,
    language: sttLanguage,
    updateEntrySpeaker,
    getTranscriptEntries: useCallback(() => meetingTranscriptRef.current, []),
    onBatchProcessed: (batchId, speakerCount) => {
      console.log(`[Audio] Diarization batch ${batchId} processed with ${speakerCount} speakers`);
    },
    onError: (error) => {
      console.error("[Audio] Diarization error:", error);
      // Don't show error to user - diarization is a background feature
    },
  });

  // Phase 3: Create audio buffer for diarization (only when conditions are met)
  const audioBuffer = useMemo(() => {
    if (meetingAssistMode && enableVAD && diarizationEnabled && assemblyAIKey) {
      return createAudioBuffer();
    }
    return null;
  }, [meetingAssistMode, enableVAD, diarizationEnabled, assemblyAIKey, createAudioBuffer]);

  // Get STT provider config for system audio
  const sttProviderConfig = allSttProviders.find(
    (p) => p.id === selectedSttProvider.provider
  );

  // Handler for system audio transcripts with translation support
  const handleSystemAudioTranscript = useCallback(
    (text: string, timestamp: number) => {
      addSystemAudioTranscript(text, timestamp);

      // Translate in background if enabled
      if (translationEnabled) {
        translate(text).then((result) => {
          if (result.success && result.translation) {
            updateTranscriptTranslation(timestamp, result.translation);
          } else if (result.error) {
            updateTranscriptTranslation(timestamp, undefined, result.error);
          }
        });
      }
    },
    [addSystemAudioTranscript, translationEnabled, translate, updateTranscriptTranslation]
  );

  // System audio capture for Meeting Assist Mode
  // Only enabled when both meetingAssistMode and enableVAD are true
  // Phase 3: Pass audioBuffer for diarization when enabled
  const { isProcessing: isProcessingSystemAudio } = useMeetingAudio({
    enabled: meetingAssistMode && enableVAD,
    onSystemAudioTranscript: handleSystemAudioTranscript,
    onError: (error) => {
      // Log but don't show error to user - system audio capture is optional
      // It requires special setup (Virtual Audio Cable or Windows loopback support)
      console.warn('[Audio] System audio capture unavailable:', error.message);
      console.info('[Audio] Tip: Install VB-Cable for system audio capture, or use microphone-only mode');
    },
    sttProvider: sttProviderConfig,
    selectedSttProvider,
    sttLanguage,
    outputDeviceId: selectedAudioDevices.output,
    audioBuffer, // Phase 3: Buffer for batch diarization
  });

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

      {/* Guest Audio Indicator - Shows when processing system audio in Meeting Mode */}
      {meetingAssistMode && enableVAD && (
        <Button
          size="icon"
          variant="outline"
          disabled
          className="cursor-default"
          title={isProcessingSystemAudio ? "Processing guest audio..." : "Listening for guest audio"}
        >
          {isProcessingSystemAudio ? (
            <LoaderCircleIcon className="h-4 w-4 animate-spin text-blue-500" />
          ) : (
            <Users className="h-4 w-4 text-muted-foreground" />
          )}
        </Button>
      )}
    </div>
  );
};
