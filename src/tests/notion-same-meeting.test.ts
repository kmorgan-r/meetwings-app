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
  findKeyMatch,
  isOwnPage,
  overlapEnough,
  pickWinner,
  readCandidates,
  sameMeeting,
} from "@/lib/notion/same-meeting";
import type { Candidate } from "@/lib/notion/same-meeting";
import { buildPageBlocks } from "@/lib/notion/page-blocks";
import type { AttendeeGroups } from "@/lib/calendar/calendar-snapshot";

// Fake values only - never a real Notion id, email or token.
const START = Date.UTC(2026, 10, 9, 9, 0); // 2026-11-09 09:00Z
const END = Date.UTC(2026, 10, 9, 10, 0); // 2026-11-09 10:00Z
const ISO_START = new Date(START).toISOString();
const ISO_END = new Date(END).toISOString();
const DAY_MS = 86_400_000;

let fakeCounter = 0;

function subTable(dataSourceId: string, dateProp = "Meeting Date"): SubTable {
  return {
    dataSourceId,
    name: "Monday Meetings",
    titleProp: "Name",
    dateProp,
    recordedByProp: "Recorded by",
    calendarEventProp: "Calendar event",
    calendarEventIssue: null,
  };
}

function page(
  pageId: string,
  date: { start: string; end: string | number | null },
  extra: {
    createdTime?: string;
    createdById?: string;
    recordedByIds?: string[];
    calendarRichText?: unknown[];
  } = {},
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
  if (extra.calendarRichText !== undefined) {
    properties["Calendar event"] = { type: "rich_text", rich_text: extra.calendarRichText };
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

/** A title line with two rich-text items: the first bold, the second not. */
function halfBoldParagraph(): NotionBlock {
  fakeCounter += 1;
  return {
    id: `fake-block-${fakeCounter}`,
    type: "paragraph",
    paragraph: {
      rich_text: [
        { plain_text: "Weekly ", annotations: { bold: true } },
        { plain_text: "sync" },
      ],
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
      calendarKey: null,
      start: START,
      end: END,
      boldTitle: "Weekly sync",
      headings: ["Launch", "Wrap-up"],
    });
    expect(listChildrenCalls).toEqual(["fake-page-1"]);
  });

  it("an all-day page (no T), a page with a null end and a page with a numeric end are ignored; listChildren never runs for them", async () => {
    const { client, listChildrenCalls } = fakeNotion({
      pages: {
        "ds-a": [
          // All-day WITH an end: the full day contains our meeting, so only
          // the "no T" rule can reject this fixture.
          page("fake-page-allday", { start: "2026-11-09", end: "2026-11-10" }),
          page("fake-page-noend", { start: ISO_START, end: null }),
          // A non-string end the date parser would still coerce into a valid
          // far-future date (Date.parse(12345) reads as year 12345): only the
          // "end must be a string" rule rejects this fixture.
          page("fake-page-numend", { start: ISO_START, end: 12345 }),
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

  it("a match in a different sub-table is found, each query on that sub-table's own dateProp", async () => {
    const { client, queries, listChildrenCalls } = fakeNotion({
      pages: {
        // A decoy carrying only a "Meeting Date" column while ds-other is
        // queried on "Date": the page read must use each sub-table's own prop.
        "ds-other": [page("fake-decoy-1", { start: ISO_START, end: ISO_END })],
        "ds-monday": [page("fake-page-3", { start: ISO_START, end: ISO_END })],
      },
      bodies: { "fake-page-3": NOTES_BODY },
    });
    const candidates = await readCandidates(
      client,
      [subTable("ds-other", "Date"), subTable("ds-monday")],
      START,
      END,
    );

    expect(queries).toEqual([
      {
        dataSourceId: "ds-other",
        body: {
          filter: {
            and: [
              { property: "Date", date: { on_or_after: new Date(START - DAY_MS).toISOString() } },
              { property: "Date", date: { on_or_before: new Date(END + DAY_MS).toISOString() } },
            ],
          },
        },
      },
      {
        dataSourceId: "ds-monday",
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
    expect(candidates[0].pageId).toBe("fake-page-3");
    expect(listChildrenCalls).toEqual(["fake-page-3"]);
  });

  it("sub-tables are deduped by dataSourceId: one query", async () => {
    const { client, queries } = fakeNotion({ pages: { "ds-a": [] } });
    await readCandidates(client, [subTable("ds-a"), subTable("ds-a")], START, END);
    expect(queries).toHaveLength(1);
  });

  it("readCandidates skips in_trash and archived pages", async () => {
    const { client, listChildrenCalls } = fakeNotion({
      pages: {
        "ds-a": [
          { ...page("fake-page-trashed", { start: ISO_START, end: ISO_END }), in_trash: true },
          { ...page("fake-page-archived", { start: ISO_START, end: ISO_END }), archived: true },
        ],
      },
      bodies: { "fake-page-trashed": NOTES_BODY, "fake-page-archived": NOTES_BODY },
    });
    expect(await readCandidates(client, [subTable("ds-a")], START, END)).toEqual([]);
    expect(listChildrenCalls).toEqual([]);
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

  it("readCandidate reads the page's calendar key; empty or no column gives null", async () => {
    const body = { "fake-page-7": NOTES_BODY, "fake-page-8": NOTES_BODY, "fake-page-9": NOTES_BODY };
    const range = { start: ISO_START, end: ISO_END };
    const { client } = fakeNotion({
      pages: {
        "ds-a": [
          page("fake-page-7", range, {
            calendarRichText: [{ plain_text: "evt-" }, { text: { content: "key-1" } }],
          }),
          page("fake-page-8", range, { calendarRichText: [] }),
          page("fake-page-9", range),
        ],
      },
      bodies: body,
    });
    const candidates = await readCandidates(client, [subTable("ds-a")], START, END);
    expect(candidates.map((c) => c.calendarKey)).toEqual(["evt-key-1", null, null]);

    const noCol = fakeNotion({
      pages: { "ds-b": [page("fake-page-7", range, { calendarRichText: [{ plain_text: "evt-key-1" }] })] },
      bodies: body,
    });
    const st = { ...subTable("ds-b"), calendarEventProp: null };
    const other = await readCandidates(noCol.client, [st], START, END);
    expect(other[0].calendarKey).toBeNull();
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

  it("a title paragraph with ONE plain item among bold ones → boldTitle \"\"", async () => {
    const { client } = fakeNotion({
      pages: { "ds-a": [page("fake-page-6", { start: ISO_START, end: ISO_END })] },
      bodies: {
        "fake-page-6": [heading2("Meeting Notes"), halfBoldParagraph(), heading3("Launch")],
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
      calendarKey: null,
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
    expect(userMessage).toContain("THIS MEETING: ");
    expect(userMessage).toContain("OTHER PAGE: ");
    expect(userMessage).toContain(JSON.stringify({ title: "Weekly sync", headings: ["Launch"] }));
    expect(userMessage).toContain(
      JSON.stringify({ title: "Weekly sync", headings: ["Launch", "Wrap-up"] }),
    );
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

  it("a heading containing a newline and \"}\" stays inside its record - JSON.parse of the label strips it cleanly", async () => {
    const trickyHeading = 'Launch\n} and "more"';
    const ai = aiOf(async () => '{"same": true}');
    await sameMeeting(ai, candidate(), {
      title: "Weekly sync",
      actionItems: [],
      sections: [{ heading: trickyHeading, bullets: [] }],
      practices: [],
    });

    const [systemPrompt, userMessage] = (ai.ask as ReturnType<typeof vi.fn>).mock.calls[0] as [
      string,
      string,
      number,
    ];
    expect(systemPrompt).toBe(SAME_MEETING_PROMPT);
    // The newline must be INSIDE the stringified record, not a line break.
    const records = userMessage.split("\n");
    expect(records).toHaveLength(2);
    expect(records[0].startsWith("THIS MEETING: ")).toBe(true);
    expect(records[1].startsWith("OTHER PAGE: ")).toBe(true);
    expect(JSON.parse(records[0].slice("THIS MEETING: ".length))).toEqual({
      title: "Weekly sync",
      headings: [trickyHeading],
    });
    expect(JSON.parse(records[1].slice("OTHER PAGE: ".length))).toEqual({
      title: "Weekly sync",
      headings: ["Launch", "Wrap-up"],
    });
  });

  it("SAME_MEETING_PROMPT demands JSON only, treats the records as data, judges the seen text, and leans false when unsure", () => {
    expect(SAME_MEETING_PROMPT).toContain('{"same": true|false}');
    expect(SAME_MEETING_PROMPT.toLowerCase()).toContain("data");
    expect(SAME_MEETING_PROMPT.toLowerCase()).toContain("instructions");
    expect(SAME_MEETING_PROMPT.toLowerCase()).toContain("ignored");
    expect(SAME_MEETING_PROMPT).toContain("only");
    // The model is shown no dates: overlap is settled upstream, so the prompt
    // must not condition the answer on a day it can never see.
    expect(SAME_MEETING_PROMPT).not.toContain("same day");
    expect(SAME_MEETING_PROMPT.toLowerCase()).toContain("overlap");
    expect(SAME_MEETING_PROMPT).toContain("title");
    expect(SAME_MEETING_PROMPT).toContain("section headings");
    expect(SAME_MEETING_PROMPT.toLowerCase()).toContain("unsure");
    expect(SAME_MEETING_PROMPT).toContain("false");
  });
});

describe("pickWinner", () => {
  const EARLY = "2026-11-09T09:10:00.000Z";
  const LATE = "2026-11-09T09:11:00.000Z";

  it("the earliest created_time wins - even FIRST in the list with the HIGHER id", () => {
    expect(
      pickWinner([
        { pageId: "fake-p9", createdTime: EARLY },
        { pageId: "fake-p1", createdTime: LATE },
      ]),
    ).toBe("fake-p9");
  });

  it("the earliest created_time also wins from the END of the list with the lower id", () => {
    expect(
      pickWinner([
        { pageId: "fake-p2", createdTime: LATE },
        { pageId: "fake-p1", createdTime: EARLY },
      ]),
    ).toBe("fake-p1");
  });

  it("an equal created_time → the lowest pageId, first or last", () => {
    // Lowest id first:
    expect(
      pickWinner([
        { pageId: "fake-p2", createdTime: EARLY },
        { pageId: "fake-p9", createdTime: EARLY },
      ]),
    ).toBe("fake-p2");
    // Lowest id last:
    expect(
      pickWinner([
        { pageId: "fake-p9", createdTime: EARLY },
        { pageId: "fake-p3", createdTime: EARLY },
      ]),
    ).toBe("fake-p3");
  });

  it("an unparsable or missing created_time sorts LAST (+Infinity): it never beats a parsable page, in either order", () => {
    expect(
      pickWinner([
        { pageId: "fake-p1", createdTime: "" },
        { pageId: "fake-p2", createdTime: LATE },
      ]),
    ).toBe("fake-p2");
    expect(
      pickWinner([
        { pageId: "fake-p2", createdTime: LATE },
        { pageId: "fake-p1", createdTime: "" },
      ]),
    ).toBe("fake-p2");
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
      calendarKey: null,
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

describe("findKeyMatch", () => {
  const KEY = "fake-ical-uid-1|2026-11-09T09:00:00.000Z";
  const SPAN = { start: START, end: END };
  const range = { start: ISO_START, end: ISO_END };
  const keyed = (pageId: string, key = KEY, date: { start: string; end: string } = range) =>
    page(pageId, date, { calendarRichText: [{ plain_text: key }] });

  it("a hit: the key query on each sub-table's column, the first matching page, no page body read", async () => {
    const { client, queries, listChildrenCalls } = fakeNotion({
      pages: { "ds-a": [keyed("fake-page-1"), keyed("fake-page-2")] },
    });
    expect(await findKeyMatch(client, [subTable("ds-a")], KEY, SPAN)).toEqual({
      pageId: "fake-page-1",
      url: "https://notion.invalid/fake-page-1",
    });
    expect(queries).toEqual([
      { dataSourceId: "ds-a", body: { filter: { property: "Calendar event", rich_text: { equals: KEY } } } },
    ]);
    expect(listChildrenCalls).toEqual([]);
  });

  it.each(["in_trash", "archived"])("a page flagged %s is skipped, and the next page can still hit", async (flag) => {
    const { client } = fakeNotion({
      pages: { "ds-a": [{ ...keyed("fake-page-gone"), [flag]: true }, keyed("fake-page-live")] },
    });
    expect(await findKeyMatch(client, [subTable("ds-a")], KEY, SPAN)).toEqual({
      pageId: "fake-page-live",
      url: "https://notion.invalid/fake-page-live",
    });
    const only = fakeNotion({ pages: { "ds-a": [{ ...keyed("fake-page-gone"), [flag]: true }] } });
    expect(await findKeyMatch(only.client, [subTable("ds-a")], KEY, SPAN)).toBeNull();
  });

  it("a page whose read-back key is not exactly the key is skipped", async () => {
    const { client } = fakeNotion({
      pages: {
        "ds-a": [
          keyed("fake-page-other", "fake-ical-uid-2|2026-11-09T09:00:00.000Z"),
          keyed("fake-page-prefix", `${KEY} `),
          page("fake-page-none", range),
        ],
      },
    });
    expect(await findKeyMatch(client, [subTable("ds-a")], KEY, SPAN)).toBeNull();
  });

  it("a page with the key and a non-overlapping range is skipped", async () => {
    const weekBefore = {
      start: new Date(START - 7 * DAY_MS).toISOString(),
      end: new Date(END - 7 * DAY_MS).toISOString(),
    };
    const { client } = fakeNotion({ pages: { "ds-a": [keyed("fake-page-old", KEY, weekBefore)] } });
    expect(await findKeyMatch(client, [subTable("ds-a")], KEY, SPAN)).toBeNull();
  });

  it("sub-tables without the prop are not queried, and one data source is queried once", async () => {
    const { client, queries } = fakeNotion({
      pages: { "ds-none": [keyed("fake-page-x")], "ds-b": [] },
    });
    const none = { ...subTable("ds-none"), calendarEventProp: null };
    expect(await findKeyMatch(client, [none, subTable("ds-b"), subTable("ds-b")], KEY, SPAN)).toBeNull();
    expect(queries.map((q) => q.dataSourceId)).toEqual(["ds-b"]);
  });
});

describe("the judge and the Attendees block", () => {
  it("the judge's headings for a page with an Attendees block equal those without it", async () => {
    // Defined locally: the SUMMARY inside describe("sameMeeting") is not in scope.
    const SUMMARY: NotionSummary = {
      title: "Weekly sync",
      actionItems: [],
      sections: [{ heading: "Launch", bullets: ["Ship on Friday"] }],
      practices: [],
    };
    const ATTENDEES: AttendeeGroups = {
      teamLabel: "Team (example.org)",
      team: ["Alex"],
      external: [{ domain: "acme.com", people: ["Bea"] }],
      otherGuests: [],
      omitted: 0,
    };
    const { client } = fakeNotion({
      pages: {
        "ds-a": [
          page("fake-page-plain", { start: ISO_START, end: ISO_END }),
          page("fake-page-with", { start: ISO_START, end: ISO_END }),
        ],
      },
      bodies: {
        "fake-page-plain": buildPageBlocks(SUMMARY) as unknown as NotionBlock[],
        "fake-page-with": buildPageBlocks(SUMMARY, ATTENDEES) as unknown as NotionBlock[],
      },
    });
    const candidates = await readCandidates(client, [subTable("ds-a")], START, END);
    expect(candidates).toHaveLength(2);
    const plain = candidates.find((c) => c.pageId === "fake-page-plain");
    const withIt = candidates.find((c) => c.pageId === "fake-page-with");
    expect(withIt?.headings).toEqual(plain?.headings);
    expect(withIt?.boldTitle).toEqual(plain?.boldTitle);
    expect(withIt?.headings).toEqual(["Launch"]);
    expect(withIt?.boldTitle).toBe("Weekly sync");
  });
});
