import { useState, useCallback, useEffect, useMemo } from "react";
import { Checkbox } from "@/components/ui/checkbox";
import { Loader2, CheckCircle2, XCircle, AlertCircle, ExternalLink } from "lucide-react";
import { cn } from "@/lib/utils";
import { TYPE_PROVIDER } from "@/types";
import { testAIProvider, testSTTProvider, TestResult } from "@/lib/functions";
import {
  setAIVerificationStatus,
  setSTTVerificationStatus,
  isAIVerificationValid,
  isSTTVerificationValid,
  clearAIVerificationStatus,
  clearSTTVerificationStatus,
} from "@/lib/storage";

/**
 * Error categorization for user-friendly messages
 */
interface ErrorInfo {
  /** User-friendly error title */
  title: string;
  /** Detailed explanation */
  description: string;
  /** Actionable next steps */
  actions: string[];
  /** Optional Learn More link */
  learnMoreUrl?: string;
}

/**
 * Provider documentation URLs for common providers
 */
const PROVIDER_DOCS: Record<string, { ai?: string; stt?: string }> = {
  openai: {
    ai: "https://platform.openai.com/docs/api-reference/authentication",
    stt: "https://platform.openai.com/docs/api-reference/audio/createTranscription",
  },
  claude: {
    ai: "https://docs.anthropic.com/en/api/getting-started",
  },
  groq: {
    ai: "https://console.groq.com/docs/quickstart",
    stt: "https://console.groq.com/docs/speech-text",
  },
  gemini: {
    ai: "https://ai.google.dev/gemini-api/docs/api-key",
  },
  "deepgram-stt": {
    stt: "https://developers.deepgram.com/docs/authenticating",
  },
  "assemblyai-diarization": {
    stt: "https://www.assemblyai.com/docs/getting-started",
  },
};

/**
 * Categorize error message and provide actionable guidance
 */
function categorizeError(
  errorMessage: string | null,
  providerId: string,
  type: "ai" | "stt"
): ErrorInfo {
  const providerDocs = PROVIDER_DOCS[providerId]?.[type];

  // Default error
  const defaultError: ErrorInfo = {
    title: "Verification failed",
    description: errorMessage || "Could not verify the API connection",
    actions: ["Double-check your API key", "Ensure your account is active"],
    learnMoreUrl: providerDocs,
  };

  if (!errorMessage) return defaultError;

  const lowerError = errorMessage.toLowerCase();

  // Authentication errors
  if (lowerError.includes("invalid api key") ||
      lowerError.includes("authentication") ||
      lowerError.includes("401") ||
      lowerError.includes("403") ||
      lowerError.includes("unauthorized")) {
    return {
      title: "Invalid API key",
      description: "The API key you entered was rejected by the provider.",
      actions: [
        "Verify the API key is copied correctly (no extra spaces)",
        "Check that the key hasn't expired or been revoked",
        "Ensure the key has the necessary permissions",
      ],
      learnMoreUrl: providerDocs,
    };
  }

  // Rate limiting
  if (lowerError.includes("rate limit") || lowerError.includes("429")) {
    return {
      title: "Rate limited",
      description: "Too many requests. Your API key is valid but you've hit usage limits.",
      actions: [
        "Wait a few minutes before trying again",
        "Check your usage quota in the provider dashboard",
      ],
      learnMoreUrl: providerDocs,
    };
  }

  // Network errors
  if (lowerError.includes("network") ||
      lowerError.includes("timeout") ||
      lowerError.includes("connection") ||
      lowerError.includes("fetch failed")) {
    return {
      title: "Connection failed",
      description: "Could not reach the API server.",
      actions: [
        "Check your internet connection",
        "Try again in a few moments",
        "Verify the provider's service status",
      ],
      learnMoreUrl: undefined, // No provider-specific docs needed for network issues
    };
  }

  // Configuration errors
  if (lowerError.includes("configuration") ||
      lowerError.includes("missing") ||
      lowerError.includes("required")) {
    return {
      title: "Configuration incomplete",
      description: "Some required settings are missing.",
      actions: [
        "Fill in all required fields above",
        "Ensure the model name is correct",
      ],
      learnMoreUrl: providerDocs,
    };
  }

  // Unsupported format
  if (lowerError.includes("not supported") || lowerError.includes("unsupported")) {
    return {
      title: "Verification not available",
      description: "Automatic verification isn't supported for this provider format.",
      actions: [
        "You can still use this provider",
        "Test manually by sending a message",
      ],
      learnMoreUrl: providerDocs,
    };
  }

  // Response/parsing errors
  if (lowerError.includes("response") ||
      lowerError.includes("invalid") ||
      lowerError.includes("parse") ||
      lowerError.includes("json")) {
    return {
      title: "Unexpected response",
      description: "The API responded but in an unexpected format.",
      actions: [
        "Verify the model name is correct",
        "Check if the provider API has changed",
        "Try a different model",
      ],
      learnMoreUrl: providerDocs,
    };
  }

  return defaultError;
}

interface ProviderVerificationProps {
  /** The type of provider being verified */
  type: "ai" | "stt";
  /** The provider configuration */
  provider: TYPE_PROVIDER | undefined;
  /** The selected provider with variables */
  selectedProvider: {
    provider: string;
    variables: Record<string, string>;
  };
  /** Whether the provider has the required configuration (API key etc) */
  isConfigured: boolean;
  /** Callback when verification status changes */
  onVerificationChange?: (verified: boolean) => void;
}

type VerificationState = "idle" | "testing" | "verified" | "failed";

export const ProviderVerification = ({
  type,
  provider,
  selectedProvider,
  isConfigured,
  onVerificationChange,
}: ProviderVerificationProps) => {
  const [state, setState] = useState<VerificationState>("idle");
  const [errorMessage, setErrorMessage] = useState<string | null>(null);

  const apiKey = selectedProvider?.variables?.api_key || "";
  const model = selectedProvider?.variables?.model || "";
  const providerId = selectedProvider?.provider || "";

  // Check if already verified on mount or when config changes
  useEffect(() => {
    if (!isConfigured) {
      setState("idle");
      setErrorMessage(null);
      return;
    }

    const checkVerification = async () => {
      try {
        const isValid = type === "ai"
          ? await isAIVerificationValid(providerId, model, apiKey)
          : await isSTTVerificationValid(providerId, model, apiKey);

        if (isValid) {
          setState("verified");
          onVerificationChange?.(true);
        } else {
          setState("idle");
          onVerificationChange?.(false);
        }
      } catch (error) {
        console.error("[ProviderVerification] Error checking verification status:", error);
        setState("idle");
        onVerificationChange?.(false);
      }
    };

    checkVerification();
  }, [providerId, model, apiKey, isConfigured, type, onVerificationChange]);

  const handleVerify = useCallback(async () => {
    if (!isConfigured || state === "testing") return;

    setState("testing");
    setErrorMessage(null);

    let result: TestResult;
    try {
      if (type === "ai") {
        result = await testAIProvider(provider, selectedProvider);
      } else {
        result = await testSTTProvider(provider, selectedProvider);
      }
    } catch (error) {
      result = {
        success: false,
        message: "Test failed",
        error: error instanceof Error ? error.message : "Unknown error",
      };
    }

    if (result.success) {
      setState("verified");
      setErrorMessage(null);
      try {
        if (type === "ai") {
          await setAIVerificationStatus(providerId, model, apiKey, true);
        } else {
          await setSTTVerificationStatus(providerId, model, apiKey, true);
        }
        // Notify after successful storage to avoid stale reads
        window.dispatchEvent(new CustomEvent("verification-status-changed"));
      } catch (error) {
        console.error("[ProviderVerification] Error saving verification status:", error);
        // Still notify on error - UI state changed even if save failed
        window.dispatchEvent(new CustomEvent("verification-status-changed"));
      }
      onVerificationChange?.(true);
    } else {
      setState("failed");
      setErrorMessage(result.error || result.message);
      try {
        if (type === "ai") {
          await setAIVerificationStatus(providerId, model, apiKey, false, result.error);
        } else {
          await setSTTVerificationStatus(providerId, model, apiKey, false, result.error);
        }
        // Notify after successful storage to avoid stale reads
        window.dispatchEvent(new CustomEvent("verification-status-changed"));
      } catch (error) {
        console.error("[ProviderVerification] Error saving verification status:", error);
        // Still notify on error - UI state changed even if save failed
        window.dispatchEvent(new CustomEvent("verification-status-changed"));
      }
      onVerificationChange?.(false);
    }
  }, [isConfigured, state, type, provider, selectedProvider, providerId, model, apiKey, onVerificationChange]);

  const handleCheckboxChange = useCallback(async (checked: boolean | "indeterminate") => {
    if (checked === true) {
      handleVerify();
    } else {
      // Clear verification when unchecked
      setState("idle");
      setErrorMessage(null);
      try {
        if (type === "ai") {
          await clearAIVerificationStatus();
        } else {
          await clearSTTVerificationStatus();
        }
        // Notify after successful storage to avoid stale reads
        window.dispatchEvent(new CustomEvent("verification-status-changed"));
      } catch (error) {
        console.error("[ProviderVerification] Error clearing verification status:", error);
        // Still notify on error - UI state changed even if clear failed
        window.dispatchEvent(new CustomEvent("verification-status-changed"));
      }
      onVerificationChange?.(false);
    }
  }, [handleVerify, type, onVerificationChange]);

  const isChecked = state === "verified";
  const isDisabled = !isConfigured || state === "testing";

  // Categorize error for better user guidance
  const errorInfo = useMemo(
    () => state === "failed" ? categorizeError(errorMessage, providerId, type) : null,
    [state, errorMessage, providerId, type]
  );

  // Handle opening external links safely
  const handleLearnMore = useCallback((url: string) => {
    // Use Tauri's shell open for security
    window.open(url, "_blank", "noopener,noreferrer");
  }, []);

  return (
    <div className="mt-4 p-3 rounded-lg border border-border bg-muted/30">
      <div className="flex items-start gap-3">
        {/* Checkbox or Loading Indicator */}
        <div className="flex items-center justify-center h-5 w-5 mt-0.5">
          {state === "testing" ? (
            <Loader2 className="h-4 w-4 animate-spin text-primary" />
          ) : (
            <Checkbox
              checked={isChecked}
              onCheckedChange={handleCheckboxChange}
              disabled={isDisabled}
              className={cn(
                state === "verified" && "border-green-500 bg-green-500 data-[state=checked]:bg-green-500",
                state === "failed" && "border-red-500"
              )}
            />
          )}
        </div>

        {/* Label and Status */}
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2">
            <span className={cn(
              "text-sm font-medium",
              !isConfigured && "text-muted-foreground"
            )}>
              {state === "testing"
                ? `Testing ${type === "ai" ? "AI" : "Speech-to-Text"} connection...`
                : `Verify ${type === "ai" ? "AI" : "Speech-to-Text"} connection`
              }
            </span>
            {state === "verified" && (
              <CheckCircle2 className="h-4 w-4 text-green-500" />
            )}
            {state === "failed" && (
              <XCircle className="h-4 w-4 text-red-500" />
            )}
          </div>

          {/* Description or Error */}
          {state === "failed" && errorInfo ? (
            <div className="mt-1.5">
              <p className="text-xs font-medium text-red-500">
                {errorInfo.title}
              </p>
              <p className="text-xs text-red-400 mt-0.5">
                {errorInfo.description}
              </p>

              {/* Actionable next steps */}
              {errorInfo.actions.length > 0 && (
                <ul className="text-xs text-muted-foreground mt-1.5 space-y-0.5 list-disc list-inside">
                  {errorInfo.actions.map((action, index) => (
                    <li key={index}>{action}</li>
                  ))}
                </ul>
              )}

              {/* Action buttons */}
              <div className="flex items-center gap-3 mt-2">
                <button
                  onClick={() => handleVerify()}
                  className="text-xs text-primary hover:underline"
                >
                  Try again
                </button>
                {errorInfo.learnMoreUrl && (
                  <button
                    onClick={() => handleLearnMore(errorInfo.learnMoreUrl!)}
                    className="text-xs text-muted-foreground hover:text-foreground inline-flex items-center gap-1"
                  >
                    Learn more
                    <ExternalLink className="h-3 w-3" />
                  </button>
                )}
              </div>
            </div>
          ) : (
            <p className={cn(
              "text-xs mt-0.5",
              "text-muted-foreground"
            )}>
              {!isConfigured ? (
                "Configure the provider above first"
              ) : state === "verified" ? (
                "Connection verified successfully"
              ) : state === "testing" ? (
                "Please wait while we test the connection..."
              ) : (
                "Check this box to verify your API key works"
              )}
            </p>
          )}
        </div>

        {/* Warning icon if not configured */}
        {!isConfigured && (
          <AlertCircle className="h-4 w-4 text-muted-foreground flex-shrink-0" />
        )}
      </div>
    </div>
  );
};

export default ProviderVerification;
