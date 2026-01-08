import { useApp } from "@/contexts";
import { useState, useEffect, useCallback } from "react";
import { TYPE_PROVIDER } from "@/types";
import {
  isAIVerificationValid,
  isSTTVerificationValid,
  getAIVerificationStatus,
  getSTTVerificationStatus,
} from "@/lib/storage";

interface SetupStatus {
  /** Whether the minimum required setup is complete (AI + STT configured AND verified) */
  isComplete: boolean;
  /** Whether an AI provider is selected and has an API key */
  aiConfigured: boolean;
  /** Whether an STT provider is selected and has an API key */
  sttConfigured: boolean;
  /** Whether the AI provider API key has been verified */
  aiVerified: boolean;
  /** Whether the STT provider API key has been verified */
  sttVerified: boolean;
  /** Completion percentage (0, 25, 50, 75, or 100) */
  completionPercent: number;
  /** Details about AI configuration */
  aiDetails: {
    providerSelected: boolean;
    hasApiKey: boolean;
    providerName: string | null;
    modelName: string | null;
  };
  /** Details about STT configuration */
  sttDetails: {
    providerSelected: boolean;
    hasApiKey: boolean;
    providerName: string | null;
    modelName: string | null;
  };
}

/**
 * Hook to check if the required API setup is complete.
 * Used to determine if the app should redirect to setup or show warnings.
 */
export function useSetupStatus(): SetupStatus {
  const {
    selectedAIProvider,
    selectedSttProvider,
    allAiProviders,
    allSttProviders,
  } = useApp();

  // Optimistic initialization from stored verification data
  // This prevents flash of "Setup Required" while async hash check runs
  const getInitialAIVerified = () => {
    const stored = getAIVerificationStatus();
    if (!stored?.isVerified) return false;
    // Check if provider/model match (can't verify hash synchronously)
    return stored.provider === selectedAIProvider?.provider &&
           stored.model === (selectedAIProvider?.variables?.model || "");
  };

  const getInitialSTTVerified = () => {
    const stored = getSTTVerificationStatus();
    if (!stored?.isVerified) return false;
    // Check if provider/model match (can't verify hash synchronously)
    return stored.provider === selectedSttProvider?.provider &&
           stored.model === (selectedSttProvider?.variables?.model || "");
  };

  // State for async verification results (optimistically initialized)
  const [aiVerified, setAiVerified] = useState(getInitialAIVerified);
  const [sttVerified, setSttVerified] = useState(getInitialSTTVerified);

  // This state forces a re-render when verification status changes
  const [verificationTrigger, setVerificationTrigger] = useState(0);

  // Listen for verification status changes
  useEffect(() => {
    const handleVerificationChange = () => {
      setVerificationTrigger((prev) => prev + 1);
    };

    window.addEventListener("verification-status-changed", handleVerificationChange);
    return () => {
      window.removeEventListener("verification-status-changed", handleVerificationChange);
    };
  }, []);

  // Compute configuration status (sync)
  const aiProviderSelected = Boolean(selectedAIProvider?.provider);
  const aiApiKey = selectedAIProvider?.variables?.api_key || "";
  const aiHasApiKey = aiApiKey.trim().length > 0;
  const aiConfigured = aiProviderSelected && aiHasApiKey;

  const sttProviderSelected = Boolean(selectedSttProvider?.provider);
  const sttApiKey = selectedSttProvider?.variables?.api_key || "";
  const sttHasApiKey = sttApiKey.trim().length > 0;
  const sttConfigured = sttProviderSelected && sttHasApiKey;

  // Get provider display names
  const aiProvider = allAiProviders?.find(
    (p: TYPE_PROVIDER) => p.id === selectedAIProvider?.provider
  );
  const aiProviderName = aiProvider?.isCustom
    ? "Custom Provider"
    : aiProvider?.name || selectedAIProvider?.provider || null;
  const aiModelName = selectedAIProvider?.variables?.model || null;

  const sttProvider = allSttProviders?.find(
    (p: TYPE_PROVIDER) => p.id === selectedSttProvider?.provider
  );
  const sttProviderName = sttProvider?.isCustom
    ? "Custom Provider"
    : sttProvider?.name || selectedSttProvider?.provider || null;
  const sttModelName = selectedSttProvider?.variables?.model || null;

  // Check verification status asynchronously
  const checkVerificationStatus = useCallback(async () => {
    if (aiConfigured) {
      const valid = await isAIVerificationValid(
        selectedAIProvider?.provider || "",
        selectedAIProvider?.variables?.model || "",
        aiApiKey
      );
      setAiVerified(valid);
    } else {
      setAiVerified(false);
    }

    if (sttConfigured) {
      const valid = await isSTTVerificationValid(
        selectedSttProvider?.provider || "",
        selectedSttProvider?.variables?.model || "",
        sttApiKey
      );
      setSttVerified(valid);
    } else {
      setSttVerified(false);
    }
  }, [
    aiConfigured,
    sttConfigured,
    selectedAIProvider?.provider,
    selectedAIProvider?.variables?.model,
    aiApiKey,
    selectedSttProvider?.provider,
    selectedSttProvider?.variables?.model,
    sttApiKey,
  ]);

  // Run verification check when dependencies change
  useEffect(() => {
    checkVerificationStatus();
  }, [checkVerificationStatus, verificationTrigger]);

  // Calculate completion (4 steps: AI configured, AI verified, STT configured, STT verified)
  let completedSteps = 0;
  if (aiConfigured) completedSteps++;
  if (aiVerified) completedSteps++;
  if (sttConfigured) completedSteps++;
  if (sttVerified) completedSteps++;
  const completionPercent = (completedSteps / 4) * 100;

  // App is only complete when both are configured AND verified
  const isComplete = aiVerified && sttVerified;

  return {
    isComplete,
    aiConfigured,
    sttConfigured,
    aiVerified,
    sttVerified,
    completionPercent,
    aiDetails: {
      providerSelected: aiProviderSelected,
      hasApiKey: aiHasApiKey,
      providerName: aiProviderName,
      modelName: aiModelName,
    },
    sttDetails: {
      providerSelected: sttProviderSelected,
      hasApiKey: sttHasApiKey,
      providerName: sttProviderName,
      modelName: sttModelName,
    },
  };
}
