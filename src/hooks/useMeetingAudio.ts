/**
 * useMeetingAudio - Hook for capturing system audio in Meeting Assist Mode
 *
 * This hook manages system audio capture specifically for meeting scenarios,
 * where we want to transcribe audio from calls/meetings (other participants)
 * separately from microphone audio (the user).
 *
 * Phase 3 Enhancement: Supports audio buffering for speaker diarization.
 * When an AudioBuffer is provided, audio segments are added to the buffer
 * for batch diarization processing (retroactive speaker labeling).
 */

import { useEffect, useCallback, useRef, useState } from 'react';
import { listen } from '@tauri-apps/api/event';
import { invoke } from '@tauri-apps/api/core';
import { fetchSTT } from '@/lib';
// Deep-imported, not via the @/lib barrel: this predicate is built from the
// same literals stt.function.ts returns, so it has to come from that module.
import { isUsableTranscription } from '@/lib/functions/stt.function';
import { STT_FAILURE_REPORT_THRESHOLD } from '@/config';
import type { TYPE_PROVIDER } from '@/types';
import type { DiarizationAudioBuffer } from '@/lib/functions/audio-buffer';

interface SelectedProvider {
  provider: string;
  variables: Record<string, string>;
}

interface UseMeetingAudioProps {
  /** Whether system audio capture is enabled */
  enabled: boolean;
  /** Callback when system audio is transcribed - returns the entry ID for buffering */
  onSystemAudioTranscript: (text: string, timestamp: number) => void;
  /** Optional callback for errors (shown to user) */
  onError?: (error: Error) => void;
  /** STT provider configuration */
  sttProvider?: TYPE_PROVIDER;
  /** Selected STT provider info */
  selectedSttProvider: SelectedProvider;
  /** Language for STT */
  sttLanguage: string;
  /** Output device ID (optional, uses default if not specified) */
  outputDeviceId?: string;
  /** Optional audio buffer for diarization (Phase 3) */
  audioBuffer?: DiarizationAudioBuffer | null;
}

// VAD configuration optimized for meeting audio
const MEETING_VAD_CONFIG = {
  enabled: true,
  hop_size: 1024,
  sensitivity_rms: 0.012,
  peak_threshold: 0.035,
  silence_chunks: 45,
  min_speech_chunks: 7,
  pre_speech_chunks: 12,
  noise_gate_threshold: 0.003,
  max_recording_duration_secs: 180,
};

// Maximum queue size to prevent unbounded memory growth when STT is slower than audio capture
// At ~50-200KB per segment, 50 segments = 2.5-10MB max memory usage (reasonable buffer)
const MAX_QUEUE_SIZE = 50;

export function useMeetingAudio({
  enabled,
  onSystemAudioTranscript,
  onError,
  sttProvider,
  selectedSttProvider,
  sttLanguage,
  outputDeviceId,
  audioBuffer,
}: UseMeetingAudioProps) {
  // Queue-based processing to avoid dropping speech segments
  const processingQueueRef = useRef<string[]>([]);
  const isProcessingRef = useRef(false);
  const [isProcessing, setIsProcessing] = useState(false);
  const [hasQueuedAudio, setHasQueuedAudio] = useState(false);
  const isSetupCompleteRef = useRef(false);
  const enabledRef = useRef(enabled);
  const audioBufferRef = useRef(audioBuffer);
  const onSystemAudioTranscriptRef = useRef(onSystemAudioTranscript);
  const onErrorRef = useRef(onError);
  const droppedCountRef = useRef(0);
  // Consecutive segments that produced no usable transcription. Latched, not
  // re-armed on report: onError lands on an unbudgeted toast in Audio.tsx, so
  // a re-arming report turns an intermittent provider into a toast storm.
  const consecutiveSttFailuresRef = useRef(0);
  const sttFailureReportedRef = useRef(false);

  // Keep refs in sync
  useEffect(() => {
    enabledRef.current = enabled;
    audioBufferRef.current = audioBuffer;
    onSystemAudioTranscriptRef.current = onSystemAudioTranscript;
    onErrorRef.current = onError;
  }, [enabled, audioBuffer, onSystemAudioTranscript, onError]);

  // Track processQueue changes
  const processQueueCountRef = useRef(0);

  const noteSttFailure = useCallback(() => {
    consecutiveSttFailuresRef.current += 1;
    if (
      consecutiveSttFailuresRef.current >= STT_FAILURE_REPORT_THRESHOLD &&
      !sttFailureReportedRef.current
    ) {
      sttFailureReportedRef.current = true;
      onErrorRef.current?.(
        new Error(
          "Speech-to-text is failing for this meeting. Check your speech provider's API key and quota."
        )
      );
    }
  }, []);

  // Process queue of audio segments
  const processQueue = useCallback(async () => {
    if (isProcessingRef.current || processingQueueRef.current.length === 0) {
      setHasQueuedAudio(false);
      return;
    }
    isProcessingRef.current = true;
    setIsProcessing(true);

    while (processingQueueRef.current.length > 0) {
      // Check if still enabled before processing each item
      if (!enabledRef.current) {
        const discardedCount = processingQueueRef.current.length;
        if (discardedCount > 0) {
          console.warn(`[MeetingAudio] Meeting mode disabled. Discarding ${discardedCount} queued audio segment(s)`);
          // Notify user about discarded segments
          onErrorRef.current?.(new Error(`Meeting mode stopped. ${discardedCount} audio segment${discardedCount > 1 ? 's were' : ' was'} not transcribed.`));
        }
        processingQueueRef.current = [];
        setHasQueuedAudio(false);
        break;
      }

      const base64Audio = processingQueueRef.current.shift()!;

      // Update queue state
      setHasQueuedAudio(processingQueueRef.current.length > 0);

      try {
        // Convert base64 to blob
        const binaryString = atob(base64Audio);
        const bytes = new Uint8Array(binaryString.length);
        for (let i = 0; i < binaryString.length; i++) {
          bytes[i] = binaryString.charCodeAt(i);
        }
        const audioBlob = new Blob([bytes], { type: 'audio/wav' });

        // Transcribe
        const transcription = await fetchSTT({
          provider: sttProvider,
          selectedProvider: selectedSttProvider,
          audio: audioBlob,
          language: sttLanguage,
        });

        if (!enabledRef.current) {
          // The call ended while this segment was in fetchSTT, so whatever it
          // resolved is discarded. Loud, so the drop is visible; binding it to
          // its enqueue-time conversation id is a separate slice.
          //
          // Do NOT claim it was "billed" here: emitSTTUsage is only reached on
          // the template path (stt.function.ts:406), and fetchMeetwingsSTT
          // returns at :179-182 before it.
          console.warn(
            "[MeetingAudio] Discarding a segment that resolved after the session ended"
          );
        } else if (!transcription?.trim()) {
          // Empty/whitespace is silence or noise, NOT a provider failure. The
          // pre-change guard ignored these; counting them would raise
          // "check your API key" after three quiet segments.
          //
          // isUsableTranscription() also returns false for empty input, so this
          // branch looks redundant. It is not: hoisting the emptiness check
          // ahead of the shared predicate is what routes silence to "do
          // nothing" instead of to noteSttFailure() in the else. Collapsing the
          // two makes three quiet segments look like a dead API key.
        } else if (isUsableTranscription(transcription)) {
          consecutiveSttFailuresRef.current = 0;
          const timestamp = Date.now();
          onSystemAudioTranscriptRef.current(transcription!, timestamp);
          if (audioBufferRef.current) {
            audioBufferRef.current.addSegment(audioBlob, timestamp, `guest_${timestamp}`);
          }
        } else {
          noteSttFailure();
        }
      } catch (err) {
        console.error('[MeetingAudio] STT failed:', err);
        // Guarded: a rejection after the session ended must not increment the
        // counter, or the report can fire after the meeting is over.
        if (enabledRef.current) noteSttFailure();
      }
    }

    isProcessingRef.current = false;
    setIsProcessing(false);
    // noteSttFailure is useCallback(…, []), so listing it costs nothing: this
    // identity never changes and processQueue is not recreated by it.
  }, [sttProvider, selectedSttProvider, sttLanguage, noteSttFailure]);

  // Log when processQueue changes
  useEffect(() => {
    processQueueCountRef.current++;
    console.log('[MeetingAudio] processQueue recreated, count:', processQueueCountRef.current);
  }, [processQueue]);

  useEffect(() => {
    console.log('[MeetingAudio] useEffect running. enabled:', enabled, 'processQueue:', processQueue.name, 'outputDeviceId:', outputDeviceId);

    if (!enabled) {
      console.log('[MeetingAudio] Disabled, skipping setup');
      return;
    }

    let unlistenSpeechDetected: (() => void) | undefined;
    let unlistenSpeechStart: (() => void) | undefined;
    isSetupCompleteRef.current = false;

    const setup = async () => {
      try {
        // Start system audio capture
        const deviceId = outputDeviceId && outputDeviceId !== 'default'
          ? outputDeviceId
          : null;

        await invoke('start_system_audio_capture', {
          vadConfig: MEETING_VAD_CONFIG,
          deviceId,
        });

        console.log('[MeetingAudio] System audio capture started');
      } catch (err) {
        console.error('[MeetingAudio] Failed to start system audio:', err);
        onErrorRef.current?.(new Error('Failed to capture system audio. Check audio permissions.'));
        return;
      }

      try {
        // Listen for speech START events (fires when guest starts speaking)
        unlistenSpeechStart = await listen('speech-start', () => {
          if (!enabledRef.current) return;
          console.log('[MeetingAudio] Guest started speaking');
          setHasQueuedAudio(true); // Show indicator immediately when guest starts speaking
        });

        // Listen for speech detected events (fires when speech ends)
        unlistenSpeechDetected = await listen('speech-detected', async (event) => {
          if (!enabledRef.current) return;

          const base64Audio = event.payload as string;

          // Prevent unbounded queue growth when STT is slower than audio capture
          if (processingQueueRef.current.length >= MAX_QUEUE_SIZE) {
            processingQueueRef.current.shift(); // Drop oldest segment
            droppedCountRef.current++;
            console.warn('[MeetingAudio] Queue full, dropping oldest segment');

            // Notify user after significant drops (actionable threshold)
            if (droppedCountRef.current === 10) {
              onErrorRef.current?.(new Error(
                'Meeting audio backlog detected. Consider using a faster STT provider.'
              ));
            }
          }

          // Queue instead of dropping
          processingQueueRef.current.push(base64Audio);
          processQueue();
        });

        isSetupCompleteRef.current = true;
        console.log('[MeetingAudio] Event listener setup complete');
      } catch (err) {
        console.error('[MeetingAudio] Failed to setup event listener:', err);
        onErrorRef.current?.(new Error('Failed to setup audio event listener.'));
        // Try to clean up the capture we started
        invoke('stop_system_audio_capture').catch(() => {});
      }
    };

    setup();

    return () => {
      console.log('[MeetingAudio] Cleaning up...');

      // Always attempt cleanup to prevent race conditions during async setup
      // All operations below are safe to call regardless of setup completion state:
      // - Event listener cleanup has null checks
      // - stop_system_audio_capture has error handling (idempotent if not started)
      // - Ref/state cleanup is always safe

      // Cleanup event listeners (safe even if undefined)
      if (unlistenSpeechStart) {
        unlistenSpeechStart();
      }
      if (unlistenSpeechDetected) {
        unlistenSpeechDetected();
      }

      // Stop system audio capture (idempotent, handles "not started" gracefully)
      invoke('stop_system_audio_capture').catch((err) => {
        console.error('[MeetingAudio] Failed to stop capture:', err);
      });

      // Phase 3: Force flush any remaining buffered audio for diarization
      // then clear the buffer (meeting ended)
      if (audioBufferRef.current) {
        audioBufferRef.current.forceFlush();
        audioBufferRef.current.clear();
      }

      // Clear queue on cleanup (log if discarding segments)
      const queueLength = processingQueueRef.current.length;
      if (queueLength > 0) {
        console.log(`[MeetingAudio] Cleanup: Discarding ${queueLength} queued segment(s)`);
      }
      processingQueueRef.current = [];
      isProcessingRef.current = false;
      setIsProcessing(false);
      setHasQueuedAudio(false);
      isSetupCompleteRef.current = false;
      droppedCountRef.current = 0; // Reset for next session
      consecutiveSttFailuresRef.current = 0;
      sttFailureReportedRef.current = false;
    };
  }, [enabled, processQueue, outputDeviceId]);

  return {
    /** Whether guest audio is being captured or processed (true while speaking OR transcribing) */
    isProcessing: isProcessing || hasQueuedAudio,
  };
}
