// LIVE NOTION CHECKS - Run by Kevin with a real token against throwaway
// databases; paste the printed results into the PR body. Checks 1, 2 and 5
// confirm the assumptions this build handles both ways.
//
// Gating: the three NOTION_LIVE_* env vars must ALL be set or the whole suite
// skips (a run without them does nothing but skip - exit 0). Only throwaway
// database ids are used, and never committed. The token is never printed and
// no header except Retry-After is ever named. Every page the checks create
// (meeting pages and the Knowledge row) goes into the cleanup list the moment
// its createPage returns, and is trashed in afterAll; page titles all start
// with "LIVECHECK". Sub-table names from the duplicated team database are
// never printed: each prints as "sub-table #<n> (<weekday slot or "other">)",
// because the printed output goes into a public PR body.
//
// Read-backs POLLED, never assumed instant: waitForCandidate re-runs the
// sender's date query every 500 ms (Date.now-timed) up to RECHECK_DELAY_MS;
// the visibility delay itself is what check 5 measures with real elapsed
// time. Check 3 reads the create response, not a read-back. Check 8 writes a
// zone-labelled wall clock for a known instant and prints (no assertion) what
// readCandidates parses it back to. Check 6 runs LAST: its 200-request burst
// must not throttle the client calls checks 7 and 8 still need.
import { beforeAll, afterAll, describe, expect, it, vi } from "vitest";
import { NotionError } from "@/lib/notion/errors";
import { buildMapping, describeMapping, describeSubTable } from "@/lib/notion/routing";
import { buildPageBlocks, pageProperties } from "@/lib/notion/page-blocks";
import type { Mapping, SubTable } from "@/lib/notion/routing";
import type { NotionClient, NotionClientDeps, NotionPage } from "@/lib/notion/client";
import type { Candidate, isOwnPage, readCandidates } from "@/lib/notion/same-meeting";
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

/** The check-5 pair gets its own span, so the two pages differ from check 1's. */
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
let mapping: Mapping | null = null;
let readCandidatesFn: typeof readCandidates | null = null;
let isOwnPageFn: typeof isOwnPage | null = null;
let readKnowledgeFn: typeof import("@/lib/notion/knowledge").readKnowledge | null = null;
let recheckDelayMs: number | null = null;
let sendImportProblem: unknown = null;
let candidatesImportProblem: unknown = null;
let knowledgeImportProblem: unknown = null;

const createdPageIds: string[] = [];

/** One check-1 page, recorded from its create response before any read-back. */
interface Created {
  subTable: SubTable;
  label: string;
  pageId: string;
  pageUrl: string;
  parentDataSourceId: string | undefined;
  createdResponseDate: { start: unknown; end: unknown };
  startAt: number;
  endAt: number;
}
const check1Pages: Created[] = [];

/** The state beforeAll guarantees; narrows the optionals for the check bodies. */
function ready(): { client: NotionClient; me: { id: string; ownerUserId: string | null } } {
  if (!client || !me) throw new Error("beforeAll has not completed");
  return { client, me };
}

/** RECHECK_DELAY_MS, or a loud stop on this check when the send.ts chain failed. */
function recheckMs(): number {
  if (recheckDelayMs === null) {
    throw new Error("RECHECK_DELAY_MS unavailable - send.ts chain failed to load (see the CONCERN line)");
  }
  return recheckDelayMs;
}

/**
 * A printable name for anything a chain load threw: NotionError code or the
 * error's name, never its message or a stack (the CONCERN lines go into the
 * public PR body, and raw messages carry absolute local paths).
 */
function errorName(thrown: unknown): string {
  if (thrown instanceof NotionError) return thrown.code;
  const name = (thrown as { name?: unknown } | null | undefined)?.name;
  return typeof name === "string" ? name : "unknown-name";
}

/** A public, workspace-anonymised label: its routing slot, never the name. */
function slotLabel(st: SubTable): string {
  const weekdays = Object.entries(mapping?.byWeekday ?? {})
    .filter(([, value]) => value === st)
    .map(([weekday]) => weekday);
  return `sub-table #${subTables.indexOf(st) + 1} (${weekdays.length > 0 ? weekdays.join("/") : "other"})`;
}

/** describeMapping's sentence with the team's sub-table names replaced by slot labels. */
function sanitisedMappingLine(): string {
  let line = describeMapping(mapping as Mapping);
  // Longest first, so a name that contains another (e.g. "Monday", "Monday
  // Late") cannot have the inside part replaced first and garble the rest.
  for (const st of [...subTables].sort((a, b) => b.name.length - a.name.length)) {
    line = line.split(st.name).join(slotLabel(st));
  }
  return line;
}

/**
 * Polls the sender's own date query until it sees the page, instead of
 * assuming instant visibility (the delay is real Notion behaviour and is what
 * check 5 measures). readCandidates on this sub-table every 500 ms, timed
 * with Date.now, up to timeoutMs. Returns the candidate - null when the
 * timeout ran out - and the real elapsed time in ms.
 */
async function waitForCandidate(
  subTable: SubTable,
  startAt: number,
  endAt: number,
  pageId: string,
  timeoutMs: number,
): Promise<{ candidate: Candidate | null; elapsedMs: number }> {
  const { client } = ready();
  if (!readCandidatesFn) {
    throw new Error("readCandidates unavailable - candidates chain failed to load (see the CONCERN line)");
  }
  const poll = readCandidatesFn;
  const startedAt = Date.now();
  for (;;) {
    const candidates = await poll(client, [subTable], startAt, endAt);
    const found = candidates.find((c) => c.pageId === pageId);
    if (found !== undefined) return { candidate: found, elapsedMs: Date.now() - startedAt };
    if (Date.now() - startedAt >= timeoutMs) return { candidate: null, elapsedMs: Date.now() - startedAt };
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
}

/** The raw date property the create response echoed, for check 3. */
function createdResponseDate(page: NotionPage, st: SubTable): { start: unknown; end: unknown } {
  const property = page.properties?.[st.dateProp];
  const date = (property as { date?: { start?: unknown; end?: unknown } } | undefined)?.date;
  return { start: date?.start, end: date?.end };
}

/** The create response's parent.data_source_id, when Notion echoed one back. */
function createdResponseParentDataSourceId(page: NotionPage): string | undefined {
  const id = (page.parent as { data_source_id?: unknown } | undefined)?.data_source_id;
  return typeof id === "string" ? id : undefined;
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
    // The redactor is module-level and fail-closed when unarmed, so it is
    // armed BEFORE the first anything that could carry the token - the
    // client's own creation included, as buildSendDeps does.
    armNotionRedactor([TOKEN]);
    client = createNotionClient({
      token: TOKEN,
      // Node's global fetch stands in for @tauri-apps/plugin-http's fetch.
      fetch: globalThis.fetch as NotionClientDeps["fetch"],
    });

    // same-meeting/knowledge/send are loaded dynamically: their chains reach
    // the DB and tauri modules, and a load failure must become a printed
    // concern, not a dead file.
    try {
      ({ RECHECK_DELAY_MS: recheckDelayMs } = await import("@/lib/notion/send"));
    } catch (thrown) {
      sendImportProblem = thrown;
    }
    try {
      ({ readCandidates: readCandidatesFn, isOwnPage: isOwnPageFn } = await import(
        "@/lib/notion/same-meeting"
      ));
    } catch (thrown) {
      candidatesImportProblem = thrown;
    }
    try {
      ({ readKnowledge: readKnowledgeFn } = await import("@/lib/notion/knowledge"));
    } catch (thrown) {
      knowledgeImportProblem = thrown;
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
    // The sender throws NOTION_INVALID when buildMapping returns null, so a
    // throwaway database it would reject must fail here, before any check.
    const builtMapping = buildMapping(subTables);
    expect(
      builtMapping !== null,
      "the sender's buildMapping must accept this database (a null mapping makes send.ts fail NOTION_INVALID before any send)",
    ).toBe(true);
    mapping = builtMapping;
    console.log(
      `[live] setup: ${subTables.length} usable sub-table(s); ` +
        `ownerUserId ${me.ownerUserId !== null ? "present" : "null"}; ` +
        `RECHECK_DELAY_MS ${
          recheckDelayMs !== null ? String(recheckDelayMs) : "UNAVAILABLE (send.ts chain failed to load)"
        }`,
    );
    console.log(`[live] setup: routing: ${sanitisedMappingLine()}`);
    for (const st of subTables) console.log(`[live] setup: ${slotLabel(st)}`);
  });

  afterAll(async () => {
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
        console.log(`[live] CONCERN: a module chain failed to load: ${errorName(problem)}`);
      }
    }
  });

  // ---------------------------------------------------------------- check 1
  it("check 1: the page in each sub-table, its creator and isOwnPage", async () => {
    const { client, me } = ready();
    const span = spanAt(180); // the -3h .. -2.5h slot
    for (const st of subTables) {
      const page = await client.createPage(meetingPageBody(st, summaryCheck, span, me.ownerUserId));
      const label = slotLabel(st);
      createdPageIds.push(page.id ?? "");
      check1Pages.push({
        subTable: st,
        label,
        pageId: page.id ?? "",
        pageUrl: page.url ?? "",
        parentDataSourceId: createdResponseParentDataSourceId(page),
        createdResponseDate: createdResponseDate(page, st),
        startAt: span.startAt,
        endAt: span.endAt,
      });
      const creatorId = page.created_by?.id ?? null;
      const matched =
        creatorId === null
          ? "none"
          : creatorId === me.id
            ? "bot"
            : me.ownerUserId !== null && creatorId === me.ownerUserId
              ? "owner"
              : "neither";
      console.log(`[live] check 1: ${label} created_by matched: ${matched}`);
      // The creator clause isThisSendsPage (send.ts) relies on: crash
      // recovery and orphan trashing only claim pages whose created_by is the
      // bot or the owner, whatever "Recorded by" says.
      expect(
        matched === "bot" || matched === "owner",
        `created_by matched neither me.id nor ownerUserId (${matched}) - the sender's creator rule is broken`,
      ).toBe(true);
      if (isOwnPageFn === null) {
        throw new Error(
          "readCandidates/isOwnPage unavailable - candidates chain failed to load (see the CONCERN line)",
        );
      }
      // Captured before the await: a call can reset module-variable narrowing.
      const isOwn = isOwnPageFn;
      const { candidate } = await waitForCandidate(st, span.startAt, span.endAt, page.id ?? "", recheckMs());
      expect(candidate, "page not visible within RECHECK_DELAY_MS (see check 5)").not.toBeNull();
      if (candidate !== null) {
        expect(
          isOwn(candidate, me),
          `isOwnPage must be true for the ${label} page`,
        ).toBe(true);
      }
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
      // Values as the create response sent them. No id is printed (the output
      // goes into a public PR body): only whether the echoed parent matches.
      const parentEcho = entry.parentDataSourceId;
      console.log(
        `[live] check 3: ${entry.label} parent.data_source_id ` +
          (parentEcho === undefined || parentEcho === null
            ? "not in create response"
            : parentEcho === entry.subTable.dataSourceId
              ? "= the requested data source"
              : "= a DIFFERENT data source") +
          `, date.start = ${String(entry.createdResponseDate.start)}` +
          `, date.end = ${String(entry.createdResponseDate.end)}`,
      );
      if (parentEcho !== undefined && parentEcho !== null) {
        expect(
          parentEcho === entry.subTable.dataSourceId,
          "the create response's parent.data_source_id must be the requested data source",
        ).toBe(true);
      }
      const end = entry.createdResponseDate.end;
      expect(
        typeof end === "string" && end.length > 0,
        "date.end must be a non-empty string in the create response",
      ).toBe(true);
    }
  });

  // ---------------------------------------------------------------- check 4
  it("check 4: a Knowledge row created Proposed reads back Proposed", async () => {
    const { client } = ready();
    if (!readKnowledgeFn) throw new Error("readKnowledge unavailable - knowledge chain failed to load (see the CONCERN line)");
    const firstMeeting = check1Pages[0];
    if (firstMeeting === undefined) {
      throw new Error("check 1 produced no page; its url is what the Knowledge row's Meeting link needs");
    }
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
        // Production always writes the meeting page's link (addPractices in
        // knowledge.ts), so the throwaway row carries it too.
        "Meeting link": { url: firstMeeting.pageUrl },
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
    createdPageIds.push(first.id ?? "");
    const second = await client.createPage(meetingPageBody(st, summaryVisible, span, me.ownerUserId));
    createdPageIds.push(second.id ?? "");
    const createdTimeOf = (page: { created_time?: string }): string => page.created_time ?? "(missing)";
    const minuteRounded = (time: string): boolean => /T\d\d:\d\d:00\.000/.test(time);
    const t1 = createdTimeOf(first);
    const t2 = createdTimeOf(second);
    console.log(`[live] check 5: created_time #1 = ${t1} (minute-rounded: ${minuteRounded(t1)})`);
    console.log(`[live] check 5: created_time #2 = ${t2} (minute-rounded: ${minuteRounded(t2)})`);

    // Timed from when the second create returned (the wall-clock wait a real
    // sender's recheck rides on), polled with the sender's own date query -
    // not a title filter. The 30s cap keeps a stuck query from hanging the
    // run; the assertion below is the gate.
    const { candidate, elapsedMs } = await waitForCandidate(st, span.startAt, span.endAt, second.id ?? "", 30_000);
    console.log(
      `[live] check 5: readCandidates saw the just-created page after ${elapsedMs}ms` +
        (candidate === null ? " - NOT seen within the 30s polling cap" : ""),
    );
    if (recheckDelayMs === null) {
      throw new Error("RECHECK_DELAY_MS unavailable - send.ts chain failed to load (see the CONCERN line)");
    }
    expect(
      elapsedMs,
      `visibility took ${elapsedMs}ms; RECHECK_DELAY_MS is ${recheckDelayMs}ms`,
    ).toBeLessThanOrEqual(recheckDelayMs);
  });

  // ---------------------------------------------------------------- check 7
  it("check 7: round-trip - readCandidates finds the check-1 pages, times intact", async () => {
    ready();
    if (!readCandidatesFn) {
      throw new Error("readCandidates unavailable - candidates chain failed to load (see the CONCERN line)");
    }
    if (check1Pages.length === 0) throw new Error("check 1 produced no pages to round-trip");
    for (const entry of check1Pages) {
      const { candidate } = await waitForCandidate(
        entry.subTable,
        entry.startAt,
        entry.endAt,
        entry.pageId,
        recheckMs(),
      );
      expect(candidate, "page not visible within RECHECK_DELAY_MS (see check 5)").not.toBeNull();
      if (candidate !== null) {
        console.log(
          `[live] check 7: ${entry.label}: written start=${new Date(entry.startAt).toISOString()} end=${new Date(entry.endAt).toISOString()} | ` +
            `page start=${new Date(candidate.start).toISOString()} end=${new Date(candidate.end).toISOString()} ` +
            `(deltas ${candidate.start - entry.startAt}ms/${candidate.end - entry.endAt}ms), boldTitle === title: ${
              candidate.boldTitle === summaryCheck.title
            }`,
        );
        expect(
          Math.abs(candidate.start - entry.startAt),
          "the round-trip must land within 60s of the written start",
        ).toBeLessThanOrEqual(60_000);
        expect(
          Math.abs(candidate.end - entry.endAt),
          "the round-trip must land within 60s of the written end",
        ).toBeLessThanOrEqual(60_000);
        expect(candidate.boldTitle).toBe(summaryCheck.title);
      }
    }
  });

  // ---------------------------------------------------------------- check 8
  it("check 8: hand-made page with a time zone (print only)", async () => {
    const { client } = ready();
    const st = subTables[0];
    const span = spanAt(480); // the -8h .. -7.5h slot, alone on its sub-table
    // A fixed instant, so the wall clocks below really do encode it.
    const instant = span.startAt;
    const machineZone = Intl.DateTimeFormat().resolvedOptions().timeZone;
    // A zone that cannot agree with the machine's wall clock - delta 0 is
    // then only possible when the parse honours the zone, never by accident.
    const zone = machineZone === "America/New_York" ? "Asia/Tokyo" : "America/New_York";
    /** That zone's wall clock for `ms`: "YYYY-MM-DDTHH:mm:00" with no offset. */
    const wallClock = (ms: number): string => {
      const parts = Intl.DateTimeFormat("en-CA", {
        timeZone: zone,
        year: "numeric",
        month: "2-digit",
        day: "2-digit",
        hour: "2-digit",
        minute: "2-digit",
        hourCycle: "h23",
      }).formatToParts(new Date(ms));
      const get = (type: Intl.DateTimeFormatPartTypes): string =>
        parts.find((p) => p.type === type)?.value ?? "";
      return `${get("year")}-${get("month")}-${get("day")}T${get("hour")}:${get("minute")}:00`;
    };
    const start = wallClock(instant);
    const end = wallClock(instant + 30 * 60_000);
    const page = await client.createPage({
      parent: { type: "data_source_id", data_source_id: st.dataSourceId },
      properties: {
        [st.titleProp]: { title: [{ type: "text", text: { content: "LIVECHECK tz" } }] },
        [st.dateProp]: { date: { start, end, time_zone: zone } },
      },
    });
    createdPageIds.push(page.id ?? "");
    const back = await client.request<{
      properties?: Record<string, { date?: { start?: string; end?: string; time_zone?: string } }>;
    }>("GET", `/v1/pages/${page.id}`);
    const rawStart = back.properties?.[st.dateProp]?.date?.start ?? "(missing)";
    const carriesOffset = /[+-]\d\d:\d\d$|Z$/.test(rawStart);
    console.log(
      `[live] check 8: machine time zone = ${machineZone}; zone used = ${zone}; intended instant = ${new Date(instant).toISOString()}`,
    );
    console.log(`[live] check 8: written with time_zone ${zone}, no offset: start "${start}", end "${end}"`);
    console.log(
      `[live] check 8: raw stored date.start as Notion returned it = "${rawStart}" (offset present: ${carriesOffset ? "yes" : "no"})`,
    );
    // The same Date.parse readCandidate uses (same-meeting.ts), printed even
    // when the misparse pushes the page out of readCandidates' overlap window.
    const parsed = Date.parse(rawStart);
    const deltaMinutes = Number.isNaN(parsed) ? NaN : (parsed - instant) / 60_000;
    console.log(`[live] check 8: Date.parse(raw start) deltaMinutes = ${deltaMinutes} [print only]`);
    const { candidate } = await waitForCandidate(st, span.startAt, span.endAt, page.id ?? "", recheckMs());
    console.log(
      candidate === null
        ? "[live] check 8: readCandidates did NOT surface the page (parsed outside the overlap window) [print only]"
        : `[live] check 8: readCandidates parses start to ${new Date(candidate.start).toISOString()} [print only]`,
    );
  });

  // ---------------------------------------------------------------- check 6
  // Runs LAST: its 200-request burst must not leave a throttled token
  // imposing multi-second Retry-After waits on checks 7 and 8, or on cleanup.
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
});
