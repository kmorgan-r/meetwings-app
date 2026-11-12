import { describe, expect, it } from "vitest";
import { GOOGLE_COPY, toGoogleCode } from "@/lib/calendar/google-errors";

describe("toGoogleCode", () => {
  it("keeps a known Google code", () => {
    expect(toGoogleCode("GOOGLE_THROTTLED")).toBe("GOOGLE_THROTTLED");
  });

  it("keeps a known Google code carried by an Error", () => {
    expect(toGoogleCode(new Error("GOOGLE_THROTTLED"))).toBe("GOOGLE_THROTTLED");
  });

  it("does not treat an inherited property name as a code", () => {
    expect(toGoogleCode("toString")).toBe("GOOGLE_NETWORK");
  });

  it("maps a Graph code to the network code", () => {
    expect(toGoogleCode(new Error("GRAPH_NETWORK"))).toBe("GOOGLE_NETWORK");
  });

  it("drops unknown text", () => {
    expect(toGoogleCode("boom: a@b.com")).toBe("GOOGLE_NETWORK");
  });

  it("has the exact copy for every code", () => {
    expect(GOOGLE_COPY).toEqual({
      GOOGLE_NOT_CONNECTED: "Google Calendar isn't connected.",
      GOOGLE_CONSENT_REQUIRED: "Google didn't grant calendar access. Connect again and allow it.",
      GOOGLE_AUTH_CANCELLED: "Sign-in was cancelled.",
      GOOGLE_AUTH_EXPIRED: "Your Google sign-in has expired. Connect again.",
      GOOGLE_AUTH_REJECTED: "Google rejected the sign-in. Check the Client ID and Client secret.",
      GOOGLE_BAD_RESPONSE: "Google sent a response Meetwings couldn't read.",
      GOOGLE_THROTTLED: "Google is limiting requests. Try again in a minute.",
      GOOGLE_NETWORK: "Couldn't reach Google. Check your connection.",
      GOOGLE_NO_KEYCHAIN: "No system keychain is available, so the connection lasts until you quit.",
    });
  });
});
