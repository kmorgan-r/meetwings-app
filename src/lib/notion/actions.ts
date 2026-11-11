import { emit } from "@tauri-apps/api/event";
import { MEETING_CONVERSATION_GAP_MS } from "@/config";
import { insertQueueRow, readConversationTranscript } from "@/lib/database/meeting-log.action";
import {
  cancelOfferedRows,
  cancelSend,
  listConversationNotionRows,
  markRowsWaiting,
  offerRowsToWaiting,
  retrySend,
  type NotionItem,
} from "@/lib/database/notion-queue.action";
import { renderTranscript, segmentByGap } from "@/lib/odoo/meeting-log";
import {
  getActiveConversationId,
  getCapturingConversationId,
} from "@/lib/storage/active-conversation.storage";
import { isNotionConfigured } from "@/lib/storage/notion-config.storage";
import { notionErrorText } from "./errors";
import { NOTION_KICK_EVENT } from "./scheduler";

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
  if (conversationId === getActiveConversationId() || conversationId === getCapturingConversationId()) {
    return "active";
  }
  if (!(await isNotionConfigured())) return "not-configured";

  const rows = await listConversationNotionRows(conversationId);
  if (
    rows.some(
      (r) =>
        // An 'offered' row counts as lane-open in SQL but is exactly what this converts.
        (r.lane_open && r.notion_status !== "offered") ||
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
  if (candidates.length > 0 && candidates.every((r) => r.transcript.trim() !== "")) {
    await markRowsWaiting(candidates.map((r) => r.id));
    await kick();
    return "queued";
  }

  // No usable rows, or some were pruned blank: write fresh ones from the saved transcript.
  const segments = segmentByGap(
    await readConversationTranscript(conversationId),
    MEETING_CONVERSATION_GAP_MS,
  );
  if (segments.length === 0) return "empty";
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
  await kick();
  return "queued";
}

export async function sendRowsToNotion(rowIds: string[]): Promise<void> {
  await offerRowsToWaiting(rowIds);
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
