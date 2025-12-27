import { Button } from "@/components";

interface SpeakerConfirmationProps {
  speakerId: string;
  suggestedName: string;
  suggestedProfileId: string;
  confidence: number;
  onConfirm: (confirmed: boolean, speakerId: string, profileId: string, name: string) => void;
  onDismiss: () => void;
}

/**
 * Inline confirmation prompt for medium-confidence speaker matches.
 * Displayed when the system is 50-70% confident about a speaker identity.
 */
export function SpeakerConfirmation({
  speakerId,
  suggestedName,
  suggestedProfileId,
  confidence,
  onConfirm,
  onDismiss,
}: SpeakerConfirmationProps) {
  const isUserProfile = suggestedProfileId === "user" || suggestedName === "You";
  const confidencePercent = Math.round(confidence * 100);

  return (
    <div className="mt-2 p-2 bg-muted/50 rounded border border-amber-500/30 text-xs">
      <p className="text-muted-foreground mb-2">
        Is this {suggestedName}?{" "}
        <span className="text-amber-600 dark:text-amber-400">
          ({confidencePercent}% match)
        </span>
      </p>
      <div className="flex flex-wrap gap-2">
        <Button
          size="sm"
          variant="outline"
          className="h-6 text-xs border-green-500/50 hover:bg-green-500/10"
          onClick={() => onConfirm(true, speakerId, suggestedProfileId, suggestedName)}
        >
          Yes, that's {isUserProfile ? "me" : suggestedName}
        </Button>
        <Button
          size="sm"
          variant="ghost"
          className="h-6 text-xs"
          onClick={() => onConfirm(false, speakerId, suggestedProfileId, suggestedName)}
        >
          No, someone else
        </Button>
        <Button
          size="sm"
          variant="ghost"
          className="h-6 text-xs text-muted-foreground"
          onClick={onDismiss}
        >
          Dismiss
        </Button>
      </div>
    </div>
  );
}
