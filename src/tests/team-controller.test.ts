import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { renderHook } from "@testing-library/react";

type Handler<T> = (arg: T) => void;

const h = vi.hoisted(() => ({
  label: "main",
  actionHandler: null as null | ((e: { payload: unknown }) => void),
  urlHandler: null as null | ((urls: string[]) => void),
  unlistenAction: vi.fn(),
  unlistenUrl: vi.fn(),
  stored: null as null | { gistId: string; key: string },
  googleConnected: false,
  listen: vi.fn(),
  emit: vi.fn(),
  onOpenUrl: vi.fn(),
  getCurrent: vi.fn(),
  invoke: vi.fn(),
  syncTeam: vi.fn(),
  fetchTeamFile: vi.fn(),
  leaveTeam: vi.fn(),
  loadStoredTeamLink: vi.fn(),
  loadOwnerTeamLink: vi.fn(),
  reconnectGoogle: vi.fn(),
}));

vi.mock("@tauri-apps/api/event", () => ({ listen: h.listen, emit: h.emit }));
vi.mock("@tauri-apps/plugin-deep-link", () => ({
  onOpenUrl: h.onOpenUrl,
  getCurrent: h.getCurrent,
}));
vi.mock("@tauri-apps/api/core", () => ({ invoke: h.invoke }));
vi.mock("@tauri-apps/api/window", () => ({
  getCurrentWindow: () => ({ label: h.label }),
}));
vi.mock("@/lib/team/team-sync", () => ({
  syncTeam: h.syncTeam,
  fetchTeamFile: h.fetchTeamFile,
  leaveTeam: h.leaveTeam,
  loadStoredTeamLink: h.loadStoredTeamLink,
  loadOwnerTeamLink: h.loadOwnerTeamLink,
}));
vi.mock("@/lib/calendar/google-connect", () => ({
  reconnectGoogle: h.reconnectGoogle,
}));

import {
  TEAM_ACTION_EVENT,
  TEAM_REFRESH_MS,
  TEAM_START_RETRY_MS,
  TEAM_STATE_EVENT,
  __resetTeamControllerForTests,
  startTeamController,
  type TeamAction,
  type TeamUiState,
} from "@/lib/team/team-controller";
import { useTeamSync } from "@/hooks/useTeamSync";
import { installMemoryLocalStorage } from "./memory-local-storage";
import {
  __resetActivityForTests,
  getActivitySnapshot,
} from "@/lib/updater/recording-activity.store";

const GIST_A = "0123456789abcdef0123456789abcdef";
const GIST_B = "fedcba9876543210fedcba9876543210";
const KEY_1 = "K".repeat(43);
const KEY_2 = "Q".repeat(43);
const linkOf = (gistId: string, key: string) => `meetwings://team/${gistId}#${key}`;
const A1 = { gistId: GIST_A, key: KEY_1 };
const LINK_A1 = linkOf(GIST_A, KEY_1);
const LINK_A2 = linkOf(GIST_A, KEY_2);
const LINK_B1 = linkOf(GIST_B, KEY_1);

const OWNER = "team-owner";
const prompt = (gistShort: string, switching: boolean, owner = OWNER) => ({ gistShort, owner, switching });
const preview = (ownerLogin = OWNER) => ({ ok: true, value: { file: {}, ownerLogin } });

const OK = { ok: true, value: { changed: true, googleClientChanged: false } };
const fail = (code: string, googleClientChanged = false) => ({
  ok: false,
  code,
  landed: false,
  googleClientChanged,
});

function deferred<T>() {
  let resolve!: (v: T) => void;
  const promise = new Promise<T>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}

const flush = async () => {
  for (let i = 0; i < 30; i++) await Promise.resolve();
};

const states = (): TeamUiState[] =>
  h.emit.mock.calls
    .filter(([event]) => event === TEAM_STATE_EVENT)
    .map(([, s]) => s as TeamUiState);
const lastState = (): TeamUiState => {
  const all = states();
  expect(all.length).toBeGreaterThan(0);
  return all[all.length - 1];
};
const invokedCount = (cmd: string) =>
  h.invoke.mock.calls.filter(([c]) => c === cmd).length;

let stop: (() => void) | null = null;
let storage: Map<string, string>;
const start = async () => {
  stop = startTeamController();
  await flush();
};
const act = async (action: TeamAction) => {
  h.actionHandler!({ payload: action });
  await flush();
};
const openUrl = async (...urls: string[]) => {
  h.urlHandler!(urls);
  await flush();
};

beforeEach(() => {
  vi.useFakeTimers();
  __resetTeamControllerForTests();
  stop = null;
  storage = installMemoryLocalStorage();
  // happy-dom's real sessionStorage survives between tests.
  sessionStorage.clear();
  __resetActivityForTests();
  h.label = "main";
  h.actionHandler = null;
  h.urlHandler = null;
  h.stored = null;
  h.googleConnected = false;
  h.unlistenAction = vi.fn();
  h.unlistenUrl = vi.fn();
  h.listen.mockReset().mockImplementation(async (_event: string, cb: Handler<{ payload: unknown }>) => {
    h.actionHandler = cb;
    return h.unlistenAction;
  });
  h.onOpenUrl.mockReset().mockImplementation(async (cb: Handler<string[]>) => {
    h.urlHandler = cb;
    return h.unlistenUrl;
  });
  h.getCurrent.mockReset().mockResolvedValue(null);
  h.emit.mockReset().mockResolvedValue(undefined);
  h.invoke.mockReset().mockImplementation(async (cmd: string) =>
    cmd === "google_status" ? { connected: h.googleConnected, sessionOnly: false } : undefined
  );
  h.syncTeam.mockReset().mockResolvedValue(OK);
  h.fetchTeamFile.mockReset().mockResolvedValue(preview());
  h.leaveTeam.mockReset().mockResolvedValue(undefined);
  h.loadStoredTeamLink.mockReset().mockImplementation(async () => h.stored);
  h.loadOwnerTeamLink.mockReset().mockResolvedValue(null);
  h.reconnectGoogle.mockReset().mockResolvedValue({ ok: true });
});

afterEach(() => {
  stop?.();
  vi.restoreAllMocks();
  vi.useRealTimers();
});

describe("team controller: incoming links", () => {
  it("cold start link -> pending prompt, dashboard opened, nothing applied", async () => {
    h.getCurrent.mockResolvedValue([LINK_A1]);
    await start();

    expect(lastState().pending).toEqual(prompt("012345", false));
    expect(lastState().joined).toBe(false);
    expect(invokedCount("open_dashboard")).toBe(1);
    expect(h.syncTeam).not.toHaveBeenCalled();
  });

  it("warm link via onOpenUrl -> pending prompt", async () => {
    await start();
    expect(lastState().pending).toBeNull();

    await openUrl(LINK_B1);

    expect(lastState().pending).toEqual(prompt("fedcba", false));
    expect(invokedCount("open_dashboard")).toBe(1);
    expect(h.syncTeam).not.toHaveBeenCalled();
  });

  it("the stored link clicked again re-syncs without a prompt", async () => {
    h.stored = A1;
    await start();
    h.syncTeam.mockClear();

    await openUrl(LINK_A1);

    expect(h.syncTeam).toHaveBeenCalledTimes(1);
    expect(h.syncTeam).toHaveBeenCalledWith(A1, { firstJoin: false });
    expect(h.fetchTeamFile).not.toHaveBeenCalled();
    expect(lastState().pending).toBeNull();
    expect(invokedCount("open_dashboard")).toBe(0);
  });

  it("a different gist while joined sets switching", async () => {
    h.stored = A1;
    await start();

    await openUrl(LINK_B1);

    expect(lastState().pending).toEqual(prompt("fedcba", true));
  });

  it("the same gist with a different key prompts", async () => {
    h.stored = A1;
    await start();
    h.syncTeam.mockClear();

    await openUrl(LINK_A2);

    expect(lastState().pending).toEqual(prompt("012345", true));
    expect(invokedCount("open_dashboard")).toBe(1);
    expect(h.syncTeam).not.toHaveBeenCalled();
  });

  it("an invalid link shows TEAM_LINK_INVALID, opens the dashboard and never logs the link", async () => {
    const SENTINEL = "SENTINELzz";
    const spies = (["log", "info", "warn", "error", "debug"] as const).map((m) =>
      vi.spyOn(console, m).mockImplementation(() => {})
    );
    await start();

    await openUrl(`meetwings://team/not-a-gist-${SENTINEL}#${SENTINEL}`);

    expect(lastState().error).toBe("TEAM_LINK_INVALID");
    expect(lastState().errorSeq).toBe(1);
    expect(lastState().pending).toBeNull();
    expect(invokedCount("open_dashboard")).toBe(1);

    // A valid link whose key carries the sentinel: a preview that throws an
    // Error naming the link, then a join that does the same. None of it may
    // reach a log, an emit or an invoke.
    const secretKey = (SENTINEL + "x".repeat(43)).slice(0, 43);
    const secretLink = linkOf(GIST_B, secretKey);
    h.fetchTeamFile.mockRejectedValueOnce(new Error(`preview ${secretLink}`));
    await openUrl(secretLink);
    expect(lastState().error).toBe("TEAM_WRITE_FAILED");
    expect(lastState().pending).toBeNull();

    h.syncTeam.mockRejectedValue(new Error(`boom ${secretLink}`));
    await openUrl(secretLink);
    expect(h.fetchTeamFile).toHaveBeenLastCalledWith({ gistId: GIST_B, key: secretKey });
    expect(lastState().pending).toEqual(prompt("fedcba", false));
    await act({ type: "confirm" });
    expect(lastState().error).toBe("TEAM_WRITE_FAILED");

    const text = (a: unknown) =>
      a instanceof Error ? `${a.message} ${a.stack}` : typeof a === "string" ? a : JSON.stringify(a);
    for (const spy of spies) {
      for (const call of spy.mock.calls) {
        for (const arg of call) expect(text(arg)).not.toContain(SENTINEL);
      }
    }
    const emitted = JSON.stringify(h.emit.mock.calls);
    expect(emitted).not.toContain(SENTINEL);
    expect(emitted).not.toContain(GIST_B);
    expect(JSON.stringify(h.invoke.mock.calls)).not.toContain(SENTINEL);
  });

  it("a second link while the prompt is open keeps one prompt with the latest link", async () => {
    await start();

    await openUrl(LINK_A1);
    await openUrl(LINK_B1);

    expect(lastState().pending).toEqual(prompt("fedcba", false));
    expect(h.syncTeam).not.toHaveBeenCalled();

    await act({ type: "confirm" });

    expect(h.syncTeam).toHaveBeenCalledTimes(1);
    expect(h.syncTeam).toHaveBeenCalledWith({ gistId: GIST_B, key: KEY_1 }, { firstJoin: true });
  });

  it("the prompt names the gist owner", async () => {
    h.fetchTeamFile.mockResolvedValue(preview("octo-cat"));
    await start();

    await openUrl(LINK_B1);

    expect(h.fetchTeamFile).toHaveBeenCalledWith({ gistId: GIST_B, key: KEY_1 });
    expect(lastState().pending?.owner).toBe("octo-cat");
    expect(lastState().pending).toEqual(prompt("fedcba", false, "octo-cat"));
  });

  it("a link whose preview fails shows the error and no prompt, and applies nothing", async () => {
    await start();
    h.fetchTeamFile.mockResolvedValue({ ok: false, code: "TEAM_DECRYPT_FAILED" });

    await openUrl(LINK_B1);

    expect(lastState()).toMatchObject({ pending: null, error: "TEAM_DECRYPT_FAILED", errorSeq: 1 });
    expect(invokedCount("open_dashboard")).toBe(1);
    await act({ type: "confirm" });
    expect(h.syncTeam).not.toHaveBeenCalled();
  });

  it("a preview that resolves after a newer link is dropped", async () => {
    await start();
    const slowA = deferred<ReturnType<typeof preview>>();
    h.fetchTeamFile
      .mockResolvedValueOnce(preview("first-owner"))
      .mockReturnValueOnce(slowA.promise)
      .mockResolvedValueOnce(preview("bee-owner"));
    await openUrl(LINK_A2);
    expect(lastState().pending).toEqual(prompt("012345", false, "first-owner"));

    await openUrl(LINK_A1);
    // The older prompt is gone while A previews: a racing confirm joins nothing.
    expect(lastState().pending).toBeNull();
    await act({ type: "confirm" });
    expect(h.syncTeam).not.toHaveBeenCalled();
    await openUrl(LINK_B1);
    expect(lastState().pending).toEqual(prompt("fedcba", false, "bee-owner"));

    slowA.resolve(preview("aye-owner"));
    await flush();

    expect(lastState().pending).toEqual(prompt("fedcba", false, "bee-owner"));
    expect(h.syncTeam).not.toHaveBeenCalled();
    await act({ type: "confirm" });
    expect(h.syncTeam).toHaveBeenCalledTimes(1);
    expect(h.syncTeam).toHaveBeenCalledWith({ gistId: GIST_B, key: KEY_1 }, { firstJoin: true });
  });

  it("the same error twice bumps errorSeq twice", async () => {
    await start();

    await openUrl("meetwings://team/bad");
    const first = lastState();
    await openUrl("meetwings://team/bad");
    const second = lastState();

    expect(first.error).toBe("TEAM_LINK_INVALID");
    expect(second.error).toBe("TEAM_LINK_INVALID");
    expect(first.errorSeq).toBe(1);
    expect(second.errorSeq).toBe(2);
  });

  it("getCurrent() null or [] starts with no prompt", async () => {
    for (const current of [null, []]) {
      __resetTeamControllerForTests();
      h.invoke.mockClear();
      h.emit.mockClear();
      h.getCurrent.mockResolvedValue(current);
      await start();

      expect(lastState().pending).toBeNull();
      expect(lastState().error).toBeNull();
      expect(invokedCount("open_dashboard")).toBe(0);
    }
    // An empty warm list is not an invalid link either.
    await openUrl();
    expect(lastState().error).toBeNull();
    expect(invokedCount("open_dashboard")).toBe(0);
  });
});

describe("team controller: launch link replay", () => {
  const RELAUNCH = "mw_relaunch_after_update";
  const SEEN = "mw_launch_link_seen";

  it("a launch link after an update relaunch is not handled, and the flag is cleared", async () => {
    storage.set(RELAUNCH, "1");
    h.getCurrent.mockResolvedValue([LINK_A1]);
    await start();

    expect(h.fetchTeamFile).not.toHaveBeenCalled();
    expect(lastState().pending).toBeNull();
    expect(invokedCount("open_dashboard")).toBe(0);
    expect(storage.has(RELAUNCH)).toBe(false);

    // A fresh click while running is always handled.
    await openUrl(LINK_A1);
    expect(lastState().pending).toEqual(prompt("012345", false));
  });

  it("a launch link already seen this session (webview reload) is not handled; a fresh click still is", async () => {
    sessionStorage.setItem(SEEN, "1");
    h.getCurrent.mockResolvedValue([LINK_A1]);
    await start();

    expect(h.fetchTeamFile).not.toHaveBeenCalled();
    expect(lastState().pending).toBeNull();

    await openUrl(LINK_B1);
    expect(lastState().pending).toEqual(prompt("fedcba", false));
  });

  it("a handled launch link is not handled again after a reload", async () => {
    h.getCurrent.mockResolvedValue([LINK_A1]);
    await start();
    expect(lastState().pending).toEqual(prompt("012345", false));
    expect(sessionStorage.getItem(SEEN)).toBe("1");

    // The reload: module state is gone, sessionStorage and getCurrent() stay.
    stop!();
    __resetTeamControllerForTests();
    h.emit.mockClear();
    await start();

    expect(h.fetchTeamFile).toHaveBeenCalledTimes(1);
    expect(lastState().pending).toBeNull();
  });

  it("StrictMode start/stop/start still handles the launch link", async () => {
    h.getCurrent.mockResolvedValue([LINK_A1]);
    startTeamController()();
    await start();

    expect(h.fetchTeamFile).toHaveBeenCalledTimes(1);
    expect(lastState().pending).toEqual(prompt("012345", false));
  });

  it("StrictMode start/stop/start after an update relaunch still skips it", async () => {
    storage.set(RELAUNCH, "1");
    h.getCurrent.mockResolvedValue([LINK_A1]);
    startTeamController()();
    await start();

    expect(h.fetchTeamFile).not.toHaveBeenCalled();
    expect(lastState().pending).toBeNull();
    expect(storage.has(RELAUNCH)).toBe(false);
  });
});

describe("team controller: actions", () => {
  it("confirm joins with firstJoin true and starts Google sign-in when not connected", async () => {
    await start();
    await openUrl(LINK_A1);

    await act({ type: "confirm" });

    expect(h.syncTeam).toHaveBeenCalledWith(A1, { firstJoin: true });
    expect(h.reconnectGoogle).toHaveBeenCalledTimes(1);
    expect(lastState()).toMatchObject({
      joined: true,
      pending: null,
      busy: false,
      error: null,
      googleNeedsConnect: false,
    });

    // Already connected: no sign-in.
    h.googleConnected = true;
    await openUrl(LINK_B1);
    await act({ type: "confirm" });
    expect(h.syncTeam).toHaveBeenCalledTimes(2);
    expect(h.reconnectGoogle).toHaveBeenCalledTimes(1);
  });

  it("a confirm holds the install gate busy until syncTeam settles, even when it rejects or stop() lands", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    await start();
    await openUrl(LINK_A1);
    const sync = deferred<typeof OK>();
    let busyAtSync: boolean | null = null;
    h.syncTeam.mockImplementation(() => {
      busyAtSync = getActivitySnapshot().appBusy;
      return sync.promise;
    });

    await act({ type: "confirm" });
    expect(busyAtSync).toBe(true);
    expect(getActivitySnapshot().appBusy).toBe(true);
    sync.resolve(OK);
    await flush();
    expect(getActivitySnapshot().appBusy).toBe(false);

    // A rejected join clears it too.
    await openUrl(LINK_B1);
    let rejectSync!: (e: Error) => void;
    h.syncTeam.mockImplementation(() => new Promise((_, reject) => (rejectSync = reject)));
    await act({ type: "confirm" });
    expect(getActivitySnapshot().appBusy).toBe(true);
    rejectSync(new Error("boom"));
    await flush();
    expect(getActivitySnapshot().appBusy).toBe(false);
    expect(lastState().error).toBe("TEAM_WRITE_FAILED");

    // A stop() mid-join: busy has no tail, so it must still clear once the write settles.
    await openUrl(LINK_A2);
    const late = deferred<typeof OK>();
    h.syncTeam.mockReturnValue(late.promise);
    await act({ type: "confirm" });
    expect(getActivitySnapshot().appBusy).toBe(true);
    stop!();
    stop = null;
    late.resolve(OK);
    await flush();
    expect(getActivitySnapshot().appBusy).toBe(false);
  });

  it("a double confirm joins once", async () => {
    await start();
    await openUrl(LINK_A1);
    const sync = deferred<typeof OK>();
    h.syncTeam.mockReturnValue(sync.promise);

    h.actionHandler!({ payload: { type: "confirm" } });
    h.actionHandler!({ payload: { type: "confirm" } });
    await flush();
    sync.resolve(OK);
    await flush();

    expect(h.syncTeam).toHaveBeenCalledTimes(1);
    expect(h.reconnectGoogle).toHaveBeenCalledTimes(1);
    expect(lastState().joined).toBe(true);
  });

  it("decline clears the prompt and applies nothing", async () => {
    await start();
    await openUrl(LINK_A1);

    await act({ type: "decline" });

    expect(lastState().pending).toBeNull();
    await act({ type: "confirm" });
    expect(h.syncTeam).not.toHaveBeenCalled();
    expect(lastState().joined).toBe(false);
  });

  it("confirm with nothing pending is ignored", async () => {
    await start();

    await act({ type: "confirm" });

    expect(h.syncTeam).not.toHaveBeenCalled();
    expect(h.reconnectGoogle).not.toHaveBeenCalled();
    expect(lastState()).toMatchObject({ joined: false, pending: null, busy: false, error: null });
  });

  it("confirm emits a non-busy state before Google sign-in starts", async () => {
    await start();
    await openUrl(LINK_A1);
    const sync = deferred<typeof OK>();
    h.syncTeam.mockReturnValue(sync.promise);
    const google = deferred<{ ok: true }>();
    h.reconnectGoogle.mockReturnValue(google.promise);

    h.actionHandler!({ payload: { type: "confirm" } });
    await flush();
    // The prompt stays open and busy while the join runs.
    expect(lastState()).toMatchObject({ busy: true, pending: { gistShort: "012345" } });

    sync.resolve(OK);
    await flush();
    expect(h.reconnectGoogle).toHaveBeenCalledTimes(1);
    expect(lastState()).toMatchObject({ pending: null, busy: false, joined: true });

    google.resolve({ ok: true });
    await flush();
    expect(lastState()).toMatchObject({ busy: false, joined: true, googleNeedsConnect: false });
  });

  it("a confirm whose sync fails sets the error, clears pending, leaves joined false and starts no Google sign-in", async () => {
    await start();
    await openUrl(LINK_A1);
    h.syncTeam.mockResolvedValue(fail("TEAM_DECRYPT_FAILED", true));

    await act({ type: "confirm" });

    expect(h.reconnectGoogle).not.toHaveBeenCalled();
    expect(invokedCount("google_connect")).toBe(0);
    expect(lastState()).toMatchObject({
      error: "TEAM_DECRYPT_FAILED",
      errorSeq: 1,
      pending: null,
      joined: false,
      busy: false,
      googleNeedsConnect: false,
    });
  });

  it("a confirm followed by a failed Google sign-in sets googleNeedsConnect", async () => {
    await start();
    await openUrl(LINK_A1);
    h.reconnectGoogle.mockResolvedValue({ ok: false, code: "GOOGLE_AUTH_REJECTED" });

    await act({ type: "confirm" });

    expect(lastState()).toMatchObject({ joined: true, googleNeedsConnect: true, error: null });

    // A later join that finds Google connected clears the stale flag.
    h.googleConnected = true;
    await openUrl(LINK_B1);
    await act({ type: "confirm" });
    expect(h.reconnectGoogle).toHaveBeenCalledTimes(1);
    expect(lastState()).toMatchObject({ joined: true, googleNeedsConnect: false });
  });

  it("a leave during Google sign-in keeps googleNeedsConnect off", async () => {
    await start();
    await openUrl(LINK_A1);
    const google = deferred<{ ok: false; code: string }>();
    h.reconnectGoogle.mockReturnValue(google.promise);

    await act({ type: "confirm" });
    expect(lastState()).toMatchObject({ joined: true, busy: false });
    await act({ type: "leave" });
    google.resolve({ ok: false, code: "GOOGLE_AUTH_REJECTED" });
    await flush();

    expect(h.leaveTeam).toHaveBeenCalledTimes(1);
    expect(lastState()).toMatchObject({ joined: false, googleNeedsConnect: false });

    // A tick already in flight when the user left changes nothing either.
    h.stored = A1;
    const tick = deferred<unknown>();
    h.syncTeam.mockReturnValueOnce(tick.promise);
    await vi.advanceTimersByTimeAsync(TEAM_REFRESH_MS);
    tick.resolve({ ok: true, value: { changed: true, googleClientChanged: true } });
    await flush();
    expect(lastState()).toMatchObject({ joined: false, googleNeedsConnect: false });
  });

  it("a leave during an in-flight confirm is ignored", async () => {
    await start();
    await openUrl(LINK_A1);
    const sync = deferred<typeof OK>();
    h.syncTeam.mockReturnValue(sync.promise);

    h.actionHandler!({ payload: { type: "confirm" } });
    await flush();
    await act({ type: "leave" });

    expect(h.leaveTeam).not.toHaveBeenCalled();
    sync.resolve(OK);
    await flush();
    expect(lastState().joined).toBe(true);
  });

  it("a state-request mid-confirm reports busy", async () => {
    await start();
    await openUrl(LINK_A1);
    const sync = deferred<typeof OK>();
    h.syncTeam.mockReturnValue(sync.promise);
    h.actionHandler!({ payload: { type: "confirm" } });
    await flush();
    h.emit.mockClear();

    await act({ type: "state-request" });

    expect(states()).toHaveLength(1);
    expect(lastState().busy).toBe(true);
    sync.resolve(OK);
    await flush();
    expect(lastState().busy).toBe(false);
  });

  it("a throwing action clears busy and reports TEAM_WRITE_FAILED", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    await start();
    await openUrl(LINK_A1);
    h.syncTeam.mockRejectedValue(new Error("boom"));

    await act({ type: "confirm" });

    expect(lastState()).toMatchObject({ busy: false, error: "TEAM_WRITE_FAILED", errorSeq: 1 });
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn).toHaveBeenCalledWith("[team] controller step failed");
  });

  it("a rejected google_status counts as not connected", async () => {
    h.stored = A1;
    h.invoke.mockImplementation(async (cmd: string) => {
      if (cmd === "google_status") throw new Error("no graph");
      return undefined;
    });
    await start();

    expect(lastState()).toMatchObject({ joined: true, googleNeedsConnect: true });

    // The same on a join: the sign-in starts.
    await openUrl(LINK_B1);
    await act({ type: "confirm" });
    expect(h.reconnectGoogle).toHaveBeenCalledTimes(1);
  });

  it("leave and connect-google update joined and googleNeedsConnect", async () => {
    h.stored = A1;
    h.leaveTeam.mockImplementation(async () => {
      h.stored = null;
    });
    await start();
    expect(lastState()).toMatchObject({ joined: true, googleNeedsConnect: true });

    h.reconnectGoogle.mockResolvedValue({ ok: true });
    await act({ type: "connect-google" });
    expect(lastState().googleNeedsConnect).toBe(false);

    h.reconnectGoogle.mockResolvedValue({ ok: false, code: "GOOGLE_AUTH_REJECTED" });
    await act({ type: "connect-google" });
    expect(h.reconnectGoogle).toHaveBeenCalledTimes(2);
    expect(lastState().googleNeedsConnect).toBe(true);

    await act({ type: "leave" });
    expect(h.leaveTeam).toHaveBeenCalledTimes(1);
    expect(lastState()).toMatchObject({ joined: false, googleNeedsConnect: false });

    // The 4 h tick reads the store fresh, so a left team is never re-applied.
    h.syncTeam.mockClear();
    await vi.advanceTimersByTimeAsync(TEAM_REFRESH_MS);
    expect(h.syncTeam).not.toHaveBeenCalled();

    // Not joined: a failed sign-in asks for no reconnect.
    await act({ type: "connect-google" });
    expect(h.reconnectGoogle).toHaveBeenCalledTimes(3);
    expect(lastState().googleNeedsConnect).toBe(false);
  });

  it("check-owner-link reports ok or the code and applies nothing", async () => {
    await start();

    await act({ type: "check-owner-link" });
    expect(lastState().check).toEqual({ ok: false, code: "TEAM_LINK_INVALID" });
    expect(h.fetchTeamFile).not.toHaveBeenCalled();

    h.loadOwnerTeamLink.mockResolvedValue(A1);
    await act({ type: "check-owner-link" });
    expect(h.fetchTeamFile).toHaveBeenCalledWith(A1);
    expect(lastState().check).toEqual({ ok: true });

    h.fetchTeamFile.mockResolvedValue({ ok: false, code: "TEAM_DECRYPT_FAILED" });
    await act({ type: "check-owner-link" });
    expect(lastState().check).toEqual({ ok: false, code: "TEAM_DECRYPT_FAILED" });

    expect(h.syncTeam).not.toHaveBeenCalled();
    expect(lastState().joined).toBe(false);
  });

  it("join and state-request route through the same controller", async () => {
    await start();
    h.emit.mockClear();

    await act({ type: "state-request" });
    expect(states()).toHaveLength(1);

    await act({ type: "join", link: LINK_A1 });
    expect(lastState().pending).toEqual(prompt("012345", false));
    expect(h.listen).toHaveBeenCalledWith(TEAM_ACTION_EVENT, expect.any(Function));
  });
});

describe("team controller: start, refresh and stop", () => {
  it("start: stored link syncs; a fetch failure retries once after 60 s, then waits for the 4 h tick", async () => {
    h.stored = A1;
    h.syncTeam.mockResolvedValue(fail("TEAM_FETCH_FAILED"));
    await start();
    expect(h.syncTeam).toHaveBeenCalledTimes(1);
    expect(h.syncTeam).toHaveBeenCalledWith(A1, { firstJoin: false });

    await vi.advanceTimersByTimeAsync(TEAM_START_RETRY_MS - 1);
    expect(h.syncTeam).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(h.syncTeam).toHaveBeenCalledTimes(2);
    expect(h.syncTeam).toHaveBeenLastCalledWith(A1, { firstJoin: false });

    // The retry failed too: nothing more until the 4 h tick.
    await vi.advanceTimersByTimeAsync(TEAM_REFRESH_MS - TEAM_START_RETRY_MS - 1);
    expect(h.syncTeam).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(1);
    expect(h.syncTeam).toHaveBeenCalledTimes(3);
    // A failed tick schedules no retry.
    await vi.advanceTimersByTimeAsync(TEAM_START_RETRY_MS);
    expect(h.syncTeam).toHaveBeenCalledTimes(3);
  });

  it("a refresh that changes the Google client sets googleNeedsConnect and opens no browser", async () => {
    // Failure branch, on the startup sync, with Google connected.
    h.stored = A1;
    h.googleConnected = true;
    h.syncTeam.mockResolvedValue({ ...fail("TEAM_WRITE_FAILED", true), landed: true });
    await start();
    expect(lastState().googleNeedsConnect).toBe(true);

    // Success branch, on the 4 h tick.
    __resetTeamControllerForTests();
    h.emit.mockClear();
    h.syncTeam.mockResolvedValue(OK);
    await start();
    expect(lastState().googleNeedsConnect).toBe(false);
    h.syncTeam.mockResolvedValue({ ok: true, value: { changed: true, googleClientChanged: true } });
    await vi.advanceTimersByTimeAsync(TEAM_REFRESH_MS);
    expect(h.syncTeam).toHaveBeenLastCalledWith(A1, { firstJoin: false });
    expect(lastState().googleNeedsConnect).toBe(true);

    expect(h.reconnectGoogle).not.toHaveBeenCalled();
    expect(invokedCount("google_connect")).toBe(0);
  });

  it("the 4 h tick re-syncs the stored link", async () => {
    h.stored = A1;
    await start();
    h.syncTeam.mockClear();

    await vi.advanceTimersByTimeAsync(TEAM_REFRESH_MS - 1);
    expect(h.syncTeam).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);

    expect(h.syncTeam).toHaveBeenCalledTimes(1);
    expect(h.syncTeam).toHaveBeenCalledWith(A1, { firstJoin: false });
  });

  it("start emits state after google_status resolves", async () => {
    h.stored = A1;
    const status = deferred<{ connected: boolean; sessionOnly: boolean }>();
    h.invoke.mockImplementation((cmd: string) =>
      cmd === "google_status" ? status.promise : Promise.resolve(undefined)
    );
    stop = startTeamController();
    await flush();
    expect(states().some((s) => s.joined)).toBe(false);

    status.resolve({ connected: false, sessionOnly: false });
    await flush();
    expect(lastState()).toMatchObject({ joined: true, googleNeedsConnect: true });

    // Connected: joined, nothing to reconnect.
    __resetTeamControllerForTests();
    h.emit.mockClear();
    h.googleConnected = true;
    h.invoke.mockImplementation(async (cmd: string) =>
      cmd === "google_status" ? { connected: h.googleConnected, sessionOnly: false } : undefined
    );
    await start();
    expect(lastState()).toMatchObject({ joined: true, googleNeedsConnect: false });
  });

  it("stop() clears timers and listeners", async () => {
    h.stored = A1;
    await start();
    expect(vi.getTimerCount()).toBeGreaterThan(0);
    h.syncTeam.mockClear();

    stop!();
    stop = null;

    expect(h.unlistenAction).toHaveBeenCalledTimes(1);
    expect(h.unlistenUrl).toHaveBeenCalledTimes(1);
    expect(vi.getTimerCount()).toBe(0);
    await vi.advanceTimersByTimeAsync(TEAM_REFRESH_MS);
    expect(h.syncTeam).not.toHaveBeenCalled();
  });

  it("stop() during a confirm leaves the next run with no prompt and not busy", async () => {
    await start();
    await openUrl(LINK_B1);
    h.syncTeam.mockReturnValue(new Promise(() => {}));
    h.actionHandler!({ payload: { type: "confirm" } });
    await flush();
    expect(lastState()).toMatchObject({ busy: true, pending: { gistShort: "fedcba" } });

    stop!();
    h.emit.mockClear();
    await start();

    expect(lastState()).toMatchObject({ busy: false, pending: null });
  });

  it("a listener that resolves after stop() is unlistened at once and never handles an event", async () => {
    h.stored = A1;
    h.getCurrent.mockResolvedValue([LINK_B1]);
    const actionReg = deferred<() => void>();
    const urlReg = deferred<() => void>();
    h.listen.mockImplementation((_event: string, cb: Handler<{ payload: unknown }>) => {
      h.actionHandler = cb;
      return actionReg.promise;
    });
    h.onOpenUrl.mockImplementation((cb: Handler<string[]>) => {
      h.urlHandler = cb;
      return urlReg.promise;
    });

    const stopFirst = startTeamController();
    stopFirst();
    actionReg.resolve(h.unlistenAction);
    urlReg.resolve(h.unlistenUrl);
    await flush();

    expect(h.unlistenAction).toHaveBeenCalledTimes(1);
    expect(h.unlistenUrl).toHaveBeenCalledTimes(1);
    expect(h.syncTeam).not.toHaveBeenCalled();
    expect(h.emit).not.toHaveBeenCalled();
    expect(invokedCount("open_dashboard")).toBe(0);
    expect(vi.getTimerCount()).toBe(0);

    // StrictMode's second mount holds a pending link; the leaked first-mount
    // handlers must neither join it nor touch state.
    const staleAction = h.actionHandler!;
    const staleUrl = h.urlHandler!;
    h.listen.mockImplementation(async (_event: string, cb: Handler<{ payload: unknown }>) => {
      h.actionHandler = cb;
      return vi.fn();
    });
    h.onOpenUrl.mockImplementation(async (cb: Handler<string[]>) => {
      h.urlHandler = cb;
      return vi.fn();
    });
    h.getCurrent.mockResolvedValue(null);
    await start();
    await openUrl(LINK_B1);
    expect(lastState().pending).toEqual(prompt("fedcba", true));
    h.emit.mockClear();
    h.invoke.mockClear();

    staleUrl(["meetwings://team/bad"]);
    staleAction({ payload: { type: "confirm" } });
    await flush();

    expect(h.syncTeam).not.toHaveBeenCalledWith(expect.anything(), { firstJoin: true });
    expect(h.emit).not.toHaveBeenCalled();
    expect(h.invoke).not.toHaveBeenCalled();

    // Control: the live handler joins exactly once.
    await act({ type: "confirm" });
    expect(h.syncTeam).toHaveBeenCalledWith({ gistId: GIST_B, key: KEY_1 }, { firstJoin: true });
    expect(h.syncTeam.mock.calls.filter(([, o]) => o.firstJoin)).toHaveLength(1);
  });
});

describe("useTeamSync", () => {
  it("useTeamSync does nothing outside the main window", async () => {
    h.label = "dashboard";
    renderHook(() => useTeamSync());
    await flush();

    expect(h.listen).not.toHaveBeenCalled();
    expect(h.onOpenUrl).not.toHaveBeenCalled();
    expect(h.getCurrent).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);

    // Control: in main it starts, and unmount stops it.
    h.label = "main";
    const { unmount } = renderHook(() => useTeamSync());
    await flush();
    expect(h.listen).toHaveBeenCalledWith(TEAM_ACTION_EVENT, expect.any(Function));
    expect(h.getCurrent).toHaveBeenCalledTimes(1);
    unmount();
    expect(h.unlistenAction).toHaveBeenCalledTimes(1);
    expect(vi.getTimerCount()).toBe(0);
  });
});
