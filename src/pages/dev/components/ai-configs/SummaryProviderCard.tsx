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

  useEffect(() => {
    let cancelled = false;
    void loadSummaryProvider().then(
      (loaded) => {
        if (!cancelled && loaded) setSelected(loaded);
      },
      () => {
        // An unreadable stored blob shows as empty; the next change overwrites it.
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
    saveSummaryProvider(next).catch(() => setSaveFailed(true));
  };

  const onChange = (next: SummaryProviderSetting) => {
    setSelected(next);
    persist(next);
  };

  return (
    <div id="summary-provider" className="space-y-3">
      <Header
        title="Meeting summaries"
        description="The AI that writes every meeting summary, for Notion and Odoo. Leave empty to use your chat model."
        isMainTitle
      />
      <Providers
        {...({
          allAiProviders,
          selectedAIProvider: selected,
          onSetSelectedAIProvider: onChange,
          variables,
        } as UseSettingsReturn)}
      />
      <Button
        type="button"
        variant="outline"
        size="sm"
        disabled={selected.provider === ""}
        onClick={() => {
          setSelected(NONE);
          persist(null);
        }}
      >
        Clear
      </Button>
      {saveFailed && (
        <p className="text-sm text-destructive">Couldn't save the meeting summaries setting.</p>
      )}
    </div>
  );
};
