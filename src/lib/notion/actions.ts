import { emit } from "@tauri-apps/api/event";
import { MEETING_CONVERSATION_GAP_MS } from "@/config";
import { insertQueueRow, readConversationTranscript } from "@/lib/database/meeting-log.action";
import {
  cancelOfferedRows,
  cancelSend,
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
  const saved = segmentByGap(await readConversationTranscript(conversationId), MEETING_CONVERSATION_GAP_MS);
  const own = pending.length > 0 ? ownMeetings(saved, pending) : saved;
  if (
    pending.length > 0 &&
    candidates.every((r) => r.transcript.trim() !== "") &&
    !hasTail(own, pending)
  ) {
    await markRowsWaiting(candidates.map((r) => r.id));
  } else {
    // No usable rows, some pruned blank, or saved lines past the rows: rebuild from the saved transcript.
    const superseded = pending
      .filter((r) => r.notion_status === "offered" || r.notion_status === "waiting")
      .map((r) => r.id);
    if (!(await insertFreshRows(conversationId, now, superseded, own))) return "empty";
  }
  await openConversation(conversationId, now);
  await kick();
  return "queued";
}

type Span = { transcript_start_at: number; transcript_end_at: number };
type Meeting = ReturnType<typeof segmentByGap>[number];

/** The saved meetings overlapping the rows' span: a later meeting of the same conversation is not theirs. */
function ownMeetings(saved: Meeting[], rows: Span[]): Meeting[] {
  const start = Math.min(...rows.map((r) => r.transcript_start_at));
  const end = Math.max(...rows.map((r) => r.transcript_end_at));
  return saved.filter((s) => s.endAt >= start && s.startAt <= end);
}

/** True when the rows' own meeting has saved spoken lines past the end of the rows. */
function hasTail(own: Meeting[], rows: Span[]): boolean {
  const end = Math.max(...rows.map((r) => r.transcript_end_at));
  return own.some((s) => s.endAt > end);
}

/**
 * Writes fresh waiting rows for `segments`, false (and cancels nothing) when there are none. Cancels
 * `supersede` BEFORE inserting: a failure between the two then leaves nothing queued (a re-press
 * rebuilds) instead of old and fresh rows overlapping and showing every line twice.
 */
async function insertFreshRows(
  conversationId: string,
  now: number,
  supersede: string[],
  segments: Meeting[],
): Promise<boolean> {
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
    // An empty list means a stale item: nothing to judge, and an empty span would rebuild everything.
    if (waiting.length > 0) {
      const own = ownMeetings(
        segmentByGap(await readConversationTranscript(conversationId), MEETING_CONVERSATION_GAP_MS),
        waiting,
      );
      if (hasTail(own, waiting)) {
        await insertFreshRows(conversationId, now, waiting.map((r) => r.id), own);
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
