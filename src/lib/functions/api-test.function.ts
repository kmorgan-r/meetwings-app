/**
 * API Connection Test Functions
 *
 * These functions perform minimal API requests to verify that the configured
 * API keys are valid and working before unlocking the app.
 */

import { TYPE_PROVIDER } from "@/types";
import { fetch as tauriFetch } from "@tauri-apps/plugin-http";
import curl2Json from "@bany/curl-to-json";
import {
  deepVariableReplacer,
  extractVariables,
  getByPath,
} from "./common.function";

export interface TestResult {
  success: boolean;
  message: string;
  error?: string;
}

/** Request body type for API calls */
type RequestBody = Record<string, unknown>;

/** Parsed curl configuration */
interface ParsedCurl {
  url?: string;
  method?: string;
  header?: Record<string, string>;
  data?: RequestBody;
  params?: Record<string, string>;
}

/** Selected provider configuration */
interface SelectedProviderConfig {
  provider: string;
  variables: Record<string, string>;
}

/** Default timeout for API test requests (10 seconds) */
const API_TEST_TIMEOUT_MS = 10000;

/**
 * Standardized error message prefixes for consistent user experience.
 */
const ErrorMessages = {
  // Configuration errors
  CONFIG_NO_PROVIDER: "Configuration error: No provider configured",
  CONFIG_NO_API_KEY: "Configuration error: API key not provided",
  CONFIG_MISSING_REQUIRED: (field: string) => `Configuration error: Missing ${field}`,
  CONFIG_INVALID: "Configuration error: Invalid provider configuration",
  CONFIG_UNSUPPORTED: "Configuration error: API format not supported for verification",

  // Authentication errors
  AUTH_INVALID_KEY: "Authentication failed: Invalid API key",
  AUTH_RATE_LIMITED: "Authentication verified (rate limited)",

  // Network errors
  NETWORK_TIMEOUT: "Network error: Connection timed out",
  NETWORK_ERROR: "Network error: Connection failed",

  // Response errors
  RESPONSE_INVALID: "Response error: Invalid response format",
  RESPONSE_EMPTY: "Response error: Empty response",
  RESPONSE_API_ERROR: (status: number) => `Response error: API returned ${status}`,

  // Success messages
  SUCCESS_VERIFIED: "Connection verified",
  SUCCESS_KEY_VERIFIED: "API key verified",
} as const;

/**
 * Validates that provider and API key are configured.
 * Returns a TestResult error if validation fails, null if valid.
 */
function validateProviderConfig(
  provider: TYPE_PROVIDER | undefined,
  selectedProvider: SelectedProviderConfig | undefined
): TestResult | null {
  if (!provider) {
    return { success: false, message: ErrorMessages.CONFIG_NO_PROVIDER, error: "Provider not found" };
  }

  if (!selectedProvider?.variables?.api_key) {
    return { success: false, message: ErrorMessages.CONFIG_NO_API_KEY, error: "Missing API key" };
  }

  return null;
}

/**
 * Parses the curl template and validates required variables.
 * Returns a TestResult error if parsing fails or required variables are missing.
 */
function parseCurlTemplate(
  provider: TYPE_PROVIDER,
  selectedProvider: SelectedProviderConfig
): { curlJson: ParsedCurl; error: null } | { curlJson: null; error: TestResult } {
  let curlJson: ParsedCurl;
  try {
    curlJson = curl2Json(provider.curl) as ParsedCurl;
  } catch (error) {
    return {
      curlJson: null,
      error: {
        success: false,
        message: ErrorMessages.CONFIG_INVALID,
        error: error instanceof Error ? error.message : "Failed to parse curl",
      },
    };
  }

  // Check for required variables (skip SYSTEM_PROMPT, TEXT, IMAGE which are injected at runtime)
  const extractedVariables = extractVariables(provider.curl);
  const requiredVars = extractedVariables.filter(
    ({ key }) => key !== "SYSTEM_PROMPT" && key !== "TEXT" && key !== "IMAGE"
  );

  for (const { key } of requiredVars) {
    if (!selectedProvider.variables?.[key] || selectedProvider.variables[key].trim() === "") {
      return {
        curlJson: null,
        error: {
          success: false,
          message: ErrorMessages.CONFIG_MISSING_REQUIRED(key.replace(/_/g, " ")),
          error: `Missing variable: ${key}`,
        },
      };
    }
  }

  return { curlJson, error: null };
}

/**
 * Handles common HTTP response status codes.
 * Returns a TestResult if the status is handled, null if the caller should continue processing.
 */
async function handleResponseStatus(response: Response): Promise<TestResult | null> {
  // Authentication errors
  if (response.status === 401 || response.status === 403) {
    return {
      success: false,
      message: ErrorMessages.AUTH_INVALID_KEY,
      error: `HTTP ${response.status}`,
    };
  }

  // Rate limited but key is valid
  if (response.status === 429) {
    return {
      success: true,
      message: ErrorMessages.AUTH_RATE_LIMITED,
    };
  }

  return null;
}

/**
 * Handles fetch errors and converts them to TestResult.
 */
function handleFetchError(error: unknown): TestResult {
  const message = error instanceof Error ? error.message : String(error);

  // Check for timeout errors
  if (message.includes("timed out")) {
    return {
      success: false,
      message: ErrorMessages.NETWORK_TIMEOUT,
      error: message,
    };
  }

  // Check for network errors
  if (message.includes("network") || message.includes("fetch")) {
    return {
      success: false,
      message: ErrorMessages.NETWORK_ERROR,
      error: message,
    };
  }

  return {
    success: false,
    message: ErrorMessages.NETWORK_ERROR,
    error: message,
  };
}

/**
 * Builds a variable map from selected provider variables.
 * Converts all keys to uppercase for template replacement.
 */
function buildVariableMap(
  selectedProvider: SelectedProviderConfig,
  additionalVars: Record<string, string> = {}
): Record<string, string> {
  return {
    ...Object.fromEntries(
      Object.entries(selectedProvider.variables).map(([key, value]) => [
        key.toUpperCase(),
        value,
      ])
    ),
    ...additionalVars,
  };
}

/**
 * Fetch wrapper with timeout support.
 * Aborts the request if it takes longer than the specified timeout.
 */
async function fetchWithTimeout(
  fetchFn: typeof fetch,
  url: string,
  options: RequestInit,
  timeoutMs: number = API_TEST_TIMEOUT_MS
): Promise<Response> {
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const response = await fetchFn(url, {
      ...options,
      signal: controller.signal,
    });
    clearTimeout(timeoutId);
    return response;
  } catch (error) {
    clearTimeout(timeoutId);
    // Convert AbortError to a more descriptive timeout error
    if (error instanceof Error && error.name === "AbortError") {
      throw new Error(`Request timed out after ${timeoutMs / 1000} seconds`);
    }
    throw error;
  }
}

/**
 * Tests an AI provider connection by making a minimal completion request.
 * Sends a simple "Say hello" prompt and checks for a valid response.
 */
export async function testAIProvider(
  provider: TYPE_PROVIDER | undefined,
  selectedProvider: SelectedProviderConfig
): Promise<TestResult> {
  try {
    // Validate provider and API key configuration
    const validationError = validateProviderConfig(provider, selectedProvider);
    if (validationError) return validationError;

    // Parse curl template and validate required variables
    const parseResult = parseCurlTemplate(provider!, selectedProvider);
    if (parseResult.error) return parseResult.error;
    const { curlJson } = parseResult;

    // Build request body with minimal test message
    let bodyObj: RequestBody = curlJson.data ? JSON.parse(JSON.stringify(curlJson.data)) : {};
    const messagesKey = Object.keys(bodyObj).find((key) =>
      ["messages", "contents", "conversation", "history"].includes(key)
    );

    if (messagesKey && Array.isArray(bodyObj[messagesKey])) {
      // Replace with a simple test message
      bodyObj[messagesKey] = [
        { role: "user", content: "Say 'OK' and nothing else." },
      ];
    }

    // Build variables for template replacement
    const allVariables = buildVariableMap(selectedProvider, {
      SYSTEM_PROMPT: "You are a test assistant. Respond with only 'OK'.",
    });

    bodyObj = deepVariableReplacer(bodyObj, allVariables) as RequestBody;
    const url = deepVariableReplacer(curlJson.url || "", allVariables) as string;
    const headers = deepVariableReplacer(curlJson.header || {}, allVariables) as Record<string, string>;
    headers["Content-Type"] = "application/json";

    // Disable streaming for test
    if (typeof bodyObj === "object" && bodyObj !== null) {
      const streamKey = Object.keys(bodyObj).find((k) => k.toLowerCase() === "stream");
      if (streamKey) {
        bodyObj[streamKey] = false;
      } else {
        bodyObj.stream = false;
      }
      // Remove stream_options if present
      delete bodyObj.stream_options;
    }

    // Limit response tokens for faster test
    if (typeof bodyObj === "object" && bodyObj !== null) {
      bodyObj.max_tokens = 10;
    }

    const fetchFunction = url?.includes("http") ? fetch : tauriFetch;

    const response = await fetchWithTimeout(fetchFunction, url, {
      method: curlJson.method || "POST",
      headers,
      body: curlJson.method === "GET" ? undefined : JSON.stringify(bodyObj),
    });

    // Handle common response status codes
    const statusResult = await handleResponseStatus(response);
    if (statusResult) return statusResult;

    if (!response.ok) {
      const errorText = await response.text().catch(() => response.statusText);
      return {
        success: false,
        message: ErrorMessages.RESPONSE_API_ERROR(response.status),
        error: errorText,
      };
    }

    // Parse response to verify we got actual content
    let json: unknown;
    try {
      json = await response.json();
    } catch {
      return {
        success: false,
        message: ErrorMessages.RESPONSE_INVALID,
        error: "Failed to parse JSON response",
      };
    }

    const content = getByPath(json, provider?.responseContentPath || "") || "";
    if (content || json) {
      return {
        success: true,
        message: ErrorMessages.SUCCESS_VERIFIED,
      };
    }

    return {
      success: false,
      message: ErrorMessages.RESPONSE_EMPTY,
      error: "No content in response",
    };
  } catch (error) {
    return handleFetchError(error);
  }
}

/**
 * Tests an STT provider connection.
 *
 * For STT, we can't easily test without audio. Instead, we make a request
 * with minimal/empty audio to verify the API key is valid. Most providers
 * will return a specific error for invalid keys vs processing errors.
 */
export async function testSTTProvider(
  provider: TYPE_PROVIDER | undefined,
  selectedProvider: SelectedProviderConfig
): Promise<TestResult> {
  try {
    // Validate provider and API key configuration
    const validationError = validateProviderConfig(provider, selectedProvider);
    if (validationError) return validationError;

    // For AssemblyAI special handler, we can test by making a simple API call
    if (provider!.requiresSpecialHandler && provider!.specialHandler === "assemblyai-diarization") {
      const apiKey = selectedProvider.variables?.API_KEY || selectedProvider.variables?.api_key;
      if (!apiKey) {
        return { success: false, message: ErrorMessages.CONFIG_NO_API_KEY, error: "Missing API key" };
      }

      // Test AssemblyAI by checking the API with a simple request
      try {
        const response = await fetchWithTimeout(
          tauriFetch,
          "https://api.assemblyai.com/v2/transcript",
          {
            method: "GET",
            headers: {
              Authorization: apiKey,
            },
          }
        );

        // 401 = invalid key, 200/other = valid key
        if (response.status === 401) {
          return {
            success: false,
            message: ErrorMessages.AUTH_INVALID_KEY,
            error: "AssemblyAI HTTP 401",
          };
        }

        // Any other response means the key is valid
        return {
          success: true,
          message: ErrorMessages.SUCCESS_VERIFIED,
        };
      } catch (error) {
        return handleFetchError(error);
      }
    }

    // Parse curl template (skip variable validation for STT - only needs API key)
    let curlJson: ParsedCurl;
    try {
      curlJson = curl2Json(provider!.curl) as ParsedCurl;
    } catch (error) {
      return {
        success: false,
        message: ErrorMessages.CONFIG_INVALID,
        error: error instanceof Error ? error.message : "Failed to parse curl",
      };
    }

    // Build variable map for template replacement
    const allVariables = buildVariableMap(selectedProvider, { LANGUAGE: "en" });

    let url = deepVariableReplacer(curlJson.url || "", allVariables) as string;
    const headers = deepVariableReplacer(curlJson.header || {}, allVariables) as Record<string, string>;

    // For OpenAI/Groq Whisper style APIs, we can test with a tiny valid WAV file
    // This is a minimal valid WAV header (44 bytes) with no audio data
    const minimalWavHeader = new Uint8Array([
      0x52, 0x49, 0x46, 0x46, // "RIFF"
      0x24, 0x00, 0x00, 0x00, // File size (36 bytes)
      0x57, 0x41, 0x56, 0x45, // "WAVE"
      0x66, 0x6d, 0x74, 0x20, // "fmt "
      0x10, 0x00, 0x00, 0x00, // Subchunk1 size (16)
      0x01, 0x00, // Audio format (1 = PCM)
      0x01, 0x00, // Num channels (1)
      0x80, 0x3e, 0x00, 0x00, // Sample rate (16000)
      0x00, 0x7d, 0x00, 0x00, // Byte rate
      0x02, 0x00, // Block align
      0x10, 0x00, // Bits per sample (16)
      0x64, 0x61, 0x74, 0x61, // "data"
      0x00, 0x00, 0x00, 0x00, // Data size (0)
    ]);

    const isForm = provider!.curl.includes("-F ") || provider!.curl.includes("--form");
    const isBinaryUpload = provider!.curl.includes("--data-binary");

    let body: FormData | Blob;
    let finalHeaders = { ...headers };

    if (isForm) {
      const form = new FormData();
      const testBlob = new Blob([minimalWavHeader], { type: "audio/wav" });
      form.append("file", testBlob, "test.wav");

      // Add model if required
      if (allVariables.MODEL) {
        form.append("model", allVariables.MODEL);
      }

      delete finalHeaders["Content-Type"];
      body = form;
    } else if (isBinaryUpload) {
      body = new Blob([minimalWavHeader], { type: "audio/wav" });
    } else {
      // For non-form/non-binary APIs (e.g., JSON body with base64 audio),
      // we cannot reliably test without implementing provider-specific logic.
      // Return false to avoid false positives with invalid API keys.
      return {
        success: false,
        message: ErrorMessages.CONFIG_UNSUPPORTED,
        error: "Automatic verification is not supported for this provider's API format. Please verify your API key manually.",
      };
    }

    // Add query params if present
    const rawParams = curlJson.params || {};
    const decodedParams = Object.fromEntries(
      Object.entries(rawParams).map(([key, value]) => [
        key,
        typeof value === "string" ? decodeURIComponent(value) : "",
      ])
    );
    const replacedParams = deepVariableReplacer(decodedParams, allVariables) as Record<string, string>;
    const queryString = new URLSearchParams(replacedParams).toString();
    if (queryString) {
      url += (url.includes("?") ? "&" : "?") + queryString;
    }

    const fetchFunction = url?.includes("http") ? tauriFetch : fetch;

    const response = await fetchWithTimeout(fetchFunction, url, {
      method: curlJson.method || "POST",
      headers: finalHeaders,
      body,
    });

    // Handle common response status codes (401/403/429)
    const statusResult = await handleResponseStatus(response);
    if (statusResult) return statusResult;

    // 400 Bad Request is expected for empty/minimal audio - key is valid
    if (response.status === 400) {
      const errorText = await response.text().catch(() => "");
      // Check if it's an auth error disguised as 400
      if (errorText.toLowerCase().includes("api key") || errorText.toLowerCase().includes("unauthorized")) {
        return {
          success: false,
          message: ErrorMessages.AUTH_INVALID_KEY,
          error: errorText,
        };
      }
      // Otherwise, the key is valid but audio was rejected
      return {
        success: true,
        message: ErrorMessages.SUCCESS_KEY_VERIFIED,
      };
    }

    if (response.ok) {
      return {
        success: true,
        message: ErrorMessages.SUCCESS_VERIFIED,
      };
    }

    // Other errors
    const errorText = await response.text().catch(() => response.statusText);
    return {
      success: false,
      message: ErrorMessages.RESPONSE_API_ERROR(response.status),
      error: errorText,
    };
  } catch (error) {
    return handleFetchError(error);
  }
}
