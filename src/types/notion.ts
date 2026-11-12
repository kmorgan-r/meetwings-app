/** Notion lane of a queued meeting row (`meeting_log_queue.notion_status`). NULL = not Notion-bound. */
export type NotionRowStatus = "held" | "offered" | "waiting" | "joined" | "cancelled";

/** State of a `notion_sends` record. */
export type NotionSendStatus =
  | "retry"
  | "sending"
  | "failed"
  | "no_summary"
  | "sent"
  | "already"
  | "cancelled";

/** The snake_case shape SQLite returns for a `notion_sends` row. */
export interface DbNotionSend {
  id: string;
  conversation_id: string | null;
  status: NotionSendStatus;
  span_start_at: number;
  span_end_at: number;
  attempts: number;
  summary_failures: number;
  claimed_at: number | null;
  next_at: number | null;
  error_code: string | null;
  practices_error_code: string | null;
  summary_json: string | null;
  create_started_at: number | null;
  page_id: string | null;
  page_url: string | null;
  page_created_time: string | null;
  lost_to_url: string | null;
  body_done: number;
  toggle_block_id: string | null;
  transcript_done: number;
  practices_done: number;
  created_at: number;
  sent_at: number | null;
}
