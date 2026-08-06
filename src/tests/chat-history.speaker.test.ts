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

import {
  appendMessagesToConversation,
  getConversationById,
} from "@/lib/database/chat-history.action";
import type { ChatMessage } from "@/types/completion";

const GUEST_MESSAGE = {
  id: "msg-guest",
  role: "user",
  content: "Can you hear me all right?",
  timestamp: 20,
  speaker: {
    speakerId: "guest_20",
    speakerLabel: "Guest",
    confirmed: false,
  },
  audioSource: "system",
} as unknown as ChatMessage;

beforeEach(() => {
  vi.clearAllMocks();
  mockExecute.mockResolvedValue({ rowsAffected: 1, lastInsertId: 0 });
  mockSelect.mockResolvedValue([]);
});

describe("message speaker persistence", () => {
  it("writes who spoke along with the message", async () => {
    await appendMessagesToConversation("conversation-1", "Standup", 30, [
      GUEST_MESSAGE,
    ]);

    const insert = mockExecute.mock.calls.find(([sql]) =>
      String(sql).includes("INSERT")
    );
    expect(insert).toBeDefined();
    const [sql, params] = insert!;

    // Without these columns every meeting message lands as a bare role:"user",
    // so a saved transcript cannot tell the user apart from the other speakers.
    expect(sql).toMatch(/speaker/);
    expect(sql).toMatch(/audio_source/);
    expect(params).toContain("system");
    expect(params.map(String).join("|")).toContain("Guest");
  });

  it("restores who spoke when the conversation is read back", async () => {
    mockSelect.mockImplementation(async (sql: string) =>
      String(sql).includes("FROM conversations")
        ? [{ id: "conversation-1", title: "Standup", created_at: 1, updated_at: 2 }]
        : [
            {
              id: "msg-guest",
              conversation_id: "conversation-1",
              role: "user",
              content: "Can you hear me all right?",
              timestamp: 20,
              attached_files: null,
              speaker: JSON.stringify(GUEST_MESSAGE.speaker),
              audio_source: "system",
            },
          ]
    );

    const conversation = await getConversationById("conversation-1");

    expect(conversation?.messages[0].speaker?.speakerLabel).toBe("Guest");
    expect(conversation?.messages[0].audioSource).toBe("system");
  });

  it("reads rows written before the speaker columns existed", async () => {
    mockSelect.mockImplementation(async (sql: string) =>
      String(sql).includes("FROM conversations")
        ? [{ id: "conversation-1", title: "Standup", created_at: 1, updated_at: 2 }]
        : [
            {
              id: "msg-old",
              conversation_id: "conversation-1",
              role: "user",
              content: "from before the migration",
              timestamp: 20,
              attached_files: null,
              speaker: null,
              audio_source: null,
            },
          ]
    );

    const conversation = await getConversationById("conversation-1");

    expect(conversation?.messages[0].content).toBe("from before the migration");
    expect(conversation?.messages[0].speaker).toBeUndefined();
    expect(conversation?.messages[0].audioSource).toBeUndefined();
  });
});
