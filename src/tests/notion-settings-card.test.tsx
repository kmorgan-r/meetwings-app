import { act, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";

const h = vi.hoisted(() => ({
  emit: vi.fn(async (..._args: unknown[]) => {}),
  store: new Map<string, string>(),
  keychain: { available: true, token: null as string | null, readThrows: false },
  checkNotionSetup: vi.fn(),
  mem: new Map<string, string>(),
}));

vi.mock("@tauri-apps/api/event", () => ({ emit: h.emit, listen: vi.fn(async () => () => {}) }));
vi.mock("@tauri-apps/api/core", () => ({
  invoke: vi.fn(async (cmd: string, args?: { token?: string }) => {
    switch (cmd) {
      case "notion_keychain_available":
        return h.keychain.available;
      case "notion_token_get":
        if (h.keychain.readThrows) throw new Error("keychain locked");
        return h.keychain.token;
      case "notion_token_set":
        h.keychain.token = args?.token ?? null;
        return;
      case "notion_token_clear":
        h.keychain.token = null;
        return;
      default:
        throw new Error(`unexpected invoke ${cmd}`);
    }
  }),
}));
vi.mock("@/lib/secure-storage", () => ({
  secureGet: vi.fn(async (k: string) => h.store.get(k) ?? null),
  secureSet: vi.fn(async (k: string, v: string) => {
    h.store.set(k, v);
  }),
  secureDelete: vi.fn(async (k: string) => {
    h.store.delete(k);
  }),
}));
vi.mock("@/lib/notion/check", () => ({ checkNotionSetup: h.checkNotionSetup }));

import { STORAGE_KEYS } from "@/config/constants";
import { NotionSettingsCard } from "@/pages/odoo/components/NotionSettingsCard";
import { SECURE_NOTION_CONFIG_KEY } from "@/lib/storage/notion-config.storage";

const TOKEN = "ntn_FAKE_TOKEN_VALUE_123";
const MEETINGS_URL = `https://www.notion.so/ws/Weekly-${"a".repeat(32)}?v=1`;

async function renderCard() {
  const view = render(<NotionSettingsCard />);
  // The mount effect has several awaits; wait for its last visible effect.
  await act(async () => {
    await new Promise((r) => setTimeout(r, 0));
  });
  return view;
}

beforeEach(() => {
  vi.clearAllMocks();
  h.store.clear();
  h.keychain.available = true;
  h.keychain.token = null;
  h.keychain.readThrows = false;
  // setup.ts stubs localStorage with bare vi.fn()s; give them a memory.
  const mem = new Map<string, string>();
  vi.mocked(localStorage.getItem).mockImplementation((k: string) => mem.get(k) ?? null);
  vi.mocked(localStorage.setItem).mockImplementation((k: string, v: string) => {
    mem.set(k, String(v));
  });
  mem.clear();
  h.mem = mem;
});

describe("NotionSettingsCard", () => {
  it("settings card never renders the stored token", async () => {
    h.keychain.token = TOKEN;
    const { container } = await renderCard();
    expect(screen.getByText("Saved in your system keychain")).toBeInTheDocument();
    expect(container.textContent).not.toContain(TOKEN);
    for (const input of container.querySelectorAll("input")) {
      expect((input as HTMLInputElement).value).not.toContain(TOKEN);
    }
  });

  it("settings card disables the token field when the keychain is unavailable", async () => {
    h.keychain.available = false;
    await renderCard();
    expect(screen.getByLabelText("Notion token")).toBeDisabled();
    expect(
      screen.getByText(/This computer has no system keychain/),
    ).toBeInTheDocument();
  });

  it("a blank token Save is disabled", async () => {
    await renderCard();
    const save = screen.getByRole("button", { name: "Save token" });
    expect(save).toBeDisabled();
    await userEvent.type(screen.getByLabelText("Notion token"), "   ");
    expect(save).toBeDisabled();
  });

  it("settings card save emits notion-config-changed through @tauri-apps/api/event", async () => {
    await renderCard();
    await userEvent.type(screen.getByLabelText("Notion token"), TOKEN);
    await userEvent.click(screen.getByRole("button", { name: "Save token" }));
    await waitFor(() => expect(h.emit).toHaveBeenCalledWith("notion-config-changed"));
    expect(h.keychain.token).toBe(TOKEN);
    // Cleared after the save, and the value is never shown back.
    expect(screen.getByLabelText("Notion token")).toHaveValue("");
    expect(screen.getByText("Remove token")).toBeInTheDocument();
  });

  it("a failed emit never relabels a successful save", async () => {
    h.emit.mockRejectedValueOnce(new Error("no window"));
    await renderCard();
    await userEvent.type(screen.getByLabelText("Meetings database link"), MEETINGS_URL);
    await userEvent.click(screen.getByRole("button", { name: "Save settings" }));
    await waitFor(() => expect(screen.getByTestId("notion-message")).toHaveTextContent("Saved"));
  });

  it("Check with a keychain read that throws shows the fixed keychain sentence and never calls checkNotionSetup", async () => {
    h.keychain.readThrows = true;
    await renderCard();
    await userEvent.click(screen.getByRole("button", { name: "Check" }));
    const shown = await screen.findByTestId("notion-check-result");
    expect(shown).toHaveTextContent(/can't use the system keychain for the Notion token/i);
    expect(shown.textContent).not.toContain("keychain locked");
    expect(h.checkNotionSetup).not.toHaveBeenCalled();
  });

  it("Check with no stored token says Notion isn't set up, without calling checkNotionSetup", async () => {
    await renderCard();
    await userEvent.click(screen.getByRole("button", { name: "Check" }));
    expect(await screen.findByTestId("notion-check-result")).toHaveTextContent(
      "Notion isn't set up.",
    );
    expect(h.checkNotionSetup).not.toHaveBeenCalled();
  });

  it("a successful Check shows the mapping and one time input per weekday", async () => {
    h.keychain.token = TOKEN;
    h.store.set(
      SECURE_NOTION_CONFIG_KEY,
      JSON.stringify({
        meetingsDbUrl: MEETINGS_URL,
        knowledgeDbUrl: "",
        teamTimes: { monday: "09:30" },
        yourName: "",
      }),
    );
    h.checkNotionSetup.mockResolvedValue({
      ok: true,
      mapping: "Monday → Monday Meetings, other days → Other Meetings",
      recorder: "Ada",
      warnings: [],
      weekdays: ["monday"],
    });
    await renderCard();
    expect(screen.queryByLabelText(/usual start time/)).toBeNull();
    await userEvent.click(screen.getByRole("button", { name: "Check" }));
    const time = await screen.findByLabelText(/Monday: usual start time/);
    expect(time).toHaveAttribute("type", "time");
    expect(time).toHaveValue("09:30");
    expect(screen.getByText("Recorded as Ada.")).toBeInTheDocument();
    // Checked against the stored token and the form's current values.
    expect(h.checkNotionSetup).toHaveBeenCalledWith(
      TOKEN,
      expect.objectContaining({ meetingsDbUrl: MEETINGS_URL }),
    );
  });

  it("a settings read that throws still renders the card with the fixed unreadable line", async () => {
    h.store.set(SECURE_NOTION_CONFIG_KEY, "{not json");
    const { container } = await renderCard();
    expect(screen.getByTestId("notion-unreadable")).toHaveTextContent(
      "Can't read the saved Notion settings. Enter them again and press Save.",
    );
    expect(screen.getByLabelText("Meetings database link")).toHaveValue("");
    expect(container.textContent).not.toMatch(/NOTION_CONFIG_UNREADABLE|not set up/i);
  });

  it("saving a token then a link leaves notion_setup_at set only after the second save", async () => {
    await renderCard();
    await userEvent.type(screen.getByLabelText("Notion token"), TOKEN);
    await userEvent.click(screen.getByRole("button", { name: "Save token" }));
    await screen.findByText("Remove token");
    expect(localStorage.getItem(STORAGE_KEYS.NOTION_SETUP_AT)).toBeNull();

    await userEvent.type(screen.getByLabelText("Meetings database link"), MEETINGS_URL);
    await userEvent.click(screen.getByRole("button", { name: "Save settings" }));
    await waitFor(() => expect(localStorage.getItem(STORAGE_KEYS.NOTION_SETUP_AT)).not.toBeNull());
  });

  it("the token never enters the config blob", async () => {
    await renderCard();
    await userEvent.type(screen.getByLabelText("Notion token"), TOKEN);
    await userEvent.click(screen.getByRole("button", { name: "Save token" }));
    await userEvent.type(screen.getByLabelText("Meetings database link"), MEETINGS_URL);
    await userEvent.click(screen.getByRole("button", { name: "Save settings" }));
    await waitFor(() => expect(h.store.get(SECURE_NOTION_CONFIG_KEY)).toBeDefined());
    expect(h.store.get(SECURE_NOTION_CONFIG_KEY)).not.toContain(TOKEN);
    expect(JSON.stringify([...h.mem])).not.toContain(TOKEN);
  });

  it("Remove token clears the keychain, emits, and re-reads the stored state", async () => {
    h.keychain.token = TOKEN;
    await renderCard();
    await userEvent.click(screen.getByRole("button", { name: "Remove token" }));
    await waitFor(() => expect(h.emit).toHaveBeenCalledWith("notion-config-changed"));
    expect(h.keychain.token).toBeNull();
    await waitFor(() => expect(screen.queryByRole("button", { name: "Remove token" })).toBeNull());
  });

  it("shows 'Saved in your system keychain' once after a token save", async () => {
    await renderCard();
    await userEvent.type(screen.getByLabelText("Notion token"), TOKEN);
    await userEvent.click(screen.getByRole("button", { name: "Save token" }));
    await screen.findByText("Remove token");
    expect(screen.getAllByText("Saved in your system keychain")).toHaveLength(1);
  });

  it("explains the Linux case without telling the user to paste into the disabled field", async () => {
    h.keychain.available = false;
    await renderCard();
    expect(
      screen.getByText(
        "This computer has no system keychain Meetwings can use, so the Notion token can't be saved here.",
      ),
    ).toBeInTheDocument();
    expect(screen.queryByText(/paste the token again/i)).toBeNull();
  });

  it("the Your name help line says it is the recorder", async () => {
    await renderCard();
    expect(
      screen.getByText("Shown as the recorder on each page. Leave empty to use your Notion name."),
    ).toBeInTheDocument();
  });

  it("editing a database link clears the Check result but editing Your name does not", async () => {
    h.keychain.token = TOKEN;
    h.checkNotionSetup.mockResolvedValue({
      ok: true,
      mapping: "Monday, other days",
      recorder: "Ada",
      warnings: [],
      weekdays: ["monday"],
    });
    await renderCard();
    await userEvent.click(screen.getByRole("button", { name: "Check" }));
    await screen.findByLabelText(/Monday: usual start time/);

    await userEvent.type(screen.getByLabelText("Your name"), "K");
    expect(screen.getByLabelText(/Monday: usual start time/)).toBeInTheDocument();

    await userEvent.type(screen.getByLabelText("Meetings database link"), "x");
    expect(screen.queryByLabelText(/Monday: usual start time/)).toBeNull();
  });

  it("the auto-send switch saves immediately and emits", async () => {
    await renderCard();
    await userEvent.click(screen.getByRole("switch", { name: /Send meetings to Notion automatically/ }));
    expect(localStorage.getItem(STORAGE_KEYS.NOTION_AUTO_SEND)).toBe("false");
    await waitFor(() => expect(h.emit).toHaveBeenCalledWith("notion-config-changed"));
  });
});
