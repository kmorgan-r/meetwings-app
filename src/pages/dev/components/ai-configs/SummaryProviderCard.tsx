import { useEffect, useMemo, useState } from "react";
import { Button, Header } from "@/components";
import { useApp } from "@/contexts";
import { extractVariables } from "@/lib/functions/common.function";
import {
  loadSummaryProvider,
  saveSummaryProvider,
  type SummaryProviderSetting,
} from "@/lib/storage/secure-provider-configs";
import type { UseSettingsReturn } from "@/types";
import { Providers } from "./Providers";

const NONE: SummaryProviderSetting = { provider: "", variables: {} };

/**
 * The AI that writes every meeting summary. Its own state, saved on change;
 * empty means the chat model is used. Reuses `Providers`, which only reads the
 * four props handed over below.
 */
export const SummaryProviderCard = () => {
  const { allAiProviders } = useApp();
  const [selected, setSelected] = useState<SummaryProviderSetting>(NONE);
  const [saveFailed, setSaveFailed] = useState(false);
  const [unreadable, setUnreadable] = useState(false);
  const [incomplete, setIncomplete] = useState(false);

  useEffect(() => {
    let cancelled = false;
    void loadSummaryProvider().then(
      (loaded) => {
        if (!cancelled && loaded) setSelected(loaded);
      },
      () => {
        // Not "empty": the user is told, and Clear resets it.
        if (!cancelled) setUnreadable(true);
      },
    );
    return () => {
      cancelled = true;
    };
  }, []);

  const variables = useMemo(() => {
    const provider = allAiProviders.find((p) => p.id === selected.provider);
    return provider ? extractVariables(provider.curl) : [];
  }, [allAiProviders, selected.provider]);

  const persist = (next: SummaryProviderSetting | null) => {
    setSaveFailed(false);
    saveSummaryProvider(next).then(
      () => {
        if (next === null) setUnreadable(false);
      },
      () => setSaveFailed(true),
    );
  };

  const onChange = (next: SummaryProviderSetting) => {
    setSelected(next);
    // A half-filled override would stop every summary, so save only a full one.
    const provider = allAiProviders.find((p) => p.id === next.provider);
    const needed = provider ? extractVariables(provider.curl) : [];
    const full = needed.every((v) => (next.variables[v.key] ?? "").trim() !== "");
    setIncomplete(!full);
    if (full) persist(next);
  };

  return (
    <div id="summary-provider" className="space-y-3">
      <Header
        title="Meeting summaries"
        description="The AI that writes every meeting summary. Leave empty to use your chat model."
        isMainTitle
      />
      <Providers
        {...({
          allAiProviders,
          selectedAIProvider: selected,
          onSetSelectedAIProvider: onChange,
          variables,
          showVerification: false,
        } as UseSettingsReturn & { showVerification: boolean })}
      />
      <Button
        type="button"
        variant="outline"
        size="sm"
        disabled={selected.provider === "" && !unreadable}
        onClick={() => {
          setSelected(NONE);
          setIncomplete(false);
          persist(null);
        }}
      >
        Clear
      </Button>
      {unreadable && (
        <p className="text-sm text-destructive">
          Can't read the saved meeting summaries setting. Press Clear to reset it.
        </p>
      )}
      {incomplete && (
        <p className="text-sm text-muted-foreground">
          Fill in every field to use this provider for summaries.
        </p>
      )}
      {saveFailed && (
        <p className="text-sm text-destructive">Couldn't save the meeting summaries setting.</p>
      )}
    </div>
  );
};
