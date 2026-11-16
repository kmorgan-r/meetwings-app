import { beforeEach, describe, expect, it, vi } from "vitest";

const h = vi.hoisted(() => ({
  invoke: vi.fn(async (..._args: unknown[]): Promise<unknown> => undefined),
  emit: vi.fn(async (..._args: unknown[]) => {}),
  load: vi.fn(),
  save: vi.fn(async (..._args: unknown[]) => {}),
  loadNotion: vi.fn(),
  saveNotion: vi.fn(async (..._args: unknown[]) => {}),
}));

vi.mock("@tauri-apps/api/core", () => ({ invoke: h.invoke }));
vi.mock("@tauri-apps/api/event", () => ({ emit: h.emit }));
vi.mock("@/lib/storage/google-config.storage", async (orig) => ({
  ...(await orig<typeof import("@/lib/storage/google-config.storage")>()),
  loadGoogleConfigState: h.load,
  saveGoogleConfig: h.save,
}));
vi.mock("@/lib/storage/notion-config.storage", async (orig) => ({
  ...(await orig<typeof import("@/lib/storage/notion-config.storage")>()),
  loadNotionConfig: h.loadNotion,
  saveNotionConfig: h.saveNotion,
}));

import { connectGoogle, reconnectGoogle } from "@/lib/calendar/google-connect";
import { TEAM_SETTINGS_APPLIED_EVENT } from "@/config/constants";
import { GOOGLE_CONNECTION_CHANGED_EVENT } from "@/lib/storage/google-config.storage";
import { NOTION_CONFIG_CHANGED_EVENT } from "@/lib/storage/notion-config.storage";

const CONFIG = { clientId: "id", clientSecret: "s" };
const COMPLETE = { state: "complete", config: CONFIG };
const RESULT = { connected: true, sessionOnly: false, name: "Ana" };
const NOTION = { meetingsDbUrl: "u", knowledgeDbUrl: "", teamTimes: {}, yourName: "" };

function connectReturns(result: unknown) {
  h.invoke.mockImplementation(async (cmd: unknown) => (cmd === "google_connect" ? result : undefined));
}
const emitted = () => h.emit.mock.calls.map((c) => c[0]);

beforeEach(() => {
  vi.clearAllMocks();
  h.load.mockResolvedValue(COMPLETE);
  h.save.mockResolvedValue(undefined);
  h.saveNotion.mockResolvedValue(undefined);
  h.loadNotion.mockResolvedValue({ ...NOTION });
  connectReturns(RESULT);
});

describe("connectGoogle", () => {
  it("fills a blank yourName from the Google name and tells other windows", async () => {
    await expect(connectGoogle(CONFIG)).resolves.toEqual({
      ok: true,
      status: { connected: true, sessionOnly: false },
    });
    expect(h.save).toHaveBeenCalledWith(CONFIG);
    expect(h.invoke).toHaveBeenCalledWith("google_connect", { clientId: "id", clientSecret: "s" });
    expect(h.saveNotion).toHaveBeenCalledWith({ ...NOTION, yourName: "Ana" });
    expect(emitted()).toContain(NOTION_CONFIG_CHANGED_EVENT);
    expect(emitted()).not.toContain(TEAM_SETTINGS_APPLIED_EVENT);
    expect(emitted()).toContain(GOOGLE_CONNECTION_CHANGED_EVENT);
  });

  it("writes the trimmed name", async () => {
    connectReturns({ ...RESULT, name: "  Ana Lima " });
    await connectGoogle(CONFIG);
    expect(h.saveNotion).toHaveBeenCalledWith({ ...NOTION, yourName: "Ana Lima" });
  });

  it("a failing name save still returns ok", async () => {
    h.saveNotion.mockRejectedValue(new Error("boom"));
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    await expect(connectGoogle(CONFIG)).resolves.toMatchObject({ ok: true });
    expect(warn).toHaveBeenCalledWith("[google] name fill failed");
    expect(warn).toHaveBeenCalledTimes(1);
    warn.mockRestore();
  });

  it("keeps a typed yourName", async () => {
    h.loadNotion.mockResolvedValue({ ...NOTION, yourName: "Bea" });
    await connectGoogle(CONFIG);
    expect(h.saveNotion).not.toHaveBeenCalled();
  });

  it("overwrites a whitespace-only yourName", async () => {
    h.loadNotion.mockResolvedValue({ ...NOTION, yourName: "   " });
    await connectGoogle(CONFIG);
    expect(h.saveNotion).toHaveBeenCalledWith({ ...NOTION, yourName: "Ana" });
  });

  it("leaves yourName blank when the sign-in has no name", async () => {
    for (const name of [null, "", "   "]) {
      connectReturns({ ...RESULT, name });
      await expect(connectGoogle(CONFIG)).resolves.toMatchObject({ ok: true });
    }
    expect(h.saveNotion).not.toHaveBeenCalled();
  });

  it("skips the name when the notion config is unreadable but still connects", async () => {
    h.loadNotion.mockRejectedValue(new Error("bad"));
    await expect(connectGoogle(CONFIG)).resolves.toMatchObject({ ok: true });
    h.loadNotion.mockResolvedValue(null);
    await expect(connectGoogle(CONFIG)).resolves.toMatchObject({ ok: true });
    expect(h.saveNotion).not.toHaveBeenCalled();
  });

  it("a rejected connect returns the code, still broadcasts, and writes no name", async () => {
    h.invoke.mockRejectedValue("GOOGLE_AUTH_CANCELLED");
    await expect(connectGoogle(CONFIG)).resolves.toEqual({ ok: false, code: "GOOGLE_AUTH_CANCELLED" });
    expect(h.saveNotion).not.toHaveBeenCalled();
    expect(emitted()).toEqual([GOOGLE_CONNECTION_CHANGED_EVENT]);
  });

  it("a failing config save maps to a code, skips the connect, and still broadcasts", async () => {
    h.save.mockRejectedValue("GOOGLE_AUTH_REJECTED");
    await expect(connectGoogle(CONFIG)).resolves.toEqual({ ok: false, code: "GOOGLE_AUTH_REJECTED" });
    expect(h.invoke).not.toHaveBeenCalled();
    expect(emitted()).toEqual([GOOGLE_CONNECTION_CHANGED_EVENT]);
  });
});

describe("reconnectGoogle", () => {
  it("reconnectGoogle delegates to connectGoogle with the saved config", async () => {
    await expect(reconnectGoogle()).resolves.toMatchObject({ ok: true });
    expect(h.save).toHaveBeenCalledWith(CONFIG);
    expect(h.invoke).toHaveBeenCalledWith("google_connect", { clientId: "id", clientSecret: "s" });
    expect(h.invoke.mock.invocationCallOrder[0]).toBeLessThan(
      h.emit.mock.invocationCallOrder.at(-1)!,
    );
    expect(emitted().at(-1)).toBe(GOOGLE_CONNECTION_CHANGED_EVENT);
  });

  // Was "broadcasts nothing": connectGoogle broadcasts on every path now.
  it("a rejected connect returns its code and still broadcasts", async () => {
    h.invoke.mockRejectedValue("GOOGLE_AUTH_CANCELLED");
    await expect(reconnectGoogle()).resolves.toEqual({ ok: false, code: "GOOGLE_AUTH_CANCELLED" });
    expect(emitted()).toEqual([GOOGLE_CONNECTION_CHANGED_EVENT]);
  });

  it("an incomplete config returns AUTH_REJECTED without connecting", async () => {
    h.load.mockResolvedValue({ state: "unreadable", config: null });
    await expect(reconnectGoogle()).resolves.toEqual({ ok: false, code: "GOOGLE_AUTH_REJECTED" });
    expect(h.save).not.toHaveBeenCalled();
    expect(h.invoke).not.toHaveBeenCalled();
    expect(h.emit).not.toHaveBeenCalled();
  });
});
