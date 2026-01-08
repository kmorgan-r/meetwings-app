import { useApp } from "@/contexts";
import { useMemo, useState, useEffect } from "react";
import { TYPE_PROVIDER } from "@/types";
import { isAIVerificationValid, isSTTVerificationValid } from "@/lib/storage";

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

  return useMemo(() => {
    // Check AI configuration
    const aiProviderSelected = Boolean(selectedAIProvider?.provider);
    const aiApiKey = selectedAIProvider?.variables?.api_key || "";
    const aiHasApiKey = aiApiKey.trim().length > 0;
    const aiConfigured = aiProviderSelected && aiHasApiKey;

    // Get AI provider display name
    const aiProvider = allAiProviders?.find(
      (p: TYPE_PROVIDER) => p.id === selectedAIProvider?.provider
    );
    const aiProviderName = aiProvider?.isCustom
      ? "Custom Provider"
      : aiProvider?.name || selectedAIProvider?.provider || null;
    const aiModelName = selectedAIProvider?.variables?.model || null;

    // Check STT configuration
    const sttProviderSelected = Boolean(selectedSttProvider?.provider);
    const sttApiKey = selectedSttProvider?.variables?.api_key || "";
    const sttHasApiKey = sttApiKey.trim().length > 0;
    const sttConfigured = sttProviderSelected && sttHasApiKey;

    // Get STT provider display name
    const sttProvider = allSttProviders?.find(
      (p: TYPE_PROVIDER) => p.id === selectedSttProvider?.provider
    );
    const sttProviderName = sttProvider?.isCustom
      ? "Custom Provider"
      : sttProvider?.name || selectedSttProvider?.provider || null;
    const sttModelName = selectedSttProvider?.variables?.model || null;

    // Check verification status
    const aiVerified = aiConfigured && isAIVerificationValid(
      selectedAIProvider?.provider || "",
      selectedAIProvider?.variables?.model || "",
      aiApiKey
    );
    const sttVerified = sttConfigured && isSTTVerificationValid(
      selectedSttProvider?.provider || "",
      selectedSttProvider?.variables?.model || "",
      sttApiKey
    );

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
  }, [selectedAIProvider, selectedSttProvider, allAiProviders, allSttProviders, verificationTrigger]);
}
