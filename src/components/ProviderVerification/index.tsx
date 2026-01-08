import { useState, useCallback, useEffect } from "react";
import { Checkbox } from "@/components/ui/checkbox";
import { Loader2, CheckCircle2, XCircle, AlertCircle } from "lucide-react";
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
      if (type === "ai") {
        await setAIVerificationStatus(providerId, model, apiKey, true);
      } else {
        await setSTTVerificationStatus(providerId, model, apiKey, true);
      }
      // Notify other components that verification status changed
      window.dispatchEvent(new CustomEvent("verification-status-changed"));
      onVerificationChange?.(true);
    } else {
      setState("failed");
      setErrorMessage(result.error || result.message);
      if (type === "ai") {
        await setAIVerificationStatus(providerId, model, apiKey, false, result.error);
      } else {
        await setSTTVerificationStatus(providerId, model, apiKey, false, result.error);
      }
      // Notify other components that verification status changed
      window.dispatchEvent(new CustomEvent("verification-status-changed"));
      onVerificationChange?.(false);
    }
  }, [isConfigured, state, type, provider, selectedProvider, providerId, model, apiKey, onVerificationChange]);

  const handleCheckboxChange = useCallback((checked: boolean | "indeterminate") => {
    if (checked === true) {
      handleVerify();
    } else {
      // Clear verification when unchecked
      setState("idle");
      setErrorMessage(null);
      if (type === "ai") {
        clearAIVerificationStatus();
      } else {
        clearSTTVerificationStatus();
      }
      // Notify other components that verification status changed
      window.dispatchEvent(new CustomEvent("verification-status-changed"));
      onVerificationChange?.(false);
    }
  }, [handleVerify, type, onVerificationChange]);

  const isChecked = state === "verified";
  const isDisabled = !isConfigured || state === "testing";

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
          <p className={cn(
            "text-xs mt-0.5",
            state === "failed" ? "text-red-500" : "text-muted-foreground"
          )}>
            {!isConfigured ? (
              "Configure the provider above first"
            ) : state === "verified" ? (
              "Connection verified successfully"
            ) : state === "failed" ? (
              errorMessage || "Verification failed. Please check your API key."
            ) : state === "testing" ? (
              "Please wait while we test the connection..."
            ) : (
              "Check this box to verify your API key works"
            )}
          </p>

          {/* Retry button for failed state */}
          {state === "failed" && (
            <button
              onClick={() => handleVerify()}
              className="text-xs text-primary hover:underline mt-1"
            >
              Try again
            </button>
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
