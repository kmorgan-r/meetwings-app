import { parseSnapshot, type CalendarSnapshot } from "@/lib/calendar/calendar-snapshot";
import { getDatabase } from "./config";

/**
 * One calendar snapshot per conversation. There is deliberately no foreign
 * key: deleteConversation / deleteAllConversations remove the row explicitly.
 * NO `BEGIN` / `COMMIT` here (see the top of notion-queue.action.ts).
 */
export const CALENDAR_SNAPSHOT_SQL = {
  upsert: `
INSERT INTO calendar_snapshots (conversation_id, snapshot_json, updated_at)
VALUES (?, ?, ?)
ON CONFLICT(conversation_id) DO UPDATE SET
  snapshot_json = excluded.snapshot_json,
  updated_at = excluded.updated_at`,
  byConversation: "SELECT snapshot_json FROM calendar_snapshots WHERE conversation_id = ?",
  deleteOne: "DELETE FROM calendar_snapshots WHERE conversation_id = ?",
  deleteAll: "DELETE FROM calendar_snapshots",
} as const;

export async function saveCalendarSnapshot(
  conversationId: string,
  snapshot: CalendarSnapshot,
  now: number
): Promise<void> {
  const db = await getDatabase();
  await db.execute(CALENDAR_SNAPSHOT_SQL.upsert, [
    conversationId,
    JSON.stringify(snapshot),
    now,
  ]);
}

export async function deleteCalendarSnapshot(conversationId: string): Promise<void> {
  const db = await getDatabase();
  await db.execute(CALENDAR_SNAPSHOT_SQL.deleteOne, [conversationId]);
}

/** A missing or corrupt row reads as null; parseSnapshot never throws. */
export async function getCalendarSnapshot(
  conversationId: string
): Promise<CalendarSnapshot | null> {
  const db = await getDatabase();
  const found = await db.select<{ snapshot_json: string }[]>(
    CALENDAR_SNAPSHOT_SQL.byConversation,
    [conversationId]
  );
  return parseSnapshot(found[0]?.snapshot_json ?? null);
}
