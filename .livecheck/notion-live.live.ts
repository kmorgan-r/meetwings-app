// LIVE NOTION CHECKS - Run by Kevin with a real token against throwaway
// databases; paste the printed results into the PR body. Checks 1, 2 and 5
// confirm the assumptions this build handles both ways.
//
// Gating: the three NOTION_LIVE_* env vars must ALL be set or the whole suite
// skips (a run without them does nothing but skip - exit 0). Only throwaway
// database ids are used, and never committed. The token is never printed and
// never names a printed header. Every page the checks create (meeting pages
// and the Knowledge row) is trashed in afterAll; page titles all start with
// "LIVECHECK".
//
// Same vitest config as the Odoo harness, one more file in its include list.
// Checks 7 and 8 are extras beyond the brief's six: 7 is the round-trip the
// sender's own-page rule (isThisSendsPage in send.ts) relies on, 8 is the
// time-zone probe for hand-made pages (print only, no assertion).
import { beforeAll, afterAll, describe, expect, it, vi } from "vitest";
import { describeSubTable } from "@/lib/notion/routing";
import { buildPageBlocks, pageProperties } from "@/lib/notion/page-blocks";
import type { NotionClient, NotionClientDeps } from "@/lib/notion/client";
import type { Candidate, isOwnPage, readCandidates } from "@/lib/notion/same-meeting";
import type { SubTable } from "@/lib/notion/routing";
import type { NotionSummary } from "@/lib/notion/summarize";

const TOKEN = process.env.NOTION_LIVE_TOKEN ?? "";
const MEETINGS_DB = process.env.NOTION_LIVE_MEETINGS_DB ?? "";
const KNOWLEDGE_DB = process.env.NOTION_LIVE_KNOWLEDGE_DB ?? "";
const ENABLED = TOKEN !== "" && MEETINGS_DB !== "" && KNOWLEDGE_DB !== "";

// The client here is built with Node's fetch passed through the deps, so
// tauriFetch is never reached; the mock keeps the plugin-http import loadable
// outside Tauri, exactly as the Odoo harness does.
vi.mock("@tauri-apps/plugin-http", () => ({
  fetch: (...args: unknown[]) =>
    (globalThis.fetch as unknown as (...a: unknown[]) => unknown)(...args),
}));

// ---------------------------------------------------------------- fixtures --
const STAMP = new Date().toISOString().replace(/[:.]/g, "-");

/** One section, one action item, no practices; title says LIVECHECK. */
const summaryCheck: NotionSummary = {
  title: `LIVECHECK meeting ${STAMP}`,
  actionItems: [`LIVECHECK action item (${STAMP})`],
  sections: [
    { heading: `LIVECHECK section (${STAMP})`, bullets: [`LIVECHECK bullet one`] },
  ],
  practices: [],
};

/** The check-5 pair gets its own span, so its title can filter a query. */
const summaryVisible: NotionSummary = {
  ...summaryCheck,
  title: `LIVECHECK visibility ${STAMP}`,
};

/** A span in the past: start = now minus `minutesAgo`, rounded down to the minute, 30 min. */
function spanAt(minutesAgo: number): { startAt: number; endAt: number } {
  const startAt = Math.floor((Date.now() - minutesAgo * 60_000) / 60_000) * 60_000;
  return { startAt, endAt: startAt + 30 * 60_000 };
}

// ------------------------------------------------------------ module state --
let client: NotionClient | undefined;
let me: { id: string; ownerUserId: string | null } | undefined;
let subTables: SubTable[] = [];
let readCandidatesFn: typeof readCandidates | null = null;
let isOwnPageFn: typeof isOwnPage | null = null;
let readKnowledgeFn: typeof import("@/lib/notion/knowledge").readKnowledge | null = null;
let recheckDelayMs: number | null = null;
let sendImportProblem: string | null = null;
let candidatesImportProblem: string | null = null;
let knowledgeImportProblem: string | null = null;

const createdPageIds: string[] = [];

interface Created {
  subTable: SubTable;
  pageId: string;
  parentDataSourceId: string;
  candidate: Candidate | undefined;
  startAt: number;
  endAt: number;
}
const check1Pages: Created[] = [];

/** The state beforeAll guarantees; narrows the optionals for the check bodies. */
function ready(): { client: NotionClient; me: { id: string; ownerUserId: string | null } } {
  if (!client || !me) throw new Error("beforeAll has not completed");
  return { client, me };
}

/** A meeting page in one sub-table, built the way a send builds it. */
function meetingPageBody(
  st: SubTable,
  summary: NotionSummary,
  span: { startAt: number; endAt: number },
  ownerUserId: string | null,
): object {
  return {
    parent: { type: "data_source_id", data_source_id: st.dataSourceId },
    properties: pageProperties(
      { subTable: st, title: summary.title },
      span.startAt,
      span.endAt,
      ownerUserId,
    ),
    children: buildPageBlocks(summary),
  };
}

describe.skipIf(!ENABLED)("Notion live checks (throwaway databases)", () => {
  beforeAll(async () => {
    const { createNotionClient } = await import("@/lib/notion/client");
    const { armNotionRedactor } = await import("@/lib/notion/redact");
    client = createNotionClient({
      token: TOKEN,
      // Node's global fetch stands in for @tauri-apps/plugin-http's fetch.
      fetch: globalThis.fetch as NotionClientDeps["fetch"],
    });
    armNotionRedactor([TOKEN]);

    // same-meeting/knowledge/send are loaded dynamically: their chains reach
    // the DB and tauri modules, and a load failure must become a printed
    // concern, not a dead file.
    try {
      ({ RECHECK_DELAY_MS: recheckDelayMs } = await import("@/lib/notion/send"));
    } catch (thrown) {
      sendImportProblem = thrown instanceof Error ? thrown.message : String(thrown);
    }
    try {
      ({ readCandidates: readCandidatesFn, isOwnPage: isOwnPageFn } = await import(
        "@/lib/notion/same-meeting"
      ));
    } catch (thrown) {
      candidatesImportProblem = thrown instanceof Error ? thrown.message : String(thrown);
    }
    try {
      ({ readKnowledge: readKnowledgeFn } = await import("@/lib/notion/knowledge"));
    } catch (thrown) {
      knowledgeImportProblem = thrown instanceof Error ? thrown.message : String(thrown);
    }

    me = await client.me();
    // Sub-tables the way a send builds them: database, then each data source,
    // then describeSubTable on its properties.
    const meetingsDatabase = await client.database(MEETINGS_DB);
    for (const ds of meetingsDatabase.dataSources) {
      const info = await client.dataSource(ds.id);
      const st = describeSubTable({ id: info.id, name: info.name, properties: info.properties });
      if (st !== null) subTables.push(st);
    }
    if (subTables.length === 0) {
      throw new Error(
        "the meetings database has no usable sub-table (each needs a title and a date property)",
      );
    }
    console.log(
      `[live] setup: ${subTables.length} usable sub-table(s); ` +
        `ownerUserId ${me.ownerUserId !== null ? "present" : "null"}; ` +
        `RECHECK_DELAY_MS ${
          recheckDelayMs !== null ? String(recheckDelayMs) : "UNAVAILABLE (send.ts chain failed to load)"
        }`,
    );
    for (const st of subTables) console.log(`[live] setup: sub-table "${st.name}"`);
  });

  afterAll(async () => {
    if (!ENABLED) return;
    if (!client) return;
    const failed: string[] = [];
    for (const pageId of createdPageIds) {
      try {
        await client.trashPage(pageId);
      } catch {
        failed.push(pageId);
      }
    }
    if (failed.length > 0) {
      console.log(
        `[live] cleanup: could NOT trash ${failed.length} of ${createdPageIds.length} page(s): ${failed.join(", ")}`,
      );
    } else if (createdPageIds.length > 0) {
      console.log(`[live] cleanup: trashed ${createdPageIds.length} page(s)`);
    }
    for (const problem of [sendImportProblem, candidatesImportProblem, knowledgeImportProblem]) {
      if (problem !== null) {
        console.log(`[live] CONCERN: a module chain failed to load: ${problem}`);
      }
    }
  });

  // ---------------------------------------------------------------- check 1
  it("check 1: the page in each sub-table, its creator and isOwnPage", async () => {
    const { client, me } = ready();
    const span = spanAt(180); // the -3h .. -2.5h slot
    for (const st of subTables) {
      const page = await client.createPage(meetingPageBody(st, summaryCheck, span, me.ownerUserId));
      createdPageIds.push(page.id ?? "");
      const creatorId = page.created_by?.id ?? null;
      const bucket =
        creatorId === null
          ? "none"
          : creatorId === me.id
            ? "the bot (me.id)"
            : me.ownerUserId !== null && creatorId === me.ownerUserId
              ? "the person (ownerUserId)"
              : "neither";
      console.log(`[live] check 1: "${st.name}" created_by id = ${bucket}`);
      if (!readCandidatesFn || !isOwnPageFn) {
        throw new Error(`readCandidates/isOwnPage unavailable: ${candidatesImportProblem}`);
      }
      const candidates = await readCandidatesFn(client, [st], span.startAt, span.endAt);
      const candidate = candidates.find((c) => c.pageId === page.id);
      expect(candidate, `the new page in "${st.name}" must be read back by readCandidates`).toBeDefined();
      check1Pages.push({
        subTable: st,
        pageId: page.id ?? "",
        parentDataSourceId:
          (page.parent as { data_source_id?: string } | undefined)?.data_source_id ?? "",
        candidate,
        startAt: span.startAt,
        endAt: span.endAt,
      });
      expect(
        isOwnPageFn(candidate as Candidate, me),
        `isOwnPage must be true for the "${st.name}" page`,
      ).toBe(true);
    }
  });

  // ---------------------------------------------------------------- check 2
  it("check 2: userName(ownerUserId) readability", async () => {
    const { client, me } = ready();
    if (me.ownerUserId === null) {
      console.log("[live] check 2: ownerUserId is null, userName not called");
      return;
    }
    const name = await client.userName(me.ownerUserId);
    console.log(
      `[live] check 2: userName(ownerUserId) returned ${
        name === null ? "null" : `a non-empty name (${name.length} chars, value not printed)`
      }`,
    );
    expect(name === null || name.length > 0).toBe(true);
  });

  // ---------------------------------------------------------------- check 3
  it("check 3: pages landed in the requested data source with date.end", async () => {
    if (check1Pages.length === 0) throw new Error("check 1 produced no pages to inspect");
    for (const entry of check1Pages) {
      const matches = entry.parentDataSourceId === entry.subTable.dataSourceId;
      console.log(
        `[live] check 3: "${entry.subTable.name}" landed in the requested data source: ` +
          (matches ? "yes" : "NO") +
          `, date.end = ` +
          (entry.candidate?.end !== undefined ? new Date(entry.candidate.end).toISOString() : "NOT SET"),
      );
      // Compared as a boolean, so a real data-source id never reaches the print.
      expect(matches, "the page's parent must be the requested data source").toBe(true);
      expect(entry.candidate?.end, "date.end must be set on the created page").toBeDefined();
    }
  });

  // ---------------------------------------------------------------- check 4
  it("check 4: a Knowledge row created Proposed reads back Proposed", async () => {
    const { client } = ready();
    if (!readKnowledgeFn) throw new Error(`readKnowledge unavailable: ${knowledgeImportProblem}`);
    const kdb = await readKnowledgeFn(client, KNOWLEDGE_DB);
    expect(
      kdb.hasProposed,
      "the Knowledge database needs a Proposed status option for this check",
    ).toBe(true);
    const row = await client.createPage({
      parent: { type: "data_source_id", data_source_id: kdb.dataSourceId },
      properties: {
        Rule: { title: [{ type: "text", text: { content: `LIVECHECK knowledge row ${STAMP}` } }] },
        Status: { status: { name: "Proposed" } },
      },
    });
    createdPageIds.push(row.id ?? "");
    // Read it back: a plain page GET, no query needed.
    const back = await client.request<{
      properties?: Record<string, { type?: string; status?: { name?: string } }>;
    }>("GET", `/v1/pages/${row.id}`);
    const status = back.properties?.Status;
    console.log(
      `[live] check 4: Status reads back as ` +
        (status?.type === "status"
          ? (status.status?.name ?? "(no name)")
          : `(type ${String(status?.type)})`),
    );
    expect(status?.type).toBe("status");
    expect(status?.status?.name).toBe("Proposed");
  });

  // ---------------------------------------------------------------- check 5
  it("check 5: a query sees a page just created (minute rounding, visibility delay)", async () => {
    const { client, me } = ready();
    const span = spanAt(330); // the -5.5h .. -5h slot
    const st = subTables[0];
    // Two creates back to back: the client spaces them NOTION_MIN_GAP_MS apart.
    const first = await client.createPage(meetingPageBody(st, summaryVisible, span, me.ownerUserId));
    const second = await client.createPage(meetingPageBody(st, summaryVisible, span, me.ownerUserId));
    createdPageIds.push(first.id ?? "", second.id ?? "");
    const createdTimeOf = (page: { created_time?: string }): string => page.created_time ?? "(missing)";
    const minuteRounded = (time: string): boolean => /T\d\d:\d\d:00\.000/.test(time);
    const t1 = createdTimeOf(first);
    const t2 = createdTimeOf(second);
    console.log(`[live] check 5: created_time #1 = ${t1} (minute-rounded: ${minuteRounded(t1)})`);
    console.log(`[live] check 5: created_time #2 = ${t2} (minute-rounded: ${minuteRounded(t2)})`);

    const seesSecond = async (): Promise<boolean> => {
      const pages = await client.queryAll(st.dataSourceId, {
        filter: { property: st.titleProp, title: { contains: summaryVisible.title } },
      });
      return pages.some((page) => page.id === second.id);
    };
    let delayMs = 0;
    let seen = await seesSecond();
    if (!seen) {
      while (!seen && delayMs < 30_000) {
        await new Promise((resolve) => setTimeout(resolve, 1_000));
        delayMs += 1_000;
        seen = await seesSecond();
      }
    }
    if (seen && delayMs === 0) {
      console.log("[live] check 5: a query immediately after the second create sees it");
    } else {
      const availability =
        recheckDelayMs !== null
          ? `RECHECK_DELAY_MS = ${recheckDelayMs}ms`
          : "RECHECK_DELAY_MS unavailable (CONCERN: send.ts chain failed to load)";
      console.log(
        `[live] check 5: the just-created page needed ${
          seen ? `${delayMs / 1000}s` : ">30s"
        } to become visible (${availability})`,
      );
    }
    if (recheckDelayMs !== null) {
      expect(
        delayMs,
        `the query must see the just-created page within RECHECK_DELAY_MS (${recheckDelayMs}ms)`,
      ).toBeLessThanOrEqual(recheckDelayMs);
    }
  });

  // ---------------------------------------------------------------- check 6
  it("check 6: 200 raw GETs - status counts and Retry-After", async () => {
    const { NOTION_API_BASE, NOTION_VERSION } = await import("@/lib/notion/client");
    const counts = new Map<number, number>();
    const retryAfterValues: string[] = [];
    let networkFailures = 0;
    const BATCH = 20;
    for (let batch = 0; batch < 200 / BATCH; batch++) {
      await Promise.all(
        Array.from({ length: BATCH }, async () => {
          try {
            const response = await fetch(`${NOTION_API_BASE}/v1/users/me`, {
              headers: {
                Authorization: `Bearer ${TOKEN}`,
                "Notion-Version": NOTION_VERSION,
              },
            });
            counts.set(response.status, (counts.get(response.status) ?? 0) + 1);
            if (response.status === 429) {
              // Retry-After is the only header that is ever read or printed.
              const retryAfter = response.headers.get("retry-after");
              if (retryAfter !== null) retryAfterValues.push(retryAfter);
            }
            void response.body?.cancel().catch(() => undefined);
          } catch {
            networkFailures += 1;
          }
        }),
      );
    }
    const statusLine =
      [...counts.entries()]
        .map(([status, count]) => `${status}x${count}`)
        .sort()
        .join(", ") || "none";
    console.log(
      `[live] check 6: 200 raw GETs -> ${statusLine}${
        networkFailures > 0 ? ` (network failures: ${networkFailures})` : ""
      }`,
    );
    console.log(
      `[live] check 6: any 429 carried Retry-After: ` +
        (retryAfterValues.length === 0
          ? "no"
          : `yes (values: ${[...new Set(retryAfterValues)].join(", ")})`),
    );
  });

  // ---------------------------------------------------------------- check 7
  it("check 7: round-trip - readCandidates finds the check-1 pages, times intact", async () => {
    const { client } = ready();
    if (!readCandidatesFn) throw new Error(`readCandidates unavailable: ${candidatesImportProblem}`);
    if (check1Pages.length === 0) throw new Error("check 1 produced no pages to round-trip");
    for (const entry of check1Pages) {
      const candidates = await readCandidatesFn(client, [entry.subTable], entry.startAt, entry.endAt);
      const candidate = candidates.find((c) => c.pageId === entry.pageId);
      expect(candidate, `readCandidates must find the "${entry.subTable.name}" page`).toBeDefined();
      const c = candidate as Candidate;
      console.log(
        `[live] check 7: "${entry.subTable.name}" written start=${new Date(entry.startAt).toISOString()} end=${new Date(entry.endAt).toISOString()} | ` +
          `page start=${new Date(c.start).toISOString()} end=${new Date(c.end).toISOString()} ` +
          `(deltas ${c.start - entry.startAt}ms/${c.end - entry.endAt}ms), boldTitle === title: ${
            c.boldTitle === summaryCheck.title
          }`,
      );
      expect(Math.abs(c.start - entry.startAt), "the round-trip must land within 60s of the written start").toBeLessThanOrEqual(60_000);
      expect(Math.abs(c.end - entry.endAt), "the round-trip must land within 60s of the written end").toBeLessThanOrEqual(60_000);
      expect(c.boldTitle).toBe(summaryCheck.title);
    }
  });

  // ---------------------------------------------------------------- check 8
  it("check 8: hand-made page with a time zone (print only)", async () => {
    const { client } = ready();
    const st = subTables[0];
    const span = spanAt(480); // the -8h .. -7.5h slot, alone on its sub-table
    // The machine's wall clock, formatted with NO offset, as a hand-made page
    // in Europe/Oslo would write it.
    const local = (ms: number): string => {
      const d = new Date(ms);
      const pad = (n: number): string => String(n).padStart(2, "0");
      return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
    };
    const page = await client.createPage({
      parent: { type: "data_source_id", data_source_id: st.dataSourceId },
      properties: {
        [st.titleProp]: { title: [{ type: "text", text: { content: "LIVECHECK tz" } }] },
        [st.dateProp]: {
          date: { start: local(span.startAt), end: local(span.endAt), time_zone: "Europe/Oslo" },
        },
      },
    });
    createdPageIds.push(page.id ?? "");
    const back = await client.request<{
      properties?: Record<string, { date?: { start?: string; end?: string; time_zone?: string } }>;
    }>("GET", `/v1/pages/${page.id}`);
    const rawStart = back.properties?.[st.dateProp]?.date?.start ?? "(missing)";
    const carriesOffset = /[+-]\d\d:\d\d$|Z$/.test(rawStart);
    console.log(`[live] check 8: intended UTC = ${new Date(span.startAt).toISOString()} .. ${new Date(span.endAt).toISOString()}`);
    console.log(`[live] check 8: written (wall clock, no offset, time_zone Europe/Oslo) = ${local(span.startAt)} .. ${local(span.endAt)}`);
    console.log(`[live] check 8: raw date.start as Notion returned it = "${rawStart}" (offset present: ${carriesOffset ? "yes" : "no"})`);
    if (!readCandidatesFn) {
      console.log(`[live] check 8: readCandidates unavailable (${candidatesImportProblem}) - parse probe not run`);
      return;
    }
    const candidates = await readCandidatesFn(client, [st], span.startAt, span.endAt);
    const candidate = candidates.find((c) => c.pageId === page.id);
    if (!candidate) {
      console.log("[live] check 8: readCandidates did NOT surface the page (parsed outside the overlap window) [print only]");
      return;
    }
    console.log(
      `[live] check 8: readCandidates parses start to ${new Date(candidate.start).toISOString()} (delta vs intended UTC: ${
        candidate.start - span.startAt
      }ms), end to ${new Date(candidate.end).toISOString()} (delta: ${candidate.end - span.endAt}ms) [print only]`,
    );
  });
});
