import { act, renderHook, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

const h = vi.hoisted(() => ({
  configured: vi.fn(async () => false as boolean),
  handlers: new Map<string, () => void>(),
  unlisten: vi.fn(),
}));

vi.mock("@tauri-apps/api/event", () => ({
  listen: vi.fn(async (name: string, handler: () => void) => {
    h.handlers.set(name, handler);
    return h.unlisten;
  }),
}));
vi.mock("@/lib/storage/odoo-config.storage", () => ({
  loadOdooConfigState: vi.fn(async () => ({ state: "absent", config: null })),
}));
vi.mock("@/lib/storage/notion-config.storage", () => ({
  NOTION_CONFIG_CHANGED_EVENT: "notion-config-changed",
  isNotionConfigured: h.configured,
}));

import { useNotionConfigured } from "@/hooks/useNotionConfigured";

beforeEach(() => {
  vi.clearAllMocks();
  h.handlers.clear();
  h.configured.mockResolvedValue(false);
});

describe("useNotionConfigured", () => {
  it("useNotionConfigured re-reads when the Tauri notion-config-changed event fires, and unlistens on unmount", async () => {
    const { result, unmount } = renderHook(() => useNotionConfigured());
    expect(result.current).toBeNull();
    await waitFor(() => expect(result.current).toBe(false));
    await waitFor(() => expect(h.handlers.has("notion-config-changed")).toBe(true));

    h.configured.mockResolvedValue(true);
    await act(async () => {
      h.handlers.get("notion-config-changed")!();
    });
    await waitFor(() => expect(result.current).toBe(true));

    unmount();
    expect(h.unlisten).toHaveBeenCalled();
  });

  it("re-reads on window focus", async () => {
    const { result } = renderHook(() => useNotionConfigured());
    await waitFor(() => expect(result.current).toBe(false));
    h.configured.mockResolvedValue(true);
    await act(async () => {
      window.dispatchEvent(new Event("focus"));
    });
    await waitFor(() => expect(result.current).toBe(true));
  });

  it("useNotionConfigured keeps its value when a re-read throws", async () => {
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    h.configured.mockResolvedValue(true);
    const { result } = renderHook(() => useNotionConfigured());
    await waitFor(() => expect(result.current).toBe(true));
    await waitFor(() => expect(h.handlers.has("notion-config-changed")).toBe(true));

    h.configured.mockRejectedValue(new Error("NOTION_CONFIG_UNREADABLE"));
    await act(async () => {
      h.handlers.get("notion-config-changed")!();
    });
    expect(result.current).toBe(true);
    expect(h.configured).toHaveBeenCalledTimes(2);
    spy.mockRestore();
  });

  it("only the latest read may set state: a slow first read cannot overwrite a fast second one", async () => {
    let resolveSlow: (v: boolean) => void = () => {};
    h.configured.mockImplementationOnce(() => new Promise<boolean>((r) => (resolveSlow = r)));
    const { result } = renderHook(() => useNotionConfigured());
    await waitFor(() => expect(h.handlers.has("notion-config-changed")).toBe(true));

    h.configured.mockResolvedValue(true);
    await act(async () => {
      h.handlers.get("notion-config-changed")!();
    });
    await waitFor(() => expect(result.current).toBe(true));

    await act(async () => {
      resolveSlow(false);
    });
    expect(result.current).toBe(true);
  });
});
