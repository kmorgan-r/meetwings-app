import { beforeEach, describe, expect, it, vi } from "vitest";

const mockExecute = vi.fn();
const mockSelect = vi.fn();

vi.mock("@/lib/database/config", () => ({
  getDatabase: vi.fn(async () => ({ execute: mockExecute, select: mockSelect })),
}));

vi.mock("@/lib", () => ({
  safeLocalStorage: {
    getItem: vi.fn(() => null),
    setItem: vi.fn(),
    removeItem: vi.fn(),
  },
}));

import { appendMessagesToConversation } from "@/lib/database/chat-history.action";

const MESSAGES = [
  { id: "msg-1", role: "user" as const, content: "one", timestamp: 1 },
  { id: "msg-2", role: "user" as const, content: "two", timestamp: 2 },
];

/**
 * The UPDATE runs first and always matches; only the per-message INSERT OR
 * IGNORE results decide whether anything was stored.
 */
function respondWithInsertedRows(rowsAffected: number) {
  mockExecute.mockImplementation(async (sql: string) =>
    String(sql).startsWith("UPDATE")
      ? { rowsAffected: 1, lastInsertId: 0 }
      : { rowsAffected, lastInsertId: 0 }
  );
}

beforeEach(() => {
  vi.clearAllMocks();
  mockSelect.mockResolvedValue([]);
});

describe("appendMessagesToConversation", () => {
  it("warns when INSERT OR IGNORE discarded every message", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    respondWithInsertedRows(0);

    await appendMessagesToConversation("conversation-1", "Standup", 5, MESSAGES);

    // Without this the call looks like a successful save that stored nothing,
    // which is how an entire meeting's transcript went missing while the
    // autosave logged success on every pass.
    expect(warn).toHaveBeenCalledWith(
      expect.stringContaining("wrote none of its 2 message(s)")
    );
  });

  it("stays quiet when the messages actually landed", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    respondWithInsertedRows(1);

    await appendMessagesToConversation("conversation-1", "Standup", 5, MESSAGES);

    expect(warn).not.toHaveBeenCalled();
  });

  it("stays quiet when there was nothing to append", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    respondWithInsertedRows(0);

    await appendMessagesToConversation("conversation-1", "Standup", 5, []);

    expect(warn).not.toHaveBeenCalled();
  });
});
