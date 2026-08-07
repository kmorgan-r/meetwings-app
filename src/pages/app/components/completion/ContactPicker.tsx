import { memo, useMemo, useState } from "react";
import { Button, Input, Popover, PopoverContent, PopoverTrigger } from "@/components";
import { compareContacts, filterContacts } from "@/lib/odoo";
import type { OdooContact, OdooOpportunity } from "@/types";
import { StarIcon, UsersIcon } from "lucide-react";

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
}

export const ContactPicker = memo(function ContactPicker({
  contactId,
  leadId: _leadId,
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
}: ContactPickerProps) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");

  const visible = useMemo(() => {
    if (cache.kind !== "ready") return [];
    return filterContacts(cache.contacts, query).sort(compareContacts).slice(0, MAX_RENDERED_ROWS);
  }, [cache, query]);

  return (
    <Popover open={open} onOpenChange={setOpen}>
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
                  Looking up opportunities&hellip;
                </p>
              ) : opportunityError !== null ? (
                <div className="flex flex-col gap-1 text-xs text-muted-foreground">
                  <p>Opportunities unavailable &mdash; {opportunityError}</p>
                  <Button size="sm" variant="outline" onClick={onRetryOpportunities}>
                    Retry
                  </Button>
                </div>
              ) : opportunities === null ? (
                <div className="flex flex-col gap-1 text-xs text-muted-foreground">
                  <p>Opportunities not looked up</p>
                  <Button size="sm" variant="outline" onClick={onRetryOpportunities}>
                    Look up
                  </Button>
                </div>
              ) : (
                <div className="flex flex-col gap-1">
                  {opportunities.map((opp) => (
                    <button
                      key={opp.id}
                      type="button"
                      onClick={() => onSelectOpportunity(opp.id)}
                      className="text-left text-xs px-2 py-1 rounded-md hover:bg-muted/50"
                    >
                      {opp.name}
                      {opp.stageName && <span className="text-muted-foreground"> &middot; {opp.stageName}</span>}
                      {opp.partnerName && (
                        <span className="text-muted-foreground"> &middot; {opp.partnerName}</span>
                      )}
                    </button>
                  ))}
                  <button
                    type="button"
                    onClick={() => onSelectOpportunity(null)}
                    className="text-left text-xs px-2 py-1 rounded-md hover:bg-muted/50 text-muted-foreground"
                  >
                    Contact record only
                  </button>
                </div>
              )}
            </div>
          )}
        </div>
      </PopoverContent>
    </Popover>
  );
});
