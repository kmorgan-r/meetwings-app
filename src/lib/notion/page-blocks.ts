import type { NotionBlockInput } from "./client";
import type { SubTable } from "./routing";
import type { NotionSummary } from "./summarize";

/**
 * Page content for a Notion meeting page (spec §3.3).
 *
 * Notion caps: 2,000 characters per rich-text item, at most 100 rich-text
 * items per block, at most 100 blocks per request, 500 KB per request body.
 * Splitting and batching here keeps every buildPageBlocks/transcriptBlocks
 * result inside those limits by construction.
 */

export interface RichTextItem {
  type: "text";
  text: { content: string };
  annotations?: { bold: boolean };
}

/**
 * Splits text into rich-text chunks of at most `max` UTF-16 units, never
 * cutting a surrogate pair in half (an emoji split returns as unreadable
 * bytes inside Notion). Empty text gives an empty list - Notion rejects a
 * rich_text array with an empty-string item.
 */
export function splitRichText(text: string, max = 2000): string[] {
  const out: string[] = [];
  const isHigh = (code: number) => code >= 0xd800 && code <= 0xdbff;
  const isLow = (code: number) => code >= 0xdc00 && code <= 0xdfff;

  let i = 0;
  while (i < text.length) {
    let end = Math.min(i + max, text.length);
    if (end < text.length) {
      const before = text.charCodeAt(end - 1);
      const after = text.charCodeAt(end);
      // A pair straddling the boundary: push the high surrogate to the next
      // chunk. `end === i` cannot happen for max >= 2, but the guard keeps a
      // nonsensical max from spinning the loop.
      if (end > i && isHigh(before) && isLow(after) && end > i + 1) end -= 1;
    }
    out.push(text.slice(i, end));
    i = end;
  }
  return out;
}

/**
 * The one rich-text builder every text field in this file goes through: the
 * 2,000-character cap per item, and an optional bold annotation.
 */
function richText(text: string, bold = false): RichTextItem[] {
  return splitRichText(text).map((content) => ({
    type: "text",
    text: { content },
    ...(bold ? { annotations: { bold: true } } : {}),
  }));
}

function block(type: string, payload: Record<string, unknown>): NotionBlockInput {
  return { object: "block", type, [type]: payload };
}

function bullet(text: string): NotionBlockInput {
  return block("bulleted_list_item", { rich_text: richText(text) });
}

function heading3(text: string): NotionBlockInput {
  return block("heading_3", { rich_text: richText(text) });
}

/**
 * Builds the page body, in spec §3.3's order: TOC, Agenda (with the section
 * headings as bullets), divider, Meeting Notes (bold title, then the Team
 * Practices callout), Action Items to-dos, a divider, every section replayed,
 * a divider, and the empty Transcript toggle last. "Agenda" and "Action
 * Items" are always present, even when their lists are empty; only the
 * callout is conditional - a page without practices has nothing to flag.
 */
export function buildPageBlocks(s: NotionSummary): NotionBlockInput[] {
  const blocks: NotionBlockInput[] = [];
  const add = (type: string, payload: Record<string, unknown>) =>
    blocks.push(block(type, payload));

  add("table_of_contents", {});
  add("heading_2", { rich_text: richText("Agenda") });
  for (const section of s.sections) blocks.push(bullet(section.heading));
  add("divider", {});
  add("heading_2", { rich_text: richText("Meeting Notes") });
  add("paragraph", { rich_text: richText(s.title, true) });

  if (s.practices.length > 0) {
    add("callout", {
      rich_text: richText("Team Practices", true),
      icon: { type: "emoji", emoji: "📌" },
      color: "yellow_background",
      children: s.practices.map((practice) => bullet(practice.rule)),
    });
  }

  add("heading_3", { rich_text: richText("Action Items") });
  for (const item of s.actionItems) {
    add("to_do", { rich_text: richText(item), checked: false });
  }

  add("divider", {});
  for (const section of s.sections) {
    blocks.push(heading3(section.heading));
    for (const bulletText of section.bullets) blocks.push(bullet(bulletText));
  }
  add("divider", {});
  add("toggle", { rich_text: richText("Transcript") });

  return blocks;
}

/**
 * The transcript as paragraphs, one per spoken line (empty or whitespace-only
 * lines are skipped), each leading "You: " replaced by the user's Notion
 * name. A line needing more than 100 rich-text items (over 200,000 chars)
 * continues in another paragraph - Notion takes at most 100 items per block,
 * and the carry-over must remain in the toggle, not vanish.
 */
export function transcriptBlocks(lines: string[], youName: string): NotionBlockInput[] {
  const out: NotionBlockInput[] = [];
  for (const line of lines) {
    if (line.trim() === "") continue;
    const text = line.startsWith("You: ") ? `${youName}: ${line.slice("You: ".length)}` : line;
    const items = richText(text);
    for (let at = 0; at < items.length; at += 100) {
      out.push(block("paragraph", { rich_text: items.slice(at, at + 100) }));
    }
  }
  return out;
}

/**
 * Splits blocks into request-sized batches: at most 100 blocks, and at most
 * maxBytes of JSON each, measured the way Notion measures. A single block
 * over maxBytes still goes through, alone in a batch of its own - the 2,000
 * character items keep even a huge transcript line far under Notion's hard
 * 500 KB limit, so dropping or splitting it would corrupt the page.
 */
export function batchBlocks(
  blocks: NotionBlockInput[],
  maxBlocks = 100,
  maxBytes = 400_000,
): NotionBlockInput[][] {
  const batches: NotionBlockInput[][] = [];
  let current: NotionBlockInput[] = [];
  let currentBytes = 0;

  for (const blockInput of blocks) {
    const size = new TextEncoder().encode(JSON.stringify(blockInput)).length;
    if (
      current.length > 0 &&
      (current.length + 1 > maxBlocks || currentBytes + size > maxBytes)
    ) {
      batches.push(current);
      current = [];
      currentBytes = 0;
    }
    current.push(blockInput);
    currentBytes += size;
  }
  if (current.length > 0) batches.push(current);

  return batches;
}

/**
 * The page's properties: the title under the data source's title column, the
 * meeting's datetime range, and - only when the data source has a "Recorded
 * by" people column AND the integration's owner is known - who sent the page.
 */
export function pageProperties(
  r: { subTable: SubTable; title: string },
  startAt: number,
  endAt: number,
  ownerUserId: string | null,
): Record<string, unknown> {
  const properties: Record<string, unknown> = {
    [r.subTable.titleProp]: { title: richText(r.title) },
    [r.subTable.dateProp]: {
      date: {
        start: new Date(startAt).toISOString(),
        end: new Date(endAt).toISOString(),
      },
    },
  };
  if (r.subTable.recordedByProp !== null && ownerUserId !== null) {
    properties[r.subTable.recordedByProp] = { people: [{ id: ownerUserId }] };
  }
  return properties;
}
