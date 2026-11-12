import { describe, expect, it, vi, type Mock } from "vitest";

// Same mocks notion-same-meeting.test.ts needs: knowledge.ts imports
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

import type {
  NotionBlockInput,
  NotionClient,
  NotionPage,
  NotionProperty,
} from "@/lib/notion/client";
import type { NotionAi } from "@/lib/notion/ai";
import type { NotionSummary } from "@/lib/notion/summarize";
import { NotionError, SummaryError } from "@/lib/notion/errors";
import {
  PRACTICES_PROMPT,
  PRACTICES_TIMEOUT_MS,
  addPractices,
  readKnowledge,
  type KnowledgeDb,
} from "@/lib/notion/knowledge";

// Fake ids only - never a real Notion id, email or token.
const DB_ID = "db-knowledge";
const DATA_SOURCE_ID = "ds-knowledge";
const PAGE_URL = "https://notion.invalid/meeting-9";
const OTHER_URL = "https://notion.invalid/other-meeting";

let fakeCounter = 0;

type RecordedCall = { method: string; args: unknown[] };
type Creation = { parent: unknown; properties: Record<string, unknown> };

function failing(method: string): never {
  throw new Error(`unexpected call: ${method}`);
}

interface FakeClientOpts {
  dataSources?: { id: string; name: string }[];
  dataSourceProperties?: Record<string, unknown>;
  queryPages?: NotionPage[];
  onCreatePage?: () => void;
}

/**
 * A NotionClient whose every method records { method, args } into one array;
 * anything other than database/dataSource/queryAll/createPage fails loudly.
 */
function fakeNotionClient(opts: FakeClientOpts = {}): {
  client: NotionClient;
  calls: RecordedCall[];
  creations: Creation[];
} {
  const calls: RecordedCall[] = [];
  const creations: Creation[] = [];
  const record = (method: string, ...args: unknown[]) => {
    calls.push({ method, args });
  };
  return {
    calls,
    creations,
    client: {
      request: vi.fn(async (method: string, path: string, body?: unknown) => {
        record("request", method, path, body);
        return failing("request");
      }),
      me: async () => {
        record("me");
        return failing("me");
      },
      userName: async (id: string) => {
        record("userName", id);
        return failing("userName");
      },
      database: async (id: string) => {
        record("database", id);
        return { dataSources: opts.dataSources ?? [] };
      },
      dataSource: async (id: string) => {
        record("dataSource", id);
        return {
          id,
          name: "Team Knowledge",
          properties: (opts.dataSourceProperties ?? {}) as Record<string, NotionProperty>,
        };
      },
      queryAll: async (dataSourceId: string, body: object) => {
        record("queryAll", dataSourceId, body);
        return opts.queryPages ?? [];
      },
      createPage: async (body: object) => {
        // Records on a later tick, like the real client's HTTP call.
        await Promise.resolve();
        record("createPage", body);
        const cast = body as { parent?: unknown; properties?: Record<string, unknown> };
        creations.push({ parent: cast.parent, properties: cast.properties ?? {} });
        if (opts.onCreatePage) opts.onCreatePage();
        fakeCounter += 1;
        return { id: `fake-row-${fakeCounter}` } as NotionPage;
      },
      listChildren: async (blockId: string) => {
        record("listChildren", blockId);
        return failing("listChildren");
      },
      appendChildren: async (blockId: string, children: NotionBlockInput[]) => {
        record("appendChildren", blockId, children);
        return failing("appendChildren");
      },
      trashPage: async (pageId: string) => {
        record("trashPage", pageId);
        return failing("trashPage");
      },
    },
  };
}

/** A fake NotionAi: `respond` returns the reply, or throws, on each ask. */
function fakeAi(respond: () => string): { ai: NotionAi; ask: Mock } {
  const ask = vi.fn(async (_systemPrompt: string, _userMessage: string, _timeoutMs: number) =>
    respond(),
  );
  return { ai: { ask }, ask };
}

function okReply(entries: unknown): string {
  return JSON.stringify({ results: entries });
}

function practice(rule: string, topic: string | null): NotionSummary["practices"][number] {
  return { rule, topic };
}

function knowledgeDb(overrides: Partial<KnowledgeDb> = {}): KnowledgeDb {
  return {
    dataSourceId: DATA_SOURCE_ID,
    topicOptions: ["Reports", "Process"],
    hasProposed: true,
    rules: [],
    ...overrides,
  };
}

function recordingOnRow(): Mock {
  return vi.fn(async () => undefined);
}

type AskPayload = {
  candidates: { index: number; rule: string; topic: string | null }[];
  existing_rules: string[];
  topic_options: string[];
};

function askUserMessage(ask: Mock): AskPayload {
  const call = ask.mock.calls[0] as unknown[];
  return JSON.parse(call[1] as string) as AskPayload;
}

/** The Team Knowledge data-source shape readKnowledge should be able to use. */
const KNOWLEDGE_PROPERTIES: Record<string, unknown> = {
  Rule: { type: "title" },
  Topic: { type: "select", select: { options: [{ name: "Reports" }, { name: "Process" }] } },
  Status: { type: "status", status: { options: [{ name: "Accepted" }, { name: "Proposed" }] } },
  "Meeting link": { type: "url" },
};

function knowledgeRow(
  rule: string | { plain_text?: string; text?: { content?: string } }[],
  meetingLink: string | null,
): NotionPage {
  const runs = typeof rule === "string" ? [{ plain_text: rule }] : rule;
  return {
    id: `fake-row-${++fakeCounter}`,
    properties: {
      Rule: { type: "title", title: runs },
      ...(meetingLink === null ? {} : { "Meeting link": { type: "url", url: meetingLink } }),
    } as NotionPage["properties"],
  };
}

describe("readKnowledge", () => {
  it("returns the exact KnowledgeDb from the first data source", async () => {
    const { client, calls } = fakeNotionClient({
      dataSources: [
        { id: DATA_SOURCE_ID, name: "Team Knowledge" },
        { id: "ds-second", name: "Other" },
      ],
      dataSourceProperties: KNOWLEDGE_PROPERTIES,
      queryPages: [
        // A title arriving as separate runs is concatenated.
        knowledgeRow([{ plain_text: "Weekly " }, { text: { content: "reports go out on Friday" } }], OTHER_URL),
        // A row without a Meeting link property reads meetingLink: null.
        knowledgeRow("Design reviews happen before launch", null),
      ],
    });
    const db = await readKnowledge(client, DB_ID);
    // No Status filter: every row comes back, or accepted rules would stop
    // deduping future sends.
    expect(calls).toContainEqual({ method: "queryAll", args: [DATA_SOURCE_ID, {}] });
    expect(db).toEqual({
      dataSourceId: DATA_SOURCE_ID,
      topicOptions: ["Reports", "Process"],
      hasProposed: true,
      rules: [
        { rule: "Weekly reports go out on Friday", meetingLink: OTHER_URL },
        { rule: "Design reviews happen before launch", meetingLink: null },
      ],
    });
  });

  it("a Status whose options lack Proposed reads hasProposed: false", async () => {
    const { client } = fakeNotionClient({
      dataSources: [{ id: DATA_SOURCE_ID, name: "Team Knowledge" }],
      dataSourceProperties: {
        ...KNOWLEDGE_PROPERTIES,
        Status: { type: "status", status: { options: [{ name: "Accepted" }] } },
      },
    });
    const db = await readKnowledge(client, DB_ID);
    expect(db.hasProposed).toBe(false);
  });

  it("a mis-typed Topic or Status reads empty options, not a crash", async () => {
    const { client } = fakeNotionClient({
      dataSources: [{ id: DATA_SOURCE_ID, name: "Team Knowledge" }],
      dataSourceProperties: {
        Rule: { type: "title" },
        Topic: { type: "select", select: { options: "nope" } },
        Status: { type: "status", status: { options: [{ name: 7 }] } },
      },
    });
    const db = await readKnowledge(client, DB_ID);
    expect(db.topicOptions).toEqual([]);
    expect(db.hasProposed).toBe(false);
  });

  it("a database with no data source throws NOTION_INVALID", async () => {
    const { client } = fakeNotionClient({ dataSources: [] });
    await expect(readKnowledge(client, DB_ID)).rejects.toMatchObject({
      code: "NOTION_INVALID",
    });
  });
});

describe("addPractices", () => {
  it("PRACTICES_TIMEOUT_MS is 60 seconds", () => {
    expect(PRACTICES_TIMEOUT_MS).toBe(60_000);
  });

  it("missing Proposed option → NOTION_INVALID and nothing written", async () => {
    const { client, creations } = fakeNotionClient();
    const { ai, ask } = fakeAi(() => okReply([]));
    const onRow = recordingOnRow();
    await expect(
      addPractices(
        client,
        ai,
        knowledgeDb({ hasProposed: false }),
        [practice("Weekly reports go out on Friday", "Reports")],
        PAGE_URL,
        onRow,
      ),
    ).rejects.toMatchObject({ code: "NOTION_INVALID" });
    // Before any ask or write: the very first statement.
    expect(ask).not.toHaveBeenCalled();
    expect(creations).toEqual([]);
    expect(onRow).not.toHaveBeenCalled();
  });

  it("an empty candidate list calls neither ask nor createPage", async () => {
    const empty = fakeNotionClient();
    const emptyAi = fakeAi(() => okReply([]));
    await addPractices(empty.client, emptyAi.ai, knowledgeDb(), [], PAGE_URL, recordingOnRow());
    expect(emptyAi.ask).not.toHaveBeenCalled();
    expect(empty.creations).toEqual([]);

    // The same when every candidate is dropped before the model: an exact
    // normalised duplicate of an existing rule stays unasked.
    const dropped = fakeNotionClient();
    const droppedAi = fakeAi(() => okReply([]));
    await addPractices(
      dropped.client,
      droppedAi.ai,
      knowledgeDb({ rules: [{ rule: "Weekly reports go out on Friday", meetingLink: null }] }),
      [practice("WEEKLY   reports go out on Friday…", "Reports")],
      PAGE_URL,
      recordingOnRow(),
    );
    expect(droppedAi.ask).not.toHaveBeenCalled();
    expect(dropped.creations).toEqual([]);
  });

  it("rows the model marks duplicate are skipped", async () => {
    const { client, creations } = fakeNotionClient();
    const { ai, ask } = fakeAi(() =>
      okReply([
        { index: 0, duplicate: true, topic: null },
        { index: 1, duplicate: false, topic: "Process" },
      ]),
    );
    const onRow = recordingOnRow();
    await addPractices(
      client,
      ai,
      knowledgeDb({ rules: [{ rule: "Weekly reports go out on Fridays", meetingLink: OTHER_URL }] }),
      [
        // A reworded duplicate only the model can catch (different suffix).
        practice("Weekly reports go out on Friday.", "Reports"),
        practice("Standups are recorded daily", "Process"),
      ],
      PAGE_URL,
      onRow,
    );
    expect(ask).toHaveBeenCalledOnce();
    expect(ask.mock.calls[0]?.[0]).toBe(PRACTICES_PROMPT);
    expect(ask.mock.calls[0]?.[2]).toBe(PRACTICES_TIMEOUT_MS);
    expect(askUserMessage(ask)).toEqual({
      candidates: [
        { index: 0, rule: "Weekly reports go out on Friday.", topic: "Reports" },
        { index: 1, rule: "Standups are recorded daily", topic: "Process" },
      ],
      existing_rules: ["Weekly reports go out on Fridays"],
      topic_options: ["Reports", "Process"],
    });
    expect(creations).toHaveLength(1);
    expect(creations[0]?.parent).toEqual({
      type: "data_source_id",
      data_source_id: DATA_SOURCE_ID,
    });
    expect(creations[0]?.properties).toEqual({
      Rule: { title: [{ type: "text", text: { content: "Standups are recorded daily" } }] },
      Status: { status: { name: "Proposed" } },
      Topic: { select: { name: "Process" } },
      "Meeting link": { url: PAGE_URL },
    });
    expect(onRow).toHaveBeenCalledOnce();
  });

  it("a retry skips rules already added with this page's Meeting link, without asking the model about them", async () => {
    const { client, creations } = fakeNotionClient();
    const { ai, ask } = fakeAi(() =>
      // One candidate, index 0 - A never became a candidate.
      okReply([{ index: 0, duplicate: false, topic: null }]),
    );
    const onRow = recordingOnRow();
    await addPractices(
      client,
      ai,
      knowledgeDb({
        rules: [
          // Added by this send's earlier attempt: same page, folded spelling.
          { rule: "weekly reports go out on friday.", meetingLink: PAGE_URL },
          { rule: "Standups are recorded daily", meetingLink: OTHER_URL },
        ],
      }),
      [
        practice("Weekly reports go out on Friday", "Reports"),
        practice("Design reviews happen before launch", "Process"),
      ],
      PAGE_URL,
      onRow,
    );
    expect(ask).toHaveBeenCalledOnce();
    const payload = askUserMessage(ask);
    expect(payload.candidates).toEqual([
      { index: 0, rule: "Design reviews happen before launch", topic: "Process" },
    ]);
    // Only rows of OTHER pages are shown to the model.
    expect(payload.existing_rules).toEqual(["Standups are recorded daily"]);
    const rawMessage = ask.mock.calls[0]?.[1];
    expect(rawMessage).not.toContain("weekly reports go out on friday");
    expect(creations).toHaveLength(1);
    expect(creations[0]?.properties.Rule).toEqual({
      title: [{ type: "text", text: { content: "Design reviews happen before launch" } }],
    });
    // topic null → the Topic key is simply absent.
    expect(creations[0]?.properties.Topic).toBeUndefined();
    expect(onRow).toHaveBeenCalledOnce();
  });

  it("a decision that omits topic reads as topic null: written with no Topic key", async () => {
    const { client, creations } = fakeNotionClient();
    const { ai } = fakeAi(() => '{"results":[{"index":0,"duplicate":false}]}');
    await addPractices(client, ai, knowledgeDb(), [practice("Standups are recorded daily", "Process")], PAGE_URL, recordingOnRow());
    expect(creations).toHaveLength(1);
    expect(creations[0]?.properties.Topic).toBeUndefined();
  });

  it("candidates that repeat an earlier candidate in the list are dropped before the model", async () => {
    const { client, creations } = fakeNotionClient();
    const { ai, ask } = fakeAi(() => okReply([{ index: 0, duplicate: false, topic: null }]));
    const onRow = recordingOnRow();
    await addPractices(
      client,
      ai,
      knowledgeDb(),
      [
        practice("Standups are recorded daily", null),
        // Same practice after case, whitespace and trailing-period changes.
        practice("  STANDUPS  are recorded daily.  ", null),
      ],
      PAGE_URL,
      onRow,
    );
    // The model sees only the first spelling, under one index.
    const payload = askUserMessage(ask);
    expect(payload.candidates).toEqual([
      { index: 0, rule: "Standups are recorded daily", topic: null },
    ]);
    expect(creations).toHaveLength(1);
    expect(creations[0]?.properties.Rule).toEqual({
      title: [{ type: "text", text: { content: "Standups are recorded daily" } }],
    });
    expect(onRow).toHaveBeenCalledOnce();
  });

  it("Status is always { status: { name: 'Proposed' } }", async () => {
    const { client, creations } = fakeNotionClient();
    const { ai } = fakeAi(() => okReply([{ index: 0, duplicate: false, topic: "Reports" }]));
    await addPractices(
      client,
      ai,
      knowledgeDb(),
      [practice("Weekly reports go out on Friday", "Reports")],
      PAGE_URL,
      recordingOnRow(),
    );
    expect(creations).toHaveLength(1);
    expect(creations[0]?.properties.Status).toEqual({ status: { name: "Proposed" } });
  });

  it("a topic matching an option case-insensitively is written in the option's own spelling; an unmatched topic omits the Topic key", async () => {
    // "reports" case-folds to the "Reports" option, written as Notion spells it.
    const folded = fakeNotionClient();
    const foldedAi = fakeAi(() => okReply([{ index: 0, duplicate: false, topic: "reports" }]));
    await addPractices(
      folded.client,
      foldedAi.ai,
      knowledgeDb(),
      [practice("Weekly reports go out on Friday", "Reports")],
      PAGE_URL,
      recordingOnRow(),
    );
    expect(folded.creations[0]?.properties.Topic).toEqual({ select: { name: "Reports" } });

    // "Finance" matches no option - no Topic key at all, so no request ever
    // creates a select option.
    const unmatched = fakeNotionClient();
    const unmatchedAi = fakeAi(() => okReply([{ index: 0, duplicate: false, topic: "Finance" }]));
    const onRow = recordingOnRow();
    await addPractices(
      unmatched.client,
      unmatchedAi.ai,
      knowledgeDb(),
      [practice("Fees are reviewed quarterly", "Finance")],
      PAGE_URL,
      onRow,
    );
    expect(unmatched.creations[0]?.properties.Topic).toBeUndefined();
    expect(onRow).toHaveBeenCalledOnce();
  });

  it("onRow is called once per created row, right after each createPage", async () => {
    const order: string[] = [];
    const { client, creations } = fakeNotionClient({
      onCreatePage: () => order.push("createPage"),
    });
    const { ai } = fakeAi(() =>
      okReply([
        { index: 0, duplicate: false, topic: "Reports" },
        { index: 1, duplicate: false, topic: null },
      ]),
    );
    // both fakes record on a later tick, like real async calls, so this pins
    // the true sequencing: each onRow finishes before the next createPage.
    const onRow = vi.fn(async () => {
      await Promise.resolve();
      order.push("onRow");
    });
    await addPractices(
      client,
      ai,
      knowledgeDb(),
      [practice("Weekly reports go out on Friday", "Reports"), practice("Standups are recorded daily", "Process")],
      PAGE_URL,
      onRow,
    );
    expect(creations).toHaveLength(2);
    expect(onRow).toHaveBeenCalledTimes(2);
    expect(order).toEqual(["createPage", "onRow", "createPage", "onRow"]);
  });

  it("a throwing onRow stops the loop and propagates, with no further createPage", async () => {
    const { client, creations, calls } = fakeNotionClient();
    const { ai } = fakeAi(() =>
      okReply([
        { index: 0, duplicate: false, topic: "Reports" },
        { index: 1, duplicate: false, topic: null },
      ]),
    );
    const rowError = new Error("row lost");
    const onRow = vi.fn(async () => {
      throw rowError;
    });
    await expect(
      addPractices(
        client,
        ai,
        knowledgeDb(),
        [practice("Weekly reports go out on Friday", "Reports"), practice("Standups are recorded daily", "Process")],
        PAGE_URL,
        onRow,
      ),
    ).rejects.toBe(rowError);
    expect(calls.filter((call) => call.method === "createPage")).toHaveLength(1);
    expect(creations).toHaveLength(1);
    expect(onRow).toHaveBeenCalledOnce();
  });

  it("repeated indices keep the first valid entry and out-of-range indices are ignored", async () => {
    const { client, creations } = fakeNotionClient();
    const { ai } = fakeAi(() =>
      okReply([
        { index: 0, duplicate: true, topic: null },
        { index: 0, duplicate: false, topic: "Process" }, // later entry loses
        { index: 9, duplicate: false, topic: "Reports" }, // not a candidate index
      ]),
    );
    await addPractices(
      client,
      ai,
      knowledgeDb(),
      [practice("Weekly reports go out on Friday", "Reports")],
      PAGE_URL,
      recordingOnRow(),
    );
    expect(creations).toEqual([]);
  });

  it("a reply missing one candidate index → PRACTICES_UNDECIDED and no createPage", async () => {
    const { client, creations } = fakeNotionClient();
    const { ai } = fakeAi(() =>
      okReply([{ index: 0, duplicate: false, topic: "Reports" }]), // index 1 missing
    );
    const onRow = recordingOnRow();
    await expect(
      addPractices(
        client,
        ai,
        knowledgeDb(),
        [practice("Standups are recorded daily", null), practice("Design reviews happen before launch", null)],
        PAGE_URL,
        onRow,
      ),
    ).rejects.toMatchObject({ code: "PRACTICES_UNDECIDED" });
    expect(creations).toEqual([]);
    expect(onRow).not.toHaveBeenCalled();
  });

  it("an unparsable or shapeless reply → PRACTICES_UNDECIDED and nothing written", async () => {
    for (const reply of [
      "I cannot read that file.",
      '{"verdicts":[{"index":0}]}',
      '{"results":[{"index":0}]}',
      // A non-string, non-null topic is not a valid entry, so the index is
      // unjudged rather than written with a bogus topic.
      '{"results":[{"index":0,"duplicate":false,"topic":5}]}',
      // Same when `duplicate` is not a boolean.
      '{"results":[{"index":0,"duplicate":"false","topic":null}]}',
    ]) {
      const { client, creations } = fakeNotionClient();
      const { ai } = fakeAi(() => reply);
      await expect(
        addPractices(
          client,
          ai,
          knowledgeDb(),
          [practice("Standups are recorded daily", null)],
          PAGE_URL,
          recordingOnRow(),
        ),
      ).rejects.toMatchObject({ code: "PRACTICES_UNDECIDED" });
      expect(creations).toEqual([]);
    }
  });

  it("model failure → PRACTICES_UNDECIDED and nothing written", async () => {
    const { client, creations } = fakeNotionClient();
    const { ai } = fakeAi(() => {
      throw new SummaryError("SUMMARY_NETWORK");
    });
    await expect(
      addPractices(
        client,
        ai,
        knowledgeDb(),
        [practice("Standups are recorded daily", null)],
        PAGE_URL,
        recordingOnRow(),
      ),
    ).rejects.toMatchObject({ code: "PRACTICES_UNDECIDED" });
    expect(creations).toEqual([]);
  });

  it("a plain Error from ask propagates unchanged", async () => {
    const { client, creations } = fakeNotionClient();
    const err = new Error("provider socket closed");
    const { ai } = fakeAi(() => {
      throw err;
    });
    // Identity, not just message: a rewrap like new Error(e.message) must fail.
    await expect(
      addPractices(
        client,
        ai,
        knowledgeDb(),
        [practice("Standups are recorded daily", null)],
        PAGE_URL,
        recordingOnRow(),
      ),
    ).rejects.toBe(err);
    expect(err).not.toBeInstanceOf(NotionError);
    expect(creations).toEqual([]);
  });

  it("never PATCHes or edits existing rows", async () => {
    const fake = fakeNotionClient({
      dataSources: [{ id: DATA_SOURCE_ID, name: "Team Knowledge" }],
      dataSourceProperties: KNOWLEDGE_PROPERTIES,
      queryPages: [knowledgeRow("Weekly reports go out on Friday", OTHER_URL)],
    });
    const { ai } = fakeAi(() => okReply([{ index: 0, duplicate: false, topic: "Process" }]));
    const db = await readKnowledge(fake.client, DB_ID);
    await addPractices(
      fake.client,
      ai,
      db,
      [practice("Standups are recorded daily", "Process")],
      PAGE_URL,
      recordingOnRow(),
    );
    // One call array for the whole flow: no request (PATCH lives there), no
    // trashPage, no appendChildren - so no select option is ever created.
    const editCalls = fake.calls.filter(
      (call) =>
        call.method === "request" || call.method === "trashPage" || call.method === "appendChildren",
    );
    expect(editCalls).toEqual([]);
    // The writes are creates parented on the data source, carrying only the
    // fixed Team Knowledge properties (never Source meeting).
    expect(fake.creations).toHaveLength(1);
    for (const creation of fake.creations) {
      expect(creation.parent).toEqual({ type: "data_source_id", data_source_id: DATA_SOURCE_ID });
      expect(Object.keys(creation.properties).sort()).toEqual([
        "Meeting link",
        "Rule",
        "Status",
        "Topic",
      ]);
    }
    expect(fake.creations[0]?.properties.Topic).toEqual({ select: { name: "Process" } });
  });
});
