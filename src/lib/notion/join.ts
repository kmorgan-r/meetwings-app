import { MEETING_CONVERSATION_GAP_MS } from "@/config";
import type { WaitingRow } from "@/lib/database/notion-queue.action";

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
