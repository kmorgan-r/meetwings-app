import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { listen } from "@tauri-apps/api/event";
import { listNotionItems, type NotionItem } from "@/lib/database/notion-queue.action";
import {
  dontSendToNotion,
  retryNotionSend,
  sendConversationToNotion,
  sendRowsToNotion,
} from "@/lib/notion/actions";
import { NOTION_COPY, notionErrorText } from "@/lib/notion/errors";
import { isNotionConfigured, NOTION_CONFIG_CHANGED_EVENT } from "@/lib/storage/notion-config.storage";

export interface NotionBadge {
  label: string;
  url: string | null;
  tone: "attention" | "waiting" | "done";
}

const badge = (label: string, tone: NotionBadge["tone"], url: string | null = null): NotionBadge => ({
  label,
  url,
  tone,
});

/**
 * The badge table, in rank order: an item takes the FIRST matcher it satisfies
 * and that matcher's position is its rank (0 is the worst). A conversation shows
 * its lowest-ranked item, so a stopped send's "In Notion" (last) can never hide
 * a later send's problem.
 */
const RANKED: ReadonlyArray<(item: NotionItem) => NotionBadge | null> = [
  (i) => (i.kind === "send" && i.send.status === "failed" ? badge("Notion failed", "attention", i.send.page_url) : null),
  (i) => (i.kind === "send" && i.send.status === "no_summary" ? badge("Couldn't summarise", "attention") : null),
  (i) =>
    i.kind === "send" &&
    (i.send.status === "retry" || i.send.status === "sending") &&
    (i.send.error_code?.startsWith("SUMMARY_") ?? false)
      ? badge("Waiting for summary", "waiting")
      : null,
  // A stopped send keeps its page and is "In Notion", whatever the practices said.
  (i) =>
    i.kind === "send" &&
    i.send.status !== "cancelled" &&
    i.send.page_id !== null &&
    i.send.practices_done === 0 &&
    i.send.practices_error_code !== null
      ? badge("Practices not added yet", "waiting", i.send.page_url)
      : null,
  (i) =>
    i.kind === "send" && (i.send.status === "retry" || i.send.status === "sending")
      ? badge("Sending to Notion", "waiting", i.send.page_url)
      : null,
  (i) => (i.kind === "rows" && i.status === "offered" ? badge("Send to Notion", "waiting") : null),
  (i) =>
    i.kind === "rows" && (i.status === "held" || i.status === "waiting")
      ? badge("Waiting for the meeting to end", "waiting")
      : null,
  (i) => (i.kind === "send" && i.send.status === "already" ? badge("Already in Notion", "done", i.send.lost_to_url) : null),
  (i) => (i.kind === "send" && i.send.status === "sent" ? badge("In Notion", "done", i.send.page_url) : null),
  (i) =>
    i.kind === "send" && i.send.status === "cancelled" && i.send.page_id !== null
      ? badge("In Notion", "done", i.send.page_url)
      : null,
];

/** The first table row the item matches, with its rank, or null for none. */
export function notionBadgeFor(item: NotionItem): { rank: number; badge: NotionBadge } | null {
  for (let rank = 0; rank < RANKED.length; rank++) {
    const b = RANKED[rank](item);
    if (b) return { rank, badge: b };
  }
  return null;
}

export function conversationIdOf(item: NotionItem): string | null {
  return item.kind === "rows" ? item.conversationId : item.send.conversation_id;
}

/** One badge per conversation, the worst-ranked of its items. */
export function buildBadgeMap(items: readonly NotionItem[]): Map<string, NotionBadge> {
  const best = new Map<string, { rank: number; badge: NotionBadge }>();
  for (const item of items) {
    const id = conversationIdOf(item);
    if (id === null) continue;
    const found = notionBadgeFor(item);
    if (!found) continue;
    const prev = best.get(id);
    if (!prev || found.rank < prev.rank) best.set(id, found);
  }
  return new Map([...best].map(([id, { badge: b }]) => [id, b]));
}

/** The reason line for an item, or null. Always fixed copy, never a raw code or text. */
export function reasonFor(item: NotionItem): string | null {
  if (item.kind !== "send") return null;
  const { status, error_code, practices_error_code } = item.send;
  const code =
    status === "failed" || status === "no_summary"
      ? error_code
      : notionBadgeFor(item)?.badge.label === "Practices not added yet"
        ? practices_error_code
        : null;
  if (code === null) return null;
  return (NOTION_COPY as Record<string, string>)[code] ?? NOTION_COPY.NOTION_INTERNAL;
}

const SEND_OUTCOME_MESSAGE = {
  queued: null,
  already: "This meeting is already in Notion or on its way.",
  active: "This conversation is still going. Send it once it ends.",
  empty: "This conversation has no transcript to send.",
  "not-configured": NOTION_COPY.NOTION_NOT_CONFIGURED,
  "system-audio": "System audio conversations can't be sent to Notion.",
} as const;

/**
 * The dashboard's view of the Notion queue. Independent of Odoo config. Every
 * action only writes the DB and kicks the overlay (through `@/lib/notion/actions`);
 * the dashboard never runs a send. Actions await, then re-read, and let a
 * rejection reach the caller, except `onSendConversation`, which reports it as
 * the row's message.
 */
export function useNotionQueue() {
  const [configured, setConfigured] = useState(false);
  const [items, setItems] = useState<NotionItem[]>([]);
  // Only the latest read may set state.
  const token = useRef(0);

  const reload = useCallback(async (): Promise<void> => {
    const id = ++token.current;
    // Independent reads: one failing keeps the other's fresh value.
    const [isConfigured, list] = await Promise.all([
      isNotionConfigured().then(
        (v) => v,
        (err: unknown) => {
          notionErrorText(err);
          return null;
        },
      ),
      listNotionItems().then(
        (v) => v,
        (err: unknown) => {
          notionErrorText(err);
          return null;
        },
      ),
    ]);
    if (id !== token.current) return;
    if (isConfigured !== null) setConfigured(isConfigured);
    if (list !== null) setItems(list);
  }, []);

  useEffect(() => {
    let cancelled = false;
    const run = () => {
      if (!cancelled) void reload();
    };
    run();
    window.addEventListener("focus", run);
    let unlisten: (() => void) | undefined;
    listen(NOTION_CONFIG_CHANGED_EVENT, run).then(
      (fn) => {
        if (cancelled) fn();
        else unlisten = fn;
      },
      (err: unknown) => {
        notionErrorText(err);
      },
    );
    return () => {
      cancelled = true;
      window.removeEventListener("focus", run);
      unlisten?.();
    };
  }, [reload]);

  const byConversation = useMemo(() => buildBadgeMap(items), [items]);

  const onSendRows = useCallback(
    async (rowIds: string[]) => {
      await sendRowsToNotion(rowIds);
      await reload();
    },
    [reload],
  );
  const onRetry = useCallback(
    async (sendId: string) => {
      await retryNotionSend(sendId);
      await reload();
    },
    [reload],
  );
  const onDontSend = useCallback(
    async (item: NotionItem) => {
      // `false`: the item already moved on, so the re-read is the whole answer.
      await dontSendToNotion(item);
      await reload();
    },
    [reload],
  );
  const onSendConversation = useCallback(
    async (id: string): Promise<string | null> => {
      try {
        const outcome = await sendConversationToNotion(id, Date.now());
        await reload();
        return SEND_OUTCOME_MESSAGE[outcome];
      } catch (err) {
        return notionErrorText(err).text;
      }
    },
    [reload],
  );

  return { configured, items, byConversation, reload, onSendRows, onRetry, onDontSend, onSendConversation };
}
