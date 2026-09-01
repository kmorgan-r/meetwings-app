import { useEffect, useLayoutEffect, useMemo, useState } from "react";
import { useApp } from "@/contexts";
import { shouldUseMeetwingsAPI } from "@/lib";
import type { ProviderConfigLike } from "@/lib/odoo/meeting-log-actions";

/**
 * The provider config, derived exactly as completion/index.tsx:60-88 derives it.
 *
 * Shared by ProviderConfigReader and AssignDialog rather than written twice:
 * the async `shouldUseMeetwingsAPI` leg needs the `cancelled` guard, and two
 * copies is two chances to drop it.
 *
 * THERE IS NO `providerConfig` FIELD ON THE CONTEXT. `const { providerConfig }
 * = useApp()` compiles - the context type is wide - and is `undefined` forever,
 * which sends every retry of a `failed` row down the fallback-body path and
 * posts a "Summarization failed" note to a customer's record. The context
 * exposes `allAiProviders`, `selectedAIProvider` and `meetwingsApiEnabled`, and
 * every consumer derives the object itself.
 *
 * Returns `null` when the Meetwings API is in use. That is CORRECT, not a
 * failure - completion returns `undefined` in exactly that case and
 * generateMeetingLogSummary routes through the Meetwings API instead. Do not
 * "fix" this branch into an error or a warning.
 */
export function useProviderConfig(): ProviderConfigLike | null {
  const { allAiProviders, selectedAIProvider, meetwingsApiEnabled } = useApp();
  const [useMeetwingsAPI, setUseMeetwingsAPI] = useState(false);

  // Keyed on the context flag, not `[]`. shouldUseMeetwingsAPI does a Tauri
  // round-trip (check_license_status), and frozen at mount a user who turns the
  // Meetwings API off gets a config stuck at null and the "Summarization
  // failed" body on every meeting thereafter. The `cancelled` guard is what
  // keeps two toggles in quick succession from resolving out of order.
  useEffect(() => {
    let cancelled = false;
    void shouldUseMeetwingsAPI().then((value) => {
      if (!cancelled) setUseMeetwingsAPI(value);
    });
    return () => {
      cancelled = true;
    };
  }, [meetwingsApiEnabled]);

  return useMemo(() => {
    if (useMeetwingsAPI) return null;
    const provider = allAiProviders.find((p) => p.id === selectedAIProvider.provider);
    return provider ? { provider, selectedProvider: selectedAIProvider } : null;
  }, [useMeetwingsAPI, allAiProviders, selectedAIProvider]);
}

/**
 * Writes the derived config into a ref. Renders nothing.
 *
 * A LEAF, so an AppProvider re-render repaints this and nothing else - the
 * 200-row list stays out of the context's re-render path. AppProvider rebuilds
 * its `value` every render and calls loadData() on cross-window `storage`
 * events, so a provider change in the main window would otherwise repaint a
 * list that does not depend on it. The page's []-stable action handlers read
 * providerConfigRef.current, which is why this writes a ref rather than lifting
 * state.
 */
export function ProviderConfigReader({
  configRef,
}: {
  configRef: React.MutableRefObject<ProviderConfigLike | null>;
}) {
  const providerConfig = useProviderConfig();
  useLayoutEffect(() => {
    configRef.current = providerConfig;
  });
  return null;
}
