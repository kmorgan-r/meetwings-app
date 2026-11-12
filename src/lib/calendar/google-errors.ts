import type { GoogleErrorCode } from "@/types";

export const GOOGLE_COPY: Record<GoogleErrorCode, string> = {
  GOOGLE_NOT_CONNECTED: "Google Calendar isn't connected.",
  GOOGLE_CONSENT_REQUIRED: "Google didn't grant calendar access. Connect again and allow it.",
  GOOGLE_AUTH_CANCELLED: "Sign-in was cancelled.",
  GOOGLE_AUTH_EXPIRED: "Your Google sign-in has expired. Connect again.",
  GOOGLE_AUTH_REJECTED: "Google rejected the sign-in. Check the Client ID and Client secret.",
  GOOGLE_BAD_RESPONSE: "Google sent a response Meetwings couldn't read.",
  GOOGLE_THROTTLED: "Google is limiting requests. Try again in a minute.",
  GOOGLE_NETWORK: "Couldn't reach Google. Check your connection.",
  GOOGLE_NO_KEYCHAIN: "No system keychain is available, so the connection lasts until you quit.",
};

/**
 * The boundary catch. Rust rejects with a bare `GOOGLE_*` string. Anything else
 * becomes GOOGLE_NETWORK and its text is dropped, never kept or forwarded.
 */
export function toGoogleCode(thrown: unknown): GoogleErrorCode {
  const raw = thrown instanceof Error ? thrown.message : String(thrown);
  return Object.prototype.hasOwnProperty.call(GOOGLE_COPY, raw)
    ? (raw as GoogleErrorCode)
    : "GOOGLE_NETWORK";
}
