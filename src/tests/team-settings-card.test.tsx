import { beforeEach, describe, expect, it, vi } from "vitest";
import { act, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter } from "react-router-dom";

const h = vi.hoisted(() => ({
  handler: null as null | ((e: { payload: unknown }) => void),
  emit: vi.fn(),
  store: new Map<string, string>(),
  exportTeamSettings: vi.fn(),
  writeText: vi.fn(),
  toastError: vi.fn(),
}));

vi.mock("@tauri-apps/api/event", () => ({
  listen: async (_e: string, cb: (e: { payload: unknown }) => void) => {
    h.handler = cb;
    return vi.fn();
  },
  emit: h.emit,
}));
vi.mock("@/lib/secure-storage", () => ({
  secureGet: async (k: string) => h.store.get(k) ?? null,
  secureSet: async (k: string, v: string) => void h.store.set(k, v),
}));
vi.mock("@/lib/team/team-file", async (orig) => ({
  ...(await orig<object>()),
  exportTeamSettings: h.exportTeamSettings,
}));
vi.mock("sonner", () => ({ toast: { error: h.toastError, success: vi.fn() } }));

import { TeamSettingsCard } from "@/pages/settings/components/TeamSettingsCard";
import { TEAM_ACTION_EVENT } from "@/lib/team/team-controller";
import { TEAM_COPY } from "@/lib/team/team-file";
import {
  TEAM_OWNER_GIST_SECURE_KEY,
  TEAM_OWNER_KEY_SECURE_KEY,
} from "@/lib/team/team-sync";
import { generateTeamKey } from "@/lib/team/team-crypto";

const GIST = "0123456789abcdef0123456789abcdef";
const LINK = `meetwings://team/${GIST}#${generateTeamKey()}`;

const pushState = (over: object = {}) =>
  act(() =>
    h.handler?.({
      payload: {
        joined: false,
        pending: null,
        busy: false,
        error: null,
        errorSeq: 0,
        check: null,
        googleNeedsConnect: false,
        ...over,
      },
    })
  );

const mount = async () => {
  render(
    <MemoryRouter>
      <TeamSettingsCard />
    </MemoryRouter>
  );
  await act(async () => {});
};

beforeEach(() => {
  h.handler = null;
  h.emit.mockReset().mockResolvedValue(undefined);
  h.store.clear();
  h.exportTeamSettings.mockReset();
  h.writeText.mockReset().mockResolvedValue(undefined);
  h.toastError.mockReset();
  Object.defineProperty(navigator, "clipboard", {
    value: { writeText: h.writeText },
    configurable: true,
  });
});

describe("TeamSettingsCard", () => {
  it("requests state on mount", async () => {
    await mount();
    expect(h.emit).toHaveBeenCalledWith(TEAM_ACTION_EVENT, { type: "state-request" });
  });

  it("an invalid pasted link shows fixed copy and sends nothing", async () => {
    await mount();
    h.emit.mockClear();
    await userEvent.type(screen.getByPlaceholderText(/meetwings:\/\/team/), "nonsense");
    await userEvent.click(screen.getByRole("button", { name: "Join" }));
    expect(screen.getByText(TEAM_COPY.TEAM_LINK_INVALID)).toBeInTheDocument();
    expect(h.emit).not.toHaveBeenCalled();
  });

  it("a valid pasted link sends join", async () => {
    await mount();
    await userEvent.type(screen.getByPlaceholderText(/meetwings:\/\/team/), LINK);
    await userEvent.click(screen.getByRole("button", { name: "Join" }));
    expect(h.emit).toHaveBeenCalledWith(TEAM_ACTION_EVENT, { type: "join", link: LINK });
  });

  it("Copy team settings refuses with fixed copy and leaves the clipboard alone", async () => {
    h.store.set(TEAM_OWNER_KEY_SECURE_KEY, generateTeamKey());
    h.exportTeamSettings.mockResolvedValue({ ok: false, code: "TEAM_FIELD_MISSING" });
    await mount();
    await userEvent.click(screen.getByRole("button", { name: "Copy team settings" }));
    expect(await screen.findByText(TEAM_COPY.TEAM_FIELD_MISSING)).toBeInTheDocument();
    expect(h.writeText).not.toHaveBeenCalled();
  });

  it("Copy team settings copies an mwt1 blob that does not contain the key", async () => {
    const key = generateTeamKey();
    h.store.set(TEAM_OWNER_KEY_SECURE_KEY, key);
    h.exportTeamSettings.mockResolvedValue({
      ok: true,
      value: { v: 1, apiKey: "SENTINEL-API-KEY" },
    });
    await mount();
    await userEvent.click(screen.getByRole("button", { name: "Copy team settings" }));
    await waitFor(() => expect(h.writeText).toHaveBeenCalledTimes(1));
    const text = h.writeText.mock.calls[0][0] as string;
    expect(text.startsWith("mwt1.")).toBe(true);
    expect(text).not.toContain(key);
    expect(text).not.toContain("SENTINEL-API-KEY");
    expect(await screen.findByText("Copied. Paste it over the file in your gist.")).toBeInTheDocument();
  });

  it("a clipboard rejection shows fixed copy, not the raw error", async () => {
    h.store.set(TEAM_OWNER_KEY_SECURE_KEY, generateTeamKey());
    h.exportTeamSettings.mockResolvedValue({ ok: true, value: { v: 1 } });
    h.writeText.mockRejectedValue(new Error("raw secret-ish detail"));
    await mount();
    await userEvent.click(screen.getByRole("button", { name: "Copy team settings" }));
    expect(await screen.findByText("Couldn't copy. Try again.")).toBeInTheDocument();
    expect(screen.queryByText(/raw secret-ish/)).toBeNull();
  });

  it("Copy team link stays disabled until a gist id is saved; a gist URL is accepted", async () => {
    const key = generateTeamKey();
    h.store.set(TEAM_OWNER_KEY_SECURE_KEY, key);
    await mount();
    const btn = screen.getByRole("button", { name: "Copy team link" });
    expect(btn).toBeDisabled();
    await userEvent.type(
      screen.getByLabelText("Gist link"),
      `https://gist.github.com/octo/${GIST}`
    );
    await userEvent.click(screen.getByRole("button", { name: "Save gist" }));
    await waitFor(() => expect(btn).toBeEnabled());
    expect(h.store.get(TEAM_OWNER_GIST_SECURE_KEY)).toBe(GIST);
    await userEvent.click(btn);
    expect(h.writeText).toHaveBeenCalledWith(`meetwings://team/${GIST}#${key}`);
    expect(await screen.findByText("Team link copied.")).toBeInTheDocument();
  });

  it("an invalid gist reference shows fixed copy and saves nothing", async () => {
    await mount();
    await userEvent.type(screen.getByLabelText("Gist link"), "nope");
    await userEvent.click(screen.getByRole("button", { name: "Save gist" }));
    expect(screen.getByText(TEAM_COPY.TEAM_LINK_INVALID)).toBeInTheDocument();
    expect(h.store.has(TEAM_OWNER_GIST_SECURE_KEY)).toBe(false);
  });

  it("Create team key stores a key and never renders it", async () => {
    await mount();
    await userEvent.click(screen.getByRole("button", { name: "Create team key" }));
    await waitFor(() => expect(h.store.has(TEAM_OWNER_KEY_SECURE_KEY)).toBe(true));
    const key = h.store.get(TEAM_OWNER_KEY_SECURE_KEY)!;
    expect(screen.queryByRole("button", { name: "Create team key" })).toBeNull();
    expect(document.body.textContent).not.toContain(key);
  });

  it("Check team link renders the controller's result", async () => {
    await mount();
    await pushState();
    await userEvent.click(screen.getByRole("button", { name: "Check team link" }));
    expect(h.emit).toHaveBeenCalledWith(TEAM_ACTION_EVENT, { type: "check-owner-link" });
    await pushState({ check: { ok: true } });
    expect(screen.getByText("Team link works.")).toBeInTheDocument();
    await pushState({ check: { ok: false, code: "TEAM_FETCH_FAILED" } });
    expect(screen.getByText(TEAM_COPY.TEAM_FETCH_FAILED)).toBeInTheDocument();
  });

  it("Reconnect Google appears only when googleNeedsConnect", async () => {
    await mount();
    await pushState();
    expect(screen.queryByRole("button", { name: "Reconnect Google" })).toBeNull();
    await pushState({ googleNeedsConnect: true });
    await userEvent.click(screen.getByRole("button", { name: "Reconnect Google" }));
    expect(h.emit).toHaveBeenCalledWith(TEAM_ACTION_EVENT, { type: "connect-google" });
  });

  it("shows the joined status and a Leave team button", async () => {
    await mount();
    await pushState({ joined: true });
    expect(screen.getByText("Using your team's settings")).toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: "Leave team" }));
    expect(h.emit).toHaveBeenCalledWith(TEAM_ACTION_EVENT, { type: "leave" });
  });
});
