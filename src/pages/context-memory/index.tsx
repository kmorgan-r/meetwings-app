import { useState, useCallback } from "react";
import { toast } from "sonner";
import { PageLayout } from "@/layouts";
import { Button } from "@/components/ui/button";
import { RefreshCcw, Sparkles } from "lucide-react";
import {
  compactKnowledge,
  summarizePendingConversations,
} from "@/lib/functions/knowledge-compactor";
import { shouldUseMeetwingsAPI } from "@/lib/functions/meetwings.api";
import { getUncompactedSummaryCount } from "@/lib/database";
import { useApp } from "@/contexts";
import {
  SummaryList,
  SummaryDetail,
  KnowledgeProfileCard,
  EntityBrowser,
  ContextSettings,
  UserIdentitySettings,
} from "./components";
import type { MeetingSummary } from "@/types";

const ContextMemory = () => {
  const { selectedAIProvider, allAiProviders } = useApp();
  const [selectedSummary, setSelectedSummary] = useState<MeetingSummary | null>(null);
  const [refreshTrigger, setRefreshTrigger] = useState(0);
  const [isCompacting, setIsCompacting] = useState(false);

  const handleRefresh = useCallback(() => {
    setRefreshTrigger((prev) => prev + 1);
  }, []);

  const handleSettingsChange = useCallback(() => {
    handleRefresh();
  }, [handleRefresh]);

  const handleSelectSummary = useCallback((summary: MeetingSummary) => {
    setSelectedSummary(summary);
  }, []);

  const handleCloseSummary = useCallback(() => {
    setSelectedSummary(null);
  }, []);

  const handleUpdateSummary = useCallback(() => {
    handleRefresh();
  }, [handleRefresh]);

  const handleCompactKnowledge = useCallback(async () => {
    setIsCompacting(true);
    try {
      // Meetwings-cloud users have no locally configured provider, so gate on
      // the Meetwings API too (mirrors the chat completion call sites).
      const useMeetwingsAPI = await shouldUseMeetwingsAPI();
      const provider = allAiProviders.find(
        (p) => p.id === selectedAIProvider.provider
      );

      if (!useMeetwingsAPI && !provider) {
        toast.error(
          "No AI provider selected. Choose one in Dev Space to update knowledge."
        );
        return;
      }

      const providerConfig = {
        provider: useMeetwingsAPI ? undefined : provider,
        selectedProvider: selectedAIProvider,
      };

      // Summarize any conversations that were never summarized, so compaction
      // has fresh material (summaries are otherwise only created when leaving a
      // conversation).
      const { summarized: backfilled, cappedAtLimit } =
        await summarizePendingConversations(providerConfig);

      // Nothing new since the last compaction -> don't claim an update.
      const uncompacted = await getUncompactedSummaryCount();
      if (uncompacted === 0) {
        toast.info("No new conversations to add to your knowledge profile.");
        return;
      }

      const updated = await compactKnowledge(providerConfig);
      handleRefresh();

      if (updated) {
        const base =
          backfilled > 0
            ? `Knowledge updated (${backfilled} new conversation${
                backfilled === 1 ? "" : "s"
              } summarized).`
            : "Knowledge updated.";
        toast.success(
          cappedAtLimit
            ? `${base} More remain — click Update Knowledge again to continue.`
            : base
        );
      } else {
        toast.error("Failed to update knowledge. See console for details.");
      }
    } catch (error) {
      console.error("Failed to compact knowledge:", error);
      toast.error("Failed to update knowledge. See console for details.");
    } finally {
      setIsCompacting(false);
    }
  }, [handleRefresh, allAiProviders, selectedAIProvider]);

  return (
    <PageLayout
      title="Context Memory"
      description="View and manage your conversation history and knowledge profile"
      rightSlot={
        <div className="flex items-center gap-2">
          <Button
            variant="outline"
            size="sm"
            onClick={handleCompactKnowledge}
            disabled={isCompacting}
            className="flex items-center gap-1"
          >
            <Sparkles className="h-3 w-3" />
            {isCompacting ? "Updating..." : "Update Knowledge"}
          </Button>
          <Button
            variant="ghost"
            size="icon"
            onClick={handleRefresh}
          >
            <RefreshCcw className="h-4 w-4" />
          </Button>
        </div>
      }
    >
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
        {/* Left Column */}
        <div className="space-y-6">
          {/* Knowledge Profile */}
          <KnowledgeProfileCard refreshTrigger={refreshTrigger} />

          {/* User Identity */}
          <UserIdentitySettings onSettingsChange={handleSettingsChange} />

          {/* Settings */}
          <ContextSettings onSettingsChange={handleSettingsChange} />
        </div>

        {/* Right Column */}
        <div className="space-y-6">
          {/* Summary List or Detail */}
          {selectedSummary ? (
            <SummaryDetail
              summary={selectedSummary}
              onClose={handleCloseSummary}
              onUpdate={handleUpdateSummary}
            />
          ) : (
            <SummaryList
              onSelectSummary={handleSelectSummary}
              refreshTrigger={refreshTrigger}
            />
          )}

          {/* Entity Browser */}
          <EntityBrowser refreshTrigger={refreshTrigger} />
        </div>
      </div>
    </PageLayout>
  );
};

export default ContextMemory;
