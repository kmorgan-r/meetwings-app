import { act, fireEvent, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { installMemoryLocalStorage } from "./memory-local-storage";

const h = vi.hoisted(() => ({
  handlers: new Map<string, () => unknown>(),
  emit: vi.fn(async (..._args: unknown[]) => {}),
  store: new Map<string, string>(),
  googleState: { state: "absent", config: null } as unknown,
  googleStatus: { connected: false, sessionOnly: false } as unknown,
  resetCache: vi.fn(),
  invoke: vi.fn(async (..._args: unknown[]): Promise<unknown> => undefined),
}));

vi.mock("@tauri-apps/api/event", () => ({
  emit: h.emit,
  listen: vi.fn(async (name: string, fn: () => unknown) => {
    h.handlers.set(name, fn);
    return () => {};
  }),
}));
vi.mock("@tauri-apps/api/core", () => ({
  invoke: vi.fn(async (cmd: string, ...rest: unknown[]) => {
    h.invoke(cmd, ...rest);
    switch (cmd) {
      case "notion_keychain_available":
        return true;
      case "notion_token_get":
        return null;
      case "google_status":
        return h.googleStatus;
      default:
        return undefined;
    }
  }),
}));
vi.mock("@tauri-apps/api/window", () => ({
  getCurrentWindow: () => ({ label: "dashboard" }),
}));
vi.mock("@tauri-apps/plugin-autostart", () => ({ enable: vi.fn(), disable: vi.fn() }));
vi.mock("@tauri-apps/plugin-opener", () => ({ openUrl: vi.fn() }));
vi.mock("@/lib/secure-storage", () => ({
  secureGet: vi.fn(async (k: string) => h.store.get(k) ?? null),
  secureSet: vi.fn(async (k: string, v: string) => {
    h.store.set(k, v);
  }),
  secureDelete: vi.fn(async (k: string) => {
    h.store.delete(k);
  }),
}));
vi.mock("@/lib/storage/google-config.storage", async (orig) => ({
  ...(await orig<typeof import("@/lib/storage/google-config.storage")>()),
  loadGoogleConfigState: vi.fn(async () => h.googleState),
}));
vi.mock("@/lib/storage/secure-provider-configs", () => ({
  loadSecureAIConfigs: vi.fn(async () => ({})),
  loadSecureSTTConfigs: vi.fn(async () => ({})),
  updateAIConfigCache: vi.fn(),
  updateSTTConfigCache: vi.fn(),
  migrateProviderConfigsToSecureStorage: vi.fn(async () => {}),
  resetSecureProviderConfigsCache: h.resetCache,
}));
vi.mock("@/lib/storage/verification.storage", () => ({
  loadVerificationCache: vi.fn(async () => {}),
  migrateVerificationToSecureStorage: vi.fn(async () => {}),
}));
vi.mock("@/lib/functions/shortcuts.function", () => ({ pushShortcutsConfig: vi.fn() }));

import {
  GOOGLE_CONNECTION_CHANGED_EVENT,
} from "@/lib/storage/google-config.storage";
import { NOTION_CONFIG_CHANGED_EVENT, SECURE_NOTION_CONFIG_KEY } from "@/lib/storage/notion-config.storage";
import { STORAGE_KEYS, TEAM_SETTINGS_APPLIED_EVENT } from "@/config/constants";
import { AppProvider, useApp } from "@/contexts/app.context";
import { GoogleCalendarCard } from "@/pages/odoo/components/GoogleCalendarCard";
import { NotionSettingsCard } from "@/pages/odoo/components/NotionSettingsCard";

const URL_A = `https://www.notion.so/ws/Weekly-${"a".repeat(32)}?v=1`;
const URL_B = `https://www.notion.so/ws/Weekly-${"b".repeat(32)}?v=1`;

const flush = () =>
  act(async () => {
    await new Promise((r) => setTimeout(r, 0));
  });

async function fire(name: string) {
  const fn = h.handlers.get(name);
  expect(fn, `listener for ${name}`).toBeTypeOf("function");
  await act(async () => {
    await fn!();
  });
}

function seedNotion(over: Record<string, unknown>) {
  h.store.set(
    SECURE_NOTION_CONFIG_KEY,
    JSON.stringify({ meetingsDbUrl: "", knowledgeDbUrl: "", teamTimes: {}, yourName: "", ...over })
  );
}

let ls: Map<string, string>;
beforeEach(() => {
  vi.clearAllMocks();
  h.handlers.clear();
  h.store.clear();
  h.googleState = { state: "absent", config: null };
  h.googleStatus = { connected: false, sessionOnly: false };
  ls = installMemoryLocalStorage();
});

function Probe() {
  const { selectedAIProvider } = useApp();
  return <div data-testid="provider">{selectedAIProvider.provider}</div>;
}

describe("team-settings-applied consumers", () => {
  it("AppContext reloads provider selection and secure caches on team-settings-applied", async () => {
    ls.set(STORAGE_KEYS.SELECTED_AI_PROVIDER, JSON.stringify({ provider: "openai", variables: {} }));
    render(
      <AppProvider>
        <Probe />
      </AppProvider>
    );
    await flush();
    expect(screen.getByTestId("provider").textContent).toBe("openai");
    h.resetCache.mockClear();

    ls.set(STORAGE_KEYS.SELECTED_AI_PROVIDER, JSON.stringify({ provider: "claude", variables: {} }));
    await fire(TEAM_SETTINGS_APPLIED_EVENT);

    expect(screen.getByTestId("provider").textContent).toBe("claude");
    expect(h.resetCache).toHaveBeenCalled();
  });

  it("NotionSettingsCard re-reads storage on team-settings-applied", async () => {
    render(<NotionSettingsCard />);
    await flush();
    expect((screen.getByLabelText("Meetings database link") as HTMLInputElement).value).toBe("");

    seedNotion({ meetingsDbUrl: URL_A });
    await fire(TEAM_SETTINGS_APPLIED_EVENT);
    expect((screen.getByLabelText("Meetings database link") as HTMLInputElement).value).toBe(URL_A);
  });

  it("NotionSettingsCard on notion-config-changed fills a blank name and keeps typed edits", async () => {
    render(<NotionSettingsCard />);
    await flush();
    fireEvent.change(screen.getByLabelText("Meetings database link"), { target: { value: URL_B } });

    seedNotion({ yourName: "Ana" });
    await fire(NOTION_CONFIG_CHANGED_EVENT);
    expect((screen.getByLabelText("Meetings database link") as HTMLInputElement).value).toBe(URL_B);
    expect((screen.getByLabelText("Your name") as HTMLInputElement).value).toBe("Ana");
  });

  it("NotionSettingsCard on notion-config-changed keeps a typed name", async () => {
    render(<NotionSettingsCard />);
    await flush();
    fireEvent.change(screen.getByLabelText("Your name"), { target: { value: "Bo" } });

    seedNotion({ yourName: "Ana" });
    await fire(NOTION_CONFIG_CHANGED_EVENT);
    expect((screen.getByLabelText("Your name") as HTMLInputElement).value).toBe("Bo");
  });

  it("NotionSettingsCard keeps a deliberately cleared name when its own emit fires", async () => {
    seedNotion({ yourName: "Ana" });
    render(<NotionSettingsCard />);
    await flush();
    const name = screen.getByLabelText("Your name") as HTMLInputElement;
    expect(name.value).toBe("Ana");
    const user = userEvent.setup();
    await user.clear(name);

    await fire(NOTION_CONFIG_CHANGED_EVENT);
    expect((screen.getByLabelText("Your name") as HTMLInputElement).value).toBe("");
  });

  it("NotionSettingsCard keeps a name cleared after its own Save when the emit fires", async () => {
    render(<NotionSettingsCard />);
    await flush();
    const user = userEvent.setup();
    await user.type(screen.getByLabelText("Meetings database link"), URL_A);
    await user.type(screen.getByLabelText("Your name"), "Bo");
    await user.click(screen.getByRole("button", { name: "Save settings" }));
    await flush();
    expect(JSON.parse(h.store.get(SECURE_NOTION_CONFIG_KEY)!).yourName).toBe("Bo");

    await user.clear(screen.getByLabelText("Your name"));
    await fire(NOTION_CONFIG_CHANGED_EVENT);
    expect((screen.getByLabelText("Your name") as HTMLInputElement).value).toBe("");
  });

  it("GoogleCalendarCard re-reads config and status on team-settings-applied", async () => {
    render(<GoogleCalendarCard />);
    await flush();
    expect((screen.getByLabelText("Client ID") as HTMLInputElement).value).toBe("");
    expect(screen.getByText("Not connected")).toBeTruthy();

    h.googleState = { state: "complete", config: { clientId: "team-id", clientSecret: "team-s" } };
    h.googleStatus = { connected: true, sessionOnly: false };
    await fire(TEAM_SETTINGS_APPLIED_EVENT);
    expect((screen.getByLabelText("Client ID") as HTMLInputElement).value).toBe("team-id");
    expect(screen.getByText("Connected")).toBeTruthy();
  });

  it("GoogleCalendarCard on google-connection-changed refreshes status only", async () => {
    h.googleState = { state: "complete", config: { clientId: "saved-id", clientSecret: "s" } };
    render(<GoogleCalendarCard />);
    await flush();
    fireEvent.change(screen.getByLabelText("Client ID"), { target: { value: "typed-id" } });
    h.invoke.mockClear();

    h.googleStatus = { connected: true, sessionOnly: false };
    await fire(GOOGLE_CONNECTION_CHANGED_EVENT);
    expect(h.invoke.mock.calls.filter((c) => c[0] === "google_status")).toHaveLength(1);
    expect((screen.getByLabelText("Client ID") as HTMLInputElement).value).toBe("typed-id");
    expect(screen.getByText("Connected")).toBeTruthy();
  });
});
