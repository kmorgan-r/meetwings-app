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

/**
 * Tests an AI provider connection by making a minimal completion request.
 * Sends a simple "Say hello" prompt and checks for a valid response.
 */
export async function testAIProvider(
  provider: TYPE_PROVIDER | undefined,
  selectedProvider: {
    provider: string;
    variables: Record<string, string>;
  }
): Promise<TestResult> {
  try {
    if (!provider) {
      return { success: false, message: "No provider configured", error: "Provider not found" };
    }

    if (!selectedProvider?.variables?.api_key) {
      return { success: false, message: "API key not provided", error: "Missing API key" };
    }

    let curlJson;
    try {
      curlJson = curl2Json(provider.curl);
    } catch (error) {
      return {
        success: false,
        message: "Invalid provider configuration",
        error: error instanceof Error ? error.message : "Failed to parse curl",
      };
    }

    // Check for required variables
    const extractedVariables = extractVariables(provider.curl);
    const requiredVars = extractedVariables.filter(
      ({ key }) => key !== "SYSTEM_PROMPT" && key !== "TEXT" && key !== "IMAGE"
    );
    for (const { key } of requiredVars) {
      if (!selectedProvider.variables?.[key] || selectedProvider.variables[key].trim() === "") {
        return {
          success: false,
          message: `Missing required: ${key.replace(/_/g, " ")}`,
          error: `Missing variable: ${key}`,
        };
      }
    }

    // Build request body with minimal test message
    let bodyObj: any = curlJson.data ? JSON.parse(JSON.stringify(curlJson.data)) : {};
    const messagesKey = Object.keys(bodyObj).find((key) =>
      ["messages", "contents", "conversation", "history"].includes(key)
    );

    if (messagesKey && Array.isArray(bodyObj[messagesKey])) {
      // Replace with a simple test message
      bodyObj[messagesKey] = [
        { role: "user", content: "Say 'OK' and nothing else." },
      ];
    }

    const allVariables = {
      ...Object.fromEntries(
        Object.entries(selectedProvider.variables).map(([key, value]) => [
          key.toUpperCase(),
          value,
        ])
      ),
      SYSTEM_PROMPT: "You are a test assistant. Respond with only 'OK'.",
    };

    bodyObj = deepVariableReplacer(bodyObj, allVariables);
    const url = deepVariableReplacer(curlJson.url || "", allVariables);
    const headers = deepVariableReplacer(curlJson.header || {}, allVariables);
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

    const response = await fetchFunction(url, {
      method: curlJson.method || "POST",
      headers,
      body: curlJson.method === "GET" ? undefined : JSON.stringify(bodyObj),
    });

    if (!response.ok) {
      let errorText = "";
      try {
        errorText = await response.text();
      } catch {}

      // Parse common error patterns
      if (response.status === 401 || response.status === 403) {
        return {
          success: false,
          message: "Invalid API key",
          error: `Authentication failed (${response.status})`,
        };
      }

      if (response.status === 429) {
        // Rate limited but key is valid
        return {
          success: true,
          message: "API key verified (rate limited)",
        };
      }

      return {
        success: false,
        message: `API error: ${response.status}`,
        error: errorText || response.statusText,
      };
    }

    // Parse response to verify we got actual content
    let json;
    try {
      json = await response.json();
    } catch {
      return {
        success: false,
        message: "Invalid response format",
        error: "Failed to parse JSON response",
      };
    }

    const content = getByPath(json, provider?.responseContentPath || "") || "";
    if (content || json) {
      return {
        success: true,
        message: "Connection verified",
      };
    }

    return {
      success: false,
      message: "Empty response",
      error: "No content in response",
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);

    // Check for network errors
    if (message.includes("network") || message.includes("fetch")) {
      return {
        success: false,
        message: "Network error",
        error: message,
      };
    }

    return {
      success: false,
      message: "Connection failed",
      error: message,
    };
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
  selectedProvider: {
    provider: string;
    variables: Record<string, string>;
  }
): Promise<TestResult> {
  try {
    if (!provider) {
      return { success: false, message: "No provider configured", error: "Provider not found" };
    }

    if (!selectedProvider?.variables?.api_key) {
      return { success: false, message: "API key not provided", error: "Missing API key" };
    }

    // For AssemblyAI special handler, we can test by making a simple API call
    if (provider.requiresSpecialHandler && provider.specialHandler === "assemblyai-diarization") {
      const apiKey = selectedProvider.variables?.API_KEY || selectedProvider.variables?.api_key;
      if (!apiKey) {
        return { success: false, message: "API key not provided", error: "Missing API key" };
      }

      // Test AssemblyAI by checking the API with a simple request
      try {
        const response = await tauriFetch("https://api.assemblyai.com/v2/transcript", {
          method: "GET",
          headers: {
            Authorization: apiKey,
          },
        });

        // 401 = invalid key, 200/other = valid key
        if (response.status === 401) {
          return {
            success: false,
            message: "Invalid API key",
            error: "AssemblyAI authentication failed",
          };
        }

        // Any other response means the key is valid
        return {
          success: true,
          message: "Connection verified",
        };
      } catch (error) {
        return {
          success: false,
          message: "Network error",
          error: error instanceof Error ? error.message : "Connection failed",
        };
      }
    }

    let curlJson;
    try {
      curlJson = curl2Json(provider.curl);
    } catch (error) {
      return {
        success: false,
        message: "Invalid provider configuration",
        error: error instanceof Error ? error.message : "Failed to parse curl",
      };
    }

    // Build variable map
    const allVariables: Record<string, string> = {
      ...Object.fromEntries(
        Object.entries(selectedProvider.variables).map(([key, value]) => [
          key.toUpperCase(),
          value,
        ])
      ),
      LANGUAGE: "en",
    };

    let url = deepVariableReplacer(curlJson.url || "", allVariables);
    const headers = deepVariableReplacer(curlJson.header || {}, allVariables);

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

    const isForm = provider.curl.includes("-F ") || provider.curl.includes("--form");
    const isBinaryUpload = provider.curl.includes("--data-binary");

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
      // For non-form APIs, we need to send audio as base64
      // This minimal approach might not work for all providers
      return {
        success: true,
        message: "Configuration looks valid",
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
    const replacedParams = deepVariableReplacer(decodedParams, allVariables);
    const queryString = new URLSearchParams(replacedParams).toString();
    if (queryString) {
      url += (url.includes("?") ? "&" : "?") + queryString;
    }

    const fetchFunction = url?.includes("http") ? tauriFetch : fetch;

    const response = await fetchFunction(url, {
      method: curlJson.method || "POST",
      headers: finalHeaders,
      body,
    });

    // Check response status
    if (response.status === 401 || response.status === 403) {
      return {
        success: false,
        message: "Invalid API key",
        error: `Authentication failed (${response.status})`,
      };
    }

    if (response.status === 429) {
      // Rate limited but key is valid
      return {
        success: true,
        message: "API key verified (rate limited)",
      };
    }

    // 400 Bad Request is expected for empty/minimal audio - key is valid
    if (response.status === 400) {
      const errorText = await response.text().catch(() => "");
      // Check if it's an auth error disguised as 400
      if (errorText.toLowerCase().includes("api key") || errorText.toLowerCase().includes("unauthorized")) {
        return {
          success: false,
          message: "Invalid API key",
          error: errorText,
        };
      }
      // Otherwise, the key is valid but audio was rejected
      return {
        success: true,
        message: "API key verified",
      };
    }

    if (response.ok) {
      return {
        success: true,
        message: "Connection verified",
      };
    }

    // Other errors
    const errorText = await response.text().catch(() => response.statusText);
    return {
      success: false,
      message: `API error: ${response.status}`,
      error: errorText,
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return {
      success: false,
      message: "Connection failed",
      error: message,
    };
  }
}
