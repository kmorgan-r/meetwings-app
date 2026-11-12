import fs from "node:fs";
import path from "node:path";
import initSqlJs, { type Database as SqlJsDatabase } from "sql.js";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

let db: SqlJsDatabase;

async function rawExecute(sql: string, params?: unknown[]) {
  db.run(sql, (params ?? []) as never[]);
  return { rowsAffected: db.getRowsModified(), lastInsertId: 0 };
}
async function rawSelect(sql: string, params?: unknown[]) {
  const stmt = db.prepare(sql);
  stmt.bind((params ?? []) as never[]);
  const rows: Record<string, unknown>[] = [];
  while (stmt.step()) rows.push(stmt.getAsObject());
  stmt.free();
  return rows;
}

const mocks = vi.hoisted(() => ({
  execute: vi.fn(),
  select: vi.fn(),
  loadState: vi.fn(),
  loadToken: vi.fn(),
  resolveProvider: vi.fn(),
  secrets: vi.fn(),
  getSummary: vi.fn(),
}));
vi.mock("@/lib/database/config", () => ({
  getDatabase: async () => ({ execute: mocks.execute, select: mocks.select }),
}));
vi.mock("@/lib/storage/notion-config.storage", () => ({ loadNotionConfigState: mocks.loadState }));
vi.mock("@/lib/notion/token", () => ({ loadNotionToken: mocks.loadToken }));
vi.mock("@/lib/functions/summary-provider", () => ({
  resolveSummaryProvider: mocks.resolveProvider,
  summarySecrets: mocks.secrets,
}));
vi.mock("@/lib/database/meeting-context.action", async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  getMeetingSummaryByConversation: mocks.getSummary,
}));

import { NOTION_LANE_OPEN } from "@/lib/database/meeting-log.action";
import { cancelSend, createSendAndLink, retrySend } from "@/lib/database/notion-queue.action";
import type { NotionAi } from "@/lib/notion/ai";
import type { NotionBlock, NotionBlockInput, NotionClient, NotionPage, NotionProperty } from "@/lib/notion/client";
import { NotionError, SummaryError } from "@/lib/notion/errors";
import { PRACTICES_PROMPT } from "@/lib/notion/knowledge";
import { buildPageBlocks, transcriptBlocks } from "@/lib/notion/page-blocks";
import { isNotionRedactorArmed, redactNotion, resetNotionRedactor } from "@/lib/notion/redact";
import { SAME_MEETING_PROMPT } from "@/lib/notion/same-meeting";
import { RECHECK_DELAY_MS, buildSendDeps, runNotionSend, type NotionSendDeps } from "@/lib/notion/send";
import { NOTION_SUMMARY_PROMPT, type NotionSummary } from "@/lib/notion/summarize";
import type { NotionConfigState } from "@/lib/storage/notion-config.storage";
import { MIGRATIONS, applyMigration14 } from "./helpers/migration-14";

// Fake ids, names, urls and secrets only.
const NOW = 1_700_000_000_000;
const START = Date.UTC(2026, 10, 9, 15, 0, 0);
const END = START + 60 * 60 * 1000;
const LINES = ["You: hello team", "Sam: hi there", "You: let's start", "Sam: sounds good"];
const TOKEN = "secret_fake_token_123";
const KEY = "sk-fake-key-456";

const STATE: Extract<NotionConfigState, { state: "complete" }> = {
  state: "complete",
  config: {
    meetingsDbUrl: "https://notion.invalid/meetings",
    knowledgeDbUrl: "https://notion.invalid/knowledge",
    teamTimes: {},
    yourName: "",
  },
  meetingsDbId: "db-meetings",
  knowledgeDbId: "db-know",
};

function seedRow(over: Record<string, unknown>) {
  const row = {
    id: "r1", session_key: `k-${over.id ?? "r1"}`, conversation_id: "c1", instance: "i",
    contact_id: 1, lead_id: null, transcript: "t", transcript_start_at: START,
    transcript_end_at: END, status: "sent", attempts: 0, meeting_started_at: 1,
    created_at: NOW, notion_status: "waiting", notion_send_id: null,
    ...over,
  };
  db.run(
    `INSERT INTO meeting_log_queue (${Object.keys(row).join(",")}) VALUES (${Object.keys(row).map(() => "?").join(",")})`,
    Object.values(row) as never[]
  );
}

/** A joined send `id` with one row holding `lines`; the span is START..END unless overridden. */
async function seedSend(id = "s1", lines: string[] = LINES, span: [number, number] = [START, END]) {
  seedRow({ id: `row-${id}`, transcript: lines.join("\n"), transcript_start_at: span[0], transcript_end_at: span[1] });
  await createSendAndLink(
    { id, conversationId: "c1", spanStartAt: span[0], spanEndAt: span[1], createdAt: NOW },
    [`row-${id}`]
  );
}

const sendOf = async (id = "s1") => (await rawSelect("SELECT * FROM notion_sends WHERE id=?", [id]))[0];
const laneOpen = async () => (await rawSelect(`SELECT id FROM meeting_log_queue WHERE ${NOTION_LANE_OPEN}`)).length;
const tamper = () => db.run("UPDATE notion_sends SET claimed_at = 5 WHERE id = 's1'");

// ---- the fake Notion world ----

interface Page {
  id: string; url: string; created_time: string; created_by: { id: string };
  properties: Record<string, NotionProperty>; ds: string; trashed: boolean; hidden: boolean;
}

function summaryJson(over: Record<string, unknown> = {}): string {
  return JSON.stringify({
    title: "Weekly sync",
    action_items: ["Send notes"],
    sections: [{ heading: "Roadmap", bullets: ["Ship it"] }],
    practices: [],
    ...over,
  });
}

const TWO_PRACTICES = [
  { rule: "Always send an agenda", topic: null },
  { rule: "Rotate the note taker", topic: null },
];

function makeWorld() {
  const w = {
    pages: new Map<string, Page>(),
    kids: new Map<string, NotionBlock[]>(),
    calls: {} as Record<string, number>,
    fails: [] as { method: string; at: number; err: unknown }[],
    createdTime: "2026-11-09T15:00:00.000Z",
    me: { id: "bot-1", ownerUserId: "owner-1" as string | null },
    hasProposed: true,
    counter: 0,
    sameAnswer: true,
    summaryReplies: [] as (string | Error)[],
    defaultSummary: summaryJson(),
    asks: [] as { kind: string; user: string }[],
    loseNextCreateResponse: false,
    onCreate: undefined as ((p: Page) => void) | undefined,
    onMe: undefined as (() => void) | undefined,
    onSleep: undefined as (() => void) | undefined,
    onAppend: undefined as (() => void) | undefined,
    client: undefined as unknown as NotionClient,
    ai: undefined as unknown as NotionAi,
  };

  const tick = (method: string) => {
    w.calls[method] = (w.calls[method] ?? 0) + 1;
    const f = w.fails.find((x) => x.method === method && x.at === w.calls[method]);
    if (f) throw f.err;
  };
  const addBlocks = (inputs: NotionBlockInput[]): NotionBlock[] =>
    inputs.map((b) => {
      const block = { ...b, id: `b-${++w.counter}` } as NotionBlock;
      if (b.type === "toggle") w.kids.set(block.id as string, []);
      return block;
    });
  const asPage = (p: Page): NotionPage => ({
    id: p.id, url: p.url, created_time: p.created_time, created_by: p.created_by, properties: p.properties,
  });

  w.client = {
    request: async () => {
      throw new Error("unexpected request");
    },
    me: async () => {
      tick("me");
      w.onMe?.();
      return w.me;
    },
    userName: async () => {
      tick("userName");
      return "Owner Name";
    },
    database: async (id: string) => {
      tick("database");
      return { dataSources: id === "db-know" ? [{ id: "ds-know", name: "Knowledge" }] : [{ id: "ds-main", name: "Other" }] };
    },
    dataSource: async (id: string) => {
      tick("dataSource");
      if (id === "ds-know") {
        return {
          id, name: "Knowledge",
          properties: {
            Rule: { type: "title" },
            Status: { type: "status", status: { options: w.hasProposed ? [{ name: "Proposed" }] : [] } },
            Topic: { type: "select", select: { options: [{ name: "Process" }] } },
            "Meeting link": { type: "url" },
          },
        };
      }
      return {
        id, name: "Other",
        properties: { Name: { type: "title" }, Date: { type: "date" }, "Recorded by": { type: "people" } },
      };
    },
    queryAll: async (ds: string) => {
      tick("queryAll");
      return [...w.pages.values()].filter((p) => p.ds === ds && !p.trashed && !p.hidden).map(asPage);
    },
    createPage: async (body: object) => {
      tick("createPage");
      const b = body as { parent: { data_source_id: string }; properties: Record<string, NotionProperty>; children?: NotionBlockInput[] };
      const id = `pg-${++w.counter}`;
      const page: Page = {
        id, url: `https://notion.invalid/${id}`, created_time: w.createdTime, created_by: { id: w.me.id },
        properties: b.properties, ds: b.parent.data_source_id, trashed: false, hidden: false,
      };
      w.pages.set(id, page);
      w.kids.set(id, addBlocks(b.children ?? []));
      w.onCreate?.(page);
      if (w.loseNextCreateResponse && page.ds === "ds-main") {
        w.loseNextCreateResponse = false;
        throw new NotionError("NOTION_NETWORK");
      }
      return asPage(page);
    },
    listChildren: async (id: string) => {
      tick("listChildren");
      return [...(w.kids.get(id) ?? [])];
    },
    appendChildren: async (parent: string, children: NotionBlockInput[]) => {
      tick("appendChildren");
      w.onAppend?.();
      const list = w.kids.get(parent);
      if (!list) throw new Error("unknown parent");
      const added = addBlocks(children);
      list.push(...added);
      return added;
    },
    trashPage: async (id: string) => {
      tick("trashPage");
      const p = w.pages.get(id);
      if (p) p.trashed = true;
    },
  };

  w.ai = {
    ask: async (system: string, user: string) => {
      const kind =
        system === NOTION_SUMMARY_PROMPT ? "summary" : system === SAME_MEETING_PROMPT ? "same" : system === PRACTICES_PROMPT ? "practices" : "other";
      w.asks.push({ kind, user });
      if (kind === "summary") {
        const r = w.summaryReplies.shift() ?? w.defaultSummary;
        if (r instanceof Error) throw r;
        return r;
      }
      if (kind === "same") return JSON.stringify({ same: w.sameAnswer });
      const candidates = (JSON.parse(user) as { candidates: { index: number }[] }).candidates;
      return JSON.stringify({ results: candidates.map((c) => ({ index: c.index, duplicate: false, topic: null })) });
    },
  };
  return w;
}

type World = ReturnType<typeof makeWorld>;

const failAt = (w: World, method: string, at: number, err: unknown) => w.fails.push({ method, at, err });
const asks = (w: World, kind: string) => w.asks.filter((a) => a.kind === kind);
const mainPages = (w: World) => [...w.pages.values()].filter((p) => p.ds === "ds-main");
const knowledgeRows = (w: World) => [...w.pages.values()].filter((p) => p.ds === "ds-know");

const iso = (ms: number) => new Date(ms).toISOString();
const dateProps = (startOff = 0, endOff = 0) => ({
  Name: { title: [] },
  Date: { date: { start: iso(START + startOff), end: iso(END + endOff) } },
});
/** The two blocks same-meeting reads a bold title from. */
const titleKids = (title: string): NotionBlock[] => [
  { id: `h-${title}`, type: "heading_2", heading_2: { rich_text: [{ type: "text", text: { content: "Meeting Notes" } }] } },
  { id: `t-${title}`, type: "paragraph", paragraph: { rich_text: [{ type: "text", text: { content: title }, annotations: { bold: true } }] } },
];

function addRival(w: World, over: Partial<Page> = {}, title = "Hand-made agenda") {
  const p: Page = {
    id: "aaa-rival", url: "https://notion.invalid/rival", created_time: w.createdTime,
    created_by: { id: "person-2" },
    properties: { Name: { title: [] }, Date: { date: { start: new Date(START).toISOString(), end: new Date(END).toISOString() } } },
    ds: "ds-main", trashed: false, hidden: false, ...over,
  };
  w.pages.set(p.id, p);
  w.kids.set(p.id, titleKids(title));
  return p;
}

function makeDeps(w: World, over: Partial<NotionSendDeps> = {}): NotionSendDeps {
  let t = NOW;
  return {
    // A moving clock: a write that reused the claim's stamp instead of the latest restamp would be refused.
    now: () => ++t,
    sleep: async () => w.onSleep?.(),
    client: w.client,
    ai: w.ai,
    state: STATE,
    ...over,
  };
}

let world: World;
let errorSpy: ReturnType<typeof vi.spyOn>;
let warnSpy: ReturnType<typeof vi.spyOn>;
// A test that expects the NOTION_INTERNAL log line says so; any other log fails the test.
let logsExpected = false;
const expectLogs = () => {
  logsExpected = true;
};

beforeEach(async () => {
  const wasmBinary = fs.readFileSync(path.resolve(__dirname, "../../node_modules/sql.js/dist/sql-wasm.wasm"));
  const SQL = await initSqlJs({ wasmBinary });
  db = new SQL.Database();
  for (const f of ["chat-history.sql", "chat-history-v8.sql", "odoo-contacts.sql", "meeting-log-queue.sql", "odoo-lead-only-target.sql"]) {
    db.run(fs.readFileSync(path.join(MIGRATIONS, f), "utf8"));
  }
  await applyMigration14(db);
  db.run(fs.readFileSync(path.join(MIGRATIONS, "notion-sends.sql"), "utf8"));
  mocks.execute.mockImplementation(async (sql: string, args?: unknown[]) => rawExecute(sql, args));
  mocks.select.mockImplementation(async (sql: string, args?: unknown[]) => rawSelect(sql, args));
  mocks.getSummary.mockReset();
  world = makeWorld();
  logsExpected = false;
  errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
  warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
});

afterEach(() => {
  try {
    if (!logsExpected) {
      expect(errorSpy).not.toHaveBeenCalled();
    }
    expect(warnSpy).not.toHaveBeenCalled();
  } finally {
    errorSpy.mockRestore();
    warnSpy.mockRestore();
    resetNotionRedactor();
  }
});

describe("summary step", () => {
  it("sends end to end: page under the data source, owner name in the transcript, rows close only when sent", async () => {
    await seedSend();
    expect(await laneOpen()).toBe(1);
    expect(await runNotionSend("s1", makeDeps(world))).toBe("sent");
    const send = await sendOf();
    expect(send).toMatchObject({ status: "sent", page_id: "pg-1", body_done: 1, transcript_done: 1, practices_done: 1 });
    expect(send.sent_at).not.toBeNull();
    expect(await laneOpen()).toBe(0);
    const toggle = world.kids.get("pg-1")?.find((b) => b.type === "toggle");
    const kids = world.kids.get(toggle?.id as string) ?? [];
    expect(kids).toHaveLength(LINES.length);
    expect(JSON.stringify(kids[0])).toContain("Owner Name: hello team");
  });

  it("all joined rows read closed only when the send is sent", async () => {
    await seedSend("s1");
    seedRow({ id: "row-b", transcript: LINES.join("\n"), notion_status: "joined", notion_send_id: "s1" });
    expect(await laneOpen()).toBe(2);
    failAt(world, "me", 1, new NotionError("NOTION_SERVER"));
    const deps = makeDeps(world);
    expect(await runNotionSend("s1", deps)).toBe("retry");
    expect(await laneOpen()).toBe(2);
    await retrySend("s1");
    expect(await runNotionSend("s1", deps)).toBe("sent");
    expect(await laneOpen()).toBe(0);
  });

  it("a retryable summary failure → retry, no page created", async () => {
    await seedSend();
    world.summaryReplies = [new SummaryError("SUMMARY_NETWORK")];
    expect(await runNotionSend("s1", makeDeps(world))).toBe("retry");
    const send = await sendOf();
    expect(send).toMatchObject({ status: "retry", error_code: "SUMMARY_NETWORK", summary_failures: 0, summary_json: null, page_id: null });
    expect(send.next_at as number).toBeGreaterThan(NOW + 59_000);
    expect(world.calls.createPage).toBeUndefined();
    expect(world.pages.size).toBe(0);
  });

  it("three strike failures in a row → no_summary SUMMARY_STRIKES_OUT; a fourth tick does not call the model", async () => {
    await seedSend();
    world.summaryReplies = ["not json", "not json", "not json", "not json"];
    const deps = makeDeps(world);
    expect(await runNotionSend("s1", deps)).toBe("retry");
    expect((await sendOf()).summary_failures).toBe(1);
    await retrySend("s1");
    expect(await runNotionSend("s1", deps)).toBe("retry");
    expect((await sendOf()).summary_failures).toBe(2);
    await retrySend("s1");
    expect(await runNotionSend("s1", deps)).toBe("no_summary");
    expect(await sendOf()).toMatchObject({ status: "no_summary", error_code: "SUMMARY_STRIKES_OUT" });
    expect(await runNotionSend("s1", deps)).toBe("not-claimed");
    expect(asks(world, "summary")).toHaveLength(3);
    expect(world.pages.size).toBe(0);
  });

  it("a non-strike retry between two strikes does not reset the strike count", async () => {
    await seedSend();
    world.summaryReplies = ["not json", new SummaryError("SUMMARY_NETWORK"), "not json", "not json"];
    const deps = makeDeps(world);
    await runNotionSend("s1", deps);
    expect((await sendOf()).summary_failures).toBe(1);
    await retrySend("s1");
    await runNotionSend("s1", deps);
    expect(await sendOf()).toMatchObject({ error_code: "SUMMARY_NETWORK", summary_failures: 1 });
    await retrySend("s1");
    await runNotionSend("s1", deps);
    expect((await sendOf()).summary_failures).toBe(2);
    await retrySend("s1");
    expect(await runNotionSend("s1", deps)).toBe("no_summary");
    expect((await sendOf()).error_code).toBe("SUMMARY_STRIKES_OUT");
  });

  it("SUMMARY_NO_PROVIDER → no_summary at once", async () => {
    await seedSend();
    world.summaryReplies = [new SummaryError("SUMMARY_NO_PROVIDER")];
    expect(await runNotionSend("s1", makeDeps(world))).toBe("no_summary");
    expect(await sendOf()).toMatchObject({ status: "no_summary", error_code: "SUMMARY_NO_PROVIDER", next_at: null });
    expect(world.pages.size).toBe(0);
  });

  it("SUMMARY_TOO_SHORT (fewer than four lines) → no_summary at once, no model call", async () => {
    await seedSend("s1", ["You: hi", "Sam: hey", "You: bye"]);
    expect(await runNotionSend("s1", makeDeps(world))).toBe("no_summary");
    expect(await sendOf()).toMatchObject({ status: "no_summary", error_code: "SUMMARY_TOO_SHORT" });
    expect(world.asks).toHaveLength(0);
    expect(world.pages.size).toBe(0);
  });

  it("a send with no joined rows and no page → no_summary SUMMARY_TOO_SHORT, never an empty page", async () => {
    await createSendAndLink({ id: "s1", conversationId: "c1", spanStartAt: START, spanEndAt: END, createdAt: NOW }, []);
    expect(await runNotionSend("s1", makeDeps(world))).toBe("no_summary");
    expect(await sendOf()).toMatchObject({ status: "no_summary", error_code: "SUMMARY_TOO_SHORT" });
    expect(world.calls.createPage).toBeUndefined();
    expect(world.asks).toHaveLength(0);
  });

  it("retry after the cause is fixed: retrySend → next run summarises and sends", async () => {
    await seedSend();
    world.summaryReplies = [new SummaryError("SUMMARY_NO_PROVIDER")];
    const deps = makeDeps(world);
    expect(await runNotionSend("s1", deps)).toBe("no_summary");
    expect(await retrySend("s1")).toBe(true);
    expect(await runNotionSend("s1", deps)).toBe("sent");
    expect((await sendOf()).error_code).toBeNull();
  });

  it("the stored summary is reused on every retry (model called once across a transcript failure + retry)", async () => {
    await seedSend();
    failAt(world, "appendChildren", 1, new NotionError("NOTION_SERVER"));
    const deps = makeDeps(world);
    expect(await runNotionSend("s1", deps)).toBe("retry");
    expect((await sendOf()).summary_json).not.toBeNull();
    await retrySend("s1");
    expect(await runNotionSend("s1", deps)).toBe("sent");
    expect(asks(world, "summary")).toHaveLength(1);
  });

  it("the Notion path never reads meeting_summaries", async () => {
    await seedSend();
    failAt(world, "appendChildren", 1, new NotionError("NOTION_SERVER"));
    const deps = makeDeps(world);
    await runNotionSend("s1", deps);
    await retrySend("s1");
    await runNotionSend("s1", deps);
    expect(mocks.getSummary).not.toHaveBeenCalled();
    const sqls = mocks.select.mock.calls.map((c) => String(c[0])).concat(mocks.execute.mock.calls.map((c) => String(c[0])));
    expect(sqls.some((s) => s.includes("meeting_summaries"))).toBe(false);
  });

  it("two sends in one conversation: each summary prompt holds only its own send's lines", async () => {
    const hour = 60 * 60 * 1000;
    await seedSend("s1", ["You: alpha one", "Sam: alpha two", "You: alpha three", "Sam: alpha four"], [START, END]);
    await seedSend("s2", ["You: beta one", "Sam: beta two", "You: beta three", "Sam: beta four"], [END + 3 * hour, END + 4 * hour]);
    const deps = makeDeps(world);
    expect(await runNotionSend("s1", deps)).toBe("sent");
    expect(await runNotionSend("s2", deps)).toBe("sent");
    const [first, second] = asks(world, "summary");
    expect(first.user).toContain("alpha one");
    expect(first.user).not.toContain("beta");
    expect(second.user).toContain("beta one");
    expect(second.user).not.toContain("alpha");
  });
});

describe("find or create", () => {
  it("someone else's matching page → already, no page, no practices", async () => {
    await seedSend();
    world.defaultSummary = summaryJson({ practices: TWO_PRACTICES });
    addRival(world);
    expect(await runNotionSend("s1", makeDeps(world))).toBe("already");
    expect(await sendOf()).toMatchObject({ status: "already", lost_to_url: "https://notion.invalid/rival", page_id: null, sent_at: null });
    expect(world.calls.createPage).toBeUndefined();
    expect(knowledgeRows(world)).toHaveLength(0);
    expect(await laneOpen()).toBe(0);
  });

  it("race: equal created_time, our id higher → we trash ours, finish already, never add practices", async () => {
    await seedSend();
    world.defaultSummary = summaryJson({ practices: TWO_PRACTICES });
    const rival = addRival(world, { hidden: true });
    world.onSleep = () => {
      rival.hidden = false;
    };
    expect(await runNotionSend("s1", makeDeps(world))).toBe("already");
    expect(await sendOf()).toMatchObject({ status: "already", lost_to_url: "https://notion.invalid/rival", page_id: "pg-1", sent_at: null });
    expect(world.pages.get("pg-1")?.trashed).toBe(true);
    expect(rival.trashed).toBe(false);
    expect(knowledgeRows(world)).toHaveLength(0);
  });

  it("race: we are earliest → we keep our page and send", async () => {
    await seedSend();
    const rival = addRival(world, { hidden: true, created_time: "2026-11-09T15:05:00.000Z" });
    world.onSleep = () => {
      rival.hidden = false;
    };
    expect(await runNotionSend("s1", makeDeps(world))).toBe("sent");
    expect(world.pages.get("pg-1")?.trashed).toBe(false);
  });

  it("race loser whose trash call fails → retry, and the next run trashes without re-creating", async () => {
    await seedSend();
    const rival = addRival(world, { hidden: true });
    world.onSleep = () => {
      rival.hidden = false;
    };
    failAt(world, "trashPage", 1, new NotionError("NOTION_SERVER"));
    const deps = makeDeps(world);
    expect(await runNotionSend("s1", deps)).toBe("retry");
    expect(await sendOf()).toMatchObject({ status: "retry", lost_to_url: "https://notion.invalid/rival", page_id: "pg-1" });
    const queries = world.calls.queryAll;
    await retrySend("s1");
    expect(await runNotionSend("s1", deps)).toBe("already");
    expect(world.calls.createPage).toBe(1);
    expect(world.calls.queryAll).toBe(queries);
    expect(world.pages.get("pg-1")?.trashed).toBe(true);
  });

  it("an orphan own page from a lost create (invisible at step 4) is trashed at the recheck, not treated as a rival", async () => {
    await seedSend();
    db.run("UPDATE notion_sends SET create_started_at = 1 WHERE id = 's1'");
    const orphan = addRival(world, { id: "orphan-1", created_by: { id: "bot-1" }, hidden: true }, "Weekly sync");
    world.onSleep = () => {
      orphan.hidden = false;
    };
    expect(await runNotionSend("s1", makeDeps(world))).toBe("sent");
    expect(orphan.trashed).toBe(true);
    expect(world.pages.get("pg-1")?.trashed).toBe(false);
    expect(asks(world, "same")).toHaveLength(0);
  });

  it.each([
    "after create, before page_id saved",
    "after page_id saved",
    "after body",
    "mid-transcript",
    "mid-practices",
  ])("crash %s → the next run adopts its own page instead of skipping it", async (point) => {
    const lines = point === "mid-transcript" ? Array.from({ length: 150 }, (_, i) => `Sam: line ${i}`) : LINES;
    await seedSend("s1", lines);
    if (point === "mid-practices") world.defaultSummary = summaryJson({ practices: TWO_PRACTICES });
    if (point === "after create, before page_id saved") world.loseNextCreateResponse = true;
    if (point === "after page_id saved") failAt(world, "listChildren", 1, new NotionError("NOTION_SERVER"));
    if (point === "after body") failAt(world, "queryAll", 2, new NotionError("NOTION_SERVER"));
    if (point === "mid-transcript") failAt(world, "appendChildren", 2, new NotionError("NOTION_SERVER"));
    if (point === "mid-practices") failAt(world, "createPage", 3, new NotionError("NOTION_SERVER"));
    const deps = makeDeps(world);

    expect(await runNotionSend("s1", deps)).toBe("retry");
    await retrySend("s1");
    expect(await runNotionSend("s1", deps)).toBe("sent");

    expect(mainPages(world)).toHaveLength(1);
    expect(mainPages(world)[0].trashed).toBe(false);
    expect((await sendOf()).page_id).toBe("pg-1");
    const toggle = world.kids.get("pg-1")?.find((b) => b.type === "toggle");
    expect(world.kids.get(toggle?.id as string)).toHaveLength(lines.length);
    if (point === "mid-practices") expect(knowledgeRows(world)).toHaveLength(2);
  });

  it("a send with several batches succeeds end to end (stamp carried across restamps)", async () => {
    const big: NotionSummary = {
      title: "Big meeting",
      actionItems: ["a"],
      sections: Array.from({ length: 40 }, (_, i) => ({ heading: `H${i}`, bullets: [`b${i}a`, `b${i}b`] })),
      practices: [],
    };
    await seedSend("s1", Array.from({ length: 250 }, (_, i) => `Sam: line ${i}`));
    db.run("UPDATE notion_sends SET summary_json = ? WHERE id = 's1'", [JSON.stringify(big)]);
    expect(await runNotionSend("s1", makeDeps(world))).toBe("sent");
    expect(world.kids.get("pg-1")).toHaveLength(buildPageBlocks(big).length);
    const toggle = world.kids.get("pg-1")?.find((b) => b.type === "toggle");
    expect(world.kids.get(toggle?.id as string)).toHaveLength(transcriptBlocks(Array.from({ length: 250 }, (_, i) => `Sam: line ${i}`), "x").length);
    expect(world.calls.appendChildren).toBeGreaterThanOrEqual(4);
    expect(asks(world, "summary")).toHaveLength(0);
    expect(world.calls.createPage).toBe(1);
  });
});

describe("only a page proven to be this send's is adopted or trashed", () => {
  it("a hand-made page by the owner, different title and range, is never trashed or adopted, and the model was asked", async () => {
    await seedSend();
    world.sameAnswer = false;
    const mine = addRival(world, { id: "hand-1", created_by: { id: "owner-1" }, properties: dateProps(30 * 60_000, 30 * 60_000) });
    expect(await runNotionSend("s1", makeDeps(world))).toBe("sent");
    expect(mine.trashed).toBe(false);
    expect((await sendOf()).page_id).toBe("pg-1");
    expect(asks(world, "same").length).toBeGreaterThan(0);
  });

  it("the same hand-made page, called the same meeting and created earlier, beats this send: already, ours trashed, theirs kept", async () => {
    await seedSend();
    const mine = addRival(world, {
      id: "hand-1", created_by: { id: "owner-1" }, hidden: true, created_time: "2026-11-09T14:00:00.000Z",
      properties: dateProps(30 * 60_000, 30 * 60_000), url: "https://notion.invalid/hand-1",
    });
    world.onSleep = () => {
      mine.hidden = false;
    };
    expect(await runNotionSend("s1", makeDeps(world))).toBe("already");
    expect(await sendOf()).toMatchObject({ status: "already", lost_to_url: "https://notion.invalid/hand-1" });
    expect(world.pages.get("pg-1")?.trashed).toBe(true);
    expect(mine.trashed).toBe(false);
  });

  it("a second own-creator page with a different title is not adopted; the one with our title is", async () => {
    await seedSend();
    db.run("UPDATE notion_sends SET create_started_at = 1 WHERE id = 's1'");
    world.sameAnswer = false;
    const decoy = addRival(world, { id: "decoy-own", created_by: { id: "bot-1" } }, "Another topic");
    addRival(world, { id: "mine-own", created_by: { id: "bot-1" } }, "Weekly sync");
    // The page our earlier attempt wrote: the whole body, so the body step finds nothing missing.
    const body = buildPageBlocks({ title: "Weekly sync", actionItems: ["Send notes"], sections: [{ heading: "Roadmap", bullets: ["Ship it"] }], practices: [] });
    world.kids.set("mine-own", body.map((b, i) => ({ ...b, id: `mine-b${i}` }) as NotionBlock));
    world.kids.set(`mine-b${body.length - 1}`, []);
    expect(await runNotionSend("s1", makeDeps(world))).toBe("sent");
    expect((await sendOf()).page_id).toBe("mine-own");
    expect(world.calls.createPage).toBeUndefined();
    expect(decoy.trashed).toBe(false);
  });

  it("two devices: the owner's page with our title but a span 5 minutes off is a competitor, not an orphan", async () => {
    await seedSend();
    const other = addRival(
      world,
      { id: "aaa-device", created_by: { id: "owner-1" }, hidden: true, created_time: "2026-11-09T14:00:00.000Z", properties: dateProps(5 * 60_000, 5 * 60_000) },
      "Weekly sync",
    );
    world.onSleep = () => {
      other.hidden = false;
    };
    expect(await runNotionSend("s1", makeDeps(world))).toBe("already");
    expect(other.trashed).toBe(false);
    expect(world.pages.get("pg-1")?.trashed).toBe(true);
    expect(asks(world, "same").length).toBeGreaterThan(0);
  });

  it("a page by a third person with our title and exact range after a lost create is a competitor: not adopted, not trashed", async () => {
    await seedSend();
    db.run("UPDATE notion_sends SET create_started_at = 1 WHERE id = 's1'");
    world.sameAnswer = false;
    const stranger = addRival(world, { id: "stranger-1", created_by: { id: "person-2" } }, "Weekly sync");
    expect(await runNotionSend("s1", makeDeps(world))).toBe("sent");
    expect((await sendOf()).page_id).toBe("pg-1");
    expect(stranger.trashed).toBe(false);
    expect(asks(world, "same").length).toBeGreaterThan(0);
  });

  it("a step-4 competitor with an empty url stores the derived url", async () => {
    await seedSend();
    addRival(world, { url: "" });
    expect(await runNotionSend("s1", makeDeps(world))).toBe("already");
    expect((await sendOf()).lost_to_url).toBe("https://www.notion.so/aaarival");
  });

  it("lost_to_url set with no page → finished already at once: no create, no model call, no trash", async () => {
    await seedSend();
    db.run("UPDATE notion_sends SET lost_to_url = 'https://notion.invalid/rival' WHERE id = 's1'");
    expect(await runNotionSend("s1", makeDeps(world))).toBe("already");
    expect(await sendOf()).toMatchObject({ status: "already", page_id: null });
    expect(world.calls).toEqual({});
    expect(world.asks).toHaveLength(0);
  });

  it("an empty winner url stores a derived url, and the loser does not carry on", async () => {
    await seedSend();
    world.defaultSummary = summaryJson({ practices: TWO_PRACTICES });
    const rival = addRival(world, { hidden: true, url: "" });
    world.onSleep = () => {
      rival.hidden = false;
    };
    expect(await runNotionSend("s1", makeDeps(world))).toBe("already");
    expect((await sendOf()).lost_to_url).toBe("https://www.notion.so/aaarival");
    expect(world.pages.get("pg-1")?.trashed).toBe(true);
    expect(knowledgeRows(world)).toHaveLength(0);
  });
});

describe("transcript and practices", () => {
  it("transcript failure does not stop practices; send stays open until both", async () => {
    await seedSend();
    world.defaultSummary = summaryJson({ practices: TWO_PRACTICES });
    failAt(world, "appendChildren", 1, new NotionError("NOTION_SERVER"));
    const deps = makeDeps(world);
    expect(await runNotionSend("s1", deps)).toBe("retry");
    expect(await sendOf()).toMatchObject({
      status: "retry", error_code: "NOTION_SERVER", practices_error_code: null, transcript_done: 0, practices_done: 1,
    });
    expect(knowledgeRows(world)).toHaveLength(2);
    expect(await laneOpen()).toBe(1);
    await retrySend("s1");
    expect(await runNotionSend("s1", deps)).toBe("sent");
    expect(knowledgeRows(world)).toHaveLength(2);
  });

  it("practices failure does not stop the transcript, and keeps the send open", async () => {
    await seedSend();
    world.defaultSummary = summaryJson({ practices: TWO_PRACTICES });
    failAt(world, "createPage", 2, new NotionError("NOTION_SERVER"));
    const deps = makeDeps(world);
    expect(await runNotionSend("s1", deps)).toBe("retry");
    expect(await sendOf()).toMatchObject({
      status: "retry", error_code: "NOTION_SERVER", practices_error_code: "NOTION_SERVER", transcript_done: 1, practices_done: 0,
    });
    await retrySend("s1");
    expect(await runNotionSend("s1", deps)).toBe("sent");
    expect(knowledgeRows(world)).toHaveLength(2);
  });

  it("a show-at-once error in either step makes the send failed", async () => {
    await seedSend();
    world.defaultSummary = summaryJson({ practices: TWO_PRACTICES });
    world.hasProposed = false;
    failAt(world, "appendChildren", 1, new NotionError("NOTION_SERVER"));
    expect(await runNotionSend("s1", makeDeps(world))).toBe("failed");
    expect(await sendOf()).toMatchObject({
      status: "failed", error_code: "NOTION_SERVER", practices_error_code: "NOTION_INVALID", next_at: null,
    });
  });

  it("a 401 during the transcript → failed at once with NOTION_UNAUTHORIZED", async () => {
    await seedSend();
    failAt(world, "appendChildren", 1, new NotionError("NOTION_UNAUTHORIZED"));
    expect(await runNotionSend("s1", makeDeps(world))).toBe("failed");
    expect(await sendOf()).toMatchObject({ status: "failed", error_code: "NOTION_UNAUTHORIZED", next_at: null });
  });

  it("a send whose rows vanished after the page exists skips the transcript and finishes", async () => {
    await seedSend();
    failAt(world, "listChildren", 1, new NotionError("NOTION_SERVER"));
    const deps = makeDeps(world);
    expect(await runNotionSend("s1", deps)).toBe("retry");
    db.run("DELETE FROM meeting_log_queue");
    await retrySend("s1");
    expect(await runNotionSend("s1", deps)).toBe("sent");
    expect((await sendOf()).transcript_done).toBe(1);
  });
});

describe("failures and claims", () => {
  it("a NOTION_SERVER at the mapping step → retry with next_at from outcomeFor, no page created", async () => {
    await seedSend();
    failAt(world, "database", 1, new NotionError("NOTION_SERVER"));
    expect(await runNotionSend("s1", makeDeps(world, { now: () => NOW }))).toBe("retry");
    expect(await sendOf()).toMatchObject({ status: "retry", error_code: "NOTION_SERVER", next_at: NOW + 60_000 });
    expect((await sendOf()).summary_json).not.toBeNull();
    expect(world.calls.createPage).toBeUndefined();
  });

  it("an unknown thrown error → failed with NOTION_INTERNAL, never thrown to the caller", async () => {
    await seedSend();
    expectLogs();
    failAt(world, "me", 1, new Error("boom with meeting words"));
    await expect(runNotionSend("s1", makeDeps(world))).resolves.toBe("failed");
    expect(await sendOf()).toMatchObject({ status: "failed", error_code: "NOTION_INTERNAL", next_at: null });
    expect(errorSpy).toHaveBeenCalledWith("[notion] NOTION_INTERNAL", "Error");
    expect(JSON.stringify(errorSpy.mock.calls)).not.toContain("boom");
  });

  it("a corrupt stored summary → failed NOTION_INTERNAL, not thrown", async () => {
    await seedSend();
    expectLogs();
    db.run("UPDATE notion_sends SET summary_json = '{nope' WHERE id = 's1'");
    await expect(runNotionSend("s1", makeDeps(world))).resolves.toBe("failed");
    expect((await sendOf()).error_code).toBe("NOTION_INTERNAL");
  });

  it("NOTION_PAGE_CHANGED after the page exists → failed, and cancelSend can then close it", async () => {
    await seedSend();
    world.onCreate = (p) => {
      if (p.ds === "ds-main") world.kids.get(p.id)?.push({ id: "extra", type: "paragraph" });
    };
    expect(await runNotionSend("s1", makeDeps(world))).toBe("failed");
    expect(await sendOf()).toMatchObject({ status: "failed", error_code: "NOTION_PAGE_CHANGED", page_id: "pg-1" });
    expect(await cancelSend("s1")).toBe(true);
    expect((await sendOf()).status).toBe("cancelled");
    expect(await laneOpen()).toBe(0);
  });

  it("a lost claim mid-send stops all further writes", async () => {
    await seedSend();
    world.onMe = tamper;
    expect(await runNotionSend("s1", makeDeps(world))).toBe("lost-claim");
    expect(await sendOf()).toMatchObject({ status: "sending", claimed_at: 5, page_id: null, error_code: null });
    expect(world.calls.createPage).toBeUndefined();
  });

  it("a lost claim mid-practices returns lost-claim with no finish", async () => {
    await seedSend();
    world.defaultSummary = summaryJson({ practices: TWO_PRACTICES });
    world.onCreate = (p) => {
      if (p.ds === "ds-know") tamper();
    };
    expect(await runNotionSend("s1", makeDeps(world))).toBe("lost-claim");
    expect(await sendOf()).toMatchObject({ status: "sending", error_code: null, practices_error_code: null, practices_done: 0 });
    expect(knowledgeRows(world)).toHaveLength(1);
    // The sentinel is not an error to classify or log.
    expect(errorSpy).not.toHaveBeenCalled();
  });

  it("a known loser is trashed before the mapping, so a failing mapping cannot keep the duplicate alive", async () => {
    await seedSend();
    const rival = addRival(world, { hidden: true });
    world.onSleep = () => {
      rival.hidden = false;
    };
    failAt(world, "trashPage", 1, new NotionError("NOTION_SERVER"));
    failAt(world, "database", 2, new NotionError("NOTION_SERVER"));
    const deps = makeDeps(world);
    expect(await runNotionSend("s1", deps)).toBe("retry");
    await retrySend("s1");
    expect(await runNotionSend("s1", deps)).toBe("already");
    expect(world.pages.get("pg-1")?.trashed).toBe(true);
    expect(world.calls.database).toBe(1);
  });

  it("a restamp refused mid-transcript -> lost-claim, no transcript_done, no practices, no finish", async () => {
    await seedSend("s1", Array.from({ length: 150 }, (_, i) => `Sam: line ${i}`));
    world.defaultSummary = summaryJson({ practices: TWO_PRACTICES });
    world.onAppend = tamper;
    expect(await runNotionSend("s1", makeDeps(world))).toBe("lost-claim");
    expect(await sendOf()).toMatchObject({ status: "sending", transcript_done: 0, practices_done: 0, error_code: null });
    expect(knowledgeRows(world)).toHaveLength(0);
    expect(errorSpy).not.toHaveBeenCalled();
  });

  it("a finishSend that throws gives failed and never rejects", async () => {
    expectLogs();
    await seedSend();
    mocks.execute.mockImplementation(async (sql: string, args?: unknown[]) => {
      if (sql.includes("claimed_at = NULL")) throw new Error("db is locked");
      return rawExecute(sql, args);
    });
    await expect(runNotionSend("s1", makeDeps(world))).resolves.toBe("failed");
  });

  it("not-claimed when another attempt holds the send", async () => {
    await seedSend();
    const deps = makeDeps(world);
    db.run("UPDATE notion_sends SET status = 'sending', claimed_at = ? WHERE id = 's1'", [NOW]);
    expect(await runNotionSend("s1", deps)).toBe("not-claimed");
    expect(world.asks).toHaveLength(0);
  });

  it("recheck waits RECHECK_DELAY_MS before reading again", async () => {
    await seedSend();
    const slept: number[] = [];
    expect(await runNotionSend("s1", makeDeps(world, { sleep: async (ms) => void slept.push(ms) }))).toBe("sent");
    expect(slept).toEqual([RECHECK_DELAY_MS]);
  });

  it.each([
    ["the client throws the token", () => failAt(world, "me", 1, new Error(`Bearer ${TOKEN} rejected`))],
    ["the model throws the key", () => (world.summaryReplies = [new Error(`key ${KEY} invalid`)])],
    ["the transcript throws both", () => failAt(world, "appendChildren", 1, new Error(`${TOKEN} ${KEY}`))],
  ])("the AI key and the token never appear in the stored codes or logs: %s", async (_name, arrange) => {
    expectLogs();
    await seedSend();
    world.defaultSummary = summaryJson({ practices: TWO_PRACTICES });
    arrange();
    await runNotionSend("s1", makeDeps(world));
    const send = await sendOf();
    for (const text of [send.error_code, send.practices_error_code, JSON.stringify(errorSpy.mock.calls)]) {
      expect(String(text)).not.toContain(TOKEN);
      expect(String(text)).not.toContain(KEY);
    }
    expect(send.error_code).toBe("NOTION_INTERNAL");
  });
});

describe("buildSendDeps", () => {
  beforeEach(() => {
    for (const m of [mocks.loadState, mocks.loadToken, mocks.resolveProvider, mocks.secrets]) m.mockReset();
    mocks.loadState.mockResolvedValue(STATE);
    mocks.loadToken.mockResolvedValue(TOKEN);
    mocks.resolveProvider.mockResolvedValue({ kind: "none" });
    mocks.secrets.mockReturnValue([KEY]);
  });

  it("a config that throws → NOTION_INTERNAL, logged by code only", async () => {
    expectLogs();
    mocks.loadState.mockRejectedValue(new Error("NOTION_CONFIG_UNREADABLE"));
    expect(await buildSendDeps()).toEqual({ error: "NOTION_INTERNAL" });
    expect(errorSpy).toHaveBeenCalledWith("[notion] NOTION_INTERNAL", "Error");
  });

  it("a config that is not complete → NOTION_NOT_CONFIGURED", async () => {
    mocks.loadState.mockResolvedValue({ state: "incomplete", missing: ["token"] });
    expect(await buildSendDeps()).toEqual({ error: "NOTION_NOT_CONFIGURED" });
    expect(mocks.loadToken).not.toHaveBeenCalled();
  });

  it.each([null, ""])("a token of %j → NOTION_NOT_CONFIGURED", async (token) => {
    mocks.loadToken.mockResolvedValue(token);
    expect(await buildSendDeps()).toEqual({ error: "NOTION_NOT_CONFIGURED" });
  });

  it("a token read that throws keeps its code", async () => {
    mocks.loadToken.mockRejectedValue(new NotionError("NOTION_KEYCHAIN_UNAVAILABLE"));
    expect(await buildSendDeps()).toEqual({ error: "NOTION_KEYCHAIN_UNAVAILABLE" });
  });

  it("a provider that throws → NOTION_INTERNAL", async () => {
    expectLogs();
    mocks.resolveProvider.mockRejectedValue(new Error("SUMMARY_PROVIDER_UNREADABLE"));
    expect(await buildSendDeps()).toEqual({ error: "NOTION_INTERNAL" });
  });

  it("builds one client and one AI, and arms the redactor with the token and the key", async () => {
    const deps = await buildSendDeps();
    expect(deps).not.toHaveProperty("error");
    const d = deps as NotionSendDeps;
    expect(d.state).toBe(STATE);
    expect(typeof d.client.trashPage).toBe("function");
    expect(typeof d.ai.ask).toBe("function");
    expect(isNotionRedactorArmed()).toBe(true);
    const redacted = redactNotion(`a ${TOKEN} b ${KEY}`);
    expect(redacted).not.toContain(TOKEN);
    expect(redacted).not.toContain(KEY);
  });
});
