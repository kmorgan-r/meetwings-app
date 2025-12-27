// Completion-related types

/**
 * Speaker information for diarization.
 */
export interface SpeakerInfo {
  speakerId: string; // "A", "B", "C" from AssemblyAI
  speakerLabel?: string; // "You", "Sarah - Client", or undefined
  speakerProfileId?: string; // Reference to enrolled profile
  confidence?: number; // 0-1 match confidence
  needsConfirmation?: boolean; // True if medium confidence, awaiting user input
}

/**
 * Transcript entry for meeting transcripts.
 */
export interface TranscriptEntry {
  original: string;
  translation?: string;
  translationError?: string;
  timestamp: number;
  // Speaker diarization fields
  speaker?: SpeakerInfo;
  audioChunkId?: string; // Reference for embedding extraction
}

export interface AttachedFile {
  id: string;
  name: string;
  type: string;
  base64: string;
  size: number;
}

export interface ChatMessage {
  id: string;
  role: "user" | "assistant" | "system";
  content: string;
  timestamp: number;
  attachedFiles?: AttachedFile[];
  /** Optional translation of the message content (for STT messages) */
  translation?: string;
  /** Translation error if translation failed */
  translationError?: string;
}

export interface ChatConversation {
  id: string;
  title: string;
  messages: ChatMessage[];
  createdAt: number;
  updatedAt: number;
}

export interface CompletionState {
  input: string;
  response: string;
  isLoading: boolean;
  error: string | null;
  attachedFiles: AttachedFile[];
  currentConversationId: string | null;
  conversationHistory: ChatMessage[];
}

// Provider-related types
export interface Message {
  role: "system" | "user" | "assistant";
  content:
    | string
    | Array<{
        type: string;
        text?: string;
        image_url?: { url: string };
        source?: any;
        inline_data?: any;
      }>;
}
