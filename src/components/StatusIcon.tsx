import { CheckCircle2, AlertCircle, Circle } from "lucide-react";

/**
 * The setup-checklist icon: green check when a step is done, a hollow muted
 * circle when it is not yet reachable, amber otherwise.
 *
 * Note what amber means here: INCOMPLETE, not failed. This icon has no failure
 * variant on purpose - it renders progress through a checklist, where the only
 * states are "done", "your turn" and "not yet". A page that also needs to show
 * an operation FAILING wants a separate, red treatment; routing an error
 * through the amber branch makes a rejected credential read as an unfinished
 * form.
 *
 * Extracted from SetupProgressHeader so the Odoo page's checklist renders
 * identically rather than growing a second, drifting copy of the same three
 * classNames.
 */
export const StatusIcon = ({ done, pending }: { done: boolean; pending?: boolean }) => {
  if (done) return <CheckCircle2 className="size-4 text-green-500 flex-shrink-0" />;
  if (pending) return <Circle className="size-4 text-muted-foreground/50 flex-shrink-0" />;
  return <AlertCircle className="size-4 text-yellow-500 flex-shrink-0" />;
};
