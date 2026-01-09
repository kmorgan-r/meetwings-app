/**
 * Integration Tests for API Test Functions
 *
 * Tests the testAIProvider and testSTTProvider functions with actual
 * provider CURL templates to ensure they correctly parse and handle
 * different API formats.
 *
 * These are unit tests that mock the network layer - they test the
 * parsing and processing logic without making actual API calls.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { testAIProvider, testSTTProvider, TestResult } from "@/lib/functions/api-test.function";
import { TYPE_PROVIDER } from "@/types";

// Mock Tauri HTTP plugin
vi.mock("@tauri-apps/plugin-http", () => ({
  fetch: vi.fn(),
}));

// Mock the global fetch
const mockFetch = vi.fn();
global.fetch = mockFetch;

// Import the mocked Tauri fetch
import { fetch as tauriFetch } from "@tauri-apps/plugin-http";
const mockTauriFetch = vi.mocked(tauriFetch);

// Helper to create mock response
function createMockResponse(options: {
  status: number;
  ok?: boolean;
  json?: unknown;
  text?: string;
}): Response {
  return {
    status: options.status,
    ok: options.ok ?? (options.status >= 200 && options.status < 300),
    json: async () => options.json,
    text: async () => options.text || "",
    statusText: options.text || `HTTP ${options.status}`,
  } as Response;
}

describe("testAIProvider", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(() => {
    vi.resetAllMocks();
  });

  describe("OpenAI provider format", () => {
    const openaiProvider: TYPE_PROVIDER = {
      id: "openai",
      name: "OpenAI",
      curl: `curl https://api.openai.com/v1/chat/completions \\
        -H "Content-Type: application/json" \\
        -H "Authorization: Bearer {{API_KEY}}" \\
        -d '{
          "model": "{{MODEL}}",
          "messages": [{"role": "system", "content": "{{SYSTEM_PROMPT}}"}, {"role": "user", "content": "{{TEXT}}"}]
        }'`,
      responseContentPath: "choices[0].message.content",
      isStreaming: true,
    };

    const selectedProvider = {
      provider: "openai",
      variables: {
        api_key: "sk-test-key-12345",
        model: "gpt-4o",
      },
    };

    it("should return success when API responds with valid content", async () => {
      mockFetch.mockResolvedValueOnce(
        createMockResponse({
          status: 200,
          json: {
            choices: [{ message: { content: "OK" } }],
          },
        })
      );

      const result = await testAIProvider(openaiProvider, selectedProvider);

      expect(result.success).toBe(true);
      expect(result.message).toBe("Connection verified");
    });

    it("should return auth error for 401 status", async () => {
      mockFetch.mockResolvedValueOnce(
        createMockResponse({
          status: 401,
          ok: false,
          text: "Unauthorized",
        })
      );

      const result = await testAIProvider(openaiProvider, selectedProvider);

      expect(result.success).toBe(false);
      expect(result.message).toBe("Authentication failed: Invalid API key");
    });

    it("should return success for 429 rate limit (key is valid)", async () => {
      mockFetch.mockResolvedValueOnce(
        createMockResponse({
          status: 429,
          ok: false,
          text: "Rate limited",
        })
      );

      const result = await testAIProvider(openaiProvider, selectedProvider);

      expect(result.success).toBe(true);
      expect(result.message).toBe("Authentication verified (rate limited)");
    });

    it("should fail when no API key provided", async () => {
      const result = await testAIProvider(openaiProvider, {
        provider: "openai",
        variables: { model: "gpt-4o" },
      });

      expect(result.success).toBe(false);
      expect(result.message).toBe("Configuration error: API key not provided");
    });
  });

  describe("Claude provider format", () => {
    const claudeProvider: TYPE_PROVIDER = {
      id: "claude",
      name: "Claude",
      curl: `curl https://api.anthropic.com/v1/messages \\
        -H "x-api-key: {{API_KEY}}" \\
        -H "anthropic-version: 2023-06-01" \\
        -H "content-type: application/json" \\
        -d '{
          "model": "{{MODEL}}",
          "system": "{{SYSTEM_PROMPT}}",
          "messages": [{"role": "user", "content": "{{TEXT}}"}],
          "max_tokens": 1024
        }'`,
      responseContentPath: "content[0].text",
      isStreaming: true,
    };

    const selectedProvider = {
      provider: "claude",
      variables: {
        api_key: "sk-ant-test-key",
        model: "claude-3-5-sonnet-20241022",
      },
    };

    it("should parse Claude response format correctly", async () => {
      mockFetch.mockResolvedValueOnce(
        createMockResponse({
          status: 200,
          json: {
            content: [{ text: "OK" }],
          },
        })
      );

      const result = await testAIProvider(claudeProvider, selectedProvider);

      expect(result.success).toBe(true);
    });

    it("should handle 403 forbidden as auth error", async () => {
      mockFetch.mockResolvedValueOnce(
        createMockResponse({
          status: 403,
          ok: false,
          text: "Forbidden",
        })
      );

      const result = await testAIProvider(claudeProvider, selectedProvider);

      expect(result.success).toBe(false);
      expect(result.message).toBe("Authentication failed: Invalid API key");
    });
  });

  describe("Gemini provider format", () => {
    const geminiProvider: TYPE_PROVIDER = {
      id: "gemini",
      name: "Gemini",
      curl: `curl "https://generativelanguage.googleapis.com/v1beta/openai/chat/completions" \\
        -H "Authorization: Bearer {{API_KEY}}" \\
        -H "Content-Type: application/json" \\
        -d '{
          "model": "{{MODEL}}",
          "messages": [{"role": "user", "content": "{{TEXT}}"}]
        }'`,
      responseContentPath: "choices[0].message.content",
      isStreaming: true,
    };

    const selectedProvider = {
      provider: "gemini",
      variables: {
        api_key: "AIza-test-key",
        model: "gemini-2.0-flash",
      },
    };

    it("should handle Gemini API format", async () => {
      mockFetch.mockResolvedValueOnce(
        createMockResponse({
          status: 200,
          json: {
            choices: [{ message: { content: "OK" } }],
          },
        })
      );

      const result = await testAIProvider(geminiProvider, selectedProvider);

      expect(result.success).toBe(true);
    });
  });

  describe("Error handling", () => {
    const provider: TYPE_PROVIDER = {
      id: "test",
      name: "Test",
      curl: `curl https://api.test.com/v1/test \\
        -H "Authorization: Bearer {{API_KEY}}" \\
        -d '{"model": "{{MODEL}}"}'`,
      responseContentPath: "content",
      isStreaming: false,
    };

    const selectedProvider = {
      provider: "test",
      variables: {
        api_key: "test-key",
        model: "test-model",
      },
    };

    it("should return error when no provider configured", async () => {
      const result = await testAIProvider(undefined, selectedProvider);

      expect(result.success).toBe(false);
      expect(result.message).toBe("Configuration error: No provider configured");
    });

    it("should handle invalid JSON response", async () => {
      mockFetch.mockResolvedValueOnce({
        status: 200,
        ok: true,
        json: async () => {
          throw new Error("Invalid JSON");
        },
        text: async () => "Not JSON",
      } as Response);

      const result = await testAIProvider(provider, selectedProvider);

      expect(result.success).toBe(false);
      expect(result.message).toBe("Response error: Invalid response format");
    });

    it("should handle network errors", async () => {
      mockFetch.mockRejectedValueOnce(new Error("Network error: fetch failed"));

      const result = await testAIProvider(provider, selectedProvider);

      expect(result.success).toBe(false);
      expect(result.message).toBe("Network error: Connection failed");
    });

    it("should handle timeout errors", async () => {
      const abortError = new Error("Request timed out after 10 seconds");
      abortError.name = "AbortError";
      mockFetch.mockRejectedValueOnce(abortError);

      const result = await testAIProvider(provider, selectedProvider);

      expect(result.success).toBe(false);
      expect(result.message).toBe("Network error: Connection timed out");
    });

    it("should handle 500 server errors", async () => {
      mockFetch.mockResolvedValueOnce(
        createMockResponse({
          status: 500,
          ok: false,
          text: "Internal Server Error",
        })
      );

      const result = await testAIProvider(provider, selectedProvider);

      expect(result.success).toBe(false);
      expect(result.message).toBe("Response error: API returned 500");
    });
  });
});

describe("testSTTProvider", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(() => {
    vi.resetAllMocks();
  });

  describe("OpenAI Whisper format (form data)", () => {
    const whisperProvider: TYPE_PROVIDER = {
      id: "openai-whisper",
      name: "OpenAI Whisper",
      curl: `curl -X POST "https://api.openai.com/v1/audio/transcriptions" \\
        -H "Authorization: Bearer {{API_KEY}}" \\
        -F "file={{AUDIO}}" \\
        -F "model={{MODEL}}" \\
        -F "language={{LANGUAGE}}"`,
      responseContentPath: "text",
      isStreaming: false,
    };

    const selectedProvider = {
      provider: "openai-whisper",
      variables: {
        api_key: "sk-test-key",
        model: "whisper-1",
      },
    };

    it("should verify API key with minimal WAV file", async () => {
      mockTauriFetch.mockResolvedValueOnce(
        createMockResponse({
          status: 400,
          ok: false,
          text: "Audio too short",
        })
      );

      const result = await testSTTProvider(whisperProvider, selectedProvider);

      // 400 with non-auth error means key is valid
      expect(result.success).toBe(true);
      expect(result.message).toBe("API key verified");
    });

    it("should detect invalid API key from 401", async () => {
      mockTauriFetch.mockResolvedValueOnce(
        createMockResponse({
          status: 401,
          ok: false,
          text: "Unauthorized",
        })
      );

      const result = await testSTTProvider(whisperProvider, selectedProvider);

      expect(result.success).toBe(false);
      expect(result.message).toBe("Authentication failed: Invalid API key");
    });

    it("should detect auth error disguised as 400", async () => {
      mockTauriFetch.mockResolvedValueOnce(
        createMockResponse({
          status: 400,
          ok: false,
          text: "Invalid API key provided",
        })
      );

      const result = await testSTTProvider(whisperProvider, selectedProvider);

      expect(result.success).toBe(false);
      expect(result.message).toBe("Authentication failed: Invalid API key");
    });
  });

  describe("Groq Whisper format", () => {
    const groqProvider: TYPE_PROVIDER = {
      id: "groq",
      name: "Groq Whisper",
      curl: `curl -X POST https://api.groq.com/openai/v1/audio/transcriptions \\
        -H "Authorization: bearer {{API_KEY}}" \\
        -F "file={{AUDIO}}" \\
        -F model={{MODEL}}`,
      responseContentPath: "text",
      isStreaming: false,
    };

    const selectedProvider = {
      provider: "groq",
      variables: {
        api_key: "gsk_test_key",
        model: "whisper-large-v3",
      },
    };

    it("should handle Groq API format", async () => {
      mockTauriFetch.mockResolvedValueOnce(
        createMockResponse({
          status: 200,
          json: { text: "Test transcription" },
        })
      );

      const result = await testSTTProvider(groqProvider, selectedProvider);

      expect(result.success).toBe(true);
    });
  });

  describe("Deepgram format (binary upload)", () => {
    const deepgramProvider: TYPE_PROVIDER = {
      id: "deepgram-stt",
      name: "Deepgram Speech-to-Text",
      curl: `curl -X POST "https://api.deepgram.com/v1/listen?model={{MODEL}}&language={{LANGUAGE}}" \\
        -H "Authorization: TOKEN {{API_KEY}}" \\
        -H "Content-Type: audio/wav" \\
        --data-binary {{AUDIO}}`,
      responseContentPath: "results.channels[0].alternatives[0].transcript",
      isStreaming: false,
    };

    const selectedProvider = {
      provider: "deepgram-stt",
      variables: {
        api_key: "dg_test_key",
        model: "nova-2",
      },
    };

    it("should handle binary upload format", async () => {
      mockTauriFetch.mockResolvedValueOnce(
        createMockResponse({
          status: 200,
          json: {
            results: {
              channels: [{ alternatives: [{ transcript: "Test" }] }],
            },
          },
        })
      );

      const result = await testSTTProvider(deepgramProvider, selectedProvider);

      expect(result.success).toBe(true);
    });
  });

  describe("AssemblyAI special handler", () => {
    const assemblyaiProvider: TYPE_PROVIDER = {
      id: "assemblyai-diarization",
      name: "AssemblyAI (with Speaker Diarization)",
      curl: `curl -X POST "https://api.assemblyai.com/v2/upload" \\
        -H "Authorization: {{API_KEY}}" \\
        --data-binary {{AUDIO}}`,
      responseContentPath: "upload_url",
      isStreaming: false,
      requiresSpecialHandler: true,
      specialHandler: "assemblyai-diarization",
    };

    const selectedProvider = {
      provider: "assemblyai-diarization",
      variables: {
        api_key: "assembly_test_key",
      },
    };

    it("should use special handler for AssemblyAI", async () => {
      mockTauriFetch.mockResolvedValueOnce(
        createMockResponse({
          status: 200,
          json: { id: "transcript-id" },
        })
      );

      const result = await testSTTProvider(assemblyaiProvider, selectedProvider);

      expect(result.success).toBe(true);
      // Verify it used the special /v2/transcript endpoint
      expect(mockTauriFetch).toHaveBeenCalledWith(
        "https://api.assemblyai.com/v2/transcript",
        expect.objectContaining({
          method: "GET",
          headers: { Authorization: "assembly_test_key" },
        })
      );
    });

    it("should detect invalid AssemblyAI key", async () => {
      mockTauriFetch.mockResolvedValueOnce(
        createMockResponse({
          status: 401,
          ok: false,
          text: "Unauthorized",
        })
      );

      const result = await testSTTProvider(assemblyaiProvider, selectedProvider);

      expect(result.success).toBe(false);
      expect(result.message).toBe("Authentication failed: Invalid API key");
    });
  });

  describe("JSON body format (unsupported)", () => {
    const googleProvider: TYPE_PROVIDER = {
      id: "google-stt",
      name: "Google Speech-to-Text",
      curl: `curl -X POST "https://speech.googleapis.com/v1/speech:recognize" \\
        -H "Authorization: Bearer {{API_KEY}}" \\
        -H "Content-Type: application/json" \\
        -d '{
          "config": { "encoding": "LINEAR16", "sampleRateHertz": 16000 },
          "audio": { "content": "{{AUDIO}}" }
        }'`,
      responseContentPath: "results[0].alternatives[0].transcript",
      isStreaming: false,
    };

    const selectedProvider = {
      provider: "google-stt",
      variables: {
        api_key: "google_test_key",
      },
    };

    it("should return unsupported for JSON body APIs", async () => {
      const result = await testSTTProvider(googleProvider, selectedProvider);

      expect(result.success).toBe(false);
      expect(result.message).toBe("Configuration error: API format not supported for verification");
      expect(result.error).toContain("Automatic verification is not supported");
    });
  });

  describe("Error handling", () => {
    const provider: TYPE_PROVIDER = {
      id: "test-stt",
      name: "Test STT",
      curl: `curl -X POST "https://api.test.com/stt" \\
        -H "Authorization: Bearer {{API_KEY}}" \\
        -F "file={{AUDIO}}"`,
      responseContentPath: "text",
      isStreaming: false,
    };

    const selectedProvider = {
      provider: "test-stt",
      variables: {
        api_key: "test-key",
      },
    };

    it("should fail when no provider configured", async () => {
      const result = await testSTTProvider(undefined, selectedProvider);

      expect(result.success).toBe(false);
      expect(result.message).toBe("Configuration error: No provider configured");
    });

    it("should fail when no API key provided", async () => {
      const result = await testSTTProvider(provider, {
        provider: "test-stt",
        variables: {},
      });

      expect(result.success).toBe(false);
      expect(result.message).toBe("Configuration error: API key not provided");
    });
  });
});

describe("Variable replacement", () => {
  const provider: TYPE_PROVIDER = {
    id: "test",
    name: "Test",
    curl: `curl "https://api.test.com/{{REGION}}/v1" \\
      -H "Authorization: Bearer {{API_KEY}}" \\
      -H "X-Custom: {{CUSTOM_HEADER}}" \\
      -d '{"model": "{{MODEL}}"}'`,
    responseContentPath: "content",
    isStreaming: false,
  };

  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("should fail when required variables are missing", async () => {
    const result = await testAIProvider(provider, {
      provider: "test",
      variables: {
        api_key: "test-key",
        model: "test-model",
        // Missing REGION and CUSTOM_HEADER
      },
    });

    expect(result.success).toBe(false);
    expect(result.message).toContain("Configuration error: Missing");
  });

  it("should succeed when all variables are provided", async () => {
    mockFetch.mockResolvedValueOnce(
      createMockResponse({
        status: 200,
        json: { content: "OK" },
      })
    );

    const result = await testAIProvider(provider, {
      provider: "test",
      variables: {
        api_key: "test-key",
        model: "test-model",
        region: "us-east-1",
        custom_header: "custom-value",
      },
    });

    expect(result.success).toBe(true);
  });
});
