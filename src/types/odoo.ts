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

export interface OdooOpportunity {
  id: number;
  name: string;
  stageName: string | null;
  partnerId: number | null;
  partnerName: string | null;
}

/** What slice 2 consumes. Written whole, never field-by-field. */
export interface ResolvedTarget {
  contactId: number;
  leadId: number | null;
}

export interface SyncResult {
  changed: number;
  fetched: number;
  skipped: number;
  clampSkipped: boolean;
}
