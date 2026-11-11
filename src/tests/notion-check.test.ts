import { beforeEach, describe, expect, it, vi } from "vitest";

const h = vi.hoisted(() => ({
  client: {
    me: vi.fn(),
    userName: vi.fn(),
    database: vi.fn(),
    dataSource: vi.fn(),
  },
  requeueAuthFailures: vi.fn(async () => {}),
  arm: vi.fn(),
}));
vi.mock("@/lib/notion/client", () => ({ createNotionClient: () => h.client }));
vi.mock("@/lib/database/notion-queue.action", () => ({
  requeueAuthFailures: h.requeueAuthFailures,
}));
vi.mock("@/lib/notion/redact", () => ({ armNotionRedactor: h.arm }));

import { checkNotionSetup } from "@/lib/notion/check";
import { NotionError } from "@/lib/notion/errors";
import type { NotionConfig } from "@/lib/storage/notion-config.storage";

const MEETINGS_ID = "a".repeat(32);
const KNOWLEDGE_ID = "b".repeat(32);
const cfg = (over: Partial<NotionConfig> = {}): NotionConfig => ({
  meetingsDbUrl: `https://www.notion.so/ws/Weekly-${MEETINGS_ID}?v=1`,
  knowledgeDbUrl: `https://www.notion.so/ws/Knowledge-${KNOWLEDGE_ID}`,
  teamTimes: {},
  yourName: "",
  ...over,
});

const meetingsProps = {
  Name: { type: "title" },
  Date: { type: "date" },
};
const knowledgeProps = (over: Record<string, unknown> = {}) => ({
  Rule: { type: "title" },
  Status: { type: "status", status: { options: [{ name: "Proposed" }, { name: "Done" }] } },
  Topic: { type: "select", select: { options: [] } },
  "Meeting link": { type: "url" },
  ...over,
});

/** Routes database()/dataSource() by id, returning the real API shapes from client.ts. */
function wire(opts: {
  meetings?: { id: string; name: string; properties: Record<string, unknown> }[];
  knowledge?: Record<string, unknown>;
  meetingsError?: unknown;
  knowledgeError?: unknown;
}) {
  const meetings = opts.meetings ?? [
    { id: "ds-mon", name: "Monday Meetings", properties: meetingsProps },
    { id: "ds-other", name: "Other Meetings", properties: meetingsProps },
  ];
  h.client.database.mockImplementation(async (id: string) => {
    if (id === MEETINGS_ID) {
      if (opts.meetingsError) throw opts.meetingsError;
      return { dataSources: meetings.map((m) => ({ id: m.id, name: m.name })) };
    }
    if (opts.knowledgeError) throw opts.knowledgeError;
    return { dataSources: [{ id: "ds-know", name: "Team Knowledge" }] };
  });
  h.client.dataSource.mockImplementation(async (id: string) => {
    if (id === "ds-know") {
      return { id, name: "Team Knowledge", properties: opts.knowledge ?? knowledgeProps() };
    }
    const m = meetings.find((x) => x.id === id)!;
    return { id, name: m.name, properties: m.properties };
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  h.client.me.mockResolvedValue({ id: "bot", ownerUserId: "owner-1" });
  h.client.userName.mockResolvedValue("Ada Owner");
  h.requeueAuthFailures.mockResolvedValue(undefined);
});

describe("checkNotionSetup", () => {
  it("Check reports the weekday mapping on success and requeues auth failures", async () => {
    wire({});
    const result = await checkNotionSetup("secret-token", cfg());
    expect(result).toEqual({
      ok: true,
      mapping: "Monday → Monday Meetings, other days → Other Meetings",
      recorder: "Ada Owner",
      warnings: [],
      weekdays: ["monday"],
    });
    expect(h.arm).toHaveBeenCalledWith(["secret-token"]);
    expect(h.requeueAuthFailures).toHaveBeenCalledTimes(1);
  });

  it("uses the typed name over the Notion name, and falls back to You", async () => {
    wire({});
    const typed = await checkNotionSetup("t", cfg({ yourName: "  Kev " }));
    expect(typed.ok && typed.recorder).toBe("Kev");
    h.client.me.mockResolvedValue({ id: "bot", ownerUserId: null });
    const none = await checkNotionSetup("t", cfg());
    expect(none.ok && none.recorder).toBe("You");
  });

  it("warns, and reads nothing, when the knowledge link is empty", async () => {
    wire({});
    const result = await checkNotionSetup("t", cfg({ knowledgeDbUrl: "" }));
    expect(result.ok && result.warnings).toEqual([
      "No Team Knowledge link: practices will only appear on the meeting page.",
    ]);
    expect(h.client.database).not.toHaveBeenCalledWith(KNOWLEDGE_ID);
  });

  it("Check: missing Proposed option → that sentence", async () => {
    wire({
      knowledge: knowledgeProps({
        Status: { type: "status", status: { options: [{ name: "Done" }] } },
      }),
    });
    const result = await checkNotionSetup("t", cfg());
    expect(result).toEqual({
      ok: false,
      message: "Team Knowledge's Status column has no Proposed option.",
    });
    expect(h.requeueAuthFailures).not.toHaveBeenCalled();
  });

  it("Check: a wrong-typed Topic reports Team Knowledge is missing the Topic column.", async () => {
    wire({ knowledge: knowledgeProps({ Topic: { type: "rich_text" } }) });
    const result = await checkNotionSetup("t", cfg());
    expect(result).toEqual({ ok: false, message: "Team Knowledge is missing the Topic column." });
  });

  it("Check: 404 on the meetings database → the 'Can't see the Weekly Team Meetings database' sentence", async () => {
    wire({ meetingsError: new NotionError("NOTION_NOT_FOUND") });
    const result = await checkNotionSetup("t", cfg());
    expect(result).toEqual({
      ok: false,
      message:
        "Can't see the Weekly Team Meetings database: open it in Notion and check you have edit access.",
    });
  });

  it("Check maps a 403 on Team Knowledge to the knowledge sentence", async () => {
    wire({ knowledgeError: new NotionError("NOTION_NO_ACCESS") });
    const result = await checkNotionSetup("t", cfg());
    expect(result).toEqual({
      ok: false,
      message:
        "Can't see the Team Knowledge database: open it in Notion and check you have edit access.",
    });
  });

  it("reports a sub-table with no date column", async () => {
    wire({ meetings: [{ id: "ds-x", name: "Friday Meetings", properties: { Name: { type: "title" } } }] });
    const result = await checkNotionSetup("t", cfg());
    expect(result).toEqual({ ok: false, message: "Friday Meetings has no date column." });
  });

  it("maps any other NotionError to its fixed copy, and an unknown throw to NOTION_INTERNAL", async () => {
    wire({});
    h.client.me.mockRejectedValueOnce(new NotionError("NOTION_UNAUTHORIZED"));
    const unauthorized = await checkNotionSetup("t", cfg());
    expect(unauthorized).toEqual({
      ok: false,
      message: "Notion rejected your token. Paste a new one in Settings > Integrations > Notion.",
    });

    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    h.client.me.mockRejectedValueOnce(new Error("token=secret-token leaked"));
    const internal = await checkNotionSetup("t", cfg());
    expect(internal.ok).toBe(false);
    expect(!internal.ok && internal.message).toBe(
      "Something went wrong sending to Notion. Press Retry.",
    );
    spy.mockRestore();
  });

  it("still succeeds when the requeue throws", async () => {
    wire({});
    h.requeueAuthFailures.mockRejectedValueOnce(new Error("db down"));
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    const result = await checkNotionSetup("t", cfg());
    expect(result.ok).toBe(true);
    spy.mockRestore();
  });
});
