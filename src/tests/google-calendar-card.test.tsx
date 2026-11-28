import { act, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";

const h = vi.hoisted(() => ({
  invoke: vi.fn(async (..._args: unknown[]): Promise<unknown> => undefined),
  emit: vi.fn(async (..._args: unknown[]) => {}),
  openUrl: vi.fn(async (..._args: unknown[]) => {}),
  load: vi.fn(),
  save: vi.fn(async (..._args: unknown[]) => {}),
  fetchGoogle: vi.fn(),
}));
const listeners = vi.hoisted(() => new Map<string, Set<(e: unknown) => void>>());

vi.mock("@tauri-apps/api/core", () => ({ invoke: h.invoke }));
vi.mock("@tauri-apps/api/event", () => ({
  emit: h.emit,
  listen: vi.fn(async (name: string, handler: (e: unknown) => void) => {
    const set = listeners.get(name) ?? new Set();
    set.add(handler);
    listeners.set(name, set);
    return () => {};
  }),
}));
vi.mock("@/lib/calendar/fetch-google-meetings", () => ({
  fetchCurrentGoogleMeetings: h.fetchGoogle,
}));
vi.mock("@tauri-apps/plugin-opener", () => ({ openUrl: h.openUrl }));
vi.mock("@/lib/storage/google-config.storage", async (orig) => ({
  ...(await orig<typeof import("@/lib/storage/google-config.storage")>()),
  loadGoogleConfigState: h.load,
  saveGoogleConfig: h.save,
}));

import { GOOGLE_CONNECTION_CHANGED_EVENT } from "@/lib/storage/google-config.storage";
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
  h.fetchGoogle.mockResolvedValue({ kind: "ok", events: [], ownAddress: null });
  listeners.clear();
});

const CONNECTED = { connected: true, sessionOnly: false };
const READABLE = "Connected · calendar readable";
const CHECKING = "Connected · checking calendar…";
const connectedInvoke = () =>
  h.invoke.mockImplementation(async (cmd: unknown) => (cmd === "google_status" ? CONNECTED : undefined));
function deferred<T>() {
  let resolve!: (v: T) => void;
  const promise = new Promise<T>((r) => (resolve = r));
  return { promise, resolve };
}
const settle = () =>
  act(async () => {
    await new Promise((r) => setTimeout(r, 0));
  });
const fireChanged = () =>
  act(async () => {
    for (const fn of listeners.get(GOOGLE_CONNECTION_CHANGED_EVENT) ?? []) fn({});
    await new Promise((r) => setTimeout(r, 0));
  });
async function connectViaForm(user: Awaited<ReturnType<typeof renderCard>>) {
  await user.type(screen.getByLabelText("Client ID"), "id");
  await user.type(screen.getByLabelText("Client secret"), "s");
  await user.click(screen.getByRole("button", { name: "Connect" }));
}

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
    expect(screen.getByText(READABLE)).toBeTruthy();
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
    expect(screen.getByText(READABLE)).toBeTruthy();
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
  });

  // saveGoogleConfig runs first, so a cancelled sign-in leaves a complete config
  // the running watcher has not heard about.
  it("a failed connect still broadcasts the connection change", async () => {
    h.invoke.mockImplementation(async (cmd: unknown) => {
      if (cmd === "google_connect") throw "GOOGLE_AUTH_CANCELLED";
      return undefined;
    });
    const user = await renderCard();
    await user.type(screen.getByLabelText("Client ID"), "id");
    await user.type(screen.getByLabelText("Client secret"), "s");
    await user.click(screen.getByRole("button", { name: "Connect" }));
    expect(h.emit).toHaveBeenCalledWith("google-connection-changed");
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
    h.fetchGoogle.mockResolvedValue({
      kind: "error",
      code: "GOOGLE_AUTH_REJECTED",
      config: "unreadable",
    });
    await renderCard();
    expect(calls("google_status")).toHaveLength(1);
    expect(screen.getByText(GOOGLE_COPY.GOOGLE_AUTH_REJECTED)).toBeTruthy();
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

  it("a connected card reads the calendar once and says it is readable", async () => {
    h.load.mockResolvedValue(COMPLETE);
    connectedInvoke();
    await renderCard();
    expect(h.fetchGoogle).toHaveBeenCalledTimes(1);
    expect(screen.getByText(READABLE)).toBeTruthy();
  });

  it("shows the checking line while the read runs", async () => {
    h.load.mockResolvedValue(COMPLETE);
    connectedInvoke();
    const d = deferred<unknown>();
    h.fetchGoogle.mockReturnValue(d.promise);
    await renderCard();
    expect(screen.getByText(CHECKING)).toBeTruthy();
    d.resolve({ kind: "ok", events: [], ownAddress: null });
    await settle();
    expect(screen.getByText(READABLE)).toBeTruthy();
  });

  it("a failed read shows that error's copy and keeps Disconnect", async () => {
    h.load.mockResolvedValue(COMPLETE);
    connectedInvoke();
    h.fetchGoogle.mockResolvedValue({
      kind: "error",
      code: "GOOGLE_CONSENT_REQUIRED",
      config: "complete",
    });
    await renderCard();
    expect(screen.getByText(GOOGLE_COPY.GOOGLE_CONSENT_REQUIRED)).toBeTruthy();
    expect(screen.getByTestId("google-status").className).toContain("text-destructive");
    expect(screen.getByRole("button", { name: "Disconnect" })).toBeTruthy();
  });

  it("not connected makes no calendar read", async () => {
    h.load.mockResolvedValue(COMPLETE);
    h.invoke.mockImplementation(async () => ({ connected: false, sessionOnly: false }));
    await renderCard();
    expect(h.fetchGoogle).not.toHaveBeenCalled();
  });

  it("a successful Connect verifies the read", async () => {
    h.invoke.mockImplementation(async (cmd: unknown) => (cmd === "google_connect" ? CONNECTED : undefined));
    const user = await renderCard();
    await connectViaForm(user);
    const connectAt = h.invoke.mock.calls.findIndex((c) => c[0] === "google_connect");
    expect(h.fetchGoogle).toHaveBeenCalled();
    expect(h.invoke.mock.invocationCallOrder[connectAt]).toBeLessThan(
      h.fetchGoogle.mock.invocationCallOrder[0]
    );
    expect(screen.getByText(READABLE)).toBeTruthy();
  });

  it("Disconnect clears the calendar line", async () => {
    h.load.mockResolvedValue(COMPLETE);
    connectedInvoke();
    const user = await renderCard();
    expect(screen.getByText(READABLE)).toBeTruthy();
    await user.click(screen.getByRole("button", { name: "Disconnect" }));
    expect(screen.getByText("Not connected")).toBeTruthy();
    expect(screen.queryByText(/calendar readable/)).toBeNull();
  });

  it("a connection change from another window re-verifies", async () => {
    h.load.mockResolvedValue(COMPLETE);
    connectedInvoke();
    await renderCard();
    await fireChanged();
    expect(h.fetchGoogle).toHaveBeenCalledTimes(2);
  });

  it("an older calendar read never overwrites a newer one", async () => {
    h.load.mockResolvedValue(COMPLETE);
    h.invoke.mockImplementation(async (cmd: unknown) =>
      cmd === "google_status" || cmd === "google_connect" ? CONNECTED : undefined
    );
    const older = deferred<unknown>();
    h.fetchGoogle.mockReturnValueOnce(older.promise);
    const user = await renderCard();
    await connectViaForm(user);
    expect(screen.getByText(READABLE)).toBeTruthy();
    older.resolve({ kind: "error", code: "GOOGLE_AUTH_REJECTED", config: "complete" });
    await settle();
    expect(screen.getByText(READABLE)).toBeTruthy();
  });

  it("an unmount before the status resolves makes no calendar read", async () => {
    h.load.mockResolvedValue(COMPLETE);
    const d = deferred<unknown>();
    h.invoke.mockImplementation(async (cmd: unknown) => (cmd === "google_status" ? d.promise : undefined));
    const { unmount } = render(<GoogleCalendarCard />);
    await settle();
    unmount();
    d.resolve(CONNECTED);
    await settle();
    expect(h.fetchGoogle).not.toHaveBeenCalled();
  });

  it("a read cut off by Disconnect leaves Not connected clean", async () => {
    h.load.mockResolvedValue(COMPLETE);
    connectedInvoke();
    const d = deferred<unknown>();
    h.fetchGoogle.mockReturnValue(d.promise);
    const user = await renderCard();
    await user.click(screen.getByRole("button", { name: "Disconnect" }));
    d.resolve({ kind: "error", code: "GOOGLE_NOT_CONNECTED", config: "complete" });
    await settle();
    expect(screen.getByText("Not connected")).toBeTruthy();
    expect(screen.queryByText(GOOGLE_COPY.GOOGLE_NOT_CONNECTED)).toBeNull();
  });

  it("a failed read then a successful one shows readable", async () => {
    h.load.mockResolvedValue(COMPLETE);
    connectedInvoke();
    h.fetchGoogle.mockResolvedValueOnce({
      kind: "error",
      code: "GOOGLE_CONSENT_REQUIRED",
      config: "complete",
    });
    await renderCard();
    expect(screen.getByText(GOOGLE_COPY.GOOGLE_CONSENT_REQUIRED)).toBeTruthy();
    await fireChanged();
    expect(screen.getByText(READABLE)).toBeTruthy();
    expect(screen.queryByText(GOOGLE_COPY.GOOGLE_CONSENT_REQUIRED)).toBeNull();
  });

  it("Disconnect stays enabled while checking", async () => {
    h.load.mockResolvedValue(COMPLETE);
    connectedInvoke();
    h.fetchGoogle.mockReturnValue(new Promise(() => {}));
    await renderCard();
    const btn = screen.getByRole("button", { name: "Disconnect" }) as HTMLButtonElement;
    expect(btn.disabled).toBe(false);
  });
});
