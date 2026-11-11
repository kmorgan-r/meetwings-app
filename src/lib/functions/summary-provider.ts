import { AI_PROVIDERS } from "@/config/ai-providers.constants";
import { getCustomAiProviders } from "@/lib/storage/ai-providers";
import { loadSummaryProvider } from "@/lib/storage/secure-provider-configs";
import { shouldUseMeetwingsAPI } from "./meetwings.api";

/** The provider shape every summary caller threads through. */
export type ProviderConfig = {
  provider: any;
  selectedProvider: { provider: string; variables: Record<string, string> };
};

export type ResolvedSummaryProvider =
  | { kind: "override"; config: ProviderConfig } // the Meeting summaries setting
  | { kind: "meetwings" }
  | { kind: "chat"; config: ProviderConfig }
  | { kind: "none" };

/** Override, then the Meetwings API, then the chat provider, then none. */
export async function resolveSummaryProvider(
  fallback?: ProviderConfig
): Promise<ResolvedSummaryProvider> {
  // An unreadable setting rejects here; falling through would send the
  // transcript to a provider the user did not choose for summaries.
  const stored = await loadSummaryProvider();
  if (stored) {
    // A provider deleted since it was chosen counts as unset (the stored value is kept).
    const provider = [...AI_PROVIDERS, ...getCustomAiProviders()].find(
      (p) => p.id === stored.provider
    );
    if (provider) {
      return {
        kind: "override",
        config: {
          provider,
          selectedProvider: { provider: stored.provider, variables: stored.variables },
        },
      };
    }
  }
  if (await shouldUseMeetwingsAPI()) return { kind: "meetwings" };
  return fallback ? { kind: "chat", config: fallback } : { kind: "none" };
}

/** Values to redact from anything logged or shown: keys, tokens and secrets. */
export function summarySecrets(r: ResolvedSummaryProvider): string[] {
  if (r.kind === "meetwings" || r.kind === "none") return [];
  return Object.entries(r.config.selectedProvider.variables)
    .filter(([k, v]) => /key|token|secret/i.test(k) && typeof v === "string" && v.length >= 6)
    .map(([, v]) => v);
}
