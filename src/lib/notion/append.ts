import { NotionError } from "./errors";
import type { NotionBlock, NotionBlockInput, NotionClient } from "./client";
import { batchBlocks } from "./page-blocks";

/**
 * The plain text of a block: the concatenated rich-text items under
 * block[block.type], taking `plain_text` when Notion returned it and
 * `text.content` when the block is one of our inputs. Blocks without
 * rich_text (dividers, callout-free shapes) give "", so they compare by type
 * alone. One helper for both NotionBlock responses and NotionBlockInput
 * requests, so append comparison and same-meeting reading see identical text.
 */
export function blockPlainText(block: { type?: string; [key: string]: unknown }): string {
  const payload = block.type === undefined ? undefined : block[block.type];
  const richText = (payload as { rich_text?: unknown } | undefined)?.rich_text;
  if (!Array.isArray(richText)) return "";
  let out = "";
  for (const item of richText as { plain_text?: string; text?: { content?: string } }[]) {
    out += item.plain_text ?? item.text?.content ?? "";
  }
  return out;
}

/**
 * Appends blocks to a page resumably, and returns the page's children after.
 *
 * The failure it survives: an earlier attempt appended a batch whose response
 * was lost (crash, network) before the send could record progress. Resuming
 * reads the page, finds the blocks already there, and writes only what is
 * missing - so a batch is never written twice, and no transcript line lands
 * duplicated.
 *
 * - The page is changed (more children than these blocks, or a mismatching
 *   last child) → NOTION_PAGE_CHANGED before any append; the retry flow asks
 *   the user what to do, it never guesses what to keep.
 * - Batches go strictly one after another: append, then onBatch() (the send's
 *   claim re-stamp showing progress), then the next append.
 */
export async function appendResumable(
  client: NotionClient,
  parentId: string,
  blocks: NotionBlockInput[],
  onBatch: () => Promise<void>,
): Promise<NotionBlock[]> {
  const existing = await client.listChildren(parentId);
  if (existing.length > blocks.length) {
    throw new NotionError("NOTION_PAGE_CHANGED");
  }
  if (existing.length > 0) {
    const lastExisting = existing[existing.length - 1];
    const expected = blocks[existing.length - 1];
    // Type plus plain text: a divider matches a divider, a differing line
    // means someone has been editing the page mid-send.
    if (
      lastExisting.type !== expected.type ||
      blockPlainText(lastExisting) !== blockPlainText(expected)
    ) {
      throw new NotionError("NOTION_PAGE_CHANGED");
    }
  }

  const all: NotionBlock[] = [...existing];
  for (const batch of batchBlocks(blocks.slice(existing.length))) {
    const appended = await client.appendChildren(parentId, batch);
    all.push(...appended);
    await onBatch();
  }
  return all;
}
