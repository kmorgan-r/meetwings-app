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

import { updateConversationTitle } from "@/lib/database/chat-history.action";

beforeEach(() => {
  vi.clearAllMocks();
  mockExecute.mockResolvedValue({ rowsAffected: 1, lastInsertId: 0 });
  mockSelect.mockResolvedValue([]);
});

describe("updateConversationTitle", () => {
  it("renames the row without touching updated_at", async () => {
    await expect(
      updateConversationTitle("conversation-1", "Signing Key Rotation")
    ).resolves.toBe(true);

    expect(mockExecute).toHaveBeenCalledTimes(1);
    const [sql, params] = mockExecute.mock.calls[0];
    // updated_at is what the chats list sorts and date-groups on. A rename is
    // not new activity, so touching it would jump the conversation to "now".
    expect(sql).not.toMatch(/updated_at/i);
    expect(String(sql).replace(/\s+/g, " ").trim()).toBe(
      "UPDATE conversations SET title = ? WHERE id = ?"
    );
    expect(params).toEqual(["Signing Key Rotation", "conversation-1"]);
  });

  it("reports false when no row matched", async () => {
    mockExecute.mockResolvedValue({ rowsAffected: 0, lastInsertId: 0 });

    await expect(
      updateConversationTitle("deleted-conversation", "Too Late")
    ).resolves.toBe(false);
  });

  it.each([
    ["", "A Title"],
    ["conversation-1", ""],
  ])("refuses to write with id %j and title %j", async (id, title) => {
    await expect(updateConversationTitle(id, title)).resolves.toBe(false);
    expect(mockExecute).not.toHaveBeenCalled();
  });

  it("propagates a failed write instead of reporting success", async () => {
    mockExecute.mockRejectedValue(new Error("database is locked"));

    await expect(
      updateConversationTitle("conversation-1", "Signing Key Rotation")
    ).rejects.toThrow(/database is locked/);
  });
});
