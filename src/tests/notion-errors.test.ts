import { describe, it, expect, vi, afterEach, beforeEach } from "vitest";
import {
  NOTION_COPY,
  NOTION_SHOW_AT_ONCE,
  NotionError,
  SUMMARY_FINAL,
  SUMMARY_STRIKE,
  SummaryError,
  notionErrorText,
  outcomeFor,
} from "@/lib/notion/errors";
import {
  armNotionRedactor,
  isNotionRedactorArmed,
  redactNotion,
  resetNotionRedactor,
} from "@/lib/notion/redact";

// Fake secrets only.
const TOKEN = "secret_ntn_XYZ";
const AI_KEY = "sk-or-v1-KEY";

// One body per HTTP failure class the redactor must survive.
const BODY_401 = `{"message":"API token ${TOKEN} is invalid","request":{"Authorization":"Bearer ${TOKEN}"}}`;
const BODY_429 = `{"message":"rate limited for ${TOKEN}","code":"rate_limited","hint":"${AI_KEY}"}`;
const BODY_500 = `{"message":"internal error ${TOKEN} ${AI_KEY}"}`;

describe("notion redactor", () => {
  beforeEach(() => resetNotionRedactor());
  afterEach(() => resetNotionRedactor());

  it("redactNotion blanks everything when unarmed", () => {
    expect(isNotionRedactorArmed()).toBe(false);
    expect(redactNotion(`token=${TOKEN} key=${AI_KEY}`)).toBe("[REDACTED]");
  });

  it("arming with only empty strings stays unarmed", () => {
    armNotionRedactor(["", undefined]);
    expect(isNotionRedactorArmed()).toBe(false);
    expect(redactNotion(`token=${TOKEN}`)).toBe("[REDACTED]");
  });

  it("armed redactor removes the token and the AI key from 401, 429 and 5xx bodies", () => {
    armNotionRedactor([TOKEN, AI_KEY]);
    expect(isNotionRedactorArmed()).toBe(true);
    for (const body of [BODY_401, BODY_429, BODY_500]) {
      const out = redactNotion(body);
      expect(out).not.toContain(TOKEN);
      expect(out).not.toContain(AI_KEY);
      expect(out).toContain("[REDACTED]");
    }
  });
});

describe("notionErrorText", () => {
  beforeEach(() => resetNotionRedactor());
  afterEach(() => resetNotionRedactor());

  it("notionErrorText never returns raw text for an unknown Error", () => {
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      const t = notionErrorText(new Error(`${TOKEN} leaked`));
      expect(t.code).toBe("NOTION_INTERNAL");
      expect(t.text).toBe(NOTION_COPY.NOTION_INTERNAL);
      expect(t.text).not.toContain(TOKEN);
      // Exactly one log line, and while unarmed it fails closed.
      expect(spy).toHaveBeenCalledTimes(1);
      expect(spy.mock.calls[0].length).toBe(1);
      const logged = String(spy.mock.calls[0][0]);
      expect(logged).not.toContain(TOKEN);
      expect(logged).toBe("[REDACTED]");
    } finally {
      spy.mockRestore();
    }
  });

  it("notionErrorText logs redactNotion(String(value)) for a non-Error", () => {
    armNotionRedactor([AI_KEY]);
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      const t = notionErrorText(`plain rejection ${AI_KEY}`);
      expect(t.code).toBe("NOTION_INTERNAL");
      expect(t.text).toBe(NOTION_COPY.NOTION_INTERNAL);
      expect(spy).toHaveBeenCalledTimes(1);
      const logged = String(spy.mock.calls[0][0]);
      expect(logged).not.toContain(AI_KEY);
      expect(logged).toBe("plain rejection [REDACTED]");
    } finally {
      spy.mockRestore();
    }
  });
});

describe("fixed copy", () => {
  it("every NOTION_COPY string is free of the word Odoo", () => {
    for (const [code, text] of Object.entries(NOTION_COPY)) {
      expect(text.toLowerCase().includes("odoo")).toBe(false);
      expect(code.includes("odoo")).toBe(false);
    }
  });

  it("SummaryError carries the fixed copy", () => {
    const e = new SummaryError("SUMMARY_NO_PROVIDER");
    expect(e).toBeInstanceOf(Error);
    expect(e.name).toBe("SummaryError");
    expect(e.code).toBe("SUMMARY_NO_PROVIDER");
    expect(e.message).toBe(NOTION_COPY.SUMMARY_NO_PROVIDER);
  });

  it("NotionError carries the fixed copy and retryAfterMs", () => {
    const e = new NotionError("NOTION_RATE_LIMITED", { retryAfterMs: 5_000 });
    expect(e).toBeInstanceOf(Error);
    expect(e.name).toBe("NotionError");
    expect(e.code).toBe("NOTION_RATE_LIMITED");
    expect(e.message).toBe(NOTION_COPY.NOTION_RATE_LIMITED);
    expect(e.retryAfterMs).toBe(5_000);
  });

  it("summary code sets hold exactly the final and strike codes", () => {
    expect([...SUMMARY_FINAL].sort()).toEqual([
      "SUMMARY_NO_PROVIDER",
      "SUMMARY_TOO_SHORT",
    ]);
    expect([...SUMMARY_STRIKE].sort()).toEqual([
      "SUMMARY_EMPTY",
      "SUMMARY_REJECTED",
      "SUMMARY_TIMEOUT",
      "SUMMARY_UNREADABLE",
    ]);
  });
});

describe("outcomeFor", () => {
  const RETRY_CODE = "NOTION_SERVER";

  it.each([
    [1, 60_000],
    [2, 120_000],
    [7, 3_600_000],
    [20, 3_600_000],
  ])("outcomeFor a retry code at attempt %i waits %i ms", (attempts, expected) => {
    const o = outcomeFor(RETRY_CODE, attempts, 0);
    expect(o.status).toBe("retry");
    expect(o.nextAt).toBe(expected);
  });

  it("outcomeFor: attempts below 1 are clamped to 1, so the floor stays 60_000", () => {
    expect(outcomeFor(RETRY_CODE, 0, 0)).toEqual({ status: "retry", nextAt: 60_000 });
  });

  it("outcomeFor: a retryAfterMs longer than the backoff wins", () => {
    const o = outcomeFor(RETRY_CODE, 1, 0, 90_000);
    expect(o.status).toBe("retry");
    expect(o.nextAt).toBe(90_000);
  });

  it("outcomeFor: a retryAfterMs shorter than the backoff is ignored", () => {
    expect(outcomeFor(RETRY_CODE, 1, 1_000, 5_000)).toEqual({
      status: "retry",
      nextAt: 61_000,
    });
  });

  it("outcomeFor: every NOTION_SHOW_AT_ONCE code, NOTION_INTERNAL included, is failed with no nextAt", () => {
    expect(NOTION_SHOW_AT_ONCE.has("NOTION_INTERNAL")).toBe(true);
    for (const code of NOTION_SHOW_AT_ONCE) {
      expect(outcomeFor(code, 3, 123, 5_000)).toEqual({
        status: "failed",
        nextAt: null,
      });
    }
  });
});
