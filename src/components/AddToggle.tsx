import { toast } from "sonner";
import { MAX_TARGETS } from "@/lib/odoo";
import type { SelectedTarget, SelectedTargets } from "@/types";

/**
 * Task 12's one control shared by contact rows, the per-contact deal
 * disclosure and the lead-search results in `ContactPicker` - "Contact rows,
 * deal rows and lead-search results all get + add / ✓ added; clicking an
 * added row removes it. Under a flat list they all produce the same kind of
 * thing." Extracted in Task 14 so `AssignDialog` (the dashboard's own
 * multi-target picker) can use the identical control rather than
 * reimplementing it.
 *
 * `aria-disabled`, never the native `disabled` attribute, for the CAP: the
 * native one drops the control from the tab order and blurs it with no
 * defined recovery target. An archived contact's own row passes its own
 * native `disabled` in through `disabled` instead - that disablement is
 * static at render time, not a side effect of another row's interaction, so
 * the focus hazard the cap treatment exists to avoid does not apply to it.
 */
export function AddToggle({
  model,
  resId,
  name,
  targets,
  atCap,
  disabled,
  onAdd,
  onRemove,
}: {
  model: SelectedTarget["model"];
  resId: number;
  name: string;
  targets: SelectedTargets;
  atCap: boolean;
  disabled?: boolean;
  onAdd: (t: SelectedTarget) => Promise<{ ok: boolean; reason?: "cap" }>;
  onRemove: (model: SelectedTarget["model"], resId: number) => Promise<void>;
}) {
  const added = targets.some((t) => t.model === model && t.resId === resId);
  // Removing an already-added row is never blocked by the cap - only adding
  // a NEW one is.
  const blocked = !disabled && !added && atCap;

  const handleClick = () => {
    if (blocked) return;
    if (added) {
      void onRemove(model, resId);
      return;
    }
    void (async () => {
      const result = await onAdd({ model, resId, name });
      // A THROWN failure is already reported by the caller's own catch (see
      // ContactPicker's addTarget / useOdooTarget.ts) - toasting it again here
      // would double it. A `{ ok: false, reason: "cap" }` RETURN is not an
      // exception and is not reported anywhere else: `atCap` is computed
      // once per render from `targets.length`, so two `+ add` clicks fired
      // before either resolves both read `blocked === false` and both call
      // `onAdd` - the loser legitimately loses the race against whichever
      // cap check the caller enforces. Without this, the user clicks,
      // nothing is added, and nothing says why.
      if (!result.ok && result.reason === "cap") {
        toast.error("Could not add target", {
          description: `Only ${MAX_TARGETS} records can be logged to a meeting at once.`,
        });
      }
    })();
  };

  return (
    <button
      type="button"
      disabled={disabled}
      aria-disabled={blocked ? true : undefined}
      aria-pressed={added}
      aria-label={`${added ? "added" : "add"} ${name}`}
      onClick={handleClick}
      className={`shrink-0 px-1.5 py-0.5 rounded text-[10px] ${
        added
          ? "bg-primary/10 text-primary"
          : blocked
            ? "text-muted-foreground/50"
            : "text-muted-foreground hover:bg-muted/50"
      }`}
    >
      {added ? "✓ added" : "+ add"}
    </button>
  );
}
