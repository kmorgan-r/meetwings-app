import {
  AIProviders,
  STTProviders,
  MeetwingsApiSetup,
  SetupProgressHeader,
  AICustomProviders,
  STTCustomProviders,
} from "./components";
import { SummaryProviderCard } from "./components/ai-configs/SummaryProviderCard";
import Contribute from "@/components/Contribute";
import { TeamJoinBox } from "@/components/TeamJoinBox";
import { useSettings, useSetupStatus, useTeamState } from "@/hooks";
import { PageLayout } from "@/layouts";

const DevSpace = () => {
  const settings = useSettings();
  const { isComplete, sttConfigured } = useSetupStatus();
  const [teamState] = useTeamState();

  return (
    <PageLayout
      title="API Setup"
      description="Connect your AI and speech services to get started"
    >
      {/* Setup Progress */}
      <SetupProgressHeader />

      {/* Colleagues whose mail client doesn't open meetwings:// links paste here */}
      {!teamState?.joined && (
        <div className="mb-6">
          <TeamJoinBox />
        </div>
      )}

      {/* Required Section */}
      <div className="space-y-6">
        <div className="flex items-center gap-2 mb-2">
          <h2 className="text-sm font-semibold text-foreground">Required</h2>
          {!isComplete && (
            <span className="text-xs px-2 py-0.5 rounded-full bg-red-500/10 text-red-600 dark:text-red-400">
              Must configure
            </span>
          )}
        </div>

        {/* AI Provider Selection */}
        <AIProviders {...settings} />

        {/* Speech keys are never shared by a team: point the colleague at their own */}
        {teamState?.joined && !sttConfigured && (
          <p className="text-sm rounded-md border border-primary/30 bg-primary/5 p-3">
            Your team set up AI, Notion and Google. Speech uses your own key. We suggest
            AssemblyAI, which is free to start and needs no card: press{" "}
            <strong>Get API Key from AssemblyAI</strong> below, sign up, then paste your key.
          </p>
        )}

        {/* STT Providers */}
        <STTProviders {...settings} />
      </div>

      {/* Optional Section */}
      <div className="mt-8 pt-6 border-t border-border">
        <div className="flex items-center gap-2 mb-4">
          <h2 className="text-sm font-semibold text-foreground">Optional</h2>
          <span className="text-xs px-2 py-0.5 rounded-full bg-muted text-muted-foreground">
            Advanced features
          </span>
        </div>

        <div className="space-y-6">
          {/* Meetwings API Setup */}
          <MeetwingsApiSetup />

          {/* Meeting summaries (Notion and Odoo) */}
          <SummaryProviderCard />

          {/* Custom AI Providers */}
          <AICustomProviders {...settings} />

          {/* Custom STT Providers */}
          <STTCustomProviders {...settings} />
        </div>
      </div>

      {/* Contribute Banner (moved to bottom) */}
      <div className="mt-8">
        <Contribute />
      </div>
    </PageLayout>
  );
};

export default DevSpace;
