import { afterEach, describe, expect, it } from "vitest";
import { buildNoteBody, queueErrorText, renderTranscript } from "@/lib/odoo/meeting-log";
import { odooError, OdooError } from "@/lib/odoo/errors";
import { resetOdooRedactor, setOdooRedactor } from "@/lib/odoo/redactor";
import type { SummarizationResult, TranscriptEntry } from "@/types";

function entry(over: Partial<TranscriptEntry> = {}): TranscriptEntry {
  return { original: "hello", timestamp: 1000, ...over };
}

function summary(over: Partial<SummarizationResult> = {}): SummarizationResult {
  return {
    title: "Kickoff",
    summary: "We agreed to start.",
    topics: [],
    goals: [],
    actionItems: [],
    nextSteps: [],
    decisions: [],
    teamUpdates: [],
    participants: [],
    entities: [],
    ...over,
  };
}

const SLICE = { entries: [entry()], startAt: 1000, endAt: 2000 };

describe("renderTranscript", () => {
  it("prefers an explicit speaker label", () => {
    const out = renderTranscript([
      entry({ speaker: { speakerLabel: "Ada" } as never, audioSource: "system" }),
    ]);
    expect(out).toContain("Ada: hello");
  });

  it("labels microphone audio You and system audio Guest", () => {
    const out = renderTranscript([
      entry({ original: "mine", audioSource: "microphone" }),
      entry({ original: "theirs", audioSource: "system" }),
    ]);
    expect(out).toContain("You: mine");
    expect(out).toContain("Guest: theirs");
  });

  it("leaves an entry with no audioSource UNLABELLED, matching labelFor", () => {
    // useCompletion.ts:1037-1043 returns null for an unknown source. Defaulting
    // to "Guest" would attribute the user's own words to the customer in a
    // customer-visible note.
    const out = renderTranscript([entry({ original: "who said this" })]);
    expect(out).toContain("who said this");
    expect(out).not.toContain("Guest");
    expect(out).not.toContain("You:");
  });
});

describe("buildNoteBody", () => {
  it("renders title, date and summary", () => {
    const body = buildNoteBody(summary(), SLICE, 1000);
    expect(body).toContain("<b>Kickoff</b>");
    expect(body).toContain("<p>We agreed to start.</p>");
  });

  it("omits a section with no content entirely", () => {
    const body = buildNoteBody(summary({ decisions: [] }), SLICE, 1000);
    expect(body).not.toContain("Decisions");
    expect(body).not.toContain("<ul></ul>");
  });

  it("renders the sections that do have content", () => {
    const body = buildNoteBody(
      summary({ decisions: ["Ship on Friday"], actionItems: ["Ada writes the doc"] }),
      SLICE,
      1000
    );
    expect(body).toContain("<b>Decisions</b><ul><li>Ship on Friday</li></ul>");
    expect(body).toContain("<li>Ada writes the doc</li>");
  });

  it("escapes markup in EVERY interpolated field, not just the transcript", () => {
    // On the normal path the transcript goes to the ATTACHMENT, so a
    // body-escaping bug hides behind a transcript-only <script> case. Every
    // field here is AI-derived from the same untrusted transcript.
    const body = buildNoteBody(
      summary({
        title: "<img onerror=x>",
        summary: "<script>alert(1)</script>",
        decisions: ["<b>hi</b>"],
        nextSteps: ["<iframe>"],
      }),
      SLICE,
      1000
    );
    expect(body).not.toContain("<img");
    expect(body).not.toContain("<script>");
    expect(body).not.toContain("<iframe>");
    expect(body).toContain("&lt;img onerror=x&gt;");
  });

  it("falls back to the transcript when there is no summary at all", () => {
    const body = buildNoteBody(null, { ...SLICE, entries: [entry({ original: "we spoke" })] }, 1000);
    expect(body).toContain("we spoke");
    expect(body).toContain("Summarization failed");
  });

  it("escapes the raw transcript on the fallback path", () => {
    const body = buildNoteBody(null, { ...SLICE, entries: [entry({ original: "<script>x</script>" })] }, 1000);
    expect(body).not.toContain("<script>");
  });

  it("survives a partial result with missing arrays", () => {
    // parseSummarizationResponse can hand back a shape whose arrays are absent
    // if anyone loosens it; a TypeError here maps to ODOO_INTERNAL -> failed.
    const partial = { title: "T", summary: "S" } as unknown as SummarizationResult;
    expect(() => buildNoteBody(partial, SLICE, 1000)).not.toThrow();
  });

  it("takes the fallback path for an empty summary string", () => {
    const body = buildNoteBody(summary({ summary: "" }), SLICE, 1000);
    expect(body).toContain("Summarization failed");
  });
});

describe("queueErrorText", () => {
  afterEach(() => resetOdooRedactor());

  it("stores the code alone when the redactor is unarmed", () => {
    resetOdooRedactor();
    const out = queueErrorText(new Error("boom sk-secret"));
    expect(out.code).toBe("ODOO_INTERNAL");
    expect(out.text).toBe("ODOO_INTERNAL");
    expect(out.text).not.toContain("sk-secret");
  });

  it("redacts the key from a PLAIN Error while keeping benign text", () => {
    // A plain Error is the case that bites: toOdooError puts the original text
    // in details.detail and sets .message to a fixed string, so a
    // message-only helper would silently drop the marker AND the secret.
    setOdooRedactor(["sk-secret"]);
    const out = queueErrorText(new Error("plugin-sql failed for sk-secret while writing"));
    expect(out.text).not.toContain("sk-secret");
    expect(out.text).toContain("while writing"); // fails in BOTH directions
  });

  it("redacts an OdooError's message and keeps its code", () => {
    setOdooRedactor(["sk-secret"]);
    const out = queueErrorText(odooError("ODOO_FAULT", "Odoo rejected sk-secret on partner 4"));
    expect(out.code).toBe("ODOO_FAULT");
    expect(out.text).not.toContain("sk-secret");
    expect(out.text).toContain("partner 4");
  });

  it("renders faultString after the message, both halves redacted", () => {
    setOdooRedactor(["sk-secret"]);
    // `new OdooError`, NOT `odooError()`: odooError redacts details.faultString at
    // construction, so a render-suite needle built with it never reaches
    // queueErrorText raw and the composition-half redaction passes vacuously.
    const err = new OdooError("ODOO_FAULT", "Odoo fault 2", {
      faultCode: 2,
      faultString: "AccessError: no match for sk-secret here",
    });
    const out = queueErrorText(err);
    expect(out.code).toBe("ODOO_FAULT");
    expect(out.text).toBe("ODOO_FAULT: Odoo fault 2 - AccessError: no match for [REDACTED] here");
  });

  it("keeps today's byte-identical output when faultString is absent, empty, or not a string", () => {
    setOdooRedactor(["sk-secret"]);
    const absent = queueErrorText(odooError("ODOO_FAULT", "Odoo fault 2"));
    const empty = queueErrorText(
      new OdooError("ODOO_FAULT", "Odoo fault 2", { faultString: "" })
    );
    const numeric = queueErrorText(
      new OdooError("ODOO_FAULT", "Odoo fault 2", { faultString: 2 as unknown as string })
    );
    const nulled = queueErrorText(
      new OdooError("ODOO_FAULT", "Odoo fault 2", { faultString: null as unknown as string })
    );
    for (const out of [absent, empty, numeric, nulled]) {
      expect(out.text).toBe("ODOO_FAULT: Odoo fault 2"); // no trailing " - "
    }
  });

  it("caps a 10k-character internal-fault traceback at 400 characters with an ellipsis", () => {
    setOdooRedactor(["sk-secret"]);
    const err = new OdooError("ODOO_FAULT", "Odoo fault 1", {
      faultCode: 1,
      faultString: "x".repeat(10_000),
    });
    const out = queueErrorText(err);
    expect(out.text.length).toBe(401);
    expect(out.text.endsWith("…")).toBe(true);
  });

  it("redacts BEFORE capping: a key straddling the 400-char cut never leaks a fragment", () => {
    // Order-of-operations pin: capping the RAW faultString first would split the
    // key across the cut, and neither fragment matches the redactor's needle -
    // a partial leak into the persisted text. The composed prefix
    // "ODOO_FAULT: Odoo fault 2 - " is 27 chars, so 368 filler chars put the
    // key at indices 395-403: a cap-first implementation slices it mid-key.
    setOdooRedactor(["sk-secret"]);
    const err = new OdooError("ODOO_FAULT", "Odoo fault 2", {
      faultCode: 2,
      faultString: `${"x".repeat(368)}sk-secret tail`,
    });
    const out = queueErrorText(err);
    expect(out.text.length).toBe(401);
    expect(out.text.endsWith("…")).toBe(true);
    expect(out.text).not.toContain("sk-");
  });

  it("redacts a key that arrives raw in a directly-constructed faultString", () => {
    // Construction-time redaction is BYPASSED on purpose (raw OdooError) so the
    // composition's own redact() call is load-bearing, not decorative.
    setOdooRedactor(["sk-secret"]);
    const err = new OdooError("ODOO_FAULT", "Odoo fault 2", {
      faultCode: 2,
      faultString: "Traceback mentioning sk-secret in the payload",
    });
    const out = queueErrorText(err);
    expect(out.text).not.toContain("sk-secret");
    expect(out.text).toContain("Traceback mentioning"); // benign half survives
  });
});
