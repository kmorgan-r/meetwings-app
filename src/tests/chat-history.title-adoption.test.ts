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

import { applySummaryTitleToConversation } from "@/lib/database/chat-history.action";

beforeEach(() => {
  vi.clearAllMocks();
  mockExecute.mockResolvedValue({ rowsAffected: 1, lastInsertId: 0 });
  mockSelect.mockResolvedValue([]);
});

describe("adopting a summary's title", () => {
  it("gives the conversation the name its summary earned", async () => {
    const renamed = await applySummaryTitleToConversation(
      "conv-1",
      "Live Platform Demo with Kylie"
    );

    expect(renamed).toBe(true);

    const [sql, params] = mockExecute.mock.calls[0];
    expect(String(sql)).toMatch(/UPDATE conversations/i);
    expect(params).toEqual(["Live Platform Demo with Kylie", "conv-1"]);
  });

  it("trims the title before storing it", async () => {
    await applySummaryTitleToConversation("conv-1", "  Padded Title  ");

    const [, params] = mockExecute.mock.calls[0];
    expect(params[0]).toBe("Padded Title");
  });

  it("reports no rename when the conversation is gone", async () => {
    mockExecute.mockResolvedValue({ rowsAffected: 0, lastInsertId: 0 });

    await expect(
      applySummaryTitleToConversation("conv-1", "Live Platform Demo")
    ).resolves.toBe(false);
  });

  it("does not touch the database when the summary has no title", async () => {
    await expect(applySummaryTitleToConversation("conv-1", "  ")).resolves.toBe(
      false
    );
    expect(mockExecute).not.toHaveBeenCalled();
  });

  it("does not throw when the rename fails", async () => {
    mockExecute.mockRejectedValue(new Error("database is locked"));

    // Titling is cosmetic; losing it must never fail the summary that was just
    // written, which is the caller's actual product.
    await expect(
      applySummaryTitleToConversation("conv-1", "Live Platform Demo")
    ).resolves.toBe(false);
  });
});
