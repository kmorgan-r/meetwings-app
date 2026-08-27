import { memo, useMemo, useState } from "react";
import { Button, Input, Popover, PopoverContent, PopoverTrigger } from "@/components";
import { compareContacts, filterContacts } from "@/lib/odoo";
import type { OdooContact, OdooOpportunity } from "@/types";
import { CheckIcon, StarIcon, UsersIcon } from "lucide-react";

export const MAX_RENDERED_ROWS = 100;

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

export interface ContactPickerProps {
  contactId: number | null; // primitive, NOT an object - see below
  leadId: number | null; // primitive
  contactName: string | null; // primitive
  cache: PickerCacheState;
  opportunities: OdooOpportunity[] | null; // null = not looked up yet
  opportunityError: string | null; // an ODOO_* code, or null
  isLookingUp: boolean;
  // EVERY handler that does async work returns its promise. See the note below:
  // Task 12's tests await these and then assert synchronously on the result.
  onSelect: (contact: OdooContact) => Promise<void>; // useCallback-stable
  onSelectOpportunity: (leadId: number | null) => Promise<void>;
  onToggleColleague: (contact: OdooContact) => Promise<void>;
  onRetryOpportunities: () => Promise<void>; // the hook owns the contact, not us
  onRefresh: () => Promise<void>;
  onOpenSettings: () => void; // opens the dashboard webview; sync
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
  contactName,
  cache,
  opportunities,
  opportunityError,
  isLookingUp,
  onSelect,
  onSelectOpportunity,
  onToggleColleague,
  onRetryOpportunities,
  onRefresh,
  onOpenSettings,
  open,
  onOpenChange,
}: ContactPickerProps) {
  const [query, setQuery] = useState("");

  const visible = useMemo(() => {
    if (cache.kind !== "ready") return [];
    return filterContacts(cache.contacts, query).sort(compareContacts).slice(0, MAX_RENDERED_ROWS);
  }, [cache, query]);

  /**
   * WHICH RECORD this meeting lands on, spelled out - the same sentence the
   * dashboard's AssignDialog carries, and needed more here than there: this is
   * the live-meeting path, res.partner vs crm.lead is invisible in the button
   * labels, and it cannot be undone once the row is `sent`.
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
        : // NEUTRAL on purpose. Only `lead_id` is persisted, never its kind, so
          // in this branch - a rehydrated target, or a record the lookup no
          // longer returns - there is nothing to tell a lead from an
          // opportunity, and naming either would be a guess about the record
          // this meeting is going to be written to.
          `the lead or opportunity you picked earlier (#${leadId})`;

  return (
    <Popover open={open} onOpenChange={onOpenChange}>
      <PopoverTrigger asChild>
        <button
          type="button"
          className={`px-2 py-1 rounded-md text-xs font-medium transition-colors ${
            contactId !== null ? "bg-primary/10 text-primary" : "bg-muted/50 text-muted-foreground"
          }`}
        >
          {contactName ?? "Who are you meeting?"}
        </button>
      </PopoverTrigger>
      <PopoverContent className="w-80 p-3">
        <div className="flex flex-col gap-2">
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
                    <div key={contact.id} data-testid="contact-row" className="flex items-center gap-1">
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
                    </div>
                  ))}
                  {visible.length === MAX_RENDERED_ROWS && (
                    <p className="text-[10px] text-muted-foreground">Refine your search to see more</p>
                  )}
                </>
              )}
            </div>
          )}

          {cache.kind !== "not-configured" && (
            <Button size="sm" variant="ghost" className="text-xs" onClick={onRefresh}>
              Refresh
            </Button>
          )}

          {contactId !== null && (
            <div className="flex flex-col gap-1 border-t pt-2">
              {isLookingUp ? (
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
                          Only leads are marked - an unmarked row is a deal,
                          which is what every row in this list used to be.
                        */}
                        {opp.type === "lead" && (
                          <span className="text-muted-foreground">Lead &middot; </span>
                        )}
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
              <p className="text-[11px]">{`This meeting will be logged on ${targetRecord}.`}</p>
            </div>
          )}
        </div>
      </PopoverContent>
    </Popover>
  );
});
