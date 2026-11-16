import { beforeEach, describe, expect, it, vi } from "vitest";
import { act, renderHook } from "@testing-library/react";

const h = vi.hoisted(() => ({
  label: "main",
  linux: false,
  listeners: new Map<string, () => void>(),
  unlisteners: [] as Array<ReturnType<typeof vi.fn>>,
  listen: vi.fn(),
  stop: vi.fn(),
  start: vi.fn(),
  invoke: vi.fn(),
}));

vi.mock("@tauri-apps/api/event", () => ({ listen: h.listen }));
vi.mock("@tauri-apps/api/window", () => ({
  getCurrentWindow: () => ({ label: h.label }),
}));
vi.mock("@tauri-apps/api/core", () => ({ invoke: h.invoke }));
vi.mock("@/lib/platform", () => ({ isLinux: () => h.linux }));
vi.mock("@/lib/updater/silent-updater", () => ({ startSilentUpdater: h.start }));

import { useSilentUpdater } from "@/hooks/useSilentUpdater";
import {
  __resetActivityForTests,
  getActivitySnapshot,
} from "@/lib/updater/recording-activity.store";
import { installMemoryLocalStorage } from "./memory-local-storage";

const flush = () => act(async () => {});
const fire = (event: string) => act(() => h.listeners.get(event)?.());

beforeEach(() => {
  __resetActivityForTests();
  h.label = "main";
  h.linux = false;
  h.listeners.clear();
  h.unlisteners.length = 0;
  h.stop.mockReset();
  h.start.mockReset().mockReturnValue(h.stop);
  h.invoke.mockReset().mockResolvedValue("1.6.0");
  h.listen.mockReset().mockImplementation(
    async (event: string, cb: () => void) => {
      h.listeners.set(event, cb);
      const un = vi.fn(() => h.listeners.delete(event));
      h.unlisteners.push(un);
      return un;
    }
  );
});

describe("useSilentUpdater", () => {
  it("does nothing outside the main window", async () => {
    h.label = "dashboard";
    renderHook(() => useSilentUpdater());
    await flush();

    expect(h.listen).not.toHaveBeenCalled();
    expect(h.start).not.toHaveBeenCalled();
  });

  it("does not start the updater or listen for meetings on Linux", async () => {
    h.linux = true;
    renderHook(() => useSilentUpdater());
    await flush();

    expect(h.listen).not.toHaveBeenCalled();
    expect(h.start).not.toHaveBeenCalled();
  });

  it("records the app version in main on Linux too, and not in other windows", async () => {
    installMemoryLocalStorage();
    h.linux = true;
    renderHook(() => useSilentUpdater());
    await flush();

    expect(h.invoke).toHaveBeenCalledWith("get_app_version");
    expect(localStorage.getItem("app_last_version")).toBe("1.6.0");
    // Linux keeps the click-to-install Updater: no listeners, no silent start.
    expect(h.listen).not.toHaveBeenCalled();
    expect(h.start).not.toHaveBeenCalled();

    h.label = "dashboard";
    h.linux = false;
    renderHook(() => useSilentUpdater());
    await flush();

    expect(h.invoke).toHaveBeenCalledTimes(1);
  });

  it("tracks meeting state from the three events", async () => {
    renderHook(() => useSilentUpdater());
    await flush();

    expect(h.listen.mock.calls.map(([event]) => event).sort()).toEqual([
      "meeting-detected",
      "meeting-ended",
      "meeting-watcher-stopped",
    ]);
    expect(h.start).toHaveBeenCalledTimes(1);

    fire("meeting-detected");
    expect(getActivitySnapshot().meetingActive).toBe(true);
    fire("meeting-ended");
    expect(getActivitySnapshot().meetingActive).toBe(false);

    // A watcher that stops mid-call emits no meeting-ended.
    fire("meeting-detected");
    expect(getActivitySnapshot().meetingActive).toBe(true);
    fire("meeting-watcher-stopped");
    expect(getActivitySnapshot().meetingActive).toBe(false);
  });

  it("unmount stops the updater and unlistens", async () => {
    const { unmount } = renderHook(() => useSilentUpdater());
    await flush();
    expect(h.unlisteners).toHaveLength(3);
    expect(h.stop).not.toHaveBeenCalled();

    unmount();

    expect(h.stop).toHaveBeenCalledTimes(1);
    h.unlisteners.forEach((un) => expect(un).toHaveBeenCalledTimes(1));
  });

  it("unmount before listen() resolves still unlistens (cancelled flag)", async () => {
    const { unmount } = renderHook(() => useSilentUpdater());
    unmount();
    await flush();

    expect(h.stop).toHaveBeenCalledTimes(1);
    expect(h.unlisteners).toHaveLength(3);
    h.unlisteners.forEach((un) => expect(un).toHaveBeenCalledTimes(1));
    expect(h.listeners.size).toBe(0);
  });
});
