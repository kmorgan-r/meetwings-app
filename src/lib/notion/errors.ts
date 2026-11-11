export type NotionErrorCode = "NOTION_KEYCHAIN_UNAVAILABLE";

export const NOTION_COPY: Record<NotionErrorCode, string> = {
  NOTION_KEYCHAIN_UNAVAILABLE:
    "Meetwings can't use the system keychain for the Notion token. Press Retry; if it keeps failing, paste the token again in Settings > Integrations > Notion.",
};

export class NotionError extends Error {
  readonly code: NotionErrorCode;
  readonly retryAfterMs?: number;
  constructor(code: NotionErrorCode, opts?: { retryAfterMs?: number }) {
    super(NOTION_COPY[code]);
    this.name = "NotionError";
    this.code = code;
    this.retryAfterMs = opts?.retryAfterMs;
  }
}
