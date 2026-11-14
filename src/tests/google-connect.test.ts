import { beforeEach, describe, expect, it, vi } from "vitest";

const h = vi.hoisted(() => ({
  invoke: vi.fn(async (..._args: unknown[]): Promise<unknown> => undefined),
  emit: vi.fn(async (..._args: unknown[]) => {}),
  load: vi.fn(),
}));

vi.mock("@tauri-apps/api/core", () => ({ invoke: h.invoke }));
vi.mock("@tauri-apps/api/event", () => ({ emit: h.emit }));
vi.mock("@/lib/storage/google-config.storage", async (orig) => ({
  ...(await orig<typeof import("@/lib/storage/google-config.storage")>()),
  loadGoogleConfigState: h.load,
}));

import { reconnectGoogle } from "@/lib/calendar/google-connect";
import { GOOGLE_CONNECTION_CHANGED_EVENT } from "@/lib/storage/google-config.storage";

const COMPLETE = { state: "complete", config: { clientId: "id", clientSecret: "s" } };

beforeEach(() => {
  vi.clearAllMocks();
  h.load.mockResolvedValue(COMPLETE);
  h.invoke.mockImplementation(async () => undefined);
});

describe("reconnectGoogle", () => {
  it("reconnect connects with the saved config and then broadcasts", async () => {
    await expect(reconnectGoogle()).resolves.toEqual({ ok: true });
    expect(h.invoke).toHaveBeenCalledWith("google_connect", { clientId: "id", clientSecret: "s" });
    expect(h.emit).toHaveBeenCalledWith(GOOGLE_CONNECTION_CHANGED_EVENT);
    expect(h.invoke.mock.invocationCallOrder[0]).toBeLessThan(h.emit.mock.invocationCallOrder[0]);
  });

  it("a rejected connect returns its code and broadcasts nothing", async () => {
    h.invoke.mockRejectedValue("GOOGLE_AUTH_CANCELLED");
    await expect(reconnectGoogle()).resolves.toEqual({ ok: false, code: "GOOGLE_AUTH_CANCELLED" });
    expect(h.emit).not.toHaveBeenCalled();
  });

  it("an incomplete config returns AUTH_REJECTED without connecting", async () => {
    h.load.mockResolvedValue({ state: "unreadable", config: null });
    await expect(reconnectGoogle()).resolves.toEqual({ ok: false, code: "GOOGLE_AUTH_REJECTED" });
    expect(h.invoke).not.toHaveBeenCalled();
    expect(h.emit).not.toHaveBeenCalled();
  });
});
