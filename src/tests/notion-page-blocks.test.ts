import { describe, expect, it } from "vitest";
import type { NotionBlockInput } from "@/lib/notion/client";
import {
  batchBlocks,
  buildPageBlocks,
  pageProperties,
  splitRichText,
  transcriptBlocks,
} from "@/lib/notion/page-blocks";
import type { SubTable } from "@/lib/notion/routing";
import type { NotionSummary } from "@/lib/notion/summarize";

const SUMMARY: NotionSummary = {
  title: "Weekly sync",
  actionItems: ["Draft the RFC", "Book the demo room"],
  sections: [
    { heading: "Launch", bullets: ["Ship on Friday", "Update the dashboard"] },
    { heading: "Pricing", bullets: ["Hold the rate"] },
  ],
  practices: [{ rule: "Rotate the demo presenter weekly", topic: "Demos" }],
};

const NO_PRACTICES: NotionSummary = { ...SUMMARY, practices: [] };

const EXPECTED_ORDER = [
  "table_of_contents",
  "heading_2",
  "bulleted_list_item",
  "bulleted_list_item",
  "divider",
  "heading_2",
  "paragraph",
  "callout",
  "heading_3",
  "to_do",
  "to_do",
  "divider",
  "heading_3",
  "bulleted_list_item",
  "bulleted_list_item",
  "heading_3",
  "bulleted_list_item",
  "divider",
  "toggle",
];

// The §3.3 order: TOC, Agenda (+ section headings), divider, Meeting Notes
// (+ bold title, callout), Action Items to-dos, sections, divider, toggle last.
function richContent(block: NotionBlockInput): string[] {
  const payload = block[block.type] as
    | { rich_text?: { text?: { content?: string } }[] }
    | undefined;
  return (payload?.rich_text ?? []).map((item) => item.text?.content ?? "");
}

function typedPayload(block: NotionBlockInput, type: string): Record<string, unknown> {
  return block[type] as Record<string, unknown>;
}

function richItems(block: NotionBlockInput): { text: { content: string } }[] {
  const payload = block.paragraph as
    | { rich_text?: { text: { content: string } }[] }
    | undefined;
  return payload?.rich_text ?? [];
}

describe("buildPageBlocks", () => {
  it("emits the §3.3 order with the toggle last", () => {
    const blocks = buildPageBlocks(SUMMARY);
    expect(blocks.map((b) => b.type)).toEqual(EXPECTED_ORDER);

    // Block shapes, per Notion API.
    expect(blocks[0]).toEqual({ object: "block", type: "table_of_contents", table_of_contents: {} });
    expect(blocks[4]).toEqual({ object: "block", type: "divider", divider: {} });

    const agenda = typedPayload(blocks[1], "heading_2");
    expect(agenda).toEqual({
      rich_text: [{ type: "text", text: { content: "Agenda" } }],
    });
    // Agenda bullets are the section headings.
    expect(richContent(blocks[2])).toEqual(["Launch"]);
    expect(richContent(blocks[3])).toEqual(["Pricing"]);

    expect(richContent(blocks[5])).toEqual(["Meeting Notes"]);

    const title = blocks[6].paragraph as Record<string, unknown>;
    expect(title).toEqual({
      rich_text: [
        { type: "text", text: { content: "Weekly sync" }, annotations: { bold: true } },
      ],
    });

    const callout = blocks[7].callout as Record<string, unknown>;
    expect(callout.icon).toEqual({ type: "emoji", emoji: "📌" });
    expect(callout.color).toBe("yellow_background");
    expect(callout.rich_text).toEqual([
      { type: "text", text: { content: "Team Practices" }, annotations: { bold: true } },
    ]);
    expect(callout.children).toEqual([
      {
        object: "block",
        type: "bulleted_list_item",
        bulleted_list_item: {
          rich_text: [{ type: "text", text: { content: "Rotate the demo presenter weekly" } }],
        },
      },
    ]);

    expect(typedPayload(blocks[8], "heading_3")).toEqual({
      rich_text: [{ type: "text", text: { content: "Action Items" } }],
    });
    expect(blocks[9].to_do).toEqual({
      rich_text: [{ type: "text", text: { content: "Draft the RFC" } }],
      checked: false,
    });
    expect(blocks[10].to_do).toEqual({
      rich_text: [{ type: "text", text: { content: "Book the demo room" } }],
      checked: false,
    });

    // Section replay: heading then its bullets.
    expect(richContent(blocks[12])).toEqual(["Launch"]);
    expect(richContent(blocks[13])).toEqual(["Ship on Friday"]);
    expect(richContent(blocks[14])).toEqual(["Update the dashboard"]);
    expect(richContent(blocks[15])).toEqual(["Pricing"]);
    expect(richContent(blocks[16])).toEqual(["Hold the rate"]);

    // The toggle is LAST and has no children - the transcript is appended to it
    // by the caller, never embedded here.
    const toggle = blocks[blocks.length - 1];
    expect(toggle.object).toBe("block");
    expect(toggle.type).toBe("toggle");
    expect(toggle.toggle).toEqual({
      rich_text: [{ type: "text", text: { content: "Transcript" } }],
    });
    expect("children" in (toggle.toggle as object)).toBe(false);
    expect(blocks[blocks.length - 2]).toEqual({ object: "block", type: "divider", divider: {} });
  });

  it("drops the callout when there are no practices, but keeps Agenda and Action Items", () => {
    const blocks = buildPageBlocks(NO_PRACTICES);
    expect(blocks.map((b) => b.type)).toEqual(
      EXPECTED_ORDER.filter((t) => t !== "callout"),
    );
    expect(richContent(blocks[1])).toEqual(["Agenda"]);
    // Dropping the callout does not touch Action Items: its to-dos still run.
    expect(blocks.map((b) => b.type)).toContain("to_do");
  });

  it("Agenda and Action Items headings stay when every list is empty", () => {
    const blocks = buildPageBlocks({
      title: "One-liner",
      actionItems: [],
      sections: [],
      practices: [],
    });
    const types = blocks.map((b) => b.type);
    expect(types).toContain("table_of_contents");
    expect(richContent(blocks[types.indexOf("heading_2")])).toEqual(["Agenda"]);
    expect(types).toContain("heading_3");
    const actionHeading = blocks[types.indexOf("heading_3")];
    expect(richContent(actionHeading)).toEqual(["Action Items"]);
    expect(types[types.length - 1]).toBe("toggle");
    expect(types).not.toContain("callout");
    expect(types).not.toContain("to_do");
  });
});

describe("splitRichText", () => {
  it("2000 chars → 1 item, 2001 → 2", () => {
    expect(splitRichText("x".repeat(2000))).toEqual(["x".repeat(2000)]);
    expect(splitRichText("x".repeat(2001))).toEqual(["x".repeat(2000), "x"]);
  });

  it('"" → []', () => {
    expect(splitRichText("")).toEqual([]);
  });

  it("a max below 2 throws RangeError - a surrogate pair cannot fit in one unit", () => {
    expect(() => splitRichText("abc", 1)).toThrowError(RangeError);
    expect(() => splitRichText("abc", 0)).toThrowError(RangeError);
  });

  it("never splits a surrogate pair at the boundary", () => {
    // 1999 'a' + one emoji: the 2000-unit boundary would fall inside the pair.
    const items = splitRichText("a".repeat(1999) + "😀");
    expect(items).toEqual(["a".repeat(1999), "😀"]);
  });

  it("1000 whole emoji fit in one item; 1001 spill exactly along the pair", () => {
    expect(splitRichText("😀".repeat(1000))).toEqual(["😀".repeat(1000)]);
    const spilled = splitRichText("😀".repeat(1001));
    expect(spilled).toEqual(["😀".repeat(1000), "😀"]);
  });
});

describe("transcriptBlocks", () => {
  it("replaces a leading 'You: ' only, keeps 'Guest: ' and mid-line 'You: '", () => {
    const blocks = transcriptBlocks(
      ["You: opened the doc", "Guest: hello there", "You said You: hi again", "   ", ""],
      "Alex",
    );
    expect(blocks.map((b) => b.type)).toEqual(["paragraph", "paragraph", "paragraph"]);
    expect(richContent(blocks[0])).toEqual(["Alex: opened the doc"]);
    expect(richContent(blocks[1])).toEqual(["Guest: hello there"]);
    expect(richContent(blocks[2])).toEqual(["You said You: hi again"]);
  });

  it("empty input → []", () => {
    expect(transcriptBlocks([], "Alex")).toEqual([]);
  });

  it("a 7,000-char emoji line becomes ONE paragraph with several rich-text items", () => {
    const line = "😀".repeat(3500); // 7000 UTF-16 units
    const blocks = transcriptBlocks([line], "Alex");
    expect(blocks).toHaveLength(1);
    expect(blocks[0].type).toBe("paragraph");
    const payload = blocks[0].paragraph as Record<string, unknown>;
    const richText = payload.rich_text as { text: { content: string } }[];
    expect(richText).toHaveLength(4);
    expect(richText.map((item) => item.text.content).join("")).toBe(line);
    for (const item of richText) expect(item.text.content.length).toBeLessThanOrEqual(2000);
  });

  it("a line over 100 rich-text items continues in a second paragraph", () => {
    // 200,001 chars → 101 items of ≤2000 chars → one full paragraph, one carry-over.
    const blocks = transcriptBlocks(["y".repeat(200_001)], "Alex");
    expect(blocks).toHaveLength(2);
    const first = richItems(blocks[0]);
    const second = richItems(blocks[1]);
    expect(first).toHaveLength(100);
    expect(second).toHaveLength(1);
    expect(first.map((i) => i.text.content).join("") + second[0].text.content).toBe(
      "y".repeat(200_001),
    );
  });
});

describe("batchBlocks", () => {
  const tinyBlock: NotionBlockInput = {
    object: "block",
    type: "paragraph",
    paragraph: { rich_text: [] },
  };

  it("100 blocks → 1 batch, 101 → 2, 1,050 → 11, and no batch exceeds 400,000 bytes", () => {
    expect(batchBlocks(Array.from({ length: 100 }, () => tinyBlock))).toHaveLength(1);
    expect(batchBlocks(Array.from({ length: 101 }, () => tinyBlock))).toHaveLength(2);
    const eleven = batchBlocks(Array.from({ length: 1050 }, () => tinyBlock));
    expect(eleven).toHaveLength(11);
    for (const batch of eleven) {
      const bytes = new TextEncoder().encode(JSON.stringify(batch)).length;
      expect(bytes).toBeLessThanOrEqual(400_000);
      expect(batch.length).toBeLessThanOrEqual(100);
    }
  });

  it("empty input → []", () => {
    expect(batchBlocks([])).toEqual([]);
  });

  it("250 2 KB blocks split on the 100-block cap; every batch stays within both caps", () => {
    const big: NotionBlockInput = {
      object: "block",
      type: "paragraph",
      paragraph: {
        rich_text: [{ type: "text", text: { content: "x".repeat(2000) } }],
      },
    };
    const blocks = Array.from({ length: 250 }, () => big);
    const batches = batchBlocks(blocks);
    expect(batches.length).toBeGreaterThanOrEqual(2);
    for (const batch of batches) {
      expect(batch.length).toBeLessThanOrEqual(100);
      expect(new TextEncoder().encode(JSON.stringify(batch)).length).toBeLessThanOrEqual(400_000);
    }
    // Nothing lost on the way.
    expect(batches.flat().length).toBe(250);
  });

  // Emoji text is the point: "😀" is 2 UTF-16 units but 4 UTF-8 bytes, so
  // measuring by string .length sees half the real size. Both tests below
  // derive maxBytes from the true TextEncoder size of one block.
  const emojiBlock = (): NotionBlockInput => ({
    object: "block",
    type: "paragraph",
    paragraph: { rich_text: [{ type: "text", text: { content: "😀".repeat(30_000) } }] },
  });

  it("splits on the byte cap with emoji text: exactly [2, 2], below the 100-block cap", () => {
    const blocks = Array.from({ length: 4 }, emojiBlock);
    const one = new TextEncoder().encode(JSON.stringify(blocks[0])).length;
    // ~120 KB of UTF-8 per block, so two fit and a third would exceed; a
    // .length measure would see ~half of that and pack all four into [4].
    // The batch rule compares per-block sums, while the assert below measures
    // the finished array, so leave head room for its brackets and comma.
    const maxBytes = one * 2 + 10;
    const batches = batchBlocks(blocks, 100, maxBytes);
    expect(batches.map((batch) => batch.length)).toEqual([2, 2]);
    for (const batch of batches) {
      expect(new TextEncoder().encode(JSON.stringify(batch)).length).toBeLessThanOrEqual(maxBytes);
    }
  });

  it("the byte counter resets per batch: [2, 2, 1] after a full batch", () => {
    const blocks = Array.from({ length: 5 }, emojiBlock);
    const one = new TextEncoder().encode(JSON.stringify(blocks[0])).length;
    const maxBytes = one * 2; // exactly two fit; a counter carried across batches yields [2, 1, 1, 1]
    const batches = batchBlocks(blocks, 100, maxBytes);
    expect(batches.map((batch) => batch.length)).toEqual([2, 2, 1]);
  });

  it("a single block larger than maxBytes goes alone in its own batch", () => {
    const oversizedContent = "z".repeat(500_000);
    const oversized: NotionBlockInput = {
      object: "block",
      type: "paragraph",
      paragraph: {
        rich_text: [{ type: "text", text: { content: oversizedContent } }],
      },
    };
    const batches = batchBlocks([tinyBlock, oversized, tinyBlock], 100, 400_000);
    expect(batches).toHaveLength(3);
    expect(batches[0]).toEqual([tinyBlock]);
    expect(batches[1]).toEqual([oversized]);
    expect(batches[2]).toEqual([tinyBlock]);
    // The oversized block is delivered whole: dropped or split would corrupt
    // the page, and its single rich-text item stays exactly one item long.
    expect(richContent(batches[1][0])).toEqual([oversizedContent]);
  });
});

const SUB_TABLE: SubTable = {
  dataSourceId: "ds-monday",
  name: "Monday Meetings",
  titleProp: "Name",
  dateProp: "Meeting Date",
  recordedByProp: "Recorded by",
};

describe("pageProperties", () => {
  const startAt = new Date(2026, 9, 5, 9, 12).getTime();
  const endAt = new Date(2026, 9, 5, 10, 3).getTime();

  it("writes the title, a datetime range, and Recorded by when both exist", () => {
    const props = pageProperties({ subTable: SUB_TABLE, title: "Weekly sync" }, startAt, endAt, "user-owner-1");
    expect(props).toEqual({
      Name: { title: [{ type: "text", text: { content: "Weekly sync" } }] },
      "Meeting Date": {
        date: {
          start: new Date(startAt).toISOString(),
          end: new Date(endAt).toISOString(),
        },
      },
      "Recorded by": { people: [{ id: "user-owner-1" }] },
    });
  });

  it("a long title is chunked into rich-text items of at most 2000 chars", () => {
    const props = pageProperties(
      { subTable: SUB_TABLE, title: "w".repeat(4001) },
      startAt,
      endAt,
      null,
    );
    const title = props["Name"] as { title: { text: { content: string } }[] };
    expect(title.title).toHaveLength(3);
    expect(title.title.map((item) => item.text.content).join("")).toBe("w".repeat(4001));
  });

  it("Recorded by is written only when both recordedByProp and ownerUserId are non-null", () => {
    const noOwner = pageProperties({ subTable: SUB_TABLE, title: "T" }, startAt, endAt, null);
    expect(Object.keys(noOwner)).toEqual(["Name", "Meeting Date"]);

    const noProp: SubTable = { ...SUB_TABLE, recordedByProp: null };
    const withOwner = pageProperties({ subTable: noProp, title: "T" }, startAt, endAt, "user-owner-1");
    expect(Object.keys(withOwner)).toEqual(["Name", "Meeting Date"]);
  });
});
