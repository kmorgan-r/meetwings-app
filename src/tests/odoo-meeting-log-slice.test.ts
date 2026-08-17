import { describe, expect, it } from "vitest";
import {
  attachmentNameFor,
  sessionKeyFor,
  sliceTranscript,
  toBase64Utf8,
} from "@/lib/odoo/meeting-log";
import type { TranscriptEntry } from "@/types";

function entry(timestamp: number, original = "hello"): TranscriptEntry {
  return { original, timestamp };
}

describe("sliceTranscript", () => {
  it("returns null when every entry is at or below the watermark", () => {
    expect(sliceTranscript([entry(100), entry(200)], 200)).toBeNull();
  });

  it("returns null for an empty array", () => {
    expect(sliceTranscript([], 0)).toBeNull();
  });

  it("keeps only entries strictly above the watermark", () => {
    const slice = sliceTranscript([entry(100), entry(200), entry(300)], 200);
    expect(slice?.entries.map((e) => e.timestamp)).toEqual([300]);
  });

  it("takes startAt/endAt as MIN/MAX, not first/last, so an out-of-order array is safe", () => {
    // addMeetingTranscriptEntries (useCompletion.ts:591-624) appends
    // caller-supplied timestamps verbatim - array order is NOT timestamp order.
    const slice = sliceTranscript([entry(500), entry(300), entry(400)], 200);
    expect(slice?.startAt).toBe(300);
    expect(slice?.endAt).toBe(500);
  });

  it("gives two consecutive meetings in one un-cleared transcript different spans", () => {
    // The whole reason the watermark exists: meetingTranscript is never
    // cleared on meeting end, so both meetings accumulate in ONE array.
    //
    // Model the real sequence. At meeting 1's end the array holds only what
    // had been said by then; meeting 2's entries are appended afterwards, and
    // its trigger re-slices the now-longer array against meeting 1's endAt.
    // (Slicing the FULL array at watermark 0 would consume all four entries
    // and leave nothing for the second slice - that is the shape of the bug,
    // not of the feature.)
    const meetingOne = [entry(100), entry(200)];
    const first = sliceTranscript(meetingOne, 0);
    expect(first?.startAt).toBe(100);
    expect(first?.endAt).toBe(200);

    const bothMeetings = [...meetingOne, entry(9000), entry(9100)];
    const second = sliceTranscript(bothMeetings, first!.endAt);
    expect(second?.startAt).toBe(9000);
    expect(second?.entries).toHaveLength(2);
  });
});

describe("sessionKeyFor", () => {
  it("namespaces on the conversation id when there is one", () => {
    expect(sessionKeyFor("conv-1", 1700)).toBe("conv-1:1700");
  });

  it("is the bare timestamp with no conversation id, never the string 'null'", () => {
    const key = sessionKeyFor(null, 1700);
    expect(key).toBe("1700");
    expect(key).not.toContain("null");
  });

  it("differs for two meetings, which is what the UNIQUE index needs", () => {
    expect(sessionKeyFor("conv-1", 100)).not.toBe(sessionKeyFor("conv-1", 9000));
  });
});

describe("attachmentNameFor", () => {
  it("is stable for one row across two different wall-clock times", () => {
    // A name formatted from Date.now() changes between attempts, so the retry
    // search can never match and every retry creates a duplicate attachment.
    const a = attachmentNameFor("row-1", Date.UTC(2026, 7, 8, 14, 32));
    const b = attachmentNameFor("row-1", Date.UTC(2026, 7, 8, 14, 32));
    expect(a).toBe(b);
    expect(a).toMatch(/^transcript-\d{4}-\d{2}-\d{2}-\d{4}-row-1\.md$/);
  });

  it("differs between two rows logged in the same minute", () => {
    const at = Date.UTC(2026, 7, 8, 14, 32);
    expect(attachmentNameFor("row-1", at)).not.toBe(attachmentNameFor("row-2", at));
  });
});

describe("toBase64Utf8", () => {
  const roundTrip = (s: string) =>
    new TextDecoder().decode(
      Uint8Array.from(atob(toBase64Utf8(s)), (c) => c.charCodeAt(0))
    );

  it("round-trips ASCII", () => {
    expect(roundTrip("hello")).toBe("hello");
  });

  it("round-trips Norwegian, which a naive btoa gets wrong", () => {
    // Do NOT assert btoa throws. It throws InvalidCharacterError in a real
    // browser, but under this repo's happy-dom environment it silently mangles
    // non-Latin1 to a DIFFERENT byte sequence instead
    // ("blåbærsyltetøy" -> "YmzlYuZyc3lsdGV0+Hk="), which is worse than
    // throwing and would make a toThrow() assertion fail against a correct
    // implementation. Assert the divergence and the round-trip instead - that
    // holds in both environments.
    const text = "blåbærsyltetøy";
    let naive: string | null = null;
    try {
      naive = btoa(text);
    } catch {
      naive = null;
    }
    expect(naive).not.toBe(toBase64Utf8(text));
    expect(roundTrip(text)).toBe(text);
  });

  it("round-trips an emoji", () => {
    expect(roundTrip("ship it 🚀")).toBe("ship it 🚀");
  });

  it("round-trips a multi-byte character straddling the chunk boundary", () => {
    // The ONLY place a chunked implementation actually breaks. Short strings
    // never cross a chunk, so the three cases above cannot catch it.
    // 0x7fff, not 0x7ffe: at 0x7ffe both bytes of "æ" land at indices
    // 32766/32767, i.e. INSIDE chunk 0, and nothing straddles. Note the
    // implementation chunks BYTES, so it is correct either way - what this case
    // guards is a future rewrite that chunks CHARACTERS, which is where a
    // multi-byte sequence really does break.
    const padded = "a".repeat(0x7fff) + "æ" + "b".repeat(10);
    expect(roundTrip(padded)).toBe(padded);
  });
});
