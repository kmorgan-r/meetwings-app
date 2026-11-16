import { beforeEach, describe, expect, it, vi } from "vitest";
import { act, render, screen } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";

const h = vi.hoisted(() => ({ invoke: vi.fn() }));

vi.mock("@tauri-apps/api/core", () => ({ invoke: h.invoke }));

import { AppStatusLine } from "@/pages/settings/components/AppStatusLine";
import { STORAGE_KEYS } from "@/config/constants";
import { installMemoryLocalStorage } from "./memory-local-storage";

let store: Map<string, string>;

const flush = () => act(async () => {});

const renderLine = () =>
  render(
    <MemoryRouter>
      <AppStatusLine />
    </MemoryRouter>
  );

beforeEach(() => {
  store = installMemoryLocalStorage();
  h.invoke.mockReset();
  h.invoke.mockImplementation(async (cmd: unknown) =>
    cmd === "get_app_version" ? "1.6.0" : (undefined as unknown)
  );
});

describe("AppStatusLine", () => {
  it("shows version, last update check and team sync when present", async () => {
    store.set(STORAGE_KEYS.UPDATER_LAST_CHECK_AT, "1736900000000");
    store.set(STORAGE_KEYS.TEAM_LAST_SYNCED_AT, "1736800000000");
    renderLine();
    await flush();

    expect(screen.getByText("Meetwings 1.6.0")).toBeInTheDocument();
    expect(
      screen.getByText(
        `Last update check: ${new Date(1736900000000).toLocaleString()}`
      )
    ).toBeInTheDocument();
    expect(
      screen.getByText(
        `Team settings synced: ${new Date(1736800000000).toLocaleString()}`
      )
    ).toBeInTheDocument();
  });

  it("says never and hides the team line when never synced or checked", async () => {
    renderLine();
    await flush();

    expect(screen.getByText("Last update check: never")).toBeInTheDocument();
    expect(screen.queryByText(/^Team settings synced:/)).toBeNull();
  });

  it("shows 'Updated to 1.6.0' when the note matches the running version", async () => {
    store.set(
      STORAGE_KEYS.APP_UPDATED_TO,
      JSON.stringify({ version: "1.6.0", at: 1736700000000 })
    );
    renderLine();
    await flush();

    expect(screen.getByText("Updated to 1.6.0")).toBeInTheDocument();
  });

  it("hides the note when it is for another version", async () => {
    store.set(
      STORAGE_KEYS.APP_UPDATED_TO,
      JSON.stringify({ version: "1.5.0", at: 1736700000000 })
    );
    renderLine();
    await flush();

    expect(screen.queryByText(/^Updated to /)).toBeNull();
  });

  it("refreshes on a storage event from another window", async () => {
    renderLine();
    await flush();
    expect(screen.getByText("Last update check: never")).toBeInTheDocument();

    store.set(STORAGE_KEYS.UPDATER_LAST_CHECK_AT, "1736900000000");
    act(() => {
      window.dispatchEvent(
        new StorageEvent("storage", { key: STORAGE_KEYS.UPDATER_LAST_CHECK_AT })
      );
    });

    expect(
      screen.getByText(
        `Last update check: ${new Date(1736900000000).toLocaleString()}`
      )
    ).toBeInTheDocument();
    expect(screen.queryByText("Last update check: never")).toBeNull();
  });

  it("shows a note that arrives via a note-only storage event", async () => {
    renderLine();
    await flush();
    expect(screen.getByText("Meetwings 1.6.0")).toBeInTheDocument();
    expect(screen.queryByText(/^Updated to /)).toBeNull();

    // Only APP_UPDATED_TO changes - neither timestamp does, so without the
    // note raw string in state React would bail out and keep the old note.
    store.set(
      STORAGE_KEYS.APP_UPDATED_TO,
      JSON.stringify({ version: "1.6.0", at: 1736700000000 })
    );
    act(() => {
      window.dispatchEvent(
        new StorageEvent("storage", { key: STORAGE_KEYS.APP_UPDATED_TO })
      );
    });

    expect(screen.getByText("Updated to 1.6.0")).toBeInTheDocument();
  });
});
