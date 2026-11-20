import { fetchSTT } from "@/lib";
import { UseCompletionReturn, SpeakerInfo, SpeakerIdFactory } from "@/types";
import { useMicVAD } from "@ricky0123/vad-react";
import { LoaderCircleIcon, MicIcon, MicOffIcon } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { Button } from "@/components";
import { useApp } from "@/contexts";
import { cn, floatArrayToWav } from "@/lib/utils";
import { shouldUseMeetwingsAPI } from "@/lib/functions/meetwings.api";
import { useTranslation } from "@/hooks";
import { isUsableTranscription } from "@/lib/functions/stt.function";
import { toast } from "sonner";

type OrtModule = Parameters<
  NonNullable<Parameters<typeof useMicVAD>[0]["ortConfig"]>
>[0];
type OrtSession = Awaited<ReturnType<OrtModule["InferenceSession"]["create"]>>;

let sharedCreate: unknown = null;

/**
 * Builds the VAD's onnxruntime session once and hands every later mount that
 * same session.
 *
 * vad-web 0.0.24 builds a fresh session on every MicVAD.new()
 * (models/legacy.js:43) and its destroy() never releases it
 * (real-time-vad.js:110-120, 197-204). onnxruntime-web keeps each one alive in
 * a module-level map (ort-web.js:26466) inside WebAssembly memory, which never
 * shrinks, and onnxruntime-common 1.14 has no public release(). This component
 * remounts on every enableVAD toggle and mic change, so each recording start
 * used to leak a session for the life of the app.
 *
 * Sharing is safe: the silero model's recurrent state (h/c) lives on each
 * SileroLegacy instance and is passed into every run(), never in the session.
 * Stream and AudioContext teardown are untouched, so the mic still closes on
 * every stop.
 *
 * `ortConfig` is the seam: vad-web calls it with its own `ort` right before
 * each model build (real-time-vad.js:135-143), and vad-react forwards it.
 *
 * ponytail: keyed on model byte length and assumes vad-web's one call shape,
 * create(ArrayBuffer). Nothing else in the renderer uses onnxruntime. Drop
 * this when vad-web is upgraded to a release whose destroy() releases its
 * session (0.0.31 does, but needs onnxruntime-web >=1.17 and changes the
 * default thresholds).
 */
const shareVadSession = (ort: OrtModule) => {
  const factory = ort.InferenceSession;
  if (factory.create === sharedCreate) return;

  const create = factory.create.bind(factory) as (
    model: ArrayBuffer
  ) => Promise<OrtSession>;
  const sessions = new Map<number, Promise<OrtSession>>();
  const shared = (model: ArrayBuffer) => {
    let session = sessions.get(model.byteLength);
    if (!session) {
      session = create(model);
      sessions.set(model.byteLength, session);
      // A failed build (offline, wasm fetch) must not break every later start.
      session.catch(() => sessions.delete(model.byteLength));
    }
    return session;
  };
  factory.create = shared as typeof factory.create;
  sharedCreate = shared;
};

interface AutoSpeechVADProps {
  submit: UseCompletionReturn["submit"];
  setState: UseCompletionReturn["setState"];
  setEnableVAD: UseCompletionReturn["setEnableVAD"];
  microphoneDeviceId: string;
  meetingAssistMode?: boolean;
  addMeetingTranscript?: UseCompletionReturn["addMeetingTranscript"];
  updateTranscriptTranslation?: UseCompletionReturn["updateTranscriptTranslation"];
  sttLanguage?: string;
}

const AutoSpeechVADInternal = ({
  submit,
  setState,
  setEnableVAD,
  microphoneDeviceId,
  meetingAssistMode = false,
  addMeetingTranscript,
  updateTranscriptTranslation,
  sttLanguage = "en",
}: AutoSpeechVADProps) => {
  const [isTranscribing, setIsTranscribing] = useState(false);
  const { selectedSttProvider, allSttProviders } = useApp();
  const { translate, isEnabled: translationEnabled } = useTranslation();

  const audioConstraints: MediaTrackConstraints = microphoneDeviceId
    ? { deviceId: { exact: microphoneDeviceId } }
    : { deviceId: "default" };

  const vad = useMicVAD({
    userSpeakingThreshold: 0.6,
    startOnLoad: true,
    additionalAudioConstraints: audioConstraints,
    ortConfig: shareVadSession,
    onSpeechEnd: async (audio) => {
      try {
        // convert float32array to blob
        const audioBlob = floatArrayToWav(audio, 16000, "wav");

        let transcription: string;
        const useMeetwingsAPI = await shouldUseMeetwingsAPI();

        // Check if we have a configured speech provider
        if (!selectedSttProvider.provider && !useMeetwingsAPI) {
          console.warn("No speech provider selected");
          setState((prev: any) => ({
            ...prev,
            error:
              "No speech provider selected. Please select one in settings.",
          }));
          return;
        }

        const providerConfig = allSttProviders.find(
          (p) => p.id === selectedSttProvider.provider
        );

        if (!providerConfig && !useMeetwingsAPI) {
          console.warn("Selected speech provider configuration not found");
          setState((prev: any) => ({
            ...prev,
            error:
              "Speech provider configuration not found. Please check your settings.",
          }));
          return;
        }

        setIsTranscribing(true);

        // Microphone audio always uses standard STT (no diarization)
        // Diarization is only for system audio (handled in useMeetingAudio.ts)
        // This ensures microphone audio is always labeled as "You"
        transcription = await fetchSTT({
          provider: useMeetwingsAPI ? undefined : providerConfig,
          selectedProvider: selectedSttProvider,
          audio: audioBlob,
          language: sttLanguage,
        });

        if (isUsableTranscription(transcription)) {
          if (meetingAssistMode && addMeetingTranscript) {
            // In Meeting Assist Mode, accumulate transcripts instead of auto-submitting
            // Phase 1: Label all microphone audio as "You"
            const microphoneSpeaker: SpeakerInfo = {
              speakerId: SpeakerIdFactory.you(),
              speakerLabel: 'You',
              confirmed: true,
            };
            const timestamp = addMeetingTranscript(transcription, microphoneSpeaker, 'microphone');

            // Translate in background if enabled
            if (translationEnabled && updateTranscriptTranslation) {
              translate(transcription).then((result) => {
                if (result.success && result.translation) {
                  updateTranscriptTranslation(timestamp, result.translation);
                } else if (result.error) {
                  updateTranscriptTranslation(timestamp, undefined, result.error);
                }
              });
            }
          } else {
            // Normal mode: auto-submit to AI
            submit(transcription);
          }
        } else if (!(meetingAssistMode && addMeetingTranscript) && transcription?.trim()) {
          // fetchSTT RESOLVES most provider failures - an expired key included -
          // so the catch below never sees them. Without this the transcribing
          // user speaks into the app and nothing happens, forever, silently.
          // state.error is the surface: it forces the popover open
          // (useCompletion.ts:1811) and renders at Input.tsx:230.
          //
          // Mirrors the meeting-mode condition above rather than plain
          // !meetingAssistMode, because a meeting without addMeetingTranscript
          // submits and so must also report.
          //
          // Meeting mode stays silent-and-dropped on purpose: reporting there
          // is not the point, keeping forged "You" lines out of
          // meetingTranscript and its autosave is.
          setState((prev: any) => ({ ...prev, error: transcription }));
        }
      } catch (error) {
        console.error("Failed to transcribe audio:", error);
        setState((prev: any) => ({
          ...prev,
          error:
            error instanceof Error ? error.message : "Transcription failed",
        }));
      } finally {
        setIsTranscribing(false);
      }
    },
  });

  // Nothing else surfaces a failed mic half. On MicVAD.new() failure vad-react
  // sets `errored`, `listening` stays false, and the button below renders the
  // plain MicIcon - identical to "voice input off". Under auto-record that is
  // a silently empty meeting.
  //
  // Deduped per mount, which is the right granularity: this component is keyed
  // on microphoneDeviceId at BOTH Audio.tsx:151 and the wrapper below, so it
  // remounts on every device change and every enableVAD toggle.
  const vadErrorToastedRef = useRef(false);
  useEffect(() => {
    if (!vad.errored || vadErrorToastedRef.current) return;
    vadErrorToastedRef.current = true;
    toast.error("Microphone could not start", {
      description: String(vad.errored),
      duration: 5000,
    });
  }, [vad.errored]);

  return (
    <>
      <Button
        size="icon"
        onClick={() => {
          if (vad.listening) {
            vad.pause();
            setEnableVAD(false);
          } else {
            vad.start();
            setEnableVAD(true);
          }
        }}
        className={cn("cursor-pointer", vad.listening && "bg-red-600 text-white hover:bg-red-600/90")}
      >
        {isTranscribing ? (
          <LoaderCircleIcon className="h-4 w-4 animate-spin text-green-500" />
        ) : vad.userSpeaking ? (
          <LoaderCircleIcon className="h-4 w-4 animate-spin" />
        ) : vad.listening ? (
          <MicOffIcon className="h-4 w-4" />
        ) : (
          <MicIcon className="h-4 w-4" />
        )}
      </Button>
    </>
  );
};

export const AutoSpeechVAD = (props: AutoSpeechVADProps) => {
  return <AutoSpeechVADInternal key={props.microphoneDeviceId} {...props} />;
};
