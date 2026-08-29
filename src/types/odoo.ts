/** Error codes for every failure this feature can surface. */
export type OdooErrorCode =
  | "ODOO_NOT_CONFIGURED"
  | "ODOO_UNREACHABLE"
  | "ODOO_AUTH_FAILED"
  | "ODOO_FAULT"
  | "ODOO_MALFORMED_RESPONSE"
  | "ODOO_PAYLOAD_UNSERIALIZABLE"
  | "ODOO_UNEXPECTED_ROW"
  // Not a failure: another window already holds the sync claim. It has its own
  // member because ODOO_INTERNAL means "something broke", and callers must be
  // able to tell "someone else is doing it" apart from that - a busy sync must
  // never paint the picker's cache red.
  | "ODOO_SYNC_BUSY"
  | "ODOO_INTERNAL";

export interface OdooConfig {
  url: string;
  db: string;
  login: string;
  apiKey: string;
  timeoutMs?: number;
}

/** A contact as the picker uses it (camelCase). */
export interface OdooContact {
  id: number;
  name: string;
  email: string | null;
  phone: string | null;
  companyName: string | null;
  parentId: number | null;
  isCompany: boolean;
  active: boolean;
  writeDate: string;
  isColleague: boolean;
  lastMeetingAt: number | null;
}

/** The snake_case shape SQLite actually returns. */
export interface DbOdooContact {
  instance: string;
  id: number;
  name: string;
  email: string | null;
  phone: string | null;
  company_name: string | null;
  parent_id: number | null;
  is_company: number;
  active: number;
  write_date: string;
  is_colleague: number;
  last_meeting_at: number | null;
  synced_at: number;
}

/**
 * One `crm.lead` row, of EITHER kind.
 *
 * The name says "opportunity" and the model does not: Odoo keeps leads and
 * opportunities in the same `crm.lead` table, separated only by the `type`
 * column, and the picker offers both. The name is kept because the persisted
 * side is already lead-named end to end (`odoo_selected_target.lead_id`,
 * `ResolvedTarget.leadId`, `meeting-log-push`'s `crm.lead`), so renaming this
 * one type would churn six files and every fixture for no behaviour change.
 *
 * `type` is what the UI needs: posting a meeting to a lead and posting it to
 * an opportunity are the same write to the same model, but they are not the
 * same thing to say out loud, and the row label and the destination sentence
 * both have to name the right one.
 */
export interface OdooOpportunity {
  id: number;
  name: string;
  type: "lead" | "opportunity";
  stageName: string | null;
  partnerId: number | null;
  partnerName: string | null;
  /**
   * `contact_name` and `email_from`: the free text a crm.lead carries when it
   * has no partner at all, which is Odoo default for an unconverted lead and
   * the only thing tying such a row to the contact on screen.
   */
  contactName: string | null;
  email: string | null;
}

/**
 * What slice 2 consumes. Written whole, never field-by-field.
 *
 * `contactId` is NULLABLE, and that is not defensive. A crm.lead picked
 * straight out of the lead search has no res.partner behind it at all -
 * Odoo's default for an unconverted lead is free-text contact details and no
 * partner - so there is no contact to name. The push already handles it:
 * `meeting-log-push` resolves a non-null `lead_id` to `crm.lead` and never
 * looks at `contact_id` in that case.
 *
 * BOTH being null is not a target and is never stored; `useOdooTarget` clears
 * the row instead.
 *
 * `leadName` is persisted rather than resolved because nothing else can name
 * a lead. A contact is named from the synced cache; a lead is not in it by
 * definition, and the in-memory list a lookup produced does not survive a
 * <Completion /> remount.
 *
 * Persisted through `odoo_selected_targets` (Task 11 on), coalesced down to
 * at most one `SelectedTarget` row - lead wins, matching migration 14's own
 * backfill rule - by `useOdooTarget.ts`'s `toSelectedTarget`/
 * `fromSelectedTarget` and `useMeetingLog.ts`'s `resolvedToSelected`. This
 * type is the single-select flow's own shape and is retired in Task 14, once
 * every caller holds a real `SelectedTargets` list instead.
 */
export interface ResolvedTarget {
  contactId: number | null;
  leadId: number | null;
  leadName: string | null;
}

export interface SelectedTarget {
  model: "res.partner" | "crm.lead";
  resId: number;
  name: string | null;
}

export type SelectedTargets = SelectedTarget[];

export type MeetingLogTargetStatus = "pending" | "sent" | "failed";

export interface MeetingLogTarget {
  id: string;
  rowId: string;
  model: "res.partner" | "crm.lead";
  resId: number;
  name: string | null;
  status: MeetingLogTargetStatus;
  attachmentId: number | null;
  messageId: number | null;
  lastError: string | null;
  lastErrorCode: string | null;
  createdAt: number;
  sentAt: number | null;
}

export interface SyncResult {
  changed: number;
  fetched: number;
  skipped: number;
  clampSkipped: boolean;
}

/**
 * Every state a queued meeting can be in.
 *
 * THIS UNION IS THE LIST OF RECORD, not the migration. `meeting-log-queue.sql`
 * enumerates seven statuses in its header and is FROZEN - sqlx checksums
 * applied migrations - so it cannot be updated and is stale as of `deleted`.
 * The column has no CHECK constraint, which is why adding a status needs no
 * migration at all.
 */
export type MeetingLogStatus =
  | "held"        // inside the 30s undo window
  | "pending"     // ready to push or retry
  | "sending"     // an Odoo call is in flight
  | "unassigned"  // ended with no contact selected
  | "sent"        // terminal
  | "failed"      // terminal until a manual retry
  | "cancelled"   // undone
  | "deleted";    // terminal. Transcript and summary blanked; the row survives.

/** The snake_case shape SQLite actually returns for a queued meeting. */
export interface DbMeetingLogRow {
  id: string;
  session_key: string;
  conversation_id: string | null;
  instance: string;
  contact_id: number | null;
  lead_id: number | null;
  transcript: string;
  transcript_start_at: number;
  transcript_end_at: number;
  summary_json: string | null;
  attachment_id: number | null;
  message_id: number | null;
  status: MeetingLogStatus;
  attempts: number;
  claimed_at: number | null;
  last_error: string | null;
  last_error_code: string | null;
  meeting_started_at: number | null;
  created_at: number;
  sent_at: number | null;
}

/**
 * What the queue page's list query returns: every column EXCEPT `transcript`,
 * plus every target row for that meeting, attached in memory by
 * `listActionableRows` (one extra query for the whole list, not N+1).
 *
 * A distinct type, and load-bearing. Typing list rows as `DbMeetingLogRow`
 * would let one be handed straight to `pushQueuedRow` and still compile - and
 * `toRow` is a bare cast, so nothing else objects. At runtime `row.transcript`
 * is then `undefined`, the slice is empty, and the push uploads an EMPTY
 * attachment plus the "Summarization failed" fallback note to a customer
 * record. The compiler should refuse that, not a test.
 *
 * `targets` is OPTIONAL here, deliberately: making it required would stop
 * every existing fixture object literal in meeting-log-page.test.tsx from
 * type-checking, three tasks before the one that replaces them. It is what
 * lets `groupOf` and AssignDialog's Confirm gate read a row's per-target
 * failure state instead of only its collapsed parent status.
 */
export type MeetingLogListRow = Omit<DbMeetingLogRow, "transcript"> & {
  targets?: MeetingLogTarget[];
};
