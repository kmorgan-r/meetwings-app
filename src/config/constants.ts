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
  MEETWINGS_API_ENABLED: "meetwings_api_enabled",
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

  // AI-generated conversation titles
  AI_TITLES_ENABLED: "ai_titles_enabled",

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

  // Auto-record meetings (detect Teams calls and record them). Deliberately a NEW
  // key: the previous `meeting_detection_enabled` carried consent to NOTIFICATIONS
  // only ("Does not start or stop recording"), so reusing it would silently expand
  // what the user agreed to. The old key is deleted, not migrated.
  MEETING_AUTO_RECORD_ENABLED: "meeting_auto_record_enabled",
  CALENDAR_AUTO_SELECT_ENABLED: "calendar_auto_select_enabled",

  // User Identity settings
  USER_IDENTITY: "user_identity",

  // Id of the conversation currently open in the chat view. Used to exclude the
  // in-progress conversation from summary backfill so it isn't frozen early.
  ACTIVE_CONVERSATION_ID: "active_conversation_id",

  // Id of the system-audio capture still recording, if any. Kept apart from
  // ACTIVE_CONVERSATION_ID because the chat view and the capture write
  // different conversations at the same time.
  CAPTURING_CONVERSATION_ID: "capturing_conversation_id",

  // How far a meeting log trigger has consumed the in-memory transcript even
  // when it wrote no row for it (Odoo not fully configured, or any throw). See
  // meeting-log-watermark.storage.ts.
  MEETING_LOG_SKIP_WATERMARK: "meeting_log_skip_watermark",

  // API Verification status
  AI_PROVIDER_VERIFIED: "ai_provider_verified",
  STT_PROVIDER_VERIFIED: "stt_provider_verified",

  // Per-provider configuration storage (remembers API keys when switching providers)
  AI_PROVIDER_CONFIGS: "ai_provider_configs",
  STT_PROVIDER_CONFIGS: "stt_provider_configs",

  // Notion meeting notes (see notion-config.storage.ts).
  // NOTION_PICKED: whether the user picked Notion for the current meeting
  // (useNotionPick boolean); cleared together with the Odoo targets.
  // NOTION_PICK_SOURCE: "auto" when Meetwings set that tick from the calendar,
  // else "hand".
  NOTION_AUTO_SEND: "notion_auto_send",
  NOTION_PICKED: "notion_picked",
  NOTION_PICK_SOURCE: "notion_pick_source",
  // When Notion first read as fully set up (ms epoch); floors crash recovery.
  NOTION_SETUP_AT: "notion_setup_at",

  // When the silent updater last completed an update check (ms epoch).
  UPDATER_LAST_CHECK_AT: "updater_last_check_at",
  // Set just before a silent install: Windows' installer relaunches with the
  // same argv, so the next start must not handle the launch link again.
  RELAUNCH_AFTER_UPDATE: "mw_relaunch_after_update",

  // Version recorded at last launch; a change means an update was installed.
  APP_LAST_VERSION: "app_last_version",
  // One-time "Updated to X" note: JSON {version, at} for the Settings readout.
  APP_UPDATED_TO: "app_updated_to",
  // When team settings were last fetched from the cloud (ms epoch).
  TEAM_LAST_SYNCED_AT: "team_last_synced_at",
} as const;

// Process image names that indicate a meeting call is in progress. Passed to the
// Rust watcher, so adding an app here is a config change rather than a Rust one.
export const MEETING_DETECT_PROCESSES = ["ms-teams.exe", "Teams.exe", "Zoom.exe"];

// Display names for the detection toasts, keyed by LOWERCASED process name.
// Matching on the Rust side is case-insensitive and the observed basename keeps
// its original case, so the lookup must lowercase before indexing.
export const MEETING_DETECT_LABELS: Record<string, string> = {
  "ms-teams.exe": "Teams",
  "teams.exe": "Teams",
  "chrome.exe": "Google Meet",
  "zoom.exe": "Zoom",
};

export const MEETING_DETECT_FALLBACK_LABEL = "Meeting";

// Processes that only count as a call when a calendar event with a Meet link is
// live: Chrome is running for every browsing session, so audio alone proves nothing.
export const MEETING_DETECT_GATED_PROCESSES = ["chrome.exe"];

// How often a gated process is re-checked against the calendar.
export const MEET_RECHECK_MS = 60_000;

// The serialized form of the Rust StopOutcome::TimedOut variant. Kept here so
// the string that gates the disable-failure ladder has exactly one home; a
// Rust-side serde change would otherwise turn that branch into dead code with
// every test still green.
export const STOP_TIMED_OUT = "timedOut";

// Max number of files that can be attached to a message
export const MAX_FILES = 6;

// Input validation limits for editor components
export const INPUT_LIMITS = {
  MAX_NAME_LENGTH: 100, // Names (people, projects, terms)
  MAX_ROLE_LENGTH: 50, // Role/title fields
  MAX_DESCRIPTION_LENGTH: 500, // Descriptions, meanings, relationships
  MAX_LIST_ITEM_LENGTH: 200, // Simple list items
  MAX_ACTION_ITEM_LENGTH: 300, // Action item text
  MAX_ASSIGNEE_LENGTH: 50, // Assignee names
} as const;

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

// Number of meeting transcript segments to accumulate before auto-saving the
// in-progress conversation to chat history. This prevents losing a whole meeting
// if the user ends/clears the transcript without ever asking the AI a question.
export const MEETING_TRANSCRIPT_AUTOSAVE_INTERVAL = 4;

// A meeting capture that opens this long after the current conversation's last
// line starts a new conversation. Measured on real data: silences inside one
// meeting reached 13 min, and detection flapping reopens the capture 5-15 min
// apart within the same call, while separate meetings were 36+ min apart.
export const MEETING_CONVERSATION_GAP_MS = 30 * 60 * 1000;

// Number of consecutive meeting-transcript autosave failures before the user
// is shown a "transcript could not be saved" report. A failed save advances
// no watermark, so the periodic autosave retries on the next segment and a
// transient failure repairs itself - latching on a run of failures (rather
// than the first one) avoids spending the report on a blip.
export const AUTOSAVE_FAILURE_REPORT_THRESHOLD = 3;

// Number of consecutive guest audio segments that produce no usable
// transcription before useMeetingAudio reports a failing STT provider.
// Three, not ten: a guest utterance is tens of seconds, so at ten a short
// call would report nothing.
export const STT_FAILURE_REPORT_THRESHOLD = 3;

// Number of consecutive guest segments that transcribe to nothing before
// useMeetingAudio reports that audio is being captured but not transcribed.
//
// Separate from the threshold above, and higher, because the two say different
// things. A rejection is the provider failing outright; an empty result is a
// COMPLETED transcription of audio the provider found no speech in, which one
// stray cough through the VAD gate can produce legitimately. Five consecutive
// (roughly a minute of a live call) is past what a run of odd segments
// explains, and still early enough to save the meeting.
export const EMPTY_TRANSCRIPTION_REPORT_THRESHOLD = 5;

/**
 * Bounded confirmation that a meeting-mode auto-stop really brought the capture
 * down. Worst case 1500 ms, past Rust's 500 ms floor (a 300 ms sleep before
 * is_capturing clears at src-tauri/src/speaker/commands.rs:478-484, 200 ms more
 * before capture-stopped at :487-490) with headroom for a saturated main thread.
 *
 * Here rather than in useMeetingAutoRecord because a module's own const reads
 * compile to a local binding: overriding its own export from a test is a silent
 * no-op, while vi.mock("@/config/constants", …) works.
 */
export const STOP_CONFIRM_ATTEMPTS = 5;
export const STOP_CONFIRM_INTERVAL_MS = 300;

// How long after a detected call ends the auto-recording keeps rolling before
// it stops on its own. Five seconds (owner's call, 2026-11-15; was two minutes):
// a hang-up should visibly stop the mic. The cost: a detection dropout longer
// than this mid-call stops the recording, and the re-detect starts a new one,
// so that call is split into two meeting-log rows. Same home as
// STOP_CONFIRM_ATTEMPTS above: a module's own const reads compile to a local
// binding, so vi.mock on this module is the only way to override it from a test.
export const CALL_END_GRACE_MS = 5_000;

// Stop a still-recording capture after fifteen minutes with no NEW transcript
// entry — counted by arrival (when a line is appended, not its timestamp) —
// whether or not a call is detected, on every platform the main window runs
// on. Fifteen minutes sits above the longest in-call silence measured (13
// minutes), so only a genuinely dead capture trips it.
export const SILENCE_STOP_MS = 15 * 60 * 1000;

// Bound on reading the calendar inside the same-call check. The answer decides
// whether a live capture keeps running, so a hung calendar request cannot be
// allowed to stall the stop: past 5 seconds the read is abandoned and treated
// as unreadable, which errs on the same-call side.
export const SAME_CALL_READ_TIMEOUT_MS = 5_000;

// Meeting Assist system prompt for contextual insights
export const MEETING_ASSIST_SYSTEM_PROMPT = `You are a live meeting/interview assistant feeding the user answers in real time. The transcript uses speaker labels: "You" is the user; other labels are the other participants.

ANSWER THE LATEST QUESTION:
Always respond to the MOST RECENT thing the other participant said (shown under "MOST RECENT thing said to you") — that is the current question. Do NOT answer an earlier question that was already addressed in the conversation history. If the latest line is a fresh question, that is the one to answer.

CRITICAL OUTPUT RULE:
When the request is "What should I say?" (or any request for what the user should say/reply/respond), output ONLY the exact words the user should speak, in the first person ("I..."), ready to say aloud verbatim.
- Do NOT describe the question, name its type, or explain your reasoning.
- Do NOT write meta-commentary like "This looks like...", "Here's a framework", "You could say...", headers, labels, bullet scaffolding, or bracketed placeholders.
- No preamble, no sign-off. Just the spoken answer.

Style for spoken answers:
- Natural, confident, conversational — how a sharp person actually talks, not written prose.
- Concise: usually 3-6 sentences. Long enough to be substantive, short enough to say without rambling.
- Genuine and SPECIFIC. Reference concrete details from the transcript (the actual role, company, product, or question mentioned). Never generic filler like "great company" or "I'm passionate about this space."
- If the transcript names the company/product/mission, weave that concrete detail in.

For other requests (e.g. "Key points so far", "Suggest questions", "Action items"): be brief, practical, and actionable (2-4 short points). These may use lists.

Always distinguish what the user ("You") said from what participants said.`;

// Emitted after team settings were applied, so other windows reload caches and forms.
export const TEAM_SETTINGS_APPLIED_EVENT = "team-settings-applied";
