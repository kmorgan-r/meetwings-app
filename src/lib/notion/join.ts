import { MEETING_CONVERSATION_GAP_MS } from "@/config";
import { snapshotJsonForSpan } from "@/lib/database/calendar-snapshot.action";
import {
  conversationsWithLiveSend,
  createSendAndLink,
  type WaitingRow,
} from "@/lib/database/notion-queue.action";
import { STALE_CLAIM_MS } from "@/lib/odoo/meeting-log";

/**
 * Groups waiting rows into sends: per conversation, sorted by start, a row joins
 * the previous set when its start is under the meeting gap after that set's max
 * end. A null conversation id never groups. Sets come out ordered by first start.
 */
export function joinSets(rows: WaitingRow[]): WaitingRow[][] {
  const byConv = new Map<string, WaitingRow[]>();
  const sets: WaitingRow[][] = [];
  for (const r of rows) {
    if (r.conversation_id === null) sets.push([r]);
    else byConv.set(r.conversation_id, [...(byConv.get(r.conversation_id) ?? []), r]);
  }
  for (const group of byConv.values()) {
    let curEnd = -Infinity;
    let cur: WaitingRow[] | null = null;
    for (const r of [...group].sort((a, b) => a.transcript_start_at - b.transcript_start_at)) {
      if (cur && r.transcript_start_at - curEnd < MEETING_CONVERSATION_GAP_MS) {
        cur.push(r);
        curEnd = Math.max(curEnd, r.transcript_end_at);
      } else {
        cur = [r];
        sets.push(cur);
        curEnd = r.transcript_end_at;
      }
    }
  }
  return sets.sort((a, b) => a[0].transcript_start_at - b[0].transcript_start_at);
}

export function isQuiet(lastLineAt: number, now: number): boolean {
  return now - lastLineAt >= MEETING_CONVERSATION_GAP_MS;
}

/**
 * Opens a send for each joined set of waiting rows, skipping system audio, a
 * conversation with a live send, and any set `ready` refuses. Lives here, not in
 * the scheduler, so the press path can call it without importing ./scheduler or ./send.
 */
export async function openSends(
  rows: WaitingRow[],
  now: number,
  ready: (set: WaitingRow[]) => Promise<boolean> = async () => true,
): Promise<void> {
  const live = await conversationsWithLiveSend(now - STALE_CLAIM_MS);
  for (const set of joinSets(rows)) {
    const first = set[0];
    const conv = first.conversation_id;
    if (conv?.startsWith("sysaudio_conv_")) continue;
    if (conv !== null && live.has(conv)) continue;
    if (!(await ready(set))) continue;
    const rowEnd = Math.max(...set.map((r) => r.transcript_end_at));
    const calendarJson =
      conv === null
        ? null
        : await snapshotJsonForSpan(conv, { start: first.transcript_start_at, end: rowEnd });
    await createSendAndLink(
      {
        id: first.id,
        conversationId: conv,
        spanStartAt: first.transcript_start_at,
        spanEndAt: rowEnd,
        createdAt: now,
        calendarJson,
      },
      set.map((r) => r.id),
    );
  }
}
