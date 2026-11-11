import { describe, expect, it, vi } from "vitest";
import type { NotionBlock, NotionBlockInput, NotionClient } from "@/lib/notion/client";
import { NotionError } from "@/lib/notion/errors";
import { appendResumable, blockPlainText } from "@/lib/notion/append";

// Fake ids only - never a real Notion id or token.
let fakeCounter = 0;

/** An input block (what the page builder produces). */
function paraInput(text: string): NotionBlockInput {
  return {
    object: "block",
    type: "paragraph",
    paragraph: { rich_text: [{ type: "text", text: { content: text } }] },
  };
}

function dividerInput(): NotionBlockInput {
  return { object: "block", type: "divider", divider: {} };
}

/** An existing block as Notion returns it (plain_text, an id). */
function paraBlock(text: string): NotionBlock {
  fakeCounter += 1;
  return {
    id: `fake-block-${fakeCounter}`,
    type: "paragraph",
    paragraph: { rich_text: [{ plain_text: text }] },
  };
}

function dividerBlock(): NotionBlock {
  fakeCounter += 1;
  return { id: `fake-block-${fakeCounter}`, type: "divider", divider: {} };
}

function inputText(block: NotionBlockInput): string {
  const payload = block[block.type] as { rich_text?: { text?: { content?: string } }[] };
  return (payload.rich_text ?? []).map((item) => item.text?.content ?? "").join("");
}

interface FakeState {
  children: NotionBlock[];
  callLog: string[];
  appendCalls: { blockId: string; batch: NotionBlockInput[] }[];
  appendCount: number;
}

/**
 * A fake NotionClient that records every append call and keeps the children
 * list it mutated. failFromAppend > 0 makes call N of appendChildren throw.
 */
function fakeClient(
  initial: NotionBlock[],
  failFromAppend = Number.POSITIVE_INFINITY,
): { client: NotionClient; state: FakeState } {
  const state: FakeState = {
    children: [...initial],
    callLog: [],
    appendCalls: [],
    appendCount: 0,
  };
  const client = {
    listChildren: vi.fn(async (_blockId: string) => [...state.children]),
    appendChildren: vi.fn(async (blockId: string, batch: NotionBlockInput[]) => {
      state.appendCount += 1;
      state.appendCalls.push({ blockId, batch });
      state.callLog.push(`append:${batch.length}`);
      if (state.appendCount >= failFromAppend) {
        throw new NotionError("NOTION_SERVER");
      }
      const created: NotionBlock[] = batch.map((block) => {
        fakeCounter += 1;
        return { id: `fake-block-${fakeCounter}`, type: block.type, ...block } as NotionBlock;
      });
      state.children.push(...created);
      return created;
    }),
  };
  return { client: client as unknown as NotionClient, state };
}

function onBatchOf(state: FakeState): () => Promise<void> {
  return async () => {
    state.callLog.push("onBatch");
  };
}

const PARENT = "fake-page-1";

/** 250 one-line paragraphs → [100, 100, 50] batches under the default caps. */
const ALL_BLOCKS = Array.from({ length: 250 }, (_, i) => paraInput(`line-${i + 1}`));

describe("appendResumable", () => {
  it("appends everything to an empty parent, one batch after another, onBatch after each", async () => {
    const { client, state } = fakeClient([]);
    const result = await appendResumable(client, PARENT, ALL_BLOCKS, onBatchOf(state));

    expect(state.callLog).toEqual([
      "append:100", "onBatch", "append:100", "onBatch", "append:50", "onBatch",
    ]);
    expect(state.appendCalls).toHaveLength(3);
    for (const call of state.appendCalls) expect(call.blockId).toBe(PARENT);
    expect(state.appendCalls[0].batch.map(inputText)).toEqual(
      ALL_BLOCKS.slice(0, 100).map(inputText),
    );
    expect(state.appendCalls[2].batch.map(inputText)).toEqual(
      ALL_BLOCKS.slice(200).map(inputText),
    );
    expect(state.children).toHaveLength(250);
    expect(result).toEqual(state.children);
  });

  it("a failure at batch 3 left the first 200; resuming appends only the last 50, no duplicate lines", async () => {
    const failing = fakeClient([], 3);
    const onBatch = vi.fn(async () => undefined);
    await expect(
      appendResumable(failing.client, PARENT, ALL_BLOCKS, onBatch),
    ).rejects.toBeInstanceOf(NotionError);
    expect(onBatch).toHaveBeenCalledTimes(2);
    expect(failing.state.children).toHaveLength(200);

    // The claim re-stamp (onBatch) has run for the first two batches, so the
    // page now holds exactly the first 200 lines.
    const { client, state } = fakeClient(failing.state.children);
    const result = await appendResumable(client, PARENT, ALL_BLOCKS, onBatchOf(state));

    expect(state.appendCount).toBe(1);
    expect(state.appendCalls[0].batch.map(inputText)).toEqual(
      ALL_BLOCKS.slice(200).map(inputText),
    );
    expect(state.callLog).toEqual(["append:50", "onBatch"]);
    expect(result).toHaveLength(250);
    const texts = result.map(blockPlainText);
    expect(new Set(texts).size).toBe(250);
    expect(texts).toEqual(ALL_BLOCKS.map(inputText));
  });

  it("a batch whose response was lost (all children already exist) is not appended twice", async () => {
    const existing: NotionBlock[] = ALL_BLOCKS.map((block) => paraBlock(inputText(block)));
    const { client, state } = fakeClient(existing);
    const result = await appendResumable(client, PARENT, ALL_BLOCKS, onBatchOf(state));

    expect(state.appendCount).toBe(0);
    expect(state.callLog).toEqual([]);
    expect(result).toEqual(existing);
    expect(result).toHaveLength(250);
  });

  it("dividers are compared by type alone: an existing divider matches a fresh divider", async () => {
    const blocks = [paraInput("line-1"), dividerInput()];
    const { client, state } = fakeClient([paraBlock("line-1"), dividerBlock()]);
    const result = await appendResumable(client, PARENT, blocks, onBatchOf(state));

    expect(state.appendCount).toBe(0);
    expect(result).toHaveLength(2);
  });

  it("a last child that doesn't match → NOTION_PAGE_CHANGED, nothing appended", async () => {
    const existing: NotionBlock[] = ALL_BLOCKS.map((block) => paraBlock(inputText(block)));
    existing[existing.length - 1] = paraBlock("changed by a teammate");
    const { client, state } = fakeClient(existing);
    const outcome = await appendResumable(client, PARENT, ALL_BLOCKS, onBatchOf(state))
      .then(() => null, (thrown: unknown) => thrown);
    expect(outcome).toBeInstanceOf(NotionError);
    expect((outcome as NotionError).code).toBe("NOTION_PAGE_CHANGED");
    expect(state.appendCount).toBe(0);
  });

  it("more children than blocks to write → NOTION_PAGE_CHANGED, nothing appended", async () => {
    const longer = [...ALL_BLOCKS.map((b) => paraBlock(inputText(b))), paraBlock("a later line")];
    const { client, state } = fakeClient(longer);
    await expect(appendResumable(client, PARENT, ALL_BLOCKS, onBatchOf(state))).rejects.toMatchObject({
      code: "NOTION_PAGE_CHANGED",
    });
    expect(state.appendCount).toBe(0);
  });
});

describe("blockPlainText", () => {
  it("prefers plain_text and falls back to text.content; no rich_text → \"\"", () => {
    expect(
      blockPlainText({
        type: "paragraph",
        paragraph: { rich_text: [{ plain_text: "from plain" }] },
      }),
    ).toBe("from plain");
    expect(
      blockPlainText({
        type: "paragraph",
        paragraph: { rich_text: [{ text: { content: "from content" } }] },
      }),
    ).toBe("from content");
    expect(blockPlainText({ type: "paragraph", paragraph: { rich_text: [] } })).toBe("");
    expect(
      blockPlainText({ type: "divider", divider: {} } as unknown as NotionBlock),
    ).toBe("");
    // Both items join in order across the two shapes the inputs and responses use.
    expect(
      blockPlainText({
        type: "paragraph",
        paragraph: {
          rich_text: [{ plain_text: "a" }, { text: { content: "b" } }] as never,
        },
      }),
    ).toBe("ab");
  });
});
