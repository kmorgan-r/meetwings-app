import { AIProviders, STTProviders, MeetwingsApiSetup, SetupProgressHeader } from "./components";
import Contribute from "@/components/Contribute";
import { useSettings } from "@/hooks";
import { PageLayout } from "@/layouts";

const DevSpace = () => {
  const settings = useSettings();

  return (
    <PageLayout
      title="API Setup"
      description="Connect your AI and speech services to get started"
    >
      {/* Setup Progress */}
      <SetupProgressHeader />

      {/* Required Section */}
      <div className="space-y-6">
        <div className="flex items-center gap-2 mb-2">
          <h2 className="text-sm font-semibold text-foreground">Required</h2>
          <span className="text-xs px-2 py-0.5 rounded-full bg-red-500/10 text-red-600 dark:text-red-400">
            Must configure
          </span>
        </div>

        {/* AI Provider Selection */}
        <AIProviders {...settings} />

        {/* STT Providers */}
        <STTProviders {...settings} />
      </div>

      {/* Optional Section */}
      <div className="mt-8 pt-6 border-t border-border">
        <div className="flex items-center gap-2 mb-4">
          <h2 className="text-sm font-semibold text-foreground">Optional</h2>
          <span className="text-xs px-2 py-0.5 rounded-full bg-muted text-muted-foreground">
            Premium features
          </span>
        </div>

        {/* Meetwings API Setup */}
        <MeetwingsApiSetup />
      </div>

      {/* Contribute Banner (moved to bottom) */}
      <div className="mt-8">
        <Contribute />
      </div>
    </PageLayout>
  );
};

export default DevSpace;
