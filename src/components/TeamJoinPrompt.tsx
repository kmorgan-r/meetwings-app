import { useEffect, useRef } from "react";
import { toast } from "sonner";
import { useTeamState } from "@/hooks/useTeamState";
import { TEAM_COPY } from "@/lib/team/team-file";
import {
  Button,
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui";

/** Confirm prompt for a pending team join, plus the toast for controller errors. */
export const TeamJoinPrompt = () => {
  const [state, send] = useTeamState();
  const seenSeq = useRef(0);

  // Keyed on errorSeq (not the error value) so the same bad link twice toasts
  // twice. Starts at 0, so a cold-start error in the first state still toasts.
  useEffect(() => {
    if (!state || state.errorSeq === seenSeq.current) return;
    seenSeq.current = state.errorSeq;
    if (state.error) toast.error(TEAM_COPY[state.error]);
  }, [state]);

  const pending = state?.pending ?? null;

  return (
    <Dialog open={!!pending} onOpenChange={(open) => !open && !state?.busy && send({ type: "decline" })}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Use your team's settings?</DialogTitle>
          <DialogDescription asChild>
            <div className="space-y-2">
              {pending && (
                <>
                  <strong className="block text-foreground">
                    {`Shared by GitHub user ${pending.owner}`}
                  </strong>
                  <p>
                    {`This replaces your AI, speech, Notion and Google settings with the ones in team file ${pending.gistShort}…. Only accept if you know this GitHub user and they sent you this link.`}
                  </p>
                  {pending.switching && <p>You'll leave your current team settings.</p>}
                </>
              )}
            </div>
          </DialogDescription>
        </DialogHeader>
        <DialogFooter>
          <Button variant="outline" disabled={state?.busy} onClick={() => send({ type: "decline" })}>
            Not now
          </Button>
          <Button disabled={state?.busy} onClick={() => send({ type: "confirm" })}>Use team settings</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
};
