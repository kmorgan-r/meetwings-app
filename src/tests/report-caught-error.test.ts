import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { reportCaughtError } from "@/lib/report-caught-error";

const original = window.Sentry;
let errorSpy: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
  errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
});

afterEach(() => {
  window.Sentry = original;
  errorSpy.mockRestore();
});

describe("reportCaughtError", () => {
  it("sends the error with its component stack when the SDK is present", () => {
    const captureException = vi.fn();
    window.Sentry = { captureException };
    const err = new Error("boom");
    reportCaughtError(err, { componentStack: "\n  at Boom" });
    expect(captureException).toHaveBeenCalledWith(err, {
      contexts: { react: { componentStack: "\n  at Boom" } },
    });
    expect(errorSpy).toHaveBeenCalledWith(err, "\n  at Boom");
  });

  it("does not throw without the SDK", () => {
    delete window.Sentry;
    expect(() => reportCaughtError(new Error("x"), {})).not.toThrow();
    expect(errorSpy).toHaveBeenCalled();
  });

  it("still logs when the SDK throws", () => {
    window.Sentry = {
      captureException: () => {
        throw new Error("sdk down");
      },
    };
    expect(() => reportCaughtError(new Error("x"), {})).not.toThrow();
    expect(errorSpy).toHaveBeenCalled();
  });
});
