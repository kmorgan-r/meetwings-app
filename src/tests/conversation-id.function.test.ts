import { beforeEach, describe, expect, it, vi } from "vitest";
import type { MutableRefObject } from "react";
import { ensureConversationId } from "@/lib/functions/conversation-id.function";

vi.mock("@/lib/chat-constants", () => ({
  generateConversationId: vi.fn(() => "chat-minted-1"),
}));

const refOf = (v: string | null): MutableRefObject<string | null> => ({ current: v });

describe("ensureConversationId", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("mints and assigns when the ref is empty", () => {
    const ref = refOf(null);
    expect(ensureConversationId(ref)).toBe("chat-minted-1");
    expect(ref.current).toBe("chat-minted-1");
  });

  it("reuses the ref's id and does not mint again", async () => {
    const { generateConversationId } = await import("@/lib/chat-constants");
    const ref = refOf("chat-existing-9");
    expect(ensureConversationId(ref)).toBe("chat-existing-9");
    expect(ref.current).toBe("chat-existing-9");
    expect(generateConversationId).not.toHaveBeenCalled();
  });

  it("reads and writes in one synchronous step, so two calls agree", () => {
    const ref = refOf(null);
    const first = ensureConversationId(ref);
    const second = ensureConversationId(ref);
    expect(second).toBe(first);
  });
});
