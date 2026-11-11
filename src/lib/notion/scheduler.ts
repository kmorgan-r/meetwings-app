import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import {
  cancelOrphanedWaitingRows,
  claimSend,
  conversationsWithLiveSend,
  createSendAndLink,
  finishSend,
  lastSpokenLineAt,
  listDueSends,
  listWaitingRows,
} from "@/lib/database/notion-queue.action";
import { promoteStaleHeldNotionRows } from "@/lib/database/meeting-log.action";
import type { ProviderConfig } from "@/lib/functions/summary-provider";
import { HOLD_MS, STALE_CLAIM_MS } from "@/lib/odoo/meeting-log";
import { isNotionConfigured } from "@/lib/storage/notion-config.storage";
import { outcomeFor, notionErrorText } from "./errors";
import { NOTION_KICK_EVENT } from "./events";
import { isQuiet, joinSets } from "./join";
import { buildSendDeps, runNotionSend } from "./send";

export interface SchedulerDeps {
  now: () => number;
  liveLastLineAt: (conversationId: string) => number | null;
  fallbackProvider: () => ProviderConfig | undefined;
}

export const NOTION_TICK_MS = 60_000;
export { NOTION_KICK_EVENT };

let inFlight: Promise<void> | null = null;
// A request that lands mid-tick is not lost: one more tick runs when this one ends.
let rerun: SchedulerDeps | null = null;

async function tick(deps: SchedulerDeps): Promise<void> {
  if (!(await isNotionConfigured())) return;
  const now = deps.now();
  await promoteStaleHeldNotionRows(now - HOLD_MS - NOTION_TICK_MS);
  const live = await conversationsWithLiveSend(now - STALE_CLAIM_MS);
  await cancelOrphanedWaitingRows();
  for (const set of joinSets(await listWaitingRows())) {
    const first = set[0];
    const conv = first.conversation_id;
    if (conv?.startsWith("sysaudio_conv_")) continue;
    if (conv !== null && live.has(conv)) continue;
    const rowEnd = Math.max(...set.map((r) => r.transcript_end_at));
    const last =
      conv === null
        ? rowEnd
        : Math.max((await lastSpokenLineAt(conv)) ?? 0, deps.liveLastLineAt(conv) ?? 0, rowEnd);
    if (!isQuiet(last, now)) continue;
    await createSendAndLink(
      {
        id: first.id,
        conversationId: conv,
        spanStartAt: first.transcript_start_at,
        spanEndAt: rowEnd,
        createdAt: now,
      },
      set.map((r) => r.id),
    );
  }

  const due = await listDueSends(now, now - STALE_CLAIM_MS);
  if (due.length === 0) return;
  const sendDeps = await buildSendDeps(deps.fallbackProvider());
  if ("error" in sendDeps) {
    const error = sendDeps.error;
    for (const send of due) {
      const stamp = await claimSend(send.id, now, now - STALE_CLAIM_MS);
      if (stamp === null) continue;
      const o = outcomeFor(error, send.attempts + 1, now);
      await finishSend(send.id, stamp, { status: o.status, errorCode: error, nextAt: o.nextAt });
    }
    return;
  }
  for (const send of due) await runNotionSend(send.id, sendDeps);
}

/** Never rejects; overlapping callers share one run. */
export function runNotionTick(deps: SchedulerDeps): Promise<void> {
  if (inFlight) {
    rerun = deps;
    return inFlight;
  }
  const p: Promise<void> = tick(deps)
    .catch((err) => void notionErrorText(err))
    .finally(() => {
      if (inFlight !== p) return;
      inFlight = null;
      const next = rerun;
      rerun = null;
      if (next) void runNotionTick(next);
    });
  inFlight = p;
  return p;
}

let started = false;
let currentDeps: SchedulerDeps | null = null;
let timer: ReturnType<typeof setInterval> | null = null;
let unlisten: UnlistenFn | null = null;

export function ensureNotionScheduler(deps: SchedulerDeps): void {
  currentDeps = deps;
  if (started) return;
  started = true;
  const run = () => {
    if (currentDeps) void runNotionTick(currentDeps);
  };
  run();
  timer = setInterval(run, NOTION_TICK_MS);
  listen(NOTION_KICK_EVENT, run).then(
    (u) => {
      if (started) unlisten = u;
      else u();
    },
    (err) => void notionErrorText(err),
  );
}

export const isNotionSchedulerStarted = () => started;

export function resetNotionSchedulerForTests(): void {
  if (timer) clearInterval(timer);
  unlisten?.();
  timer = null;
  unlisten = null;
  currentDeps = null;
  started = false;
  inFlight = null;
  rerun = null;
}
