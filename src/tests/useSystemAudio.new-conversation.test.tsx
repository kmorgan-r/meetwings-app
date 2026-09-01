import { act, renderHook } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { useSystemAudio } from "@/hooks/useSystemAudio";

// useSystemAudio() calls useApp() (app.context.tsx:806-808 throws outside an
// AppProvider), plus useWindowResize/useGlobalShortcuts from "@/hooks" and a
// Tauri listen(...) in a mount effect - none of this test's concern, but the
// hook does not mount without them.
vi.mock("@/contexts", () => ({
  useApp: () => ({
    selectedSttProvider: null,
    allSttProviders: [],
    selectedAIProvider: { provider: null },
    allAiProviders: [],
    systemPrompt: "",
    selectedAudioDevices: {},
    sttLanguage: "en",
  }),
}));
vi.mock("@/hooks", () => ({
  useWindowResize: () => ({ resizeWindow: vi.fn() }),
  useGlobalShortcuts: () => ({ registerSystemAudioCallback: vi.fn() }),
}));
vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn().mockResolvedValue(true) }));
vi.mock("@tauri-apps/api/event", () => ({ listen: vi.fn().mockResolvedValue(vi.fn()) }));

// `@/lib` is deliberately left unmocked, as meeting-log-page.test.tsx:72-77
// does for the same reason: this test asserts two ids DIFFER, and the
// meeting-assist suite's constant-"conversation-1" mock would make that
// impossible. The real generateConversationId supplies distinct ids, which
// is exactly what is under test - that useSystemAudio's own
// startNewConversation is NOT part of Task 3's ensureConversationId fix and
// must keep minting a fresh id every time it is called.
describe("useSystemAudio new conversation", () => {
  it("mints a distinct id for each new conversation", async () => {
    const { result } = renderHook(() => useSystemAudio());

    await act(async () => {
      result.current.startNewConversation();
    });
    const first = result.current.conversation.id;

    await act(async () => {
      result.current.startNewConversation();
    });
    const second = result.current.conversation.id;

    expect(second).not.toBe(first);
  });
});
