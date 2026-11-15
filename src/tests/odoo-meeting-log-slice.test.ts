import { describe, expect, it } from "vitest";
import {
  IDLE_FLUSH_MS,
  attachmentNameFor,
  isScrap,
  mergeScraps,
  segmentByGap,
  sessionKeyFor,
  sliceTranscript,
  toBase64Utf8,
} from "@/lib/odoo/meeting-log";
import type { TranscriptEntry, TranscriptSlice } from "@/types";

function entry(timestamp: number, original = "hello"): TranscriptEntry {
  return { original, timestamp };
}

/** One slice spanning the given timestamps, at least one. */
function sliceAt(...timestamps: number[]): TranscriptSlice {
  return {
    entries: timestamps.map((t, i) => entry(t, `line ${i + 1}`)),
    startAt: Math.min(...timestamps),
    endAt: Math.max(...timestamps),
  };
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

describe("segmentByGap", () => {
  it("returns no segments for an empty array", () => {
    expect(segmentByGap([], IDLE_FLUSH_MS)).toEqual([]);
  });

  it("keeps a continuous run as ONE segment", () => {
    const segments = segmentByGap([entry(1000), entry(2000), entry(3000)], IDLE_FLUSH_MS);
    expect(segments).toHaveLength(1);
    expect(segments[0].startAt).toBe(1000);
    expect(segments[0].endAt).toBe(3000);
  });

  it("splits where the silence exceeds the gap", () => {
    // The whole point: two meetings recorded into one conversation with no
    // queue row between them must not be recovered as a single spliced row
    // posted to whichever contact the user picks for it.
    const segments = segmentByGap(
      [entry(1000), entry(2000), entry(2000 + IDLE_FLUSH_MS + 1), entry(2000 + IDLE_FLUSH_MS + 2)],
      IDLE_FLUSH_MS
    );
    expect(segments).toHaveLength(2);
    expect(segments[0].entries.map((e) => e.timestamp)).toEqual([1000, 2000]);
    expect(segments[1].startAt).toBe(2000 + IDLE_FLUSH_MS + 1);
  });

  it("does NOT split on a silence exactly equal to the gap", () => {
    // Strictly greater, matching how the idle timer fires only once the full
    // window has elapsed with nothing said.
    const segments = segmentByGap([entry(1000), entry(1000 + IDLE_FLUSH_MS)], IDLE_FLUSH_MS);
    expect(segments).toHaveLength(1);
  });

  it("sorts before segmenting, so an out-of-order array is safe", () => {
    // Same hazard sliceTranscript's MIN/MAX guards against: nothing in the
    // pipeline guarantees timestamp order, and a naive scan would see a fake
    // backwards gap and split a single meeting into three.
    const segments = segmentByGap([entry(3000), entry(1000), entry(2000)], IDLE_FLUSH_MS);
    expect(segments).toHaveLength(1);
    expect(segments[0].entries.map((e) => e.timestamp)).toEqual([1000, 2000, 3000]);
  });
});

describe("isScrap", () => {
  it("59_999 ms with 3 entries is a scrap", () => {
    // One millisecond inside SCRAP_MIN_MS, with the entry count above its own
    // threshold - so this case pins the DURATION rule at its boundary.
    expect(isScrap(sliceAt(0, 30_000, 59_999))).toBe(true);
  });

  it("exactly 60_000 ms with exactly 3 entries is kept", () => {
    // Both rules sit exactly ON their thresholds, which are strict `<`s -
    // 60 seconds IS a meeting, and 3 entries ARE a meeting.
    expect(isScrap(sliceAt(0, 30_000, 60_000))).toBe(false);
  });

  it("60_000 ms with 2 entries is a scrap", () => {
    // The span clears its threshold, so this case pins the ENTRY rule at its
    // own boundary - exactly 2, which is fewer than 3.
    expect(isScrap(sliceAt(0, 60_000))).toBe(true);
  });
});

describe("mergeScraps", () => {
  it("a scrap merges into the nearer neighbour", () => {
    const a = sliceAt(0, 30_000, 60_000, 90_000, 120_000); // 5 lines over 2 min
    const b = sliceAt(126_000, 130_000); // 2 lines over 4 s - a scrap
    const c = sliceAt(1_200_000, 1_300_000, 1_500_000); // 20..25 min, 3 lines
    // B sits 6 s after A but 1_070 s before C - backward it is.
    const merged = mergeScraps([a, b, c]);

    expect(merged).toHaveLength(2);
    expect(merged[0].entries.map((e) => e.timestamp)).toEqual([
      0, 30_000, 60_000, 90_000, 120_000, 126_000, 130_000,
    ]);
    expect(merged[0].startAt).toBe(0); // A's
    expect(merged[0].endAt).toBe(130_000); // B's
    expect(merged[1]).toEqual(c);
  });

  it("a scrap nearer the next segment merges forward", () => {
    const a = sliceAt(0, 50_000, 100_000); // ends 100_000
    const b = sliceAt(110_000, 112_000); // gap backward: 10 s
    const c = sliceAt(118_000, 180_000, 240_000); // gap forward: 6 s - nearer
    const merged = mergeScraps([a, b, c]);

    expect(merged).toHaveLength(2);
    expect(merged[0]).toEqual(a);
    expect(merged[1].entries.map((e) => e.timestamp)).toEqual([
      110_000, 112_000, 118_000, 180_000, 240_000,
    ]);
    expect(merged[1].startAt).toBe(110_000); // the scrap's span swallowed whole
    expect(merged[1].endAt).toBe(240_000);
  });

  it("an equal gap goes to the previous segment", () => {
    const a = sliceAt(0, 50_000, 100_000); // ends 100_000
    const b = sliceAt(110_000, 112_000); // gap backward: 10 s
    const c = sliceAt(122_000, 130_000, 200_000); // gap forward: 10 s - a tie
    const merged = mergeScraps([a, b, c]);

    expect(merged).toHaveLength(2);
    expect(merged[0].entries.map((e) => e.timestamp)).toEqual([
      0, 50_000, 100_000, 110_000, 112_000,
    ]);
    expect(merged[1]).toEqual(c);
  });

  it("a lone scrap is dropped", () => {
    expect(mergeScraps([sliceAt(0, 10_000)])).toEqual([]);
  });

  it("returns nothing for an empty run", () => {
    expect(mergeScraps([])).toEqual([]);
  });

  it("two adjacent scraps alone merge, and are dropped if still a scrap", () => {
    // 2 lines + 2 lines spanning 4 min: the union clears BOTH thresholds
    // (4 entries, a 4-minute span), so it survives.
    const kept = mergeScraps([sliceAt(0, 10_000), sliceAt(230_000, 240_000)]);
    expect(kept).toHaveLength(1);
    expect(kept[0].entries).toHaveLength(4);
    expect(kept[0].startAt).toBe(0);
    expect(kept[0].endAt).toBe(240_000);

    // 1 + 1 line spanning 10 s: still one scrap after merging, and with no
    // long neighbour left to absorb it, it goes.
    expect(mergeScraps([sliceAt(0), sliceAt(10_000)])).toEqual([]);
  });

  it("non-scrap segments pass through unchanged", () => {
    const a = sliceAt(0, 50_000, 100_000);
    const b = sliceAt(200_000, 260_000, 300_000);
    expect(mergeScraps([a, b])).toEqual([a, b]);
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
