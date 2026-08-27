import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { CheckIcon } from "lucide-react";
import {
  Button,
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  Input,
} from "@/components";
import { shouldUseMeetwingsAPI } from "@/lib";
import { listContacts } from "@/lib/database/odoo-contacts.action";
import { createOdooClient, type OdooClient } from "@/lib/odoo/client";
import { compareContacts, filterContacts } from "@/lib/odoo/contact-ordering";
import { reportOdooError } from "@/lib/odoo/errors";
import type { ProviderConfigLike } from "@/lib/odoo/meeting-log-actions";
import { fetchOpportunities } from "@/lib/odoo/opportunities";
import { requireOdooConfig } from "@/lib/storage/odoo-config.storage";
import type { MeetingLogListRow, OdooContact, OdooOpportunity } from "@/types";
import { useProviderConfig } from "./ProviderConfigReader";
import { meetingDateOf } from "./QueueRow";

/**
 * The Assign / Reassign dialog.
 *
 * THE DIALOG OWNS NO PUSH. Confirm hands `{ contactId, leadId, providerConfig }`
 * UP to a page-owned handler, which is what calls `assignMeetingLog`, marks the
 * row busy and re-reads. Both alternatives break a stated rule: a dialog that
 * closed on Confirm while owning the push would drive page state from an
 * unmounted child and "dispose" a client still in use minutes later; one that
 * stayed open would render "Sending…" in the list behind a modal whose Cancel
 * has no defined meaning mid-push.
 *
 * `useOdooTarget` IS NOT REUSED. It owns the singleton `odoo_selected_target`
 * row - the contact for the *next* meeting - so assigning a past meeting
 * through it would silently retarget the meeting the user is about to have.
 *
 * MOUNTED ONLY WHILE OPEN, so creation and disposal bracket exactly one
 * session. Rendered once at page level behind an `open` prop, "one client per
 * dialog session" silently becomes one client per page mount.
 */

/**
 * The same bound the picker uses (`ContactPicker.MAX_RENDERED_ROWS`).
 *
 * Restated rather than imported across page trees: that constant is part of the
 * overlay picker's contract and its own tests, and importing it here would make
 * a change there silently change this dialog.
 */
const MAX_CONTACT_ROWS = 100;

/** What Confirm hands up. Three members - see the note on `client`, below. */
export interface AssignPayload {
  contactId: number;
  leadId: number | null;
  /**
   * Derived HERE, from `@/contexts`, and carried up because the page-owned
   * handler needs a real config for `ActionDeps.providerConfig`. `null` is a
   * legitimate value: it is what the Meetwings API path produces.
   *
   * There is deliberately NO `client` member. `runAction` never reads
   * `deps.client` - it rebuilds unconditionally from the config it just
   * resolved (`meeting-log-actions.ts:149`), because `instanceFingerprint` is
   * url|db only, so a credential rotation while this dialog sat open still
   * matches the fingerprint and pushing with the dialog's client would hit
   * revoked credentials and record a spurious ODOO_AUTH_FAILED. A fourth member
   * would be dead weight that reads as load-bearing.
   */
  providerConfig: ProviderConfigLike | null;
}

export interface AssignDialogProps {
  /** The row being assigned. A snapshot - the page re-reads after the CAS. */
  row: MeetingLogListRow;
  /** The fingerprint the page resolved this cycle, for `listContacts`. */
  instance: string;
  onConfirm: (payload: AssignPayload) => void;
  onCancel: () => void;
}

/**
 * Step 0's three outcomes.
 *
 * `error` is not folded into "no contacts": `requireOdooConfig` throws for
 * exactly the half-filled config a user comes to this page to fix, and an empty
 * picker would tell them their contacts had not synced.
 */
type Preflight =
  | { state: "loading" }
  | { state: "ready" }
  | { state: "error"; code: string };

export function AssignDialog({ row, instance, onConfirm, onCancel }: AssignDialogProps) {
  // Consumed INSIDE the dialog, never in the page shell: AppProvider rebuilds
  // its value every render and calls loadData() on cross-window `storage`
  // events, so a provider change in the main window would otherwise repaint a
  // 200-row list that does not depend on it.
  const providerConfig = useProviderConfig();

  const [preflight, setPreflight] = useState<Preflight>({ state: "loading" });
  const [attempt, setAttempt] = useState(0);
  const [contacts, setContacts] = useState<OdooContact[]>([]);
  const [viaMeetwingsAPI, setViaMeetwingsAPI] = useState(false);
  const [query, setQuery] = useState("");
  const [selected, setSelected] = useState<OdooContact | null>(null);
  const [leadId, setLeadId] = useState<number | null>(null);
  const [opportunities, setOpportunities] = useState<OdooOpportunity[] | null>(null);
  const [opportunityError, setOpportunityError] = useState<string | null>(null);
  const [isLookingUp, setIsLookingUp] = useState(false);

  const clientRef = useRef<Promise<OdooClient> | null>(null);
  const selectionToken = useRef(0);

  /**
   * ONE client per dialog session, held as a PROMISE.
   *
   * `if (!ref.current) ref.current = createOdooClient(await requireOdooConfig())`
   * does not work: the check-and-assign spans a yield, so two quick contact
   * selections both observe `null` and both build a client, which is slice 1's
   * open follow-up (`useOdooTarget.ts:162-167`) repeated.
   *
   * SELF-CLEARING, like sweepInFlight's `.finally` (meeting-log-push.ts:397-399).
   * A bare `??=` caches a PERMANENTLY REJECTED promise for the whole dialog
   * session the moment requireOdooConfig rejects - which is exactly the
   * half-filled config this page exists to fix - so the failure state's retry
   * control could never succeed.
   */
  const getClient = useCallback((): Promise<OdooClient> => {
    if (clientRef.current) return clientRef.current;
    const p = requireOdooConfig().then(createOdooClient);
    clientRef.current = p;
    p.catch(() => {
      if (clientRef.current === p) clientRef.current = null;
    });
    return p;
  }, []);

  /**
   * Step 0, and steps 1's read.
   *
   * `getClient()` is AWAITED here, not fired and forgotten: that is what turns
   * a credentials rejection into the pre-flight failure UI instead of an
   * unhandled rejection on the most common interaction in the dialog.
   *
   * `listContacts` is read HERE, on open, never inherited from the page's
   * mount-time map - the dashboard webview is hidden rather than destroyed, so
   * a long-mounted page outlives every main-window runSync and a contact synced
   * afterwards would be unpickable.
   *
   * The `cancelled` guard is the repo's (`useOdooTarget.ts:353-364`). The
   * dialog is mounted only while open, so a Cancel during the pre-flight
   * otherwise resolves into a setState on a component already unmounting.
   */
  useEffect(() => {
    let cancelled = false;
    setPreflight({ state: "loading" });
    void (async () => {
      try {
        const [, cached, viaAPI] = await Promise.all([
          getClient(),
          listContacts(instance),
          // Necessary but NOT sufficient: it tests configuration, while
          // generateMeetingLogSummary returns null identically for a
          // configured-but-FAILING provider. Task 6's `degraded` outcome covers
          // that half.
          shouldUseMeetwingsAPI(),
        ]);
        if (cancelled) return;
        setContacts(cached);
        setViaMeetwingsAPI(viaAPI);
        setPreflight({ state: "ready" });
      } catch (err) {
        if (cancelled) return;
        // The CODE only. `reportOdooError` redacts at construction and
        // degrades `message` to the bare code whenever the redactor is
        // unarmed - which a fresh dashboard webview is - so interpolating it
        // would render "ODOO_INTERNAL" twice for no information.
        setPreflight({
          state: "error",
          code: reportOdooError(err, "open the assign dialog").code,
        });
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [attempt, instance, getClient]);

  /**
   * Step 2, TOKEN-ORDERED on both branches.
   *
   * Concurrent lookups are reachable by this dialog's own argument for the
   * client promise ("two quick contact selections"), so contact A's slower
   * lookup can resolve after contact B's and paint A's deals under B - Confirm
   * then writes `lead_id` for the wrong customer, and the page pushes
   * immediately with no undo. The rejection path matters as much: a stale
   * `setOpportunityError` paints the wrong contact's failure.
   */
  const selectContact = useCallback(
    (contact: OdooContact) => {
      selectionToken.current += 1;
      const token = selectionToken.current;

      setSelected(contact);
      // Reset unconditionally, FIRST. `lead_id` and `contact_id` are written by
      // one statement, so a leadId left over from the previous contact would
      // file the meeting on a deal belonging to somebody else - and contact A's
      // deals would sit on screen under contact B until B's lookup lands.
      setLeadId(null);
      setOpportunities(null);
      setOpportunityError(null);
      setIsLookingUp(true);

      void (async () => {
        try {
          const client = await getClient();
          const rows = await fetchOpportunities(client, contact);
          if (token !== selectionToken.current) return;
          setOpportunities(rows);
          setIsLookingUp(false);
        } catch (err) {
          if (token !== selectionToken.current) return;
          setOpportunityError(reportOdooError(err, "fetch opportunities").code);
          setIsLookingUp(false);
        }
      })();
    },
    [getClient]
  );

  const visible = useMemo(
    // `filterContacts` returns a COPY, which is what makes the in-place sort
    // safe here; sorting its argument would reorder the cache during render.
    () => filterContacts(contacts, query).sort(compareContacts).slice(0, MAX_CONTACT_ROWS),
    [contacts, query]
  );

  const chosenOpportunity =
    leadId === null ? null : (opportunities?.find((o) => o.id === leadId) ?? null);

  // Gated on `ready`, not rendered eagerly: before shouldUseMeetwingsAPI
  // settles the flag is at its initial `false`, so a licensed user would see
  // the warning flash and vanish on every open.
  const providerMissing =
    preflight.state === "ready" && !viaMeetwingsAPI && providerConfig === null;

  return (
    <Dialog
      open
      onOpenChange={(next) => {
        // Escape, the overlay and the header's X all route through here, so
        // Cancel is not the only way out. Cancel writes nothing: the dialog
        // closing is not a state change.
        if (!next) onCancel();
      }}
    >
      <DialogContent className="max-h-[85vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle>
            {row.status === "failed" ? "Reassign this meeting" : "Assign this meeting"}
          </DialogTitle>
          <DialogDescription>
            {`Choose who the meeting from ${meetingDateOf(row)} belongs to. It is sent to Odoo as soon as you confirm.`}
          </DialogDescription>
        </DialogHeader>

        {preflight.state === "loading" && (
          <p className="text-sm text-muted-foreground">Getting your Odoo contacts…</p>
        )}

        {preflight.state === "error" && (
          <div className="flex flex-col items-start gap-2">
            <p className="text-sm text-destructive">
              {`Your Odoo contacts could not be loaded (${preflight.code}). Nothing has been sent.`}
            </p>
            <Button
              size="sm"
              variant="outline"
              onClick={() => setAttempt((n) => n + 1)}
            >
              Try again
            </Button>
          </div>
        )}

        {providerMissing && (
          <p className="text-sm text-destructive">
            No AI provider is set up, so this meeting will be logged with the transcript's
            first lines instead of a summary.
          </p>
        )}

        {preflight.state === "ready" && (
          <div className="flex flex-col gap-2">
            <Input
              type="text"
              aria-label="Search contacts"
              placeholder="Search contacts"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
            />

            <div className="flex max-h-56 flex-col gap-1 overflow-y-auto">
              {visible.length === 0 ? (
                <p className="text-xs text-muted-foreground">No contacts match.</p>
              ) : (
                visible.map((c) => (
                  <button
                    key={c.id}
                    type="button"
                    data-testid="assign-contact"
                    // Reassign exists because a target Odoo archived is
                    // unrecoverable; letting the user pick ANOTHER archived
                    // partner reproduces the same terminal ODOO_FAULT.
                    disabled={!c.active}
                    aria-pressed={selected?.id === c.id}
                    onClick={() => selectContact(c)}
                    className={`rounded-lg px-2 py-1 text-left text-sm hover:bg-muted/50 ${
                      selected?.id === c.id ? "bg-muted" : ""
                    } ${c.active ? "" : "opacity-50"}`}
                  >
                    {c.name}
                    {c.companyName && (
                      <span className="text-muted-foreground">{` (${c.companyName})`}</span>
                    )}
                    {!c.active && (
                      <span className="ml-1 text-xs text-muted-foreground">Archived</span>
                    )}
                  </button>
                ))
              )}
            </div>
          </div>
        )}

        {preflight.state === "ready" && selected !== null && (
          <div className="flex flex-col gap-2 border-t pt-2">
            {isLookingUp && (
              <p className="text-xs text-muted-foreground">Looking up opportunities &amp; leads…</p>
            )}

            {opportunityError !== null && (
              <div className="flex flex-col items-start gap-2">
                {/*
                  NEVER an empty list. fetchOpportunities throws on the first
                  unreadable row and on any transport failure, and rendering
                  that as "no open deals" sends the meeting to the res.partner
                  instead of the crm.lead - silently, and irreversibly once it
                  is `sent`. The second sentence is what stops Confirm being
                  read as "this contact has none".
                */}
                <p className="text-xs text-destructive">
                  {`The opportunities and leads for this contact could not be read (${opportunityError}). Whether ${selected.name} has open deals is unknown.`}
                </p>
                <Button
                  size="sm"
                  variant="outline"
                  onClick={() => selectContact(selected)}
                >
                  Try again
                </Button>
              </div>
            )}

            {opportunityError === null && opportunities !== null && (
              opportunities.length === 0 ? (
                <p className="text-xs text-muted-foreground">
                  No open opportunities or leads for this contact.
                </p>
              ) : (
                <div className="flex flex-col gap-1">
                  {opportunities.map((opp) => (
                    <button
                      key={opp.id}
                      type="button"
                      aria-pressed={leadId === opp.id}
                      onClick={() => setLeadId(opp.id)}
                      className={`flex items-start gap-1.5 rounded-lg px-2 py-1 text-left text-xs hover:bg-muted/50 ${
                        leadId === opp.id ? "bg-muted" : ""
                      }`}
                    >
                      {/* Held, not conditionally rendered - see ContactPicker. */}
                      <CheckIcon
                        aria-hidden
                        className={`mt-0.5 h-3 w-3 shrink-0 text-primary ${
                          leadId === opp.id ? "" : "invisible"
                        }`}
                      />
                      <span>
                        {/* A prefix, and only on leads - see ContactPicker. */}
                        {opp.type === "lead" && (
                          <span className="text-muted-foreground">{"Lead · "}</span>
                        )}
                        {opp.name}
                        {opp.stageName && (
                          <span className="text-muted-foreground">{` · ${opp.stageName}`}</span>
                        )}
                        {/* Partner, or an unlinked lead free text - see ContactPicker. */}
                        {(opp.partnerName ?? opp.contactName ?? opp.email) && (
                          <span className="text-muted-foreground">
                            {` · ${opp.partnerName ?? opp.contactName ?? opp.email}`}
                          </span>
                        )}
                      </span>
                    </button>
                  ))}
                  <button
                    type="button"
                    aria-pressed={leadId === null}
                    onClick={() => setLeadId(null)}
                    className={`flex items-start gap-1.5 rounded-lg px-2 py-1 text-left text-xs hover:bg-muted/50 ${
                      leadId === null ? "bg-muted" : "text-muted-foreground"
                    }`}
                  >
                    <CheckIcon
                      aria-hidden
                      className={`mt-0.5 h-3 w-3 shrink-0 text-primary ${
                        leadId === null ? "" : "invisible"
                      }`}
                    />
                    <span>Contact record only</span>
                  </button>
                </div>
              )
            )}

            {/*
              Which RECORD this lands on, spelled out. The difference between a
              res.partner and a crm.lead is invisible in the button label and
              cannot be undone once the row is `sent`.
            */}
            <p className="text-xs">
              {chosenOpportunity === null
                ? `This meeting will be logged on ${selected.name}'s contact record.`
                : // Two branches, not the picker's three: `leadId` here is local
                  // state set from the list that is on screen, so the record it
                  // names is always present to name its own kind.
                  `This meeting will be logged on the ${chosenOpportunity.type} ${chosenOpportunity.name}.`}
            </p>
          </div>
        )}

        <DialogFooter>
          <Button variant="outline" onClick={onCancel}>
            Cancel
          </Button>
          <Button
            disabled={selected === null}
            onClick={() => {
              if (selected === null) return;
              onConfirm({ contactId: selected.id, leadId, providerConfig });
            }}
          >
            Log this meeting
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
