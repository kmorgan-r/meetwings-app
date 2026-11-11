import { describe, expect, it, vi } from "vitest";

// Same mocks notion-summarize.test.ts needs: same-meeting imports
// extractJsonObject from meeting-summarizer, which pulls the DB and storage
// modules. The hoisted fake fetch fails loudly on any real call.
const { fetchAIResponse } = vi.hoisted(() => ({
  fetchAIResponse: vi.fn(() => {
    throw new Error("unexpected fetchAIResponse call: inject a fake fetch impl");
  }),
}));
vi.mock("@/lib/functions/ai-response.function", () => ({ fetchAIResponse }));
vi.mock("@/lib/functions/meetwings.api", () => ({
  shouldUseMeetwingsAPI: vi.fn(async () => false),
}));
vi.mock("@/lib/storage/secure-provider-configs", () => ({
  loadSummaryProvider: vi.fn(async () => null),
}));
vi.mock("@/lib/database", () => ({}));
vi.mock("@/lib/storage", () => ({
  getUserIdentity: vi.fn(() => null),
  hasUserIdentity: vi.fn(() => false),
}));
vi.mock("@/lib/odoo/meeting-log", () => ({ renderTranscript: vi.fn(() => "") }));

import type { NotionBlock, NotionClient, NotionPage } from "@/lib/notion/client";
import { NotionError, SummaryError } from "@/lib/notion/errors";
import type { NotionAi } from "@/lib/notion/ai";
import type { SubTable } from "@/lib/notion/routing";
import type { NotionSummary } from "@/lib/notion/summarize";
import {
  SAME_MEETING_PROMPT,
  SAME_MEETING_TIMEOUT_MS,
  isOwnPage,
  overlapEnough,
  pickWinner,
  readCandidates,
  sameMeeting,
} from "@/lib/notion/same-meeting";
import type { Candidate } from "@/lib/notion/same-meeting";

// Fake values only - never a real Notion id, email or token.
const START = Date.UTC(2026, 10, 9, 9, 0); // 2026-11-09 09:00Z
const END = Date.UTC(2026, 10, 9, 10, 0); // 2026-11-09 10:00Z
const ISO_START = new Date(START).toISOString();
const ISO_END = new Date(END).toISOString();
const DAY_MS = 86_400_000;

let fakeCounter = 0;

function subTable(dataSourceId: string): SubTable {
  return {
    dataSourceId,
    name: "Monday Meetings",
    titleProp: "Name",
    dateProp: "Meeting Date",
    recordedByProp: "Recorded by",
  };
}

function page(
  pageId: string,
  date: { start: string; end: string | null },
  extra: { createdTime?: string; createdById?: string; recordedByIds?: string[] } = {},
): NotionPage {
  const properties: Record<string, unknown> = {
    "Meeting Date": { type: "date", date },
  };
  if (extra.recordedByIds !== undefined) {
    properties["Recorded by"] = {
      type: "people",
      people: extra.recordedByIds.map((id) => ({ id })),
    };
  }
  fakeCounter += 1;
  return {
    id: pageId,
    url: `https://notion.invalid/${pageId}`,
    created_time: extra.createdTime ?? "2026-11-09T09:10:00.000Z",
    created_by: { id: extra.createdById ?? `fake-user-${fakeCounter}` },
    properties: properties as NotionPage["properties"],
  };
}

function heading2(text: string): NotionBlock {
  fakeCounter += 1;
  return { id: `fake-block-${fakeCounter}`, type: "heading_2", heading_2: { rich_text: [{ plain_text: text }] } };
}

function heading3(text: string): NotionBlock {
  fakeCounter += 1;
  return { id: `fake-block-${fakeCounter}`, type: "heading_3", heading_3: { rich_text: [{ plain_text: text }] } };
}

function paragraph(text: string, bold = false): NotionBlock {
  fakeCounter += 1;
  return {
    id: `fake-block-${fakeCounter}`,
    type: "paragraph",
    paragraph: {
      rich_text: [{ plain_text: text, ...(bold ? { annotations: { bold: true } } : {}) }],
    },
  };
}

/** The page body of §3.3 around the Meeting Notes heading. */
const NOTES_BODY = [
  heading2("Agenda"),
  heading2("Meeting Notes"),
  paragraph("Weekly sync", true),
  heading3("Action Items"),
  heading3("Launch"),
  heading3("Wrap-up"),
];

function fakeNotion(opts: {
  pages?: Record<string, NotionPage[]>;
  bodies?: Record<string, NotionBlock[]>;
}): {
  client: NotionClient;
  queries: { dataSourceId: string; body: unknown }[];
  listChildrenCalls: string[];
} {
  const queries: { dataSourceId: string; body: unknown }[] = [];
  const listChildrenCalls: string[] = [];
  const client = {
    queryAll: vi.fn(async (dataSourceId: string, body: object) => {
      queries.push({ dataSourceId, body });
      return opts.pages?.[dataSourceId] ?? [];
    }),
    listChildren: vi.fn(async (blockId: string) => {
      listChildrenCalls.push(blockId);
      return opts.bodies?.[blockId] ?? [];
    }),
  };
  return { client: client as unknown as NotionClient, queries, listChildrenCalls };
}

describe("overlapEnough", () => {
  it("overlap exactly half → true; just under → false; one range inside another → true", () => {
    // min duration 1_000 ms; an overlap of exactly 500 is enough, 499 is not.
    const a = { start: 0, end: 1_000 };
    expect(overlapEnough(a, { start: 500, end: 2_000 })).toBe(true);
    expect(overlapEnough(a, { start: 501, end: 2_000 })).toBe(false);
    expect(overlapEnough({ start: 10, end: 90 }, { start: 0, end: 100 })).toBe(true);
  });

  it("a zero-length range and a negative overlap never count, whatever the ratio", () => {
    // duration 0: the ratio is undefined, the ruling says false.
    expect(overlapEnough({ start: 10, end: 10 }, { start: 0, end: 100 })).toBe(false);
    // no overlap at all.
    expect(overlapEnough({ start: 0, end: 100 }, { start: 200, end: 300 })).toBe(false);
    // an end before a start is a broken range: false.
    expect(overlapEnough({ start: 100, end: 0 }, { start: 0, end: 100 })).toBe(false);
  });
});

describe("readCandidates", () => {
  it("queries the sub-table on its dateProp with the ±24h window and returns the counted page's fields", async () => {
    const { client, queries, listChildrenCalls } = fakeNotion({
      pages: { "ds-a": [page("fake-page-1", { start: ISO_START, end: ISO_END })] },
      bodies: { "fake-page-1": NOTES_BODY },
    });
    const candidates = await readCandidates(client, [subTable("ds-a")], START, END);

    expect(queries).toEqual([
      {
        dataSourceId: "ds-a",
        body: {
          filter: {
            and: [
              { property: "Meeting Date", date: { on_or_after: new Date(START - DAY_MS).toISOString() } },
              { property: "Meeting Date", date: { on_or_before: new Date(END + DAY_MS).toISOString() } },
            ],
          },
        },
      },
    ]);
    expect(candidates).toHaveLength(1);
    expect(candidates[0]).toEqual({
      pageId: "fake-page-1",
      url: "https://notion.invalid/fake-page-1",
      createdTime: "2026-11-09T09:10:00.000Z",
      createdById: expect.any(String),
      recordedByIds: [],
      start: START,
      end: END,
      boldTitle: "Weekly sync",
      headings: ["Launch", "Wrap-up"],
    });
    expect(listChildrenCalls).toEqual(["fake-page-1"]);
  });

  it("an all-day page (no T) and a page without end are ignored; listChildren never runs for them", async () => {
    const { client, listChildrenCalls } = fakeNotion({
      pages: {
        "ds-a": [
          page("fake-page-allday", { start: "2026-11-09", end: null }),
          page("fake-page-noend", { start: ISO_START, end: null }),
        ],
      },
    });
    const candidates = await readCandidates(client, [subTable("ds-a")], START, END);
    expect(candidates).toEqual([]);
    expect(listChildrenCalls).toEqual([]);
  });

  it("a page whose range does not overlap enough is not a candidate", async () => {
    // Held a day earlier at the same time: no overlap with our window.
    const otherDay = new Date(Date.UTC(2026, 10, 2, 9, 0)).toISOString();
    const { client, listChildrenCalls } = fakeNotion({
      pages: { "ds-a": [page("fake-page-2", { start: otherDay, end: new Date(Date.UTC(2026, 10, 2, 10)).toISOString() })] },
    });
    const candidates = await readCandidates(client, [subTable("ds-a")], START, END);
    expect(candidates).toEqual([]);
    expect(listChildrenCalls).toEqual([]);
  });

  it("a match in a different sub-table is found", async () => {
    const { client, queries, listChildrenCalls } = fakeNotion({
      pages: {
        "ds-other": [],
        "ds-monday": [page("fake-page-3", { start: ISO_START, end: ISO_END })],
      },
      bodies: { "fake-page-3": NOTES_BODY },
    });
    const candidates = await readCandidates(
      client,
      [subTable("ds-other"), subTable("ds-monday")],
      START,
      END,
    );

    expect(queries.map((q) => q.dataSourceId)).toEqual(["ds-other", "ds-monday"]);
    expect(candidates).toHaveLength(1);
    expect(candidates[0].pageId).toBe("fake-page-3");
    expect(listChildrenCalls).toEqual(["fake-page-3"]);
  });

  it("sub-tables are deduped by dataSourceId: one query", async () => {
    const { client, queries } = fakeNotion({ pages: { "ds-a": [] } });
    await readCandidates(client, [subTable("ds-a"), subTable("ds-a")], START, END);
    expect(queries).toHaveLength(1);
  });

  it("recordedByIds come from the sub-table's Recorded by property when set", async () => {
    const { client } = fakeNotion({
      pages: {
        "ds-a": [
          page("fake-page-4", { start: ISO_START, end: ISO_END }, {
            recordedByIds: ["fake-owned-1", "fake-peer-9"],
          }),
        ],
      },
      bodies: { "fake-page-4": NOTES_BODY },
    });
    const candidates = await readCandidates(client, [subTable("ds-a")], START, END);
    expect(candidates[0].recordedByIds).toEqual(["fake-owned-1", "fake-peer-9"]);
  });

  it("a first paragraph after the Meeting Notes heading that is not all bold → boldTitle \"\"", async () => {
    const { client } = fakeNotion({
      pages: { "ds-a": [page("fake-page-5", { start: ISO_START, end: ISO_END })] },
      bodies: {
        "fake-page-5": [heading2("Meeting Notes"), paragraph("someone typed this"), heading3("Launch")],
      },
    });
    const candidates = await readCandidates(client, [subTable("ds-a")], START, END);
    expect(candidates[0].boldTitle).toBe("");
    expect(candidates[0].headings).toEqual(["Launch"]);
  });
});

describe("sameMeeting", () => {
  const SUMMARY: NotionSummary = {
    title: "Weekly sync",
    actionItems: [],
    sections: [{ heading: "Launch", bullets: ["Ship on Friday"] }],
    practices: [],
  };

  function candidate(): Candidate {
    return {
      pageId: "fake-page-1",
      url: "https://notion.invalid/fake-page-1",
      createdTime: "2026-11-09T09:10:00.000Z",
      createdById: null,
      recordedByIds: [],
      start: START,
      end: END,
      boldTitle: "Weekly sync",
      headings: ["Launch", "Wrap-up"],
    };
  }

  function aiOf(impl: (systemPrompt: string, userMessage: string, timeoutMs: number) => Promise<string>): NotionAi {
    return { ask: vi.fn(impl) };
  }

  it("the AI calls them the same → true; ask gets the prompt, both records, and the 30_000 ms timeout", async () => {
    const ai = aiOf(async () => '{"same": true}');
    const result = await sameMeeting(ai, candidate(), SUMMARY);
    expect(result).toBe(true);
    expect(ai.ask).toHaveBeenCalledTimes(1);
    const [systemPrompt, userMessage, timeoutMs] = (ai.ask as ReturnType<typeof vi.fn>).mock.calls[0];
    expect(systemPrompt).toBe(SAME_MEETING_PROMPT);
    expect(timeoutMs).toBe(SAME_MEETING_TIMEOUT_MS);
    expect(timeoutMs).toBe(30_000);
    // Both records are present, clearly labelled as data.
    expect(userMessage).toContain("MEETING A");
    expect(userMessage).toContain("MEETING B");
    expect(userMessage).toContain("title: Weekly sync");
    expect(userMessage).toContain("section headings: Launch");
    expect(userMessage).toContain("bold title: Weekly sync");
    expect(userMessage).toContain("headings: Launch, Wrap-up");
  });

  it("overlapping ranges the AI calls different → not same", async () => {
    const ai = aiOf(async () => '{"same": false}');
    expect(await sameMeeting(ai, candidate(), SUMMARY)).toBe(false);
  });

  it("a fenced reply still parses", async () => {
    const ai = aiOf(async () => '```json\n{"same": true}\n```');
    expect(await sameMeeting(ai, candidate(), SUMMARY)).toBe(true);
  });

  it("a SummaryError → SAME_MEETING_UNDECIDED, never a guess", async () => {
    const ai = aiOf(async () => {
      throw new SummaryError("SUMMARY_TIMEOUT");
    });
    const thrown = await sameMeeting(ai, candidate(), SUMMARY)
      .then(() => null, (e: unknown) => e);
    expect(thrown).toBeInstanceOf(NotionError);
    expect((thrown as NotionError).code).toBe("SAME_MEETING_UNDECIDED");
  });

  it.each([
    ["no json here"],
    ['{"same": "yes"}'],
    ["{\"same\": 1}"],
    ["[]"],
    ['{"same": null}'],
  ])("an unparsable or non-boolean reply %j → SAME_MEETING_UNDECIDED", async (reply) => {
    const ai = aiOf(async () => reply);
    const thrown = await sameMeeting(ai, candidate(), SUMMARY)
      .then(() => null, (e: unknown) => e);
    expect(thrown).toBeInstanceOf(NotionError);
    expect((thrown as NotionError).code).toBe("SAME_MEETING_UNDECIDED");
  });

  it("any other thrown value from ask propagates unchanged - it is a bug, not undecided", async () => {
    const boom = new Error("boom");
    const ai = aiOf(async () => {
      throw boom;
    });
    let caught: unknown;
    try {
      await sameMeeting(ai, candidate(), SUMMARY);
    } catch (thrown) {
      caught = thrown;
    }
    expect(caught).toBe(boom);
    expect(caught).not.toBeInstanceOf(NotionError);
  });

  it("SAME_MEETING_PROMPT demands JSON only, treats the records as data, and explains the bar for true", () => {
    expect(SAME_MEETING_PROMPT).toContain('{"same": true|false}');
    expect(SAME_MEETING_PROMPT.toLowerCase()).toContain("data");
    expect(SAME_MEETING_PROMPT.toLowerCase()).toContain("instructions");
    expect(SAME_MEETING_PROMPT.toLowerCase()).toContain("ignored");
    expect(SAME_MEETING_PROMPT).toContain("only");
  });
});

describe("pickWinner", () => {
  it("the earliest created_time wins", () => {
    expect(
      pickWinner([
        { pageId: "fake-p2", createdTime: "2026-11-09T09:11:00.000Z" },
        { pageId: "fake-p1", createdTime: "2026-11-09T09:10:00.000Z" },
      ]),
    ).toBe("fake-p1");
  });

  it("an equal created_time → the lowest pageId by string compare", () => {
    expect(
      pickWinner([
        { pageId: "fake-p9", createdTime: "2026-11-09T09:10:00.000Z" },
        { pageId: "fake-p3", createdTime: "2026-11-09T09:10:00.000Z" },
      ]),
    ).toBe("fake-p3");
  });

  it("an empty list throws a plain Error", () => {
    const thrown = (() => {
      try {
        pickWinner([]);
        return null;
      } catch (e) {
        return e;
      }
    })();
    expect(thrown).toBeInstanceOf(Error);
    expect(thrown).not.toBeInstanceOf(NotionError);
  });
});

describe("isOwnPage", () => {
  const ME = { id: "fake-bot-1", ownerUserId: "fake-owned-1" };

  function candidateOf(extra: Partial<Candidate>): Candidate {
    return {
      pageId: "fake-page-1",
      url: "https://notion.invalid/fake-page-1",
      createdTime: "2026-11-09T09:10:00.000Z",
      createdById: null,
      recordedByIds: [],
      start: START,
      end: END,
      boldTitle: "T",
      headings: [],
      ...extra,
    };
  }

  it("matches the bot id, the owner id, or Recorded by", () => {
    expect(isOwnPage(candidateOf({ createdById: "fake-bot-1" }), ME)).toBe(true);
    expect(isOwnPage(candidateOf({ createdById: "fake-owned-1" }), ME)).toBe(true);
    expect(
      isOwnPage(candidateOf({ createdById: null, recordedByIds: ["fake-peer-7", "fake-owned-1"] }), ME),
    ).toBe(true);
  });

  it("a teammate's page, and a null ownerUserId, never match", () => {
    expect(isOwnPage(candidateOf({ createdById: "fake-teammate-1" }), ME)).toBe(false);
    expect(isOwnPage(candidateOf({ createdById: null }), ME)).toBe(false);
    const noOwner = { id: "fake-bot-1", ownerUserId: null };
    expect(isOwnPage(candidateOf({ createdById: "fake-owned-1" }), noOwner)).toBe(false);
    expect(isOwnPage(candidateOf({ createdById: null, recordedByIds: ["fake-owned-1"] }), noOwner)).toBe(false);
  });
});
