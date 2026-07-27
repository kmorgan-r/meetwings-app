import { beforeEach, describe, expect, it, vi } from "vitest";

const mockExecute = vi.fn();
const mockSelect = vi.fn();

vi.mock("@/lib/database/config", () => ({
  getDatabase: vi.fn(async () => ({
    execute: mockExecute,
    select: mockSelect,
  })),
}));

vi.mock("@/lib", () => ({
  safeLocalStorage: {
    getItem: vi.fn(() => null),
    setItem: vi.fn(),
    removeItem: vi.fn(),
  },
}));

import {
  createConversation,
  saveConversation,
} from "@/lib/database/chat-history.action";
import { ChatConversation } from "@/types";

const CONVERSATION: ChatConversation = {
  id: "conversation-1",
  title: "Existing title",
  createdAt: 1000,
  updatedAt: 2000,
  messages: [
    { id: "msg-1", role: "user", content: "hello", timestamp: 1000 },
    { id: "msg-2", role: "assistant", content: "hi", timestamp: 1001 },
  ],
};

/** SQL statements passed to db.execute, whitespace-normalized. */
function executedSql(): string[] {
  return mockExecute.mock.calls.map((call) =>
    String(call[0]).replace(/\s+/g, " ").trim()
  );
}

function deleteConversationCalls(): unknown[][] {
  return mockExecute.mock.calls.filter((call) =>
    /^DELETE FROM conversations/i.test(String(call[0]).trim())
  );
}

beforeEach(() => {
  vi.clearAllMocks();
  mockExecute.mockResolvedValue({ rowsAffected: 1, lastInsertId: 0 });
  mockSelect.mockResolvedValue([]);
});

describe("createConversation rollback", () => {
  it("does not delete the conversation when the conversation INSERT itself fails", async () => {
    // A pre-existing row with the same id: the INSERT hits the primary key.
    mockExecute.mockImplementation(async (sql: string) => {
      if (/INSERT INTO conversations/i.test(sql)) {
        throw new Error("UNIQUE constraint failed: conversations.id");
      }
      return { rowsAffected: 1, lastInsertId: 0 };
    });

    await expect(createConversation(CONVERSATION)).rejects.toThrow(
      /UNIQUE constraint failed/
    );

    // The row belongs to a real conversation this call never created, and
    // messages cascade on delete.
    expect(deleteConversationCalls()).toHaveLength(0);
  });

  it("still deletes the conversation it inserted when a message INSERT fails", async () => {
    mockExecute.mockImplementation(async (sql: string) => {
      if (/INSERT INTO messages/i.test(sql)) {
        throw new Error("disk I/O error");
      }
      return { rowsAffected: 1, lastInsertId: 0 };
    });

    await expect(createConversation(CONVERSATION)).rejects.toThrow(
      /disk I\/O error/
    );

    const deletes = deleteConversationCalls();
    expect(deletes).toHaveLength(1);
    expect(deletes[0][1]).toEqual(["conversation-1"]);
  });
});

describe("saveConversation routing", () => {
  it("propagates a failed existence read instead of treating it as absent", async () => {
    mockSelect.mockRejectedValue(new Error("database is locked"));

    await expect(saveConversation(CONVERSATION)).rejects.toThrow(
      /database is locked/
    );

    // No create attempt, so no rollback delete can fire.
    expect(executedSql()).toHaveLength(0);
  });

  it("updates when the conversation already exists", async () => {
    mockSelect.mockResolvedValue([{ id: "conversation-1" }]);

    await saveConversation(CONVERSATION);

    expect(executedSql()).toContainEqual(
      expect.stringMatching(/^UPDATE conversations/i)
    );
    expect(executedSql()).not.toContainEqual(
      expect.stringMatching(/^INSERT INTO conversations/i)
    );
  });

  it("creates when the conversation does not exist", async () => {
    mockSelect.mockResolvedValue([]);

    await saveConversation(CONVERSATION);

    expect(executedSql()).toContainEqual(
      expect.stringMatching(/^INSERT INTO conversations/i)
    );
  });
});
