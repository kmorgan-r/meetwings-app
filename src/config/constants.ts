// Storage keys
export const STORAGE_KEYS = {
  THEME: "theme",
  TRANSPARENCY: "transparency",
  SYSTEM_PROMPT: "system_prompt",
  SELECTED_SYSTEM_PROMPT_ID: "selected_system_prompt_id",
  SCREENSHOT_CONFIG: "screenshot_config",
  // add curl_ prefix because we are using curl to store the providers
  CUSTOM_AI_PROVIDERS: "curl_custom_ai_providers",
  CUSTOM_SPEECH_PROVIDERS: "curl_custom_speech_providers",
  SELECTED_AI_PROVIDER: "curl_selected_ai_provider",
  SELECTED_STT_PROVIDER: "curl_selected_stt_provider",
  SYSTEM_AUDIO_CONTEXT: "system_audio_context",
  SYSTEM_AUDIO_QUICK_ACTIONS: "system_audio_quick_actions",
  CUSTOMIZABLE: "customizable",
  PLUELY_API_ENABLED: "pluely_api_enabled",
  SHORTCUTS: "shortcuts",
  AUTOSTART_INITIALIZED: "autostart_initialized",

  SELECTED_AUDIO_INPUT_DEVICE: "selected_audio_input_device",
  SELECTED_AUDIO_OUTPUT_DEVICE: "selected_audio_output_device",
  RESPONSE_SETTINGS: "response_settings",
  COMPLETION_QUICK_ACTIONS: "completion_quick_actions",
  COMPLETION_QUICK_ACTIONS_VISIBLE: "completion_quick_actions_visible",

  // Context Memory settings
  CONTEXT_MEMORY_ENABLED: "context_memory_enabled",
  CONTEXT_MEMORY_MAX_TOKENS: "context_memory_max_tokens",
  CONTEXT_MEMORY_DAYS: "context_memory_days",

  // Meeting Assist Mode settings
  MEETING_ASSIST_MODE_ENABLED: "meeting_assist_mode_enabled",

  // STT Language setting
  STT_LANGUAGE: "stt_language",

  // STT Translation settings
  STT_TRANSLATION_ENABLED: "stt_translation_enabled",
  STT_TRANSLATION_LANGUAGE: "stt_translation_language",

  // Speaker Diarization settings
  SPEAKER_DIARIZATION_ENABLED: "speaker_diarization_enabled",
  SPEAKER_PROFILES: "speaker_profiles",
  USER_VOICE_ENROLLMENT: "user_voice_enrollment",
  ASSEMBLYAI_API_KEY: "assemblyai_api_key",
  PREVIOUS_STT_PROVIDER: "previous_stt_provider",
} as const;

// Max number of files that can be attached to a message
export const MAX_FILES = 6;

// Default settings
export const DEFAULT_SYSTEM_PROMPT =
  "You are a helpful AI assistant. Be concise, accurate, and friendly in your responses";

export const DEFAULT_QUICK_ACTIONS = [
  "What should I say?",
  "Follow-up questions",
  "Fact-check",
  "Recap",
];

// Meeting Assist Mode quick actions - optimized for meeting insights
export const MEETING_ASSIST_QUICK_ACTIONS = [
  "What should I say?",
  "Key points so far",
  "Suggest questions",
  "Action items",
];

// Meeting Assist system prompt for contextual insights
export const MEETING_ASSIST_SYSTEM_PROMPT = `You are a meeting assistant providing real-time insights. Based on the meeting transcript provided, give helpful, concise suggestions. Focus on:
- Being practical and actionable
- Keeping responses brief (2-3 sentences max unless more detail is needed)
- Understanding the context and flow of the conversation
- Providing relevant insights based on the specific request`;
