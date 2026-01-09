import { useSetupStatus } from "@/hooks";
import { CheckCircle2, AlertCircle, Circle } from "lucide-react";
import { cn } from "@/lib/utils";

// StatusIcon component defined outside to prevent recreation on every render
const StatusIcon = ({ done, pending }: { done: boolean; pending?: boolean }) => {
  if (done) return <CheckCircle2 className="size-4 text-green-500 flex-shrink-0" />;
  if (pending) return <Circle className="size-4 text-muted-foreground/50 flex-shrink-0" />;
  return <AlertCircle className="size-4 text-yellow-500 flex-shrink-0" />;
};

export const SetupProgressHeader = () => {
  const {
    isComplete,
    aiConfigured,
    sttConfigured,
    aiVerified,
    sttVerified,
    aiDetails,
    sttDetails,
    completionPercent,
  } = useSetupStatus();

  return (
    <div className="rounded-lg border border-border bg-card p-4 mb-6">
      {/* Header */}
      <div className="flex items-center justify-between mb-3">
        <h2 className="text-sm font-semibold text-foreground">Setup Progress</h2>
        <span
          className={cn(
            "text-xs font-medium px-2 py-0.5 rounded-full",
            isComplete
              ? "bg-green-500/10 text-green-600 dark:text-green-400"
              : "bg-yellow-500/10 text-yellow-600 dark:text-yellow-400"
          )}
        >
          {isComplete ? "Complete" : `${Math.round(completionPercent)}% Done`}
        </span>
      </div>

      {/* Progress Bar */}
      <div className="h-2 bg-muted rounded-full overflow-hidden mb-4">
        <div
          className={cn(
            "h-full transition-all duration-500 rounded-full",
            isComplete ? "bg-green-500" : "bg-yellow-500"
          )}
          style={{ width: `${completionPercent}%` }}
        />
      </div>

      {/* Status Items - 4 steps now */}
      <div className="space-y-2">
        {/* AI Provider Configured */}
        <div className="flex items-center gap-2">
          <StatusIcon done={aiConfigured} />
          <span className="text-sm text-foreground">
            {aiConfigured ? (
              <>
                AI Provider configured
                <span className="text-muted-foreground ml-1">
                  ({aiDetails.providerName}
                  {aiDetails.modelName && ` - ${aiDetails.modelName}`})
                </span>
              </>
            ) : (
              <span className="text-muted-foreground">Configure AI Provider</span>
            )}
          </span>
        </div>

        {/* AI Provider Verified */}
        <div className="flex items-center gap-2 pl-6">
          <StatusIcon done={aiVerified} pending={!aiConfigured} />
          <span className={cn("text-sm", !aiConfigured && "text-muted-foreground/50")}>
            {aiVerified ? (
              <span className="text-foreground">AI connection verified</span>
            ) : aiConfigured ? (
              <span className="text-muted-foreground">Verify AI connection</span>
            ) : (
              <span className="text-muted-foreground/50">Verify AI connection</span>
            )}
          </span>
        </div>

        {/* STT Provider Configured */}
        <div className="flex items-center gap-2">
          <StatusIcon done={sttConfigured} />
          <span className="text-sm text-foreground">
            {sttConfigured ? (
              <>
                Speech-to-Text configured
                <span className="text-muted-foreground ml-1">
                  ({sttDetails.providerName}
                  {sttDetails.modelName && ` - ${sttDetails.modelName}`})
                </span>
              </>
            ) : (
              <span className="text-muted-foreground">Configure Speech-to-Text</span>
            )}
          </span>
        </div>

        {/* STT Provider Verified */}
        <div className="flex items-center gap-2 pl-6">
          <StatusIcon done={sttVerified} pending={!sttConfigured} />
          <span className={cn("text-sm", !sttConfigured && "text-muted-foreground/50")}>
            {sttVerified ? (
              <span className="text-foreground">Speech-to-Text verified</span>
            ) : sttConfigured ? (
              <span className="text-muted-foreground">Verify Speech-to-Text connection</span>
            ) : (
              <span className="text-muted-foreground/50">Verify Speech-to-Text connection</span>
            )}
          </span>
        </div>
      </div>

      {/* Help Text */}
      {!isComplete && (
        <p className="text-xs text-muted-foreground mt-4 pt-3 border-t border-border">
          {!aiConfigured || !sttConfigured ? (
            "Configure both providers below, then verify each connection to unlock Meetwings."
          ) : !aiVerified || !sttVerified ? (
            "Check the verification box below each provider to test your API keys."
          ) : (
            "All set! You can now use Meetwings."
          )}
        </p>
      )}
    </div>
  );
};
