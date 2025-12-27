import { useState, useCallback } from "react";
import { PageLayout } from "@/layouts";
import { Button } from "@/components/ui/button";
import { RefreshCcw } from "lucide-react";
import {
  SummaryList,
  SummaryDetail,
  KnowledgeProfileCard,
  EntityBrowser,
  ContextSettings,
} from "./components";
import type { MeetingSummary } from "@/types";

const ContextMemory = () => {
  const [selectedSummary, setSelectedSummary] = useState<MeetingSummary | null>(null);
  const [refreshTrigger, setRefreshTrigger] = useState(0);

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

  return (
    <PageLayout
      title="Context Memory"
      description="View and manage your conversation history and knowledge profile"
      rightSlot={
        <Button
          variant="ghost"
          size="icon"
          onClick={handleRefresh}
        >
          <RefreshCcw className="h-4 w-4" />
        </Button>
      }
    >
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
        {/* Left Column */}
        <div className="space-y-6">
          {/* Knowledge Profile */}
          <KnowledgeProfileCard refreshTrigger={refreshTrigger} />

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
