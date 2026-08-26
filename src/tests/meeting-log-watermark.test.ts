import { beforeEach, describe, expect, it, vi } from "vitest";
import { getSkipWatermark, setSkipWatermark } from "@/lib/storage/meeting-log-watermark.storage";

// setup.ts installs an INERT localStorage stub whose getItem always returns
// undefined and whose setItem stores nothing. A round-trip assertion against
// that stub fails even when the implementation is correct, so this suite backs
// it with a real Record first. Precedent: secure-provider-configs.test.ts:39-49.
const store: Record<string, string> = {};

beforeEach(() => {
  for (const key of Object.keys(store)) delete store[key];
  vi.mocked(localStorage.getItem).mockImplementation((k: string) => store[k] ?? null);
  vi.mocked(localStorage.setItem).mockImplementation((k: string, v: string) => {
    store[k] = v;
  });
  vi.mocked(localStorage.removeItem).mockImplementation((k: string) => {
    delete store[k];
  });
});

describe("setSkipWatermark", () => {
  it("keeps the higher value when a lower one is written", () => {
    // The mutant this kills is the SHIPPED unconditional setItem. A test that
    // only ever writes increasing values passes against that mutant and is
    // therefore not a test. One future caller snapshotting a sub-range walks
    // this watermark backward and reopens the cross-customer mis-post gap the
    // mechanism exists to close: one customer's transcript posted onto another
    // customer's record.
    setSkipWatermark(10);
    setSkipWatermark(5);
    expect(getSkipWatermark()).toBe(10);
  });

  it("still advances on a higher value", () => {
    setSkipWatermark(10);
    setSkipWatermark(25);
    expect(getSkipWatermark()).toBe(25);
  });

  it("writes through when nothing is stored yet", () => {
    setSkipWatermark(7);
    expect(getSkipWatermark()).toBe(7);
  });
});
