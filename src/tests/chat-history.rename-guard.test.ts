import { beforeEach, describe, expect, it, vi } from "vitest";

const mockExecute = vi.fn();
const mockSelect = vi.fn();
vi.mock("@/lib/database/config", () => ({
  getDatabase: () => Promise.resolve({ execute: mockExecute, select: mockSelect }),
}));

// chat-history.action.ts:3 imports safeLocalStorage from "@/lib". Without this
// stub, importing the action pulls the whole flat barrel - ./functions,
// ./database, ./odoo and the Tauri plugin modules - into the test graph. Every
// sibling suite (update-title, append-silent, speaker, create-rollback,
// title-adoption) carries the same block for the same reason.
vi.mock("@/lib", () => ({
  safeLocalStorage: {
    getItem: vi.fn(() => null),
    setItem: vi.fn(),
    removeItem: vi.fn(),
  },
}));

const sqlOf = (call: unknown[]) => String(call[0]).replace(/\s+/g, " ").trim();
const titleWrites = () =>
  mockExecute.mock.calls.filter((c) => sqlOf(c).startsWith("UPDATE conversations SET title"));
const stampWrites = () =>
  mockExecute.mock.calls.filter((c) => sqlOf(c).startsWith("UPDATE conversations SET updated_at"));

beforeEach(() => {
  mockExecute.mockReset();
  mockSelect.mockReset();
  mockExecute.mockResolvedValue({ rowsAffected: 1 });
  mockSelect.mockResolvedValue([]);
});

describe("appendMessagesToConversation title guard", () => {
  it("splits the header write into an unconditional stamp and a guarded title", async () => {
    const { appendMessagesToConversation } = await import("@/lib/database/chat-history.action");
    await appendMessagesToConversation("conversation-1", "Autosave Title", 1234, []);

    expect(stampWrites()).toHaveLength(1);
    expect(sqlOf(stampWrites()[0])).toBe(
      "UPDATE conversations SET updated_at = ? WHERE id = ?"
    );
    expect(stampWrites()[0][1]).toEqual([1234, "conversation-1"]);

    expect(titleWrites()).toHaveLength(1);
    expect(sqlOf(titleWrites()[0])).toBe(
      "UPDATE conversations SET title = ? WHERE id = ? AND title_source = 'auto'"
    );
    expect(titleWrites()[0][1]).toEqual(["Autosave Title", "conversation-1"]);
  });

  it("never names updated_at in the guarded title statement", async () => {
    const { appendMessagesToConversation } = await import("@/lib/database/chat-history.action");
    await appendMessagesToConversation("conversation-1", "T", 1234, []);
    expect(sqlOf(titleWrites()[0])).not.toContain("updated_at");
  });

  it("still raises when the conversation is gone", async () => {
    const { appendMessagesToConversation } = await import("@/lib/database/chat-history.action");
    mockExecute.mockResolvedValueOnce({ rowsAffected: 0 });
    await expect(
      appendMessagesToConversation("missing", "T", 1234, [])
    ).rejects.toThrow("Conversation not found");
  });
});

describe("updateConversation title guard", () => {
  it("splits the header write the same way", async () => {
    const { updateConversation } = await import("@/lib/database/chat-history.action");
    await updateConversation({
      id: "conversation-1",
      title: "Save Title",
      messages: [],
      createdAt: 1,
      updatedAt: 1234,
    });

    expect(sqlOf(stampWrites()[0])).toBe(
      "UPDATE conversations SET updated_at = ? WHERE id = ?"
    );
    expect(sqlOf(titleWrites()[0])).toBe(
      "UPDATE conversations SET title = ? WHERE id = ? AND title_source = 'auto'"
    );
    expect(sqlOf(titleWrites()[0])).not.toContain("updated_at");
  });

  it("still raises when the conversation is gone", async () => {
    const { updateConversation } = await import("@/lib/database/chat-history.action");
    mockExecute.mockResolvedValueOnce({ rowsAffected: 0 });
    await expect(
      updateConversation({ id: "missing", title: "T", messages: [], createdAt: 1, updatedAt: 1 })
    ).rejects.toThrow("Conversation not found");
  });
});

describe("applySummaryTitleToConversation", () => {
  it("returns false without throwing when the guard matches no row", async () => {
    // CHARACTERISATION, not red-then-green: it already delegates to
    // updateConversationTitle (:602-623) and already returns false on zero rows.
    // Expect it green from the start. The load-bearing half is the SQL
    // assertion below - that the delegation now carries the guard clause.
    const { applySummaryTitleToConversation } = await import("@/lib/database/chat-history.action");
    mockExecute.mockResolvedValueOnce({ rowsAffected: 0 });
    await expect(
      applySummaryTitleToConversation("conversation-1", "Summary Title")
    ).resolves.toBe(false);
    expect(sqlOf(titleWrites()[0])).toContain("title_source = 'auto'");
  });
});

describe("renameConversationManually", () => {
  it("writes both columns and leaves updated_at alone", async () => {
    const { renameConversationManually } = await import("@/lib/database/chat-history.action");
    await renameConversationManually("conversation-1", "Quarterly review with Acme");

    const [sql, params] = mockExecute.mock.calls[0];
    expect(String(sql).replace(/\s+/g, " ").trim()).toBe(
      "UPDATE conversations SET title = ?, title_source = 'manual' WHERE id = ?"
    );
    expect(params).toEqual(["Quarterly review with Acme", "conversation-1"]);
    expect(String(sql)).not.toContain("updated_at");
  });

  it("returns false when no row matched", async () => {
    const { renameConversationManually } = await import("@/lib/database/chat-history.action");
    mockExecute.mockResolvedValueOnce({ rowsAffected: 0 });
    await expect(renameConversationManually("gone", "T")).resolves.toBe(false);
  });

  it.each([
    ["", "T"],
    ["conversation-1", ""],
  ])("refuses id=%p title=%p without touching the database", async (id, title) => {
    const { renameConversationManually } = await import("@/lib/database/chat-history.action");
    await expect(renameConversationManually(id, title)).resolves.toBe(false);
    expect(mockExecute).not.toHaveBeenCalled();
  });

  it("propagates a rejected write rather than reporting success", async () => {
    const { renameConversationManually } = await import("@/lib/database/chat-history.action");
    mockExecute.mockRejectedValueOnce(new Error("database is locked"));
    await expect(renameConversationManually("conversation-1", "T")).rejects.toThrow("database is locked");
  });
});
