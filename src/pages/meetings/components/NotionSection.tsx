import { useCallback, useState } from "react";
import moment from "moment";
import { openUrl } from "@tauri-apps/plugin-opener";
import { Button } from "@/components";
import { notionBadgeFor, reasonFor } from "@/hooks/useNotionQueue";
import type { NotionItem } from "@/lib/database/notion-queue.action";
import { notionErrorText } from "@/lib/notion/errors";

export interface NotionSectionProps {
  items: readonly NotionItem[];
  onSendRows: (rowIds: string[]) => Promise<void>;
  onRetry: (sendId: string) => Promise<void>;
  onDontSend: (item: NotionItem) => Promise<void>;
}

const keyOf = (item: NotionItem) => (item.kind === "rows" ? `rows:${item.rowIds.join(",")}` : item.send.id);

/** Sent, already-there and stopped sends exist in `items` only for the row badge. */
const isListed = (item: NotionItem) =>
  item.kind === "rows" || !["sent", "already", "cancelled"].includes(item.send.status);

function heading(item: NotionItem): string {
  const [start, end] =
    item.kind === "rows" ? [item.startAt, item.endAt] : [item.send.span_start_at, item.send.span_end_at];
  return `${moment(start).format("ddd, MMM D")}, ${moment(start).format("hh:mm A")} - ${moment(end).format("hh:mm A")}`;
}

/** Notion sends that need a look or a decision. Hidden while there are none. */
export function NotionSection({ items, onSendRows, onRetry, onDontSend }: NotionSectionProps) {
  const [busy, setBusy] = useState<ReadonlySet<string>>(new Set());
  const [error, setError] = useState<string | null>(null);

  const run = useCallback(async (key: string, action: () => Promise<void>) => {
    setBusy((prev) => new Set(prev).add(key));
    setError(null);
    try {
      await action();
    } catch (err) {
      setError(notionErrorText(err).text);
    } finally {
      setBusy((prev) => {
        const next = new Set(prev);
        next.delete(key);
        return next;
      });
    }
  }, []);

  const listed = items.filter(isListed);
  if (listed.length === 0) return null;

  return (
    <section aria-label="Notion" className="flex flex-col gap-2">
      <h3 className="text-sm font-medium">Notion</h3>
      {error !== null && <p className="text-sm text-destructive">{error}</p>}
      <ul className="flex flex-col gap-2">
        {listed.map((item) => {
          const key = keyOf(item);
          const found = notionBadgeFor(item);
          const reason = reasonFor(item);
          const pending = busy.has(key);
          const url = found?.badge.url ?? null;
          const hasPage = item.kind === "send" && item.send.page_id !== null;
          const status = item.kind === "rows" ? item.status : item.send.status;
          return (
            <li key={key} data-notion-item={key} className="flex items-start justify-between gap-3 rounded-xl border p-3">
              <div className="flex flex-col gap-1">
                <span className="text-xs text-muted-foreground">{heading(item)}</span>
                <span className="text-sm">
                  {url !== null ? (
                    <a
                      href={url}
                      className="underline"
                      onClick={(e) => {
                        e.preventDefault();
                        void openUrl(url);
                      }}
                    >
                      {found?.badge.label}
                    </a>
                  ) : (
                    found?.badge.label
                  )}
                </span>
                {reason !== null && <span className="text-xs text-muted-foreground">{reason}</span>}
              </div>
              <div className="flex items-center gap-1">
                {item.kind === "rows" && status === "offered" && (
                  <Button size="sm" variant="outline" disabled={pending} onClick={() => void run(key, () => onSendRows(item.rowIds))}>
                    Send to Notion
                  </Button>
                )}
                {item.kind === "send" && (status === "failed" || status === "no_summary" || status === "retry") && (
                  <Button size="sm" variant="outline" disabled={pending} onClick={() => void run(key, () => onRetry(item.send.id))}>
                    Retry
                  </Button>
                )}
                {!hasPage && (item.kind === "send" ? status !== "sending" : status === "offered") && (
                  <Button size="sm" variant="ghost" disabled={pending} onClick={() => void run(key, () => onDontSend(item))}>
                    Don't send
                  </Button>
                )}
                {item.kind === "send" && status === "failed" && hasPage && (
                  <Button size="sm" variant="ghost" disabled={pending} onClick={() => void run(key, () => onDontSend(item))}>
                    Stop and keep page
                  </Button>
                )}
              </div>
            </li>
          );
        })}
      </ul>
    </section>
  );
}
