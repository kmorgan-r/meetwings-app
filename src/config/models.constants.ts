/**
 * Model configurations for AI and STT providers.
 * Used to populate model dropdowns in the Dev Space settings.
 */

export interface ModelOption {
  id: string;
  name: string;
  recommended?: boolean;
  description?: string;
}

export interface ProviderInfo {
  name: string;
  signupUrl: string;
  pricingUrl?: string;
  description: string;
}

/**
 * AI provider information including signup and pricing URLs.
 */
export const AI_PROVIDER_INFO: Record<string, ProviderInfo> = {
  openai: {
    name: "OpenAI",
    signupUrl: "https://platform.openai.com/signup",
    pricingUrl: "https://openai.com/api/pricing",
    description: "Get your API key and credits from OpenAI",
  },
  claude: {
    name: "Anthropic",
    signupUrl: "https://console.anthropic.com/",
    pricingUrl: "https://www.anthropic.com/pricing#anthropic-api",
    description: "Get your API key and credits from Anthropic",
  },
  grok: {
    name: "xAI",
    signupUrl: "https://console.x.ai/",
    pricingUrl: "https://x.ai/api",
    description: "Get your API key from xAI",
  },
  gemini: {
    name: "Google AI Studio",
    signupUrl: "https://aistudio.google.com/apikey",
    pricingUrl: "https://ai.google.dev/pricing",
    description: "Get your API key from Google AI Studio",
  },
  mistral: {
    name: "Mistral AI",
    signupUrl: "https://console.mistral.ai/",
    pricingUrl: "https://mistral.ai/technology/#pricing",
    description: "Get your API key and credits from Mistral AI",
  },
  cohere: {
    name: "Cohere",
    signupUrl: "https://dashboard.cohere.com/welcome/register",
    pricingUrl: "https://cohere.com/pricing",
    description: "Get your API key and credits from Cohere",
  },
  groq: {
    name: "Groq",
    signupUrl: "https://console.groq.com/keys",
    pricingUrl: "https://groq.com/pricing/",
    description: "Get your API key from Groq (generous free tier!)",
  },
  perplexity: {
    name: "Perplexity",
    signupUrl: "https://www.perplexity.ai/settings/api",
    pricingUrl: "https://docs.perplexity.ai/guides/pricing",
    description: "Get your API key and credits from Perplexity",
  },
  openrouter: {
    name: "OpenRouter",
    signupUrl: "https://openrouter.ai/keys",
    pricingUrl: "https://openrouter.ai/models",
    description: "Access multiple AI providers through one API",
  },
  ollama: {
    name: "Ollama",
    signupUrl: "https://ollama.com/download",
    description: "Download and run models locally for free",
  },
};

/**
 * STT provider information including signup and pricing URLs.
 */
export const STT_PROVIDER_INFO: Record<string, ProviderInfo> = {
  "openai-whisper": {
    name: "OpenAI Whisper",
    signupUrl: "https://platform.openai.com/signup",
    pricingUrl: "https://openai.com/api/pricing",
    description: "Get your API key from OpenAI",
  },
  groq: {
    name: "Groq Whisper",
    signupUrl: "https://console.groq.com/keys",
    pricingUrl: "https://groq.com/pricing/",
    description: "Get your API key from Groq (very affordable!)",
  },
  "elevenlabs-stt": {
    name: "ElevenLabs",
    signupUrl: "https://elevenlabs.io/app/sign-up",
    pricingUrl: "https://elevenlabs.io/pricing",
    description: "Get your API key from ElevenLabs",
  },
  "google-stt": {
    name: "Google Cloud Speech",
    signupUrl: "https://console.cloud.google.com/apis/credentials",
    pricingUrl: "https://cloud.google.com/speech-to-text/pricing",
    description: "Get your API key from Google Cloud Console",
  },
  "deepgram-stt": {
    name: "Deepgram",
    signupUrl: "https://console.deepgram.com/signup",
    pricingUrl: "https://deepgram.com/pricing",
    description: "Get your API key from Deepgram",
  },
  "azure-stt": {
    name: "Azure Speech Services",
    signupUrl: "https://azure.microsoft.com/en-us/products/ai-services/speech-to-text",
    pricingUrl: "https://azure.microsoft.com/en-us/pricing/details/cognitive-services/speech-services/",
    description: "Get your API key from Azure Portal",
  },
  "speechmatics-stt": {
    name: "Speechmatics",
    signupUrl: "https://portal.speechmatics.com/signup",
    pricingUrl: "https://www.speechmatics.com/pricing",
    description: "Get your API key from Speechmatics",
  },
  "rev-ai-stt": {
    name: "Rev.ai",
    signupUrl: "https://www.rev.ai/auth/signup",
    pricingUrl: "https://www.rev.ai/pricing",
    description: "Get your API key from Rev.ai",
  },
  "ibm-watson-stt": {
    name: "IBM Watson",
    signupUrl: "https://cloud.ibm.com/catalog/services/speech-to-text",
    pricingUrl: "https://www.ibm.com/products/speech-to-text/pricing",
    description: "Get your API key from IBM Cloud",
  },
  "assemblyai-diarization": {
    name: "AssemblyAI",
    signupUrl: "https://www.assemblyai.com/app/signup",
    pricingUrl: "https://www.assemblyai.com/pricing",
    description: "Get your API key from AssemblyAI",
  },
};

/**
 * Get provider info for an AI provider.
 */
export function getAIProviderInfo(providerId: string): ProviderInfo | null {
  return AI_PROVIDER_INFO[providerId] || null;
}

/**
 * Get provider info for an STT provider.
 */
export function getSTTProviderInfo(providerId: string): ProviderInfo | null {
  return STT_PROVIDER_INFO[providerId] || null;
}

/**
 * AI model options per provider.
 * Models are ordered by recommendation/popularity.
 * Text-only models say so in `name`: the dropdown never shows `description`,
 * and they fail any request that carries a screenshot.
 */
export const AI_MODELS: Record<string, ModelOption[]> = {
  openai: [
    { id: "gpt-5.6-terra", name: "GPT-5.6 Terra", recommended: true, description: "Balanced quality, speed and cost" },
    { id: "gpt-5.6-luna", name: "GPT-5.6 Luna", description: "Fastest and cheapest" },
    { id: "gpt-5.6-sol", name: "GPT-5.6 Sol", description: "Frontier GPT-5.6 for complex work" },
    { id: "gpt-6-astra", name: "GPT-6 Astra", description: "Most capable, slower and costly" },
  ],
  claude: [
    { id: "claude-opus-5", name: "Claude Opus 5", recommended: true, description: "Best reasoning — ideal for interviews" },
    { id: "claude-sonnet-5", name: "Claude Sonnet 5", description: "Near-Opus quality, faster and cheaper" },
    { id: "claude-haiku-4-5", name: "Claude Haiku 4.5", description: "Fastest, most affordable" },
    { id: "claude-fable-5-1", name: "Claude Fable 5.1", description: "Most capable; slow, always thinks" },
  ],
  grok: [
    { id: "grok-4.20-0309-non-reasoning", name: "Grok 4.20 (non-reasoning)", recommended: true, description: "Fast answers, no reasoning step" },
    { id: "grok-4.6", name: "Grok 4.6", description: "Most capable, always reasons" },
    { id: "grok-4.3", name: "Grok 4.3", description: "Cheaper reasoning, 1M context" },
  ],
  gemini: [
    { id: "gemini-3.8-flash", name: "Gemini 3.8 Flash", recommended: true, description: "Newest, smartest Flash" },
    { id: "gemini-3.6-flash", name: "Gemini 3.6 Flash", description: "Stable Flash" },
    { id: "gemini-3.5-flash-lite", name: "Gemini 3.5 Flash-Lite", description: "Fastest, minimal thinking" },
    { id: "gemini-3.1-flash-lite", name: "Gemini 3.1 Flash-Lite", description: "Cheapest" },
  ],
  mistral: [
    { id: "mistral-large-2512", name: "Mistral Large 3", recommended: true, description: "Multimodal, no reasoning step, low cost" },
    { id: "mistral-medium-3-5", name: "Mistral Medium 3.5", description: "Frontier multimodal" },
    { id: "mistral-small-2603", name: "Mistral Small 4", description: "Cheap, multimodal" },
    { id: "ministral-14b-2512", name: "Ministral 3 14B", description: "Small vision model, very cheap" },
    { id: "ministral-8b-2512", name: "Ministral 3 8B", description: "Tiny and fast" },
  ],
  cohere: [
    { id: "command-a-vision-07-2025", name: "Command A Vision", recommended: true, description: "Image input, no thinking step" },
    { id: "command-a-plus-05-2026", name: "Command A+", description: "Newest, vision + reasoning" },
    { id: "command-a-03-2025", name: "Command A (text only)", description: "256K context" },
  ],
  groq: [
    { id: "openai/gpt-oss-120b", name: "GPT-OSS 120B (text only)", recommended: true, description: "Fast, capable reasoning" },
    { id: "openai/gpt-oss-20b", name: "GPT-OSS 20B (text only)", description: "Fastest and cheapest" },
  ],
  perplexity: [
    { id: "sonar-pro", name: "Sonar Pro", recommended: true, description: "Best web-grounded answers" },
    { id: "sonar", name: "Sonar", description: "Fast, cheap web-grounded answers" },
  ],
  openrouter: [
    { id: "openai/gpt-5.6-luna", name: "GPT-5.6 Luna", recommended: true, description: "Cheap, fast, vision" },
    { id: "z-ai/glm-5.3-flash", name: "GLM 5.3 Flash", description: "Cheap vision, reasoning always on" },
    { id: "deepseek/deepseek-v4.1-flash", name: "DeepSeek V4.1 Flash", description: "Fast vision, 2x price at weekday peak" },
    { id: "google/gemini-3.8-flash", name: "Gemini 3.8 Flash", description: "Strong vision, pricier" },
    { id: "deepseek/deepseek-v4-flash-0731", name: "DeepSeek V4 Flash (text only)", description: "Ultra cheap" },
    { id: "upstage/solar-pro4", name: "Solar Pro 4 (text only)", description: "Cheapest popular pick" },
    { id: "openrouter/free", name: "Free Models Router", description: "Picks a free model per request, rate-limited" },
    { id: "thinkingmachines/inkling:free", name: "Inkling (free)", description: "Vision, rate-limited" },
    { id: "nvidia/nemotron-3.5-lightning:free", name: "Nemotron 3.5 Lightning (free, text only)", description: "Rate-limited" },
  ],
  ollama: [
    { id: "ministral-3", name: "Ministral 3", recommended: true, description: "Vision, no thinking; 8B default" },
    { id: "gemma4", name: "Gemma 4", description: "Google's newest; vision + audio" },
    { id: "qwen3.8", name: "Qwen 3.8", description: "Newest Qwen, vision; 27B (18GB)" },
    { id: "qwen3.5", name: "Qwen 3.5", description: "Vision + thinking; 9B default" },
    { id: "granite4.2", name: "Granite 4.2 (text only)", description: "IBM; 8B default" },
  ],
};

/**
 * STT model options per provider.
 * Models are ordered by recommendation/popularity.
 */
export const STT_MODELS: Record<string, ModelOption[]> = {
  "openai-whisper": [
    { id: "whisper-1", name: "Whisper V1", recommended: true, description: "Standard Whisper model" },
    { id: "gpt-4o-transcribe", name: "GPT-4o Transcribe", description: "High accuracy transcription" },
    { id: "gpt-4o-mini-transcribe", name: "GPT-4o Mini Transcribe", description: "Fast and affordable" },
  ],
  groq: [
    { id: "whisper-large-v3-turbo", name: "Whisper Large V3 Turbo", recommended: true, description: "Fastest + cheapest, near-instant for live use" },
    { id: "whisper-large-v3", name: "Whisper Large V3", description: "Best accuracy, slightly slower" },
    { id: "distil-whisper-large-v3-en", name: "Distil Whisper (English)", description: "Fast, English only" },
  ],
  "elevenlabs-stt": [
    { id: "scribe_v1", name: "Scribe V1", recommended: true, description: "ElevenLabs STT model" },
  ],
  "google-stt": [
    { id: "default", name: "Default", recommended: true, description: "Google Cloud STT" },
    { id: "latest_long", name: "Latest Long", description: "Optimized for long audio" },
    { id: "latest_short", name: "Latest Short", description: "Optimized for short audio" },
  ],
  "deepgram-stt": [
    { id: "nova-2", name: "Nova 2", recommended: true, description: "Latest, most accurate" },
    { id: "nova", name: "Nova", description: "Previous generation" },
    { id: "enhanced", name: "Enhanced", description: "Higher accuracy" },
    { id: "base", name: "Base", description: "Standard accuracy" },
  ],
  "azure-stt": [
    { id: "default", name: "Default", recommended: true, description: "Azure Speech Services" },
  ],
  "speechmatics-stt": [
    { id: "default", name: "Default", recommended: true, description: "Speechmatics STT" },
  ],
  "rev-ai-stt": [
    { id: "default", name: "Default", recommended: true, description: "Rev.ai STT" },
  ],
  "ibm-watson-stt": [
    { id: "default", name: "Default", recommended: true, description: "IBM Watson STT" },
  ],
  "assemblyai-diarization": [
    { id: "best", name: "Best", recommended: true, description: "Highest accuracy" },
    { id: "nano", name: "Nano", description: "Fastest, lower cost" },
  ],
};

/**
 * Get models for a specific AI provider.
 * Returns empty array if provider not found.
 */
export function getAIModelsForProvider(providerId: string): ModelOption[] {
  return AI_MODELS[providerId] || [];
}

/**
 * Get models for a specific STT provider.
 * Returns empty array if provider not found.
 */
export function getSTTModelsForProvider(providerId: string): ModelOption[] {
  return STT_MODELS[providerId] || [];
}

/**
 * Check if a provider has predefined models.
 */
export function hasModelsForProvider(providerId: string, type: "ai" | "stt"): boolean {
  if (type === "ai") {
    return providerId in AI_MODELS && AI_MODELS[providerId].length > 0;
  }
  return providerId in STT_MODELS && STT_MODELS[providerId].length > 0;
}

/**
 * Check if a model exists in the predefined list for a provider.
 * Returns true if:
 * - The model is in the predefined list, OR
 * - The provider has no predefined models (custom models allowed)
 *
 * @param providerId - The provider ID
 * @param modelId - The model ID to validate
 * @param type - "ai" or "stt"
 * @returns true if the model is valid for this provider
 */
export function isModelValidForProvider(
  providerId: string,
  modelId: string,
  type: "ai" | "stt"
): boolean {
  // Empty model is invalid
  if (!modelId || modelId.trim() === "") {
    return false;
  }

  const models = type === "ai"
    ? getAIModelsForProvider(providerId)
    : getSTTModelsForProvider(providerId);

  // If no predefined models, any model is valid (custom provider)
  if (models.length === 0) {
    return true;
  }

  // Check if model exists in predefined list
  return models.some((m) => m.id === modelId);
}

/**
 * Get the recommended model for a provider.
 * Returns null if no models are defined or no recommended model.
 */
export function getRecommendedModel(
  providerId: string,
  type: "ai" | "stt"
): ModelOption | null {
  const models = type === "ai"
    ? getAIModelsForProvider(providerId)
    : getSTTModelsForProvider(providerId);

  return models.find((m) => m.recommended) || models[0] || null;
}
