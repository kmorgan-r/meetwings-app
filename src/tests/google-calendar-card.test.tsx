import { act, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";

const h = vi.hoisted(() => ({
  invoke: vi.fn(async (..._args: unknown[]): Promise<unknown> => undefined),
  emit: vi.fn(async (..._args: unknown[]) => {}),
  openUrl: vi.fn(async (..._args: unknown[]) => {}),
  load: vi.fn(),
  save: vi.fn(async (..._args: unknown[]) => {}),
}));

vi.mock("@tauri-apps/api/core", () => ({ invoke: h.invoke }));
vi.mock("@tauri-apps/api/event", () => ({ emit: h.emit, listen: vi.fn(async () => () => {}) }));
vi.mock("@tauri-apps/plugin-opener", () => ({ openUrl: h.openUrl }));
vi.mock("@/lib/storage/google-config.storage", async (orig) => ({
  ...(await orig<typeof import("@/lib/storage/google-config.storage")>()),
  loadGoogleConfigState: h.load,
  saveGoogleConfig: h.save,
}));

import { GOOGLE_COPY } from "@/lib/calendar/google-errors";
import { GoogleCalendarCard } from "@/pages/odoo/components/GoogleCalendarCard";

const ABSENT = { state: "absent", config: null };
const COMPLETE = { state: "complete", config: { clientId: "id", clientSecret: "s" } };

async function renderCard() {
  const user = userEvent.setup();
  render(<GoogleCalendarCard />);
  await act(async () => {
    await new Promise((r) => setTimeout(r, 0));
  });
  return user;
}

const calls = (cmd: string) => h.invoke.mock.calls.filter((c) => c[0] === cmd);

beforeEach(() => {
  vi.clearAllMocks();
  h.load.mockResolvedValue(ABSENT);
  h.invoke.mockImplementation(async () => undefined);
});

describe("GoogleCalendarCard", () => {
  it("shows both fields and no Disconnect when not connected", async () => {
    await renderCard();
    expect(screen.getByLabelText("Client ID")).toBeTruthy();
    expect(screen.getByLabelText("Client secret").getAttribute("type")).toBe("password");
    expect(screen.getByText("Not connected")).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Disconnect" })).toBeNull();
  });

  it("Connect with a blank secret saves nothing and invokes nothing", async () => {
    const user = await renderCard();
    await user.type(screen.getByLabelText("Client ID"), "id");
    await user.click(screen.getByRole("button", { name: "Connect" }));
    expect(screen.getByText("Enter both the Client ID and the Client secret.")).toBeTruthy();
    expect(h.save).not.toHaveBeenCalled();
    expect(h.invoke).not.toHaveBeenCalled();
  });

  it("Connect saves, invokes google_connect with both values, and broadcasts", async () => {
    h.invoke.mockImplementation(async (cmd: unknown) =>
      cmd === "google_connect" ? { connected: true, sessionOnly: false } : undefined
    );
    const user = await renderCard();
    await user.type(screen.getByLabelText("Client ID"), "id");
    await user.type(screen.getByLabelText("Client secret"), "s");
    await user.click(screen.getByRole("button", { name: "Connect" }));
    expect(h.save).toHaveBeenCalledWith({ clientId: "id", clientSecret: "s" });
    expect(h.invoke).toHaveBeenCalledWith("google_connect", { clientId: "id", clientSecret: "s" });
    const connectAt = h.invoke.mock.calls.findIndex((c) => c[0] === "google_connect");
    expect(h.save.mock.invocationCallOrder[0]).toBeLessThan(
      h.invoke.mock.invocationCallOrder[connectAt]
    );
    expect(h.emit).toHaveBeenCalledWith("google-connection-changed");
    expect(h.invoke.mock.invocationCallOrder[connectAt]).toBeLessThan(
      h.emit.mock.invocationCallOrder[0]
    );
    expect(screen.getByText("Connected")).toBeTruthy();
  });

  it("a failed emit does not turn a successful connect into an error", async () => {
    h.emit.mockRejectedValueOnce(new Error("boom"));
    h.invoke.mockImplementation(async (cmd: unknown) =>
      cmd === "google_connect" ? { connected: true, sessionOnly: false } : undefined
    );
    const user = await renderCard();
    await user.type(screen.getByLabelText("Client ID"), "id");
    await user.type(screen.getByLabelText("Client secret"), "s");
    await user.click(screen.getByRole("button", { name: "Connect" }));
    expect(screen.getByText("Connected")).toBeTruthy();
  });

  it("a failed connect shows the fixed copy for its code", async () => {
    h.invoke.mockImplementation(async (cmd: unknown) => {
      if (cmd === "google_connect") throw "GOOGLE_AUTH_REJECTED";
      return undefined;
    });
    const user = await renderCard();
    await user.type(screen.getByLabelText("Client ID"), "id");
    await user.type(screen.getByLabelText("Client secret"), "s");
    await user.click(screen.getByRole("button", { name: "Connect" }));
    expect(screen.getByText(GOOGLE_COPY.GOOGLE_AUTH_REJECTED)).toBeTruthy();
    expect(h.emit).not.toHaveBeenCalled();
  });

  it("shows the session-only note", async () => {
    h.load.mockResolvedValue(COMPLETE);
    h.invoke.mockImplementation(async () => ({ connected: true, sessionOnly: true }));
    await renderCard();
    expect(
      screen.getByText(
        "No system keychain found: you'll need to connect again after restarting Meetwings."
      )
    ).toBeTruthy();
  });

  it("Disconnect invokes google_disconnect and broadcasts", async () => {
    h.load.mockResolvedValue(COMPLETE);
    h.invoke.mockImplementation(async (cmd: unknown) =>
      cmd === "google_status" ? { connected: true, sessionOnly: false } : undefined
    );
    const user = await renderCard();
    await user.click(screen.getByRole("button", { name: "Disconnect" }));
    expect(h.invoke).toHaveBeenCalledWith("google_disconnect");
    expect(h.emit).toHaveBeenCalledWith("google-connection-changed");
    const disconnectAt = h.invoke.mock.calls.findIndex((c) => c[0] === "google_disconnect");
    expect(h.invoke.mock.invocationCallOrder[disconnectAt]).toBeLessThan(
      h.emit.mock.invocationCallOrder[0]
    );
    expect(screen.getByText("Not connected")).toBeTruthy();
  });

  it("a failed disconnect still broadcasts", async () => {
    h.load.mockResolvedValue(COMPLETE);
    h.invoke.mockImplementation(async (cmd: unknown) => {
      if (cmd === "google_disconnect") throw "GOOGLE_NO_KEYCHAIN";
      return { connected: true, sessionOnly: false };
    });
    const user = await renderCard();
    await user.click(screen.getByRole("button", { name: "Disconnect" }));
    expect(h.emit).toHaveBeenCalledWith("google-connection-changed");
    expect(screen.getByText(GOOGLE_COPY.GOOGLE_NO_KEYCHAIN)).toBeTruthy();
  });

  it("an unreadable config still reads status and offers Disconnect when connected", async () => {
    h.load.mockResolvedValue({ state: "unreadable", config: null });
    h.invoke.mockImplementation(async () => ({ connected: true, sessionOnly: false }));
    await renderCard();
    expect(calls("google_status")).toHaveLength(1);
    expect(screen.getByText("Connected")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Disconnect" })).toBeTruthy();
    expect((screen.getByLabelText("Client ID") as HTMLInputElement).value).toBe("");
    expect((screen.getByLabelText("Client secret") as HTMLInputElement).value).toBe("");
  });

  it("prefills both fields from a complete stored config", async () => {
    h.load.mockResolvedValue(COMPLETE);
    h.invoke.mockImplementation(async () => ({ connected: false, sessionOnly: false }));
    await renderCard();
    expect((screen.getByLabelText("Client ID") as HTMLInputElement).value).toBe("id");
    expect((screen.getByLabelText("Client secret") as HTMLInputElement).value).toBe("s");
  });

  it("never calls google_status for a user who never configured Google", async () => {
    await renderCard();
    expect(calls("google_status")).toHaveLength(0);
  });

  it("opens the setup guide", async () => {
    const user = await renderCard();
    await user.click(screen.getByText("How to set up the Google app"));
    expect(h.openUrl).toHaveBeenCalledWith(
      "https://github.com/kmorgan-r/meetwings-app/blob/main/docs/google-calendar-setup.md"
    );
  });
});
