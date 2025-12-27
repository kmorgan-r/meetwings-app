// Supported STT languages (ISO 639-1 codes)
// These are languages commonly supported by major STT providers
export const STT_LANGUAGES = [
  { code: "en", name: "English" },
  { code: "es", name: "Spanish" },
  { code: "fr", name: "French" },
  { code: "de", name: "German" },
  { code: "it", name: "Italian" },
  { code: "pt", name: "Portuguese" },
  { code: "nl", name: "Dutch" },
  { code: "pl", name: "Polish" },
  { code: "ru", name: "Russian" },
  { code: "ja", name: "Japanese" },
  { code: "ko", name: "Korean" },
  { code: "zh", name: "Chinese" },
  { code: "ar", name: "Arabic" },
  { code: "fa", name: "Persian (Farsi)" },
  { code: "hi", name: "Hindi" },
  { code: "tr", name: "Turkish" },
  { code: "vi", name: "Vietnamese" },
  { code: "th", name: "Thai" },
  { code: "sv", name: "Swedish" },
  { code: "da", name: "Danish" },
  { code: "no", name: "Norwegian" },
  { code: "fi", name: "Finnish" },
  { code: "he", name: "Hebrew" },
  { code: "uk", name: "Ukrainian" },
  { code: "cs", name: "Czech" },
  { code: "el", name: "Greek" },
  { code: "id", name: "Indonesian" },
  { code: "ms", name: "Malay" },
] as const;

export const DEFAULT_STT_LANGUAGE = "en";

// STT Translation defaults
export const DEFAULT_TRANSLATION_ENABLED = false;
export const DEFAULT_TRANSLATION_LANGUAGE = "fa"; // Persian (Farsi) - default target
export const TRANSLATION_LANGUAGES = STT_LANGUAGES;

export const SPEECH_TO_TEXT_PROVIDERS = [
  {
    id: "openai-whisper",
    name: "OpenAI Whisper",
    curl: `curl -X POST "https://api.openai.com/v1/audio/transcriptions" \\
      -H "Authorization: Bearer {{API_KEY}}" \\
      -F "file={{AUDIO}}" \\
      -F "model={{MODEL}}" \\
      -F "language={{LANGUAGE}}"`,
    responseContentPath: "text",
    streaming: false,
  },
  {
    id: "groq",
    name: "Groq Whisper",
    curl: `curl -X POST https://api.groq.com/openai/v1/audio/transcriptions \\
      -H "Authorization: bearer {{API_KEY}}" \\
      -F "file={{AUDIO}}" \\
      -F model={{MODEL}} \\
      -F temperature=0 \\
      -F response_format=text \\
      -F language={{LANGUAGE}}`,
    responseContentPath: "text",
    streaming: false,
  },
  {
    id: "elevenlabs-stt",
    name: "ElevenLabs Speech-to-Text",
    curl: `curl -X POST "https://api.elevenlabs.io/v1/speech-to-text" \\
      -H "xi-api-key: {{API_KEY}}" \\
      -F "file={{AUDIO}}" \\
      -F "model_id={{MODEL}}"`,
    responseContentPath: "text",
    streaming: false,
  },
  {
    id: "google-stt",
    name: "Google Speech-to-Text",
    curl: `curl -X POST "https://speech.googleapis.com/v1/speech:recognize" \\
      -H "Authorization: Bearer {{API_KEY}}" \\
      -H "Content-Type: application/json" \\
      -H "x-goog-user-project: {{PROJECT_ID}}" \\
      -d '{
        "config": {
          "encoding": "LINEAR16",
          "sampleRateHertz": 16000,
          "languageCode": "{{LANGUAGE}}-US"
        },
        "audio": {
          "content": "{{AUDIO}}"
        }
      }'`,
    responseContentPath: "results[0].alternatives[0].transcript",
    streaming: false,
  },
  {
    id: "deepgram-stt",
    name: "Deepgram Speech-to-Text",
    curl: `curl -X POST "https://api.deepgram.com/v1/listen?model={{MODEL}}&language={{LANGUAGE}}" \\
      -H "Authorization: TOKEN {{API_KEY}}" \\
      -H "Content-Type: audio/wav" \\
      --data-binary {{AUDIO}}`,
    responseContentPath: "results.channels[0].alternatives[0].transcript",
    streaming: false,
  },
  {
    id: "azure-stt",
    name: "Azure Speech-to-Text",
    curl: `curl -X POST "https://{{REGION}}.stt.speech.microsoft.com/speech/recognition/conversation/cognitiveservices/v1?language={{LANGUAGE}}-US" \\
      -H "Ocp-Apim-Subscription-Key: {{API_KEY}}" \\
      -H "Content-Type: audio/wav" \\
      --data-binary {{AUDIO}}`,
    responseContentPath: "DisplayText",
    streaming: false,
  },
  {
    id: "speechmatics-stt",
    name: "Speechmatics",
    curl: `curl -X POST "https://asr.api.speechmatics.com/v2/jobs" \\
      -H "Authorization: Bearer {{API_KEY}}" \\
      -F "data_file={{AUDIO}}" \\
      -F 'config={"type": "transcription", "transcription_config": {"language": "{{LANGUAGE}}"}}'`,
    responseContentPath: "job.id",
    streaming: false,
  },
  {
    id: "rev-ai-stt",
    name: "Rev.ai Speech-to-Text",
    curl: `curl -X POST "https://api.rev.ai/speechtotext/v1/jobs" \\
      -H "Authorization: Bearer {{API_KEY}}" \\
      -F "media={{AUDIO}}" \\
      -F "options={{OPTIONS}}"`,
    responseContentPath: "id",
    streaming: false,
  },
  {
    id: "ibm-watson-stt",
    name: "IBM Watson Speech-to-Text",
    curl: `curl -X POST "https://api.us-south.speech-to-text.watson.cloud.ibm.com/v1/recognize" \\
      -H "Authorization: Basic {{API_KEY}}" \\
      -H "Content-Type: audio/wav" \\
      --data-binary {{AUDIO}}`,
    responseContentPath: "results[0].alternatives[0].transcript",
    streaming: false,
  },
  {
    id: "assemblyai-diarization",
    name: "AssemblyAI (with Speaker Diarization)",
    curl: `curl -X POST "https://api.assemblyai.com/v2/upload" \\
      -H "Authorization: {{API_KEY}}" \\
      -H "Content-Type: application/octet-stream" \\
      --data-binary {{AUDIO}}`,
    responseContentPath: "upload_url",
    streaming: false,
    requiresSpecialHandler: true,
    specialHandler: "assemblyai-diarization",
  },
];
