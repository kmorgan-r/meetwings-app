import { Fragment, memo, useEffect, useMemo, useState } from "react";
import { AddToggle, Button, Input, Popover, PopoverContent, PopoverTrigger } from "@/components";
import { compareContacts, filterContacts, kindLabel, MAX_TARGETS } from "@/lib/odoo";
import type { OdooContact, OdooOpportunity, SelectedTarget, SelectedTargets } from "@/types";
import { CheckIcon, ChevronDownIcon, StarIcon, UsersIcon } from "lucide-react";

export const MAX_RENDERED_ROWS = 100;

/**
 * How long the search box sits still before the lead search goes out.
 *
 * The contact list filters offline against a synced cache and updates on every
 * keystroke; the lead search is a live XML-RPC round trip, and firing one per
 * keystroke would put a dozen calls on the wire for one word.
 */
export const LEAD_SEARCH_DEBOUNCE_MS = 350;

/**
 * `not-configured` is a SEPARATE state from `never-synced`.
 *
 * ODOO_NOT_CONFIGURED is the very first thing runSync can throw, and it is the
 * state most users are in the first time they open the picker. Folding it into
 * `never-synced` tells someone who has entered no credentials that their
 * contacts have "not synced yet" - which is true, unhelpful, and points them at
 * a Refresh button that can only fail again. It needs its own sentence and its
 * own link to Settings.
 *
 * `sync-failed` is the EMPTY-cache failure, and `ready.lastError` is the
 * populated-cache one. They must not be the same variant: `last_error_code`
 * persists until a run completes, so a laptop that is offline at every app
 * start would be locked out of a perfectly good local list forever if a failure
 * replaced the contacts. A failure over a populated cache is a BANNER, not a
 * substitute for the rows - the same reasoning that makes ODOO_SYNC_BUSY leave
 * the cache alone.
 */
export type PickerCacheState =
  | { kind: "ready"; contacts: OdooContact[]; lastError: string | null }
  | { kind: "not-configured" }
  | { kind: "never-synced" }
  | { kind: "sync-failed"; code: string };

/**
 * Task 12 built this file's own `+ add` / `✓ added` control; Task 14
 * extracted it to `@/components/AddToggle` (imported above) so `AssignDialog`
 * - the dashboard's own multi-target picker - could use the identical
 * control instead of reimplementing it.
 */

/** `null`/cache-fallback chain, the same shape Task 13's targetNameOf uses. */
function nameForTarget(target: SelectedTarget, contacts: OdooContact[]): string {
  if (target.name) return target.name;
  if (target.model === "res.partner") {
    return contacts.find((c) => c.id === target.resId)?.name ?? `Contact #${target.resId}`;
  }
  return `Lead or opportunity #${target.resId}`;
}

/**
 * `SelectedTarget` carries `model`, not `type` ("lead" vs "opportunity") - a
 * crm.lead row coalesced down from an `OdooOpportunity` loses that
 * distinction, so naming one over the other here would be a guess about the
 * record this meeting is about to be written to. `kindLabel` (used elsewhere
 * in this file, where an `OdooOpportunity` with a real `type` is still in
 * hand) is not reachable for this - by the time something is a flat
 * `SelectedTarget`, the kind is already gone.
 *
 * NEUTRAL wording, matching this file's own single-select `targetRecord`
 * sentence below (`the lead or opportunity X` / `... you picked earlier
 * (#N)`). Final whole-branch review, Important 5: this function used to say
 * "the lead X" for every crm.lead target regardless of which one it actually
 * is - a regression against e9df310 ("say Opportunity on a deal, not just
 * Lead on a lead"), and, for an unnamed target, a broken double-name
 * ("the lead Lead or opportunity #123") built by prefixing `nameForTarget`'s
 * own generic-placeholder fallback. Two branches here, not a prefix onto
 * `nameForTarget`, so that placeholder is never embedded inside this one.
 */
function describeTargetForSentence(target: SelectedTarget, contacts: OdooContact[]): string {
  if (target.model !== "crm.lead") return nameForTarget(target, contacts);
  return target.name !== null
    ? `the lead or opportunity ${target.name}`
    : `the lead or opportunity you picked earlier (#${target.resId})`;
}

function joinWithAnd(items: string[]): string {
  if (items.length <= 1) return items.join("");
  if (items.length === 2) return `${items[0]} and ${items[1]}`;
  return `${items.slice(0, -1).join(", ")}, and ${items[items.length - 1]}`;
}

export interface ContactPickerProps {
  contactId: number | null; // primitive, NOT an object - see below
  leadId: number | null; // primitive
  /**
   * The chosen crm.lead's name, PERSISTED alongside its id.
   *
   * The only thing that can name a lead-only target. Its contact name comes
   * from the synced cache and a lead is not in that cache by definition, so
   * without this the trigger reads "Who are you meeting?" while a meeting is
   * queued against a real record.
   */
  leadName: string | null;
  contactName: string | null; // primitive
  cache: PickerCacheState;
  opportunities: OdooOpportunity[] | null; // null = not looked up yet
  opportunityError: string | null; // an ODOO_* code, or null
  isLookingUp: boolean;
  // The lead SEARCH - a different read from the opportunity lookup above, with
  // its own in-flight and error state. null = nothing searched for yet.
  leadResults: OdooOpportunity[] | null;
  leadSearchError: string | null;
  isSearchingLeads: boolean;
  onSelectLead: (lead: OdooOpportunity) => Promise<void>;
  onSearchLeads: (query: string) => Promise<void>;
  // EVERY handler that does async work returns its promise. See the note below:
  // Task 12's tests await these and then assert synchronously on the result.
  onSelect: (contact: OdooContact) => Promise<void>; // useCallback-stable
  onSelectOpportunity: (leadId: number | null) => Promise<void>;
  onToggleColleague: (contact: OdooContact) => Promise<void>;
  onRetryOpportunities: () => Promise<void>; // the hook owns the contact, not us
  onRefresh: () => Promise<void>;
  onOpenSettings: () => void; // opens the dashboard webview; sync
  /**
   * Task 12: the flat multi-target list (Task 11's `useOdooTarget.targets`).
   * Separate from `contactId`/`leadId`/`opportunities` above, which are the
   * single-select flow's own primitives and untouched by this task. Task 14
   * retired that flow's own shared type in favour of one local to
   * `useOdooTarget.ts`; this component's own props never named it.
   */
  targets: SelectedTargets;
  onAddTarget: (t: SelectedTarget) => Promise<{ ok: boolean; reason?: "cap" }>;
  // Two positional arguments, mirroring useOdooTarget.ts's own
  // removeTarget(model, resId) exactly (verified against source) rather than
  // the single-object shape onAddTarget takes.
  onRemoveTarget: (model: SelectedTarget["model"], resId: number) => Promise<void>;
  /**
   * Drops EVERY destination in one action. Fired only after the inline
   * confirmation below - the hook behind it wipes the whole instance's
   * `odoo_selected_targets`, so it is not something a stray click may do.
   */
  onClearTargets: () => Promise<void>;
  /** Runs (or joins) a "Logging to" row's own per-contact deal lookup. */
  onExpandContact: (contactId: number) => Promise<void>;
  opportunitiesFor: (contactId: number) => OdooOpportunity[] | null;
  errorFor: (contactId: number) => string | null;
  onRetryContactOpportunities: (contactId: number) => Promise<void>;
  // CONTROLLED, not local state. The main window is 600x54 and non-resizable
  // (src-tauri/tauri.conf.json), and grows only through useCompletion's
  // resize effect - the one caller of resizeWindow(true), driven by a fixed
  // flag list mirroring isFilesPopoverOpen (see Files.tsx). A popover that
  // owns its own `open` state is invisible to that effect: Radix portals
  // several hundred pixels of content into a 54px-tall webview with nothing
  // to grow it first. The caller (useCompletion, via <Completion />) must be
  // able to observe every open/close so it can resize around this exact
  // popover the same way it already does for Files/mic/message-history.
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

export const ContactPicker = memo(function ContactPicker({
  contactId,
  leadId,
  leadName,
  contactName,
  cache,
  opportunities,
  opportunityError,
  isLookingUp,
  leadResults,
  leadSearchError,
  isSearchingLeads,
  onSelectLead,
  onSearchLeads,
  onSelect,
  onSelectOpportunity,
  onToggleColleague,
  onRetryOpportunities,
  onRefresh,
  onOpenSettings,
  targets,
  onAddTarget,
  onRemoveTarget,
  onClearTargets,
  onExpandContact,
  opportunitiesFor,
  errorFor,
  onRetryContactOpportunities,
  open,
  onOpenChange,
}: ContactPickerProps) {
  const [query, setQuery] = useState("");
  // Task 12: which contact rows' own deal disclosure is open. Purely local
  // UI state - the underlying lookup itself is cached per contact id inside
  // useOdooTarget (opportunitiesFor/errorFor survive a collapse/re-expand),
  // this Set only tracks which rows currently show that cache on screen.
  const [expandedContacts, setExpandedContacts] = useState<Set<number>>(new Set());
  /**
   * Whether the "Clear all" confirmation is armed. A two-step swap inside the
   * "Logging to" box rather than a <Dialog>: this popover renders into a
   * window tauri.conf.json fixes at 600x54, grown only by useCompletion's
   * flag-driven resize effect, and a modal portalled over that has no room
   * and fights this popover for the focus trap. The reset below matters
   * because ContactPicker stays MOUNTED when the popover closes - without it
   * the armed warning would be the first thing on screen on reopen.
   */
  const [confirmingClear, setConfirmingClear] = useState(false);
  useEffect(() => {
    if (!open || targets.length === 0) setConfirmingClear(false);
  }, [open, targets.length]);

  const toggleExpand = (contactId: number) => {
    const isExpanding = !expandedContacts.has(contactId);
    setExpandedContacts((prev) => {
      const next = new Set(prev);
      if (next.has(contactId)) next.delete(contactId);
      else next.add(contactId);
      return next;
    });
    // Fired OUTSIDE the setExpandedContacts updater, not inside it: a state
    // updater can run more than once for the same commit (StrictMode), and a
    // side effect inside one would double-fire the lookup.
    if (isExpanding) void onExpandContact(contactId);
  };

  /**
   * The live half of the search box.
   *
   * Debounced HERE rather than in the hook because the query lives here - and
   * the cleanup is what makes it a debounce rather than a delay: every
   * keystroke cancels the pending timer, so only the last one in a burst is
   * ever sent. `void` because this runs from a timer, where a rejection would
   * be unhandled; `onSearchLeads` is documented never to reject.
   */
  useEffect(() => {
    const timer = setTimeout(() => {
      void onSearchLeads(query);
    }, LEAD_SEARCH_DEBOUNCE_MS);
    return () => clearTimeout(timer);
  }, [query, onSearchLeads]);

  const visible = useMemo(() => {
    if (cache.kind !== "ready") return [];
    return filterContacts(cache.contacts, query).sort(compareContacts).slice(0, MAX_RENDERED_ROWS);
  }, [cache, query]);

  /**
   * WHICH RECORD this meeting lands on, spelled out, for the single-select
   * flow (`leadId`/`contactId`, not the flat `targets` list below). Task 14
   * retired the dashboard AssignDialog's own version of this sentence in
   * favor of the multi-target `destinationSentence` further down - this one
   * is needed here regardless: this is the live-meeting path, res.partner vs
   * crm.lead is invisible in the button labels, and it cannot be undone once
   * the row is `sent`.
   *
   * Three branches, not two. `leadId` is persisted in odoo_selected_target
   * while `opportunities` is in-memory, so a target rehydrated after a
   * <Completion /> remount arrives holding a lead id with no list to name it
   * from - and a lookup that DID run comes back without it once the deal is
   * won or lost. Falling back to "contact record" in either case would state
   * the opposite of what slice 2 will write.
   */
  const chosenOpportunity =
    leadId === null ? null : (opportunities?.find((o) => o.id === leadId) ?? null);
  const targetRecord =
    leadId === null
      ? // `contactName` is resolved from the CACHE, so it is null whenever the
        // selected contact is not in it - a target that outlived a sync, or a
        // cache still loading. The sentence still has to name a record.
        `${contactName ?? "the selected contact"}'s contact record`
      : chosenOpportunity !== null
        ? `the ${chosenOpportunity.type} ${chosenOpportunity.name}`
        : // The persisted name, when there is one. NEUTRAL between the two
          // kinds either way: only `lead_id` and `lead_name` are stored, never
          // the kind, so naming one would be a guess about the record this
          // meeting is about to be written to.
          leadName !== null
          ? `the lead or opportunity ${leadName}`
          : `the lead or opportunity you picked earlier (#${leadId})`;

  // Task 12: the flat multi-target list's own trigger/destination text. Full
  // unfiltered cache (not `visible`, which drops rows the search query
  // excludes) - a target's own contact can be scrolled out of the current
  // filter without stopping being a target.
  const allContacts = cache.kind === "ready" ? cache.contacts : [];
  const atCap = targets.length >= MAX_TARGETS;
  const triggerLabel =
    targets.length === 0
      ? contactName ?? leadName ?? "Who are you meeting?"
      : targets.length === 1
        ? nameForTarget(targets[0], allContacts)
        : `${nameForTarget(targets[0], allContacts)} + ${targets.length - 1} more`;
  const destinationSentence =
    targets.length === 0
      ? null
      : `This meeting will be logged on ${targets.length} record${
          targets.length === 1 ? "" : "s"
        }: ${joinWithAnd(targets.map((t) => describeTargetForSentence(t, allContacts)))}.`;

  return (
    <Popover open={open} onOpenChange={onOpenChange}>
      <PopoverTrigger asChild>
        <button
          type="button"
          data-testid="contact-picker-trigger"
          className={`px-2 py-1 rounded-md text-xs font-medium transition-colors ${
            contactId !== null || leadId !== null || targets.length > 0
              ? "bg-primary/10 text-primary"
              : "bg-muted/50 text-muted-foreground"
          }`}
        >
          {triggerLabel}
        </button>
      </PopoverTrigger>
      <PopoverContent className="w-80 p-3">
        <div className="flex flex-col gap-2">
          {targets.length > 0 && (
            <div
              /*
                The height cap is dropped while confirming: a warning the user
                has to scroll to finish reading is a warning they will not
                read. The destination list it replaces is the thing the cap
                exists for, and it is not on screen at the same time.
              */
              className={`flex flex-col gap-1 border-b pb-2 ${
                confirmingClear ? "" : "max-h-24 overflow-y-auto"
              }`}
              data-testid="logging-to-section"
            >
              {confirmingClear ? (
                <>
                  <p className="text-[10px] uppercase tracking-wide text-destructive">
                    Clear all destinations?
                  </p>
                  {/*
                    Claims FUTURE behaviour only. Clearing the selection does
                    not touch meetings already sitting in meeting_log_queue,
                    and copy implying otherwise would send someone hunting the
                    queue page for damage that never happened.
                  */}
                  <p className="text-[11px]">
                    {`Removes all ${targets.length} destination${
                      targets.length === 1 ? "" : "s"
                    }. Nothing will be logged to Odoo until you pick again. Meetings already queued are unaffected.`}
                  </p>
                  <div className="flex gap-1 pt-1">
                    <Button
                      size="sm"
                      variant="destructive"
                      className="h-6 text-[11px]"
                      data-testid="confirm-clear-targets"
                      onClick={() => {
                        setConfirmingClear(false);
                        void onClearTargets();
                      }}
                    >
                      Clear all
                    </Button>
                    <Button
                      size="sm"
                      variant="ghost"
                      className="h-6 text-[11px]"
                      onClick={() => setConfirmingClear(false)}
                    >
                      Cancel
                    </Button>
                  </div>
                </>
              ) : (
                <>
                  <div className="flex items-center justify-between gap-2">
                    <p className="text-[10px] uppercase tracking-wide text-muted-foreground">
                      {`Logging to (${targets.length})${atCap ? " · limit reached" : ""}`}
                    </p>
                    <button
                      type="button"
                      data-testid="clear-targets"
                      onClick={() => setConfirmingClear(true)}
                      className="text-[10px] uppercase tracking-wide text-muted-foreground hover:text-destructive"
                    >
                      Clear all
                    </button>
                  </div>
                  <p className="text-[11px]">{destinationSentence}</p>
                </>
              )}
            </div>
          )}
          <Input
            type="text"
            placeholder="Search contacts"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            className="h-7 text-xs"
          />

          {cache.kind === "ready" && cache.lastError !== null && (
            <div className="text-[11px] text-destructive">Last sync failed &mdash; {cache.lastError}</div>
          )}

          {cache.kind === "not-configured" && (
            <div className="flex flex-col gap-2 text-xs text-muted-foreground">
              <p>Odoo is not set up yet</p>
              <Button size="sm" variant="outline" onClick={onOpenSettings}>
                Open Settings
              </Button>
            </div>
          )}

          {cache.kind === "never-synced" && (
            <div className="flex flex-col gap-2 text-xs text-muted-foreground">
              <p>Contacts have not synced yet</p>
            </div>
          )}

          {cache.kind === "sync-failed" && (
            <div className="flex flex-col gap-2 text-xs text-muted-foreground">
              <p>
                Last sync failed &mdash; {cache.code}
              </p>
            </div>
          )}

          {cache.kind === "ready" && (
            <div className="flex flex-col gap-1 max-h-64 overflow-y-auto">
              {visible.length === 0 ? (
                <p className="text-xs text-muted-foreground">No contacts match</p>
              ) : (
                <>
                  {visible.map((contact) => (
                    <Fragment key={contact.id}>
                      {/*
                        Button order is load-bearing: existing tests address
                        the select button and the star by POSITION
                        (rowButton() -> index 0, the colleague-star tests ->
                        index 1), so the two Task 12 controls are appended
                        AFTER the star rather than interleaved.
                      */}
                      <div data-testid="contact-row" className="flex items-center gap-1">
                        <button
                          type="button"
                          disabled={!contact.active}
                          onClick={() => onSelect(contact)}
                          className={`flex-1 text-left text-xs px-2 py-1 rounded-md hover:bg-muted/50 ${
                            !contact.active ? "opacity-50" : ""
                          }`}
                        >
                          {contact.name}
                          {contact.companyName && (
                            <span className="text-muted-foreground"> ({contact.companyName})</span>
                          )}
                          {!contact.active && (
                            <span className="ml-1 text-[10px] text-muted-foreground">Archived</span>
                          )}
                        </button>
                        <button
                          type="button"
                          aria-label={`Mark ${contact.name} as a colleague`}
                          aria-pressed={contact.isColleague}
                          onClick={() => onToggleColleague(contact)}
                          className="p-1 rounded-md hover:bg-muted/50"
                        >
                          <StarIcon
                            className={`h-3.5 w-3.5 ${
                              contact.isColleague ? "fill-primary text-primary" : "text-muted-foreground"
                            }`}
                          />
                        </button>
                        <AddToggle
                          model="res.partner"
                          resId={contact.id}
                          name={contact.name}
                          targets={targets}
                          atCap={atCap}
                          disabled={!contact.active}
                          onAdd={onAddTarget}
                          onRemove={onRemoveTarget}
                        />
                        <button
                          type="button"
                          aria-label={`expand ${contact.name}`}
                          aria-expanded={expandedContacts.has(contact.id)}
                          onClick={() => toggleExpand(contact.id)}
                          className="p-1 rounded-md hover:bg-muted/50 text-muted-foreground"
                        >
                          <ChevronDownIcon
                            className={`h-3.5 w-3.5 transition-transform ${
                              expandedContacts.has(contact.id) ? "rotate-180" : ""
                            }`}
                          />
                        </button>
                      </div>
                      {/*
                        The per-contact deal DISCLOSURE - keyed by contact id
                        via useOdooTarget's own rowCache/rowError
                        (opportunitiesFor/errorFor), independent of the
                        single-flow `opportunities` list above. A deal added
                        from here is its OWN flat target, never attached to
                        the contact it was found under.
                      */}
                      {expandedContacts.has(contact.id) && (
                        <div
                          data-testid="contact-deals"
                          className="pl-3 pb-1 flex flex-col gap-1"
                        >
                          {contact.isColleague ? (
                            // A colleague is still a valid target - onSelect
                            // commits one exactly like anyone else. Only the
                            // crm.lead LOOKUP is skipped for a colleague
                            // (expandContact's own early return), so this row
                            // states that, rather than implying the contact
                            // itself can't be logged.
                            <p className="text-[11px] text-muted-foreground">
                              No deal lookup for colleagues.
                            </p>
                          ) : errorFor(contact.id) !== null ? (
                            <div className="flex flex-col gap-1 text-[11px] text-muted-foreground">
                              <p>Deals unavailable &mdash; {errorFor(contact.id)}</p>
                              <Button
                                size="sm"
                                variant="outline"
                                onClick={() => onRetryContactOpportunities(contact.id)}
                              >
                                Retry
                              </Button>
                            </div>
                          ) : opportunitiesFor(contact.id) === null ? (
                            <p className="text-[11px] text-muted-foreground">
                              Looking up deals&hellip;
                            </p>
                          ) : opportunitiesFor(contact.id)?.length === 0 ? (
                            <p className="text-[11px] text-muted-foreground">No open deals</p>
                          ) : (
                            opportunitiesFor(contact.id)?.map((opp) => (
                              <div key={opp.id} className="flex items-center gap-1">
                                <span className="flex-1 text-[11px] text-muted-foreground truncate">
                                  {kindLabel(opp.type)} &middot; {opp.name}
                                </span>
                                <AddToggle
                                  model="crm.lead"
                                  resId={opp.id}
                                  name={opp.name}
                                  targets={targets}
                                  atCap={atCap}
                                  onAdd={onAddTarget}
                                  onRemove={onRemoveTarget}
                                />
                              </div>
                            ))
                          )}
                        </div>
                      )}
                    </Fragment>
                  ))}
                  {visible.length === MAX_RENDERED_ROWS && (
                    <p className="text-[10px] text-muted-foreground">Refine your search to see more</p>
                  )}
                </>
              )}
            </div>
          )}

          {/*
            THE ONLY WAY TO REACH AN UNCONVERTED LEAD. The list above searches
            synced res.partner records; Odoo default for a lead is free-text
            contact details and no partner at all, so such a record has no
            contact to pick first and no lookup to hang off one.

            Rendered under the contacts rather than mixed into them: these are
            live results for the same query, they arrive later than the offline
            filter above, and reordering the contact list as they land would
            move a row out from under a click.
          */}
          {(isSearchingLeads || leadSearchError !== null || leadResults !== null) && (
            <div className="flex flex-col gap-1 border-t pt-2">
              <p className="text-[10px] uppercase tracking-wide text-muted-foreground">
                Leads &amp; opportunities
              </p>

              {leadSearchError !== null ? (
                <p className="text-[11px] text-destructive">
                  {`Search failed \u2014 ${leadSearchError}`}
                </p>
              ) : isSearchingLeads ? (
                <p className="text-[11px] text-muted-foreground">Searching&hellip;</p>
              ) : leadResults !== null && leadResults.length === 0 ? (
                <p className="text-[11px] text-muted-foreground">No matches</p>
              ) : (
                <div
                  data-testid="lead-search-results"
                  className="flex flex-col gap-1 max-h-40 overflow-y-auto"
                >
                  {(leadResults ?? []).map((lead) => (
                    // The testid moved from the button to this wrapper (Task
                    // 12): each row now holds the OLD single-flow select
                    // button PLUS the new add/remove toggle, and the select
                    // button stays first (index 0), the same convention
                    // contact rows use.
                    <div key={lead.id} data-testid="lead-search-row" className="flex items-center gap-1">
                      <button
                        type="button"
                        aria-pressed={leadId === lead.id}
                        onClick={() => onSelectLead(lead)}
                        className={`flex-1 flex items-start gap-1.5 text-left text-xs px-2 py-1 rounded-md hover:bg-muted/50 ${
                          leadId === lead.id ? "bg-muted" : ""
                        }`}
                      >
                        <CheckIcon
                          aria-hidden
                          className={`h-3 w-3 mt-0.5 shrink-0 text-primary ${
                            leadId === lead.id ? "" : "invisible"
                          }`}
                        />
                        <span>
                          <span className="text-muted-foreground">
                            {kindLabel(lead.type)} &middot;{" "}
                          </span>
                          {lead.name}
                          {(lead.partnerName ?? lead.contactName ?? lead.email) && (
                            <span className="text-muted-foreground">
                              {" "}
                              &middot; {lead.partnerName ?? lead.contactName ?? lead.email}
                            </span>
                          )}
                        </span>
                      </button>
                      <AddToggle
                        model="crm.lead"
                        resId={lead.id}
                        name={lead.name}
                        targets={targets}
                        atCap={atCap}
                        onAdd={onAddTarget}
                        onRemove={onRemoveTarget}
                      />
                    </div>
                  ))}
                </div>
              )}
            </div>
          )}

          {cache.kind !== "not-configured" && (
            <Button size="sm" variant="ghost" className="text-xs" onClick={onRefresh}>
              Refresh
            </Button>
          )}

          {/*
            `contactId !== null || leadId !== null`, because a lead picked out
            of the search HAS no contact. Gating on the contact alone hid the
            destination sentence for exactly the target that most needs it -
            the one whose record cannot be named from the contact cache at all.
          */}
          {(contactId !== null || leadId !== null) && (
            <div className="flex flex-col gap-1 border-t pt-2">
              {/*
                The lookup itself stays contact-gated: it hangs off a res.partner
                and there is nothing to run it against without one.
              */}
              {contactId === null ? null : isLookingUp ? (
                <p className="text-xs text-muted-foreground flex items-center gap-1">
                  <UsersIcon className="h-3 w-3 animate-pulse" />
                  Looking up opportunities &amp; leads&hellip;
                </p>
              ) : opportunityError !== null ? (
                <div className="flex flex-col gap-1 text-xs text-muted-foreground">
                  <p>Opportunities &amp; leads unavailable &mdash; {opportunityError}</p>
                  <Button size="sm" variant="outline" onClick={onRetryOpportunities}>
                    Retry
                  </Button>
                </div>
              ) : opportunities === null ? (
                <div className="flex flex-col gap-1 text-xs text-muted-foreground">
                  <p>Opportunities &amp; leads not looked up</p>
                  <Button size="sm" variant="outline" onClick={onRetryOpportunities}>
                    Look up
                  </Button>
                </div>
              ) : (
                /*
                  max-h + overflow, matching the contacts list above. This
                  popover renders into a window fixed at 600x54 that grows only
                  through useCompletion's resize effect, so an unbounded list -
                  now carrying leads as well as deals - pushes the destination
                  sentence below it off the bottom, which is the one line that
                  says where this meeting is going.
                */
                <div data-testid="opportunity-list" className="flex flex-col gap-1 max-h-40 overflow-y-auto">
                  {opportunities.map((opp) => (
                    <button
                      key={opp.id}
                      type="button"
                      aria-pressed={leadId === opp.id}
                      onClick={() => onSelectOpportunity(opp.id)}
                      className={`flex items-start gap-1.5 text-left text-xs px-2 py-1 rounded-md hover:bg-muted/50 ${
                        leadId === opp.id ? "bg-muted" : ""
                      }`}
                    >
                      {/*
                        `invisible`, NOT a conditional render: the tick holds its
                        column on every row, so choosing one does not shunt the
                        list sideways. aria-hidden because aria-pressed on the
                        button already carries this to a screen reader, and a
                        second announcement of the same fact is noise.
                      */}
                      <CheckIcon
                        aria-hidden
                        data-testid="lead-check"
                        className={`h-3 w-3 mt-0.5 shrink-0 text-primary ${
                          leadId === opp.id ? "" : "invisible"
                        }`}
                      />
                      <span>
                        {/*
                          A PREFIX, not a suffix: it is the first thing to scan
                          down the column, and leads and opportunities sit
                          interleaved in write_date order rather than grouped.
                        */}
                        <span className="text-muted-foreground">
                          {kindLabel(opp.type)} &middot;{" "}
                        </span>
                        {opp.name}
                        {opp.stageName && <span className="text-muted-foreground"> &middot; {opp.stageName}</span>}
                        {/*
                          WHO the record is about. `partnerName` for anything
                          Odoo has linked to a partner; for an unlinked lead
                          there is no partner to name, and its own free text is
                          the only thing on the row tying it to the contact
                          that was just selected - which for a heuristic match
                          is exactly what the user needs to see before picking.
                        */}
                        {(opp.partnerName ?? opp.contactName ?? opp.email) && (
                          <span className="text-muted-foreground">
                            {" "}
                            &middot; {opp.partnerName ?? opp.contactName ?? opp.email}
                          </span>
                        )}
                      </span>
                    </button>
                  ))}
                  <button
                    type="button"
                    aria-pressed={leadId === null}
                    onClick={() => onSelectOpportunity(null)}
                    className={`flex items-start gap-1.5 text-left text-xs px-2 py-1 rounded-md hover:bg-muted/50 ${
                      leadId === null ? "bg-muted" : "text-muted-foreground"
                    }`}
                  >
                    <CheckIcon
                      aria-hidden
                      data-testid="lead-check"
                      className={`h-3 w-3 mt-0.5 shrink-0 text-primary ${
                        leadId === null ? "" : "invisible"
                      }`}
                    />
                    <span>Contact record only</span>
                  </button>
                </div>
              )}
              {/*
                Final review, Important 4: `commit` mirrors every single-select
                into `targets` and `addTarget` never clears the single-select
                state, so BOTH this block's own gate (contactId/leadId set) and
                the flat multi-target sentence's gate (targets.length > 0)
                stay true after any single-select - the two destination
                sentences could render at once and contradict each other. This
                one now defers to the flat list once it holds anything: that
                sentence (and `Logging to (N)` above it) is the one honest
                summary once multi-select is in play.
              */}
              {targets.length === 0 && (
                <p className="text-[11px]">{`This meeting will be logged on ${targetRecord}.`}</p>
              )}
            </div>
          )}
        </div>
      </PopoverContent>
    </Popover>
  );
});
