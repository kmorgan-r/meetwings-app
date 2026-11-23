import { emit } from "@tauri-apps/api/event";
import { MEETING_CONVERSATION_GAP_MS } from "@/config";
import { insertQueueRow, readConversationTranscript } from "@/lib/database/meeting-log.action";
import {
  cancelOfferedRows,
  cancelSend,
  lastSpokenLineAt,
  listConversationNotionRows,
  listWaitingRows,
  markRowsWaiting,
  offerRowsToWaiting,
  retrySend,
  type NotionItem,
} from "@/lib/database/notion-queue.action";
import { renderTranscript, segmentByGap } from "@/lib/odoo/meeting-log";
import { isConversationRecording } from "@/lib/storage/active-conversation.storage";
import { isNotionConfigured } from "@/lib/storage/notion-config.storage";
import { notionErrorText } from "./errors";
import { NOTION_KICK_EVENT } from "./events";
import { openSends } from "./join";

/** Only the overlay runs sends; every action writes the DB then kicks it. A failed kick only delays to the next 60 s tick. */
async function kick(): Promise<void> {
  try {
    await emit(NOTION_KICK_EVENT);
  } catch (err) {
    notionErrorText(err);
  }
}

export type SendConversationOutcome =
  | "queued" | "already" | "active" | "empty" | "not-configured" | "system-audio";

export async function sendConversationToNotion(
  conversationId: string,
  now: number,
): Promise<SendConversationOutcome> {
  if (conversationId.startsWith("sysaudio_conv_")) return "system-audio";
  if (isConversationRecording(conversationId)) return "active";
  if (!(await isNotionConfigured())) return "not-configured";

  const rows = await listConversationNotionRows(conversationId);
  // Waiting with no send: auto-Notion queued it, or a press's link failed. A press opens it now.
  const heal = rows.filter((r) => r.notion_status === "waiting" && r.notion_send_id === null);
  if (
    rows.some(
      (r) =>
        // An 'offered' row counts as lane-open in SQL but is exactly what this converts.
        (r.lane_open && r.notion_status !== "offered" && !heal.includes(r)) ||
        r.send_status === "sent" ||
        r.send_status === "already" ||
        (r.send_status === "cancelled" && r.send_page_id !== null),
    )
  ) {
    return "already";
  }

  const candidates = rows.filter(
    (r) =>
      r.status !== "cancelled" && r.status !== "deleted" &&
      (r.notion_status === null || r.notion_status === "offered"),
  );
  const pending = [...candidates, ...heal];
  if (
    pending.length > 0 &&
    candidates.every((r) => r.transcript.trim() !== "") &&
    !(await tailBeyond(conversationId, Math.max(...pending.map((r) => r.transcript_end_at))))
  ) {
    await markRowsWaiting(candidates.map((r) => r.id));
  } else {
    // No usable rows, some pruned blank, or saved lines past the rows: rebuild from the saved transcript.
    const superseded = [...candidates, ...heal]
      .filter((r) => r.notion_status === "offered" || r.notion_status === "waiting")
      .map((r) => r.id);
    const fromAt = pending.length > 0 ? Math.min(...pending.map((r) => r.transcript_start_at)) : 0;
    if (!(await insertFreshRows(conversationId, now, superseded, fromAt))) return "empty";
  }
  await openConversation(conversationId, now);
  await kick();
  return "queued";
}

/** True when saved spoken lines run past the end of the rows. */
async function tailBeyond(conversationId: string, rowsEnd: number): Promise<boolean> {
  return ((await lastSpokenLineAt(conversationId)) ?? 0) > rowsEnd;
}

/**
 * Writes fresh waiting rows from the saved transcript, keeping only segments that end at or after
 * `fromAt`. Cancels `supersede` BEFORE inserting: a failure between the two then leaves nothing
 * queued (a re-press rebuilds) instead of old and fresh rows overlapping and showing every line twice.
 */
async function insertFreshRows(
  conversationId: string,
  now: number,
  supersede: string[],
  fromAt: number,
): Promise<boolean> {
  const segments = segmentByGap(
    await readConversationTranscript(conversationId),
    MEETING_CONVERSATION_GAP_MS,
  ).filter((slice) => slice.endAt >= fromAt);
  if (segments.length === 0) return false;
  await cancelOfferedRows(supersede);
  for (const slice of segments) {
    await insertQueueRow({
      id: crypto.randomUUID(),
      sessionKey: `notion:${conversationId}:${slice.startAt}:${now}`,
      conversationId,
      instance: "",
      targets: [],
      transcript: renderTranscript(slice.entries),
      transcriptStartAt: slice.startAt,
      transcriptEndAt: slice.endAt,
      meetingStartedAt: slice.startAt,
      status: "none",
      notionStatus: "waiting",
      createdAt: now,
    });
  }
  return true;
}

async function openConversation(conversationId: string, now: number): Promise<void> {
  await openSends((await listWaitingRows()).filter((r) => r.conversation_id === conversationId), now);
}

/** A hand press opens the send now, with no quiet wait; a conversation still recording stays waiting. */
export async function sendRowsToNotion(
  rowIds: string[],
  conversationId: string | null,
  now: number = Date.now(),
): Promise<void> {
  await offerRowsToWaiting(rowIds);
  if (conversationId === null) {
    await openSends((await listWaitingRows()).filter((r) => rowIds.includes(r.id)), now);
  } else if (!conversationId.startsWith("sysaudio_conv_") && !isConversationRecording(conversationId)) {
    const waiting = (await listWaitingRows()).filter((r) => r.conversation_id === conversationId);
    // An empty list means a stale item; its max would be -Infinity and rebuild the whole conversation.
    if (waiting.length > 0) {
      if (await tailBeyond(conversationId, Math.max(...waiting.map((r) => r.transcript_end_at)))) {
        await insertFreshRows(
          conversationId,
          now,
          waiting.map((r) => r.id),
          Math.min(...waiting.map((r) => r.transcript_start_at)),
        );
      }
      await openConversation(conversationId, now);
    }
  }
  await kick();
}

export async function retryNotionSend(sendId: string): Promise<void> {
  await retrySend(sendId);
  await kick();
}

export async function dontSendToNotion(item: NotionItem): Promise<boolean> {
  const changed =
    item.kind === "rows" ? await cancelOfferedRows(item.rowIds) : await cancelSend(item.send.id);
  if (changed) await kick();
  return changed;
}
