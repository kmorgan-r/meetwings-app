import { useEffect, useLayoutEffect, useRef, type RefObject } from "react";
import { listen } from "@tauri-apps/api/event";
import { isCalendarAutoSelectEnabled, planAutoSelect } from "@/lib/calendar/auto-select";
import { fetchCurrentMeetings } from "@/lib/calendar/fetch-current-meetings";
import type {
  CalendarParticipant,
  CreateContactResult,
  OdooContact,
  SelectedTarget,
  SelectedTargets,
} from "@/types";

interface AutoSelectInputs {
  /** The synced contact cache, or `null` while it is not ready. */
  contacts: OdooContact[] | null;
  targetsRef: RefObject<SelectedTargets>;
  addTarget: (t: SelectedTarget) => Promise<{ ok: boolean; reason?: "cap" }>;
  onCreateContact: (
    participant: CalendarParticipant,
    draft: { name: string; parentId: number | null }
  ) => Promise<CreateContactResult>;
}

/**
 * When meeting capture starts (useCompletion's `meetingCaptureStarted`), adds
 * the current Outlook meeting's attendees as Odoo targets, creating a contact
 * for a clearly new attendee, with no confirm click. Only the clear case -
 * see planAutoSelect - and only while CALENDAR_AUTO_SELECT_ENABLED is on.
 *
 * Writes through useOdooTarget's own addTarget/onCreateContact, so the picker,
 * the "Logging to" list and the database stay in step. Silent by design: a
 * skipped or failed run leaves today's confirm-only flow.
 */
export function useCalendarAutoSelect(inputs: AutoSelectInputs): void {
  // The listeners below register once; they read the latest props through this.
  // A LAYOUT effect, like useOdooTarget's mirrors: useCompletion's capture-edge
  // effect can dispatch meetingCaptureStarted synchronously inside the same
  // commit's passive-effect flush, before a passive sync here would have run.
  const latest = useRef(inputs);
  useLayoutEffect(() => {
    latest.current = inputs;
  });

  const inFlight = useRef(false);
  // Bumped by anything that moves the targets to another conversation or
  // instance, or empties them (the picker's Clear). A run stops at its next
  // write when this changes under it.
  const generation = useRef(0);
  // After an instance change the cache still holds the OUTGOING instance's rows
  // until the resync replaces the array (CalendarProposalState's `idle` doc);
  // an id from one instance names a different partner in another.
  const staleContacts = useRef<OdooContact[] | null | undefined>(undefined);

  useEffect(() => {
    const bump = () => {
      generation.current += 1;
    };
    window.addEventListener("newConversationStarted", bump);
    window.addEventListener("odooTargetsCleared", bump);
    return () => {
      window.removeEventListener("newConversationStarted", bump);
      window.removeEventListener("odooTargetsCleared", bump);
    };
  }, []);

  useEffect(() => {
    // Disposed flag: see useCalendarProposal's listeners for the
    // unmount-before-resolve race.
    let disposed = false;
    let unlisten: (() => void) | undefined;
    void listen("odoo-instance-changed", () => {
      generation.current += 1;
      staleContacts.current = latest.current.contacts;
    }).then((fn) => {
      if (disposed) {
        fn();
        return;
      }
      unlisten = fn;
    });
    return () => {
      disposed = true;
      unlisten?.();
    };
  }, []);

  useEffect(() => {
    const run = async () => {
      if (inFlight.current) return;
      inFlight.current = true;
      try {
        if (!isCalendarAutoSelectEnabled()) return;
        const { contacts } = latest.current;
        if (contacts === null || contacts.length === 0 || contacts === staleContacts.current) return;
        const mine = generation.current;

        const fetched = await fetchCurrentMeetings();
        if (fetched.kind !== "ok") return;
        const plan = planAutoSelect({
          events: fetched.events,
          ownAddress: fetched.ownAddress,
          contacts,
          targets: latest.current.targetsRef.current,
          now: Date.now(),
        });
        if (plan.kind === "skip") return;

        // Sequential: addSelectedTarget is a non-atomic check-then-act. Matches
        // first, so an Odoo failure on a create cannot cost them.
        for (const contact of plan.add) {
          if (generation.current !== mine) return;
          const added = await latest.current.addTarget({
            model: "res.partner",
            resId: contact.id,
            name: contact.name,
          });
          // Any refusal (cap, or an error addTarget already toasted) would only repeat.
          if (!added.ok) return;
        }
        for (const { participant, name, parentId } of plan.create) {
          if (generation.current !== mine) return;
          const created = await latest.current.onCreateContact(participant, { name, parentId });
          if (created.kind !== "created" && created.kind !== "adopted-active") continue;
          if (generation.current !== mine) return;
          const added = await latest.current.addTarget({
            model: "res.partner",
            resId: created.contact.id,
            name: created.contact.name,
          });
          if (!added.ok) return;
        }
      } finally {
        inFlight.current = false;
      }
    };
    const onCaptureStarted = () => {
      run().catch((err) => console.error("Calendar auto-select failed:", err));
    };
    window.addEventListener("meetingCaptureStarted", onCaptureStarted);
    return () => window.removeEventListener("meetingCaptureStarted", onCaptureStarted);
  }, []);
}