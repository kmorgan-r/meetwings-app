import { describe, expect, it } from "vitest";
import { reportGraphError, toGraphError } from "@/lib/calendar/errors";

const TOKEN = "eyJ0eXAiOiJKV1QiLCJhbGciOiJSUzI1NiJ9.SECRETPAYLOAD.sig";
const SUBJECT = "Acme renewal — pricing";
const ADDRESS = "cfo@acme.example";

describe("Graph errors never carry meeting content", () => {
  // reportOdooError propagates the thrown error's message once the redactor is
  // initialised. The Graph analogue must NOT: a subject or address lifted from
  // a raw reqwest/serde failure would survive into the report, and no fixed
  // needle list can catch a per-event value.
  it.each([TOKEN, SUBJECT, ADDRESS])("drops %s from a raw thrown error", (secret) => {
    const report = reportGraphError(new Error(`failed on ${secret}`), "current meetings");
    expect(JSON.stringify(report)).not.toContain(secret);
  });

  it("keeps the code and the operation", () => {
    const report = reportGraphError("GRAPH_THROTTLED", "current meetings");
    expect(report.code).toBe("GRAPH_THROTTLED");
    expect(report.message).toBe("GRAPH_THROTTLED");
    expect(report.details.where).toBe("current meetings");
  });

  it("keeps non-identifying counts", () => {
    const report = reportGraphError(
      toGraphError("GRAPH_BAD_RESPONSE"),
      "current meetings"
    );
    expect(report.code).toBe("GRAPH_BAD_RESPONSE");
  });
});
