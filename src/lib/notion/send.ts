import {
  claimSend,
  finishSend,
  getSend,
  patchSend,
  readSendLines,
  restampSend,
  type SendPatch,
} from "@/lib/database/notion-queue.action";
import { STALE_CLAIM_MS } from "@/lib/odoo/meeting-log";
import type { ProviderConfig } from "@/lib/functions/summary-provider";
import { resolveSummaryProvider, summarySecrets } from "@/lib/functions/summary-provider";
import {
  loadNotionConfigState,
  type NotionConfigState,
} from "@/lib/storage/notion-config.storage";
import type { DbNotionSend } from "@/types/notion";
import { createNotionAi, type NotionAi } from "./ai";
import { appendResumable } from "./append";
import { createNotionClient, type NotionClient } from "./client";
import {
  NOTION_SHOW_AT_ONCE,
  NotionError,
  SUMMARY_FINAL,
  SUMMARY_STRIKE,
  SummaryError,
  notionErrorText,
  outcomeFor,
  type NotionErrorCode,
  type SummaryErrorCode,
} from "./errors";
import { addPractices, readKnowledge } from "./knowledge";
import { batchBlocks, buildPageBlocks, pageProperties, transcriptBlocks } from "./page-blocks";
import { armNotionRedactor } from "./redact";
import { buildMapping, describeSubTable, routeMeeting, type SubTable } from "./routing";
import { pickWinner, type Candidate, readCandidates, sameMeeting } from "./same-meeting";
import { summarizeForNotion, type NotionSummary } from "./summarize";
import { loadNotionToken } from "./token";

/** Consecutive strike-coded summary failures that end a send as no_summary. */
export const SUMMARY_STRIKES = 3;
/** Wait before the recheck that settles a same-meeting race. */
export const RECHECK_DELAY_MS = 5_000;

export interface NotionSendDeps {
  now: () => number;
  sleep: (ms: number) => Promise<void>;
  client: NotionClient;
  ai: NotionAi;
  state: Extract<NotionConfigState, { state: "complete" }>;
}

export type SendOutcome =
  | "sent"
  | "already"
  | "retry"
  | "failed"
  | "no_summary"
  | "lost-claim"
  | "not-claimed";

/** The competitor's link; an empty url must never leave lost_to_url empty. */
const linkOf = (c: Candidate) => c.url || `https://www.notion.so/${c.pageId.replace(/-/g, "")}`;

/** Thrown when a restamp, patch or finish is refused: another attempt owns the send. */
class LostClaim extends Error {}

type StepError = { code: NotionErrorCode | SummaryErrorCode; retryAfterMs?: number };

/** The code of a caught throw. A non-Notion throw is logged (code + type name only) by notionErrorText. */
function errorInfo(thrown: unknown): StepError {
  if (thrown instanceof NotionError) return { code: thrown.code, retryAfterMs: thrown.retryAfterMs };
  if (thrown instanceof SummaryError) return { code: thrown.code };
  return { code: notionErrorText(thrown).code as NotionErrorCode };
}

/**
 * Runs one send, resumably. Never throws. The step order and its crash points
 * are the plan's Task 13; the stamp is one local variable, replaced by each
 * successful restamp and passed to every write.
 */
export async function runNotionSend(sendId: string, deps: NotionSendDeps): Promise<SendOutcome> {
  let claimed = false;
  let attempts = 1;
  let stampAt = 0;

  const stamp = async () => {
    const next = await restampSend(sendId, stampAt, deps.now());
    if (next === null) throw new LostClaim();
    stampAt = next;
  };

  try {
    const t0 = deps.now();
    const claim = await claimSend(sendId, t0, t0 - STALE_CLAIM_MS);
    if (claim === null) return "not-claimed";
    stampAt = claim;
    const row = await getSend(sendId);
    if (row === null) return "not-claimed";
    claimed = true;
    attempts = row.attempts;
    // Local copy of the row; every patch is mirrored into it.
    const s: DbNotionSend = { ...row };

    const patch = async (p: SendPatch) => {
      if (!(await patchSend(sendId, stampAt, p))) throw new LostClaim();
      for (const [k, v] of Object.entries(p)) {
        if (v !== undefined) (s as unknown as Record<string, unknown>)[k] = v;
      }
    };
    const finish = async (
      status: "retry" | "failed" | "no_summary" | "sent" | "already",
      extra: { errorCode?: string | null; practicesErrorCode?: string | null; nextAt?: number | null; sentAt?: number | null } = {},
    ): Promise<SendOutcome> => {
      if (!(await finishSend(sendId, stampAt, { status, ...extra }))) throw new LostClaim();
      return status;
    };
    const finishFor = (e: StepError) => {
      const o = outcomeFor(e.code, attempts, deps.now(), e.retryAfterMs);
      return finish(o.status, { errorCode: e.code, nextAt: o.nextAt });
    };

    const { lines } = await readSendLines(sendId);

    // A known loser trashes first: a failing step below must never keep a duplicate alive.
    const trashLoser = async (): Promise<SendOutcome> => {
      await stamp();
      await deps.client.trashPage(s.page_id as string);
      return await finish("already");
    };
    // A loser's finish was refused or crashed: no page means nothing to trash.
    if (s.lost_to_url) return s.page_id ? await trashLoser() : await finish("already");

    if (lines.length === 0 && !s.page_id) {
      return await finish("no_summary", { errorCode: "SUMMARY_TOO_SHORT" });
    }

    // 1. Summary: stored once, reused on every retry.
    let summary: NotionSummary;
    if (s.summary_json) {
      summary = JSON.parse(s.summary_json) as NotionSummary;
    } else {
      await stamp();
      try {
        summary = await summarizeForNotion(lines, deps.ai);
      } catch (e) {
        if (!(e instanceof SummaryError)) throw e;
        if (SUMMARY_FINAL.has(e.code)) return await finish("no_summary", { errorCode: e.code });
        if (SUMMARY_STRIKE.has(e.code)) {
          const strikes = s.summary_failures + 1;
          if (strikes >= SUMMARY_STRIKES) {
            return await finish("no_summary", { errorCode: "SUMMARY_STRIKES_OUT" });
          }
          await patch({ summary_failures: strikes });
        }
        return await finishFor({ code: e.code });
      }
      await patch({ summary_json: JSON.stringify(summary), summary_failures: 0 });
    }

    // 2. Me.
    await stamp();
    const { config, meetingsDbId, knowledgeDbId } = deps.state;
    const me = await deps.client.me();
    let name = config.yourName;
    if (!name && me.ownerUserId !== null) name = (await deps.client.userName(me.ownerUserId)) ?? "";
    name = name || "You";

    // 3. Mapping.
    const subTables: SubTable[] = [];
    await stamp();
    const meetingsDb = await deps.client.database(meetingsDbId);
    for (const ds of meetingsDb.dataSources) {
      await stamp();
      const st = describeSubTable(await deps.client.dataSource(ds.id));
      if (st !== null) subTables.push(st);
    }
    const mapping = buildMapping(subTables);
    if (mapping === null) throw new NotionError("NOTION_INVALID");

    // Proven to be THIS send's page: a creator match alone is not proof (with a personal
    // token the owner is the person, so their hand-made pages match too). Needs our creator,
    // the exact range this send wrote (60 s covers minute rounding) and our bold title.
    // ponytail: the same token on two devices recording one meeting with identical AI titles
    // and spans within 60 s would still trash each other's pages; no cheaper proof exists.
    const isThisSendsPage = (c: Candidate): boolean =>
      s.create_started_at !== null &&
      c.createdById !== null &&
      (c.createdById === me.id || (me.ownerUserId !== null && c.createdById === me.ownerUserId)) &&
      Math.abs(c.start - s.span_start_at) <= 60_000 &&
      Math.abs(c.end - s.span_end_at) <= 60_000 &&
      c.boldTitle === summary.title;

    // 4. Find or create the page.
    if (!s.page_id) {
      await stamp();
      const candidates = await readCandidates(deps.client, subTables, s.span_start_at, s.span_end_at);
      if (s.create_started_at !== null) {
        const own = candidates.find(isThisSendsPage);
        if (own) await patch({ page_id: own.pageId, page_url: own.url, page_created_time: own.createdTime });
      }
      if (!s.page_id) {
        for (const c of candidates) {
          if (isThisSendsPage(c)) continue;
          await stamp();
          if (await sameMeeting(deps.ai, c, summary)) {
            await patch({ lost_to_url: linkOf(c) });
            return await finish("already");
          }
        }
        await stamp();
        await patch({ create_started_at: deps.now() });
        const r = routeMeeting(s.span_start_at, mapping, config.teamTimes, summary.title);
        const page = await deps.client.createPage({
          parent: { type: "data_source_id", data_source_id: r.subTable.dataSourceId },
          properties: pageProperties(r, s.span_start_at, s.span_end_at, me.ownerUserId),
          children: batchBlocks(buildPageBlocks(summary))[0] ?? [],
        });
        if (!page.id || !page.url) throw new NotionError("NOTION_INTERNAL");
        await patch({ page_id: page.id, page_url: page.url, page_created_time: page.created_time ?? "" });
      }
    }
    const pageId = s.page_id as string;

    // 5. Body.
    if (!s.body_done) {
      await stamp();
      const all = await appendResumable(deps.client, pageId, buildPageBlocks(summary), stamp);
      const toggle = [...all].reverse().find((b) => b.type === "toggle");
      if (!toggle?.id) throw new NotionError("NOTION_PAGE_CHANGED");
      await patch({ body_done: 1, toggle_block_id: toggle.id });
    }

    // 6. Recheck: settle a same-meeting race, trash the loser.
    if (!s.lost_to_url) {
      await stamp();
      await deps.sleep(RECHECK_DELAY_MS);
      await stamp();
      const candidates = await readCandidates(deps.client, subTables, s.span_start_at, s.span_end_at);
      // An own page that is not this one is an orphan from a create whose response was lost.
      for (const c of candidates) {
        if (isThisSendsPage(c) && c.pageId !== pageId) {
          await stamp();
          await deps.client.trashPage(c.pageId);
        }
      }
      const rivals: typeof candidates = [];
      for (const c of candidates) {
        if (c.pageId === pageId || isThisSendsPage(c)) continue;
        await stamp();
        if (await sameMeeting(deps.ai, c, summary)) rivals.push(c);
      }
      const winner = pickWinner([
        { pageId, createdTime: s.page_created_time ?? "" },
        ...rivals.map((c) => ({ pageId: c.pageId, createdTime: c.createdTime })),
      ]);
      if (winner !== pageId) {
        await patch({ lost_to_url: linkOf(rivals.find((c) => c.pageId === winner) as Candidate) });
      }
    }
    if (s.lost_to_url) return await trashLoser();

    // 7. Transcript and practices, independent. A LostClaim always escapes.
    let transcriptErr: StepError | null = null;
    let practicesErr: StepError | null = null;
    if (!s.transcript_done) {
      try {
        await stamp();
        if (lines.length > 0) {
          if (!s.toggle_block_id) throw new NotionError("NOTION_PAGE_CHANGED");
          await appendResumable(deps.client, s.toggle_block_id, transcriptBlocks(lines, name), stamp);
        }
        await patch({ transcript_done: 1 });
      } catch (e) {
        if (e instanceof LostClaim) throw e;
        transcriptErr = errorInfo(e);
      }
    }
    if (!s.practices_done) {
      try {
        if (summary.practices.length > 0 && knowledgeDbId !== null) {
          if (!s.page_url) throw new NotionError("NOTION_INTERNAL");
          await stamp();
          const kdb = await readKnowledge(deps.client, knowledgeDbId);
          await stamp();
          await addPractices(deps.client, deps.ai, kdb, summary.practices, s.page_url, stamp);
        }
        await patch({ practices_done: 1 });
      } catch (e) {
        if (e instanceof LostClaim) throw e;
        practicesErr = errorInfo(e);
      }
    }

    // 8. Finish.
    const primary = transcriptErr ?? practicesErr;
    if (primary === null) return await finish("sent", { sentAt: deps.now() });
    const o = outcomeFor(primary.code, attempts, deps.now(), primary.retryAfterMs);
    const other = transcriptErr !== null ? practicesErr : null;
    const atOnce = other !== null && NOTION_SHOW_AT_ONCE.has(other.code as NotionErrorCode);
    return await finish(atOnce ? "failed" : o.status, {
      errorCode: primary.code,
      practicesErrorCode: practicesErr?.code ?? null,
      nextAt: atOnce ? null : o.nextAt,
    });
  } catch (thrown) {
    if (thrown instanceof LostClaim) return "lost-claim";
    const info = errorInfo(thrown);
    if (!claimed) return "failed";
    try {
      const o = outcomeFor(info.code, attempts, deps.now(), info.retryAfterMs);
      if (!(await finishSend(sendId, stampAt, { status: o.status, errorCode: info.code, nextAt: o.nextAt }))) {
        return "lost-claim";
      }
      return o.status;
    } catch {
      return "failed";
    }
  }
}

/**
 * Everything one tick of sends shares: config, one client (pacing is per
 * client), one AI. Never throws; a failure comes back as its code.
 */
export async function buildSendDeps(
  fallback?: ProviderConfig,
): Promise<NotionSendDeps | { error: NotionErrorCode }> {
  try {
    const state = await loadNotionConfigState();
    if (state.state !== "complete") return { error: "NOTION_NOT_CONFIGURED" };
    const token = await loadNotionToken();
    if (!token) return { error: "NOTION_NOT_CONFIGURED" };
    const resolved = await resolveSummaryProvider(fallback);
    armNotionRedactor([token, ...summarySecrets(resolved)]);
    return {
      now: Date.now,
      sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
      client: createNotionClient({ token }),
      ai: createNotionAi(resolved),
      state,
    };
  } catch (thrown) {
    if (thrown instanceof NotionError) return { error: thrown.code };
    return { error: notionErrorText(thrown).code as NotionErrorCode };
  }
}
