import { afterEach, beforeEach, describe, expect, it, vi, type Mock } from "vitest";
import type { Update } from "@tauri-apps/plugin-updater";

const mocks = vi.hoisted(() => ({ check: vi.fn(), invoke: vi.fn() }));
vi.mock("@tauri-apps/plugin-updater", () => ({ check: mocks.check }));
vi.mock("@tauri-apps/plugin-process", () => ({ relaunch: vi.fn() }));
vi.mock("@tauri-apps/api/core", () => ({ invoke: mocks.invoke }));

import {
  CHECK_TIMEOUT_MS,
  INSTALL_RECHECK_MS,
  UPDATE_TICK_MS,
  __resetSilentUpdaterForTests,
  getSilentUpdaterStatus,
  readGateInput,
  retryInstall,
  startSilentUpdater,
  subscribeSilentUpdater,
  type SilentUpdaterDeps,
} from "@/lib/updater/silent-updater";
import {
  __resetActivityForTests,
  setCaptureActive,
  setMeetingActive,
} from "@/lib/updater/recording-activity.store";
import type { GateInput } from "@/lib/updater/install-gate";
import { STORAGE_KEYS } from "@/config/constants";
import { installMemoryLocalStorage } from "@/tests/memory-local-storage";

const NOW = 1_700_000_000_000;
const idle = (): GateInput => ({
  capturing: false,
  meetingActive: false,
  lastCaptureEndedAt: null,
  now: NOW,
});
const busy = (): GateInput => ({ ...idle(), capturing: true });

interface FakeUpdate {
  version: string;
  download: Mock;
  install: Mock;
  close: Mock;
}
const fakeUpdate = (version: string): FakeUpdate => ({
  version,
  download: vi.fn().mockResolvedValue(undefined),
  install: vi.fn().mockResolvedValue(undefined),
  close: vi.fn().mockResolvedValue(undefined),
});
const asUpdate = (u: FakeUpdate) => u as unknown as Update;

/** A promise the test settles by hand, to hold a step in flight. */
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}

const flush = () => vi.advanceTimersByTimeAsync(0);

let deps: {
  check: Mock<SilentUpdaterDeps["check"]>;
  relaunch: Mock<SilentUpdaterDeps["relaunch"]>;
  readGateInput: Mock<SilentUpdaterDeps["readGateInput"]>;
  now: Mock<SilentUpdaterDeps["now"]>;
};
let stop: (() => void) | null;
let storage: Map<string, string>;
let errorSpy: ReturnType<typeof vi.spyOn>;

const start = () => {
  stop = startSilentUpdater(deps);
};

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(NOW);
  __resetSilentUpdaterForTests();
  __resetActivityForTests();
  storage = installMemoryLocalStorage();
  mocks.check.mockReset();
  mocks.invoke.mockReset();
  deps = {
    check: vi.fn<SilentUpdaterDeps["check"]>(),
    relaunch: vi.fn<SilentUpdaterDeps["relaunch"]>().mockResolvedValue(undefined),
    readGateInput: vi
      .fn<SilentUpdaterDeps["readGateInput"]>()
      .mockResolvedValue(idle()),
    now: vi.fn<SilentUpdaterDeps["now"]>(() => NOW),
  };
  stop = null;
  errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
});

afterEach(() => {
  stop?.();
  errorSpy.mockRestore();
  vi.useRealTimers();
});

describe("silent updater scheduler", () => {
  it("pins the tick, re-check and check-timeout constants", () => {
    expect(UPDATE_TICK_MS).toBe(4 * 60 * 60 * 1000);
    expect(INSTALL_RECHECK_MS).toBe(5 * 60 * 1000);
    expect(CHECK_TIMEOUT_MS).toBe(60 * 1000);
  });

  it("idle: downloads, installs, relaunches in order and stamps the last check", async () => {
    const u = fakeUpdate("1.6.0");
    deps.check.mockResolvedValue(asUpdate(u));
    start();
    await flush();

    expect(u.download).toHaveBeenCalledTimes(1);
    expect(u.install).toHaveBeenCalledTimes(1);
    expect(deps.relaunch).toHaveBeenCalledTimes(1);
    expect(u.download.mock.invocationCallOrder[0]).toBeLessThan(
      u.install.mock.invocationCallOrder[0]
    );
    expect(u.install.mock.invocationCallOrder[0]).toBeLessThan(
      deps.relaunch.mock.invocationCallOrder[0]
    );
    expect(storage.get(STORAGE_KEYS.UPDATER_LAST_CHECK_AT)).toBe(String(NOW));
  });

  it("busy: downloads but defers install, then installs on the re-check once idle", async () => {
    const u = fakeUpdate("1.6.0");
    deps.check.mockResolvedValue(asUpdate(u));
    deps.readGateInput.mockResolvedValue(busy());
    start();
    await flush();

    expect(u.download).toHaveBeenCalledTimes(1);
    expect(u.install).not.toHaveBeenCalled();
    expect(getSilentUpdaterStatus()).toEqual({ kind: "waiting", version: "1.6.0" });

    deps.readGateInput.mockResolvedValue(idle());
    await vi.advanceTimersByTimeAsync(INSTALL_RECHECK_MS);

    expect(u.install).toHaveBeenCalledTimes(1);
    expect(deps.relaunch).toHaveBeenCalledTimes(1);
  });

  it("re-reads the gate after the download (a recording that started during download is seen)", async () => {
    const u = fakeUpdate("1.6.0");
    const download = deferred<void>();
    u.download.mockReturnValue(download.promise);
    deps.check.mockResolvedValue(asUpdate(u));
    start();
    await flush();

    // Download in flight: the gate has not been read yet.
    expect(u.download).toHaveBeenCalledTimes(1);
    expect(deps.readGateInput).not.toHaveBeenCalled();

    // A recording starts while the download runs.
    deps.readGateInput.mockResolvedValue(busy());
    download.resolve();
    await flush();

    expect(deps.readGateInput).toHaveBeenCalledTimes(1);
    expect(u.install).not.toHaveBeenCalled();
    expect(getSilentUpdaterStatus()).toEqual({ kind: "waiting", version: "1.6.0" });
  });

  it("defers the relaunch when a recording starts between install and relaunch", async () => {
    const u = fakeUpdate("1.6.0");
    deps.check.mockResolvedValue(asUpdate(u));
    deps.readGateInput
      .mockResolvedValueOnce(idle())
      .mockResolvedValueOnce(busy())
      .mockResolvedValue(idle());
    start();
    await flush();

    expect(u.install).toHaveBeenCalledTimes(1);
    expect(deps.relaunch).not.toHaveBeenCalled();
    expect(getSilentUpdaterStatus()).toEqual({
      kind: "relaunch-pending",
      version: "1.6.0",
    });

    await vi.advanceTimersByTimeAsync(INSTALL_RECHECK_MS);

    expect(deps.relaunch).toHaveBeenCalledTimes(1);
    expect(u.install).toHaveBeenCalledTimes(1);
  });

  it("a failed check installs nothing and retries on the next tick", async () => {
    deps.check
      .mockRejectedValueOnce(new Error("offline"))
      .mockResolvedValue(null);
    start();
    await flush();

    expect(errorSpy.mock.calls).toEqual([["[updater] check/download failed"]]);
    expect(deps.readGateInput).not.toHaveBeenCalled();
    expect(deps.relaunch).not.toHaveBeenCalled();
    expect(storage.has(STORAGE_KEYS.UPDATER_LAST_CHECK_AT)).toBe(false);

    await vi.advanceTimersByTimeAsync(UPDATE_TICK_MS);

    expect(deps.check).toHaveBeenCalledTimes(2);
    expect(storage.get(STORAGE_KEYS.UPDATER_LAST_CHECK_AT)).toBe(String(NOW));
    expect(deps.readGateInput).not.toHaveBeenCalled();
  });

  it("a failed download installs nothing; the next tick retries", async () => {
    const u = fakeUpdate("1.6.0");
    u.download.mockRejectedValueOnce(new Error("network"));
    deps.check.mockResolvedValue(asUpdate(u));
    start();
    await flush();

    expect(errorSpy.mock.calls).toEqual([["[updater] check/download failed"]]);
    expect(u.install).not.toHaveBeenCalled();
    expect(deps.relaunch).not.toHaveBeenCalled();
    expect(getSilentUpdaterStatus()).toEqual({ kind: "idle" });

    await vi.advanceTimersByTimeAsync(UPDATE_TICK_MS);

    expect(u.download).toHaveBeenCalledTimes(2);
    expect(u.install).toHaveBeenCalledTimes(1);
    expect(deps.relaunch).toHaveBeenCalledTimes(1);
  });

  it("a failed install is not retried for that version until retryInstall", async () => {
    const u = fakeUpdate("1.6.0");
    u.install.mockRejectedValueOnce(new Error("password prompt cancelled"));
    deps.check.mockResolvedValue(asUpdate(u));
    start();
    await flush();

    expect(getSilentUpdaterStatus()).toEqual({
      kind: "install-failed",
      version: "1.6.0",
    });
    expect(deps.relaunch).not.toHaveBeenCalled();
    expect(u.close).toHaveBeenCalledTimes(1);

    await vi.advanceTimersByTimeAsync(UPDATE_TICK_MS);

    expect(deps.check).toHaveBeenCalledTimes(2);
    expect(u.download).toHaveBeenCalledTimes(1);
    expect(u.install).toHaveBeenCalledTimes(1);
    expect(getSilentUpdaterStatus()).toEqual({
      kind: "install-failed",
      version: "1.6.0",
    });
    // The rejected install released the update; the failed-version discard
    // at the retry tick releases it once more.
    expect(u.close).toHaveBeenCalledTimes(2);

    retryInstall();
    await flush();

    expect(deps.check).toHaveBeenCalledTimes(3);
    expect(u.download).toHaveBeenCalledTimes(2);
    expect(u.install).toHaveBeenCalledTimes(2);
    expect(deps.relaunch).toHaveBeenCalledTimes(1);
    expect(u.close).toHaveBeenCalledTimes(2);
  });

  it("sets the relaunch flag immediately before install, not while the gate is closed", async () => {
    // Windows' installer relaunches with the same argv, replaying a launch link.
    const u = fakeUpdate("1.6.0");
    let flagAtInstall: string | undefined;
    u.install.mockImplementation(async () => {
      flagAtInstall = storage.get("mw_relaunch_after_update");
    });
    deps.check.mockResolvedValue(asUpdate(u));
    deps.readGateInput.mockResolvedValue(busy());
    start();
    await flush();
    expect(getSilentUpdaterStatus()).toEqual({ kind: "waiting", version: "1.6.0" });
    expect(storage.has("mw_relaunch_after_update")).toBe(false);

    deps.readGateInput.mockResolvedValue(idle());
    await vi.advanceTimersByTimeAsync(INSTALL_RECHECK_MS);

    expect(u.install).toHaveBeenCalledTimes(1);
    expect(flagAtInstall).toBe("1");
  });

  it("clears the relaunch flag when install throws", async () => {
    const u = fakeUpdate("1.6.0");
    let flagAtInstall: string | undefined;
    u.install.mockImplementation(async () => {
      flagAtInstall = storage.get("mw_relaunch_after_update");
      throw new Error("installer failed");
    });
    deps.check.mockResolvedValue(asUpdate(u));
    start();
    await flush();

    expect(flagAtInstall).toBe("1");
    expect(getSilentUpdaterStatus()).toEqual({ kind: "install-failed", version: "1.6.0" });
    expect(storage.has("mw_relaunch_after_update")).toBe(false);
  });

  it("a newer version after a failed install installs automatically", async () => {
    const u1 = fakeUpdate("1.6.0");
    u1.install.mockRejectedValue(new Error("failed"));
    const u2 = fakeUpdate("1.6.1");
    deps.check
      .mockResolvedValueOnce(asUpdate(u1))
      .mockResolvedValue(asUpdate(u2));
    start();
    await flush();

    expect(getSilentUpdaterStatus()).toEqual({
      kind: "install-failed",
      version: "1.6.0",
    });

    await vi.advanceTimersByTimeAsync(UPDATE_TICK_MS);

    expect(u2.download).toHaveBeenCalledTimes(1);
    expect(u2.install).toHaveBeenCalledTimes(1);
    expect(deps.relaunch).toHaveBeenCalledTimes(1);
    expect(u1.install).toHaveBeenCalledTimes(1);
  });

  it("a newer release while waiting for the gate replaces the held update", async () => {
    const u1 = fakeUpdate("1.6.0");
    const u2 = fakeUpdate("1.6.1");
    deps.check
      .mockResolvedValueOnce(asUpdate(u1))
      .mockResolvedValue(asUpdate(u2));
    deps.readGateInput.mockResolvedValue(busy());
    start();
    await flush();

    expect(u1.download).toHaveBeenCalledTimes(1);
    expect(getSilentUpdaterStatus()).toEqual({ kind: "waiting", version: "1.6.0" });

    await vi.advanceTimersByTimeAsync(UPDATE_TICK_MS);

    expect(u2.download).toHaveBeenCalledTimes(1);
    expect(getSilentUpdaterStatus()).toEqual({ kind: "waiting", version: "1.6.1" });

    deps.readGateInput.mockResolvedValue(idle());
    await vi.advanceTimersByTimeAsync(INSTALL_RECHECK_MS);

    expect(u2.install).toHaveBeenCalledTimes(1);
    expect(u1.install).not.toHaveBeenCalled();
    expect(deps.relaunch).toHaveBeenCalledTimes(1);
    expect(u1.close).toHaveBeenCalledTimes(1);
  });

  it("a re-check that fires while a tick holds busy reschedules itself", async () => {
    const u = fakeUpdate("1.6.0");
    deps.check.mockResolvedValueOnce(asUpdate(u));
    deps.readGateInput.mockResolvedValue(busy());
    start();
    await flush();

    expect(getSilentUpdaterStatus()).toEqual({ kind: "waiting", version: "1.6.0" });

    // The next tick's check hangs, holding busy across the next re-check.
    const pendingCheck = deferred<Update | null>();
    deps.check.mockReturnValueOnce(pendingCheck.promise);
    await vi.advanceTimersByTimeAsync(UPDATE_TICK_MS);
    expect(u.install).not.toHaveBeenCalled();

    deps.readGateInput.mockResolvedValue(idle());
    // A re-check fires while the hung check holds busy: it must reschedule.
    await vi.advanceTimersByTimeAsync(INSTALL_RECHECK_MS);
    expect(u.install).not.toHaveBeenCalled();

    pendingCheck.resolve(null);
    await flush();
    expect(u.install).not.toHaveBeenCalled();

    // The rescheduled re-check runs once busy clears, and installs.
    await vi.advanceTimersByTimeAsync(INSTALL_RECHECK_MS);
    expect(u.install).toHaveBeenCalledTimes(1);
    expect(deps.relaunch).toHaveBeenCalledTimes(1);
  });

  it("a rejected relaunch shows install-failed and retryInstall relaunches without reinstalling", async () => {
    const u = fakeUpdate("1.6.0");
    deps.check.mockResolvedValue(asUpdate(u));
    deps.relaunch
      .mockRejectedValueOnce(new Error("relaunch failed"))
      .mockResolvedValue(undefined);
    start();
    await flush();

    expect(getSilentUpdaterStatus()).toEqual({
      kind: "install-failed",
      version: "1.6.0",
    });

    // An installed update awaiting relaunch: the tick does not check again.
    await vi.advanceTimersByTimeAsync(UPDATE_TICK_MS);
    expect(deps.check).toHaveBeenCalledTimes(1);

    retryInstall();
    await flush();

    expect(u.install).toHaveBeenCalledTimes(1);
    expect(u.download).toHaveBeenCalledTimes(1);
    expect(deps.relaunch).toHaveBeenCalledTimes(2);
    expect(deps.check).toHaveBeenCalledTimes(1);
  });

  it("a tick while a check or download is in flight is skipped", async () => {
    const u = fakeUpdate("1.6.0");
    u.download.mockReturnValue(new Promise<void>(() => {}));
    deps.check.mockResolvedValue(asUpdate(u));
    start();
    await flush();

    await vi.advanceTimersByTimeAsync(UPDATE_TICK_MS);

    expect(deps.check).toHaveBeenCalledTimes(1);
    expect(u.download).toHaveBeenCalledTimes(1);
  });

  it("stop() cancels pending timers", async () => {
    // Held update waiting on the gate: both the interval and a re-check are armed.
    const u = fakeUpdate("1.6.0");
    deps.check.mockResolvedValue(asUpdate(u));
    deps.readGateInput.mockResolvedValue(busy());
    start();
    await flush();
    expect(deps.readGateInput).toHaveBeenCalledTimes(1);

    stop!();
    stop = null;
    await vi.advanceTimersByTimeAsync(2 * UPDATE_TICK_MS);

    expect(deps.check).toHaveBeenCalledTimes(1);
    expect(deps.readGateInput).toHaveBeenCalledTimes(1);
    expect(u.install).not.toHaveBeenCalled();
  });

  it("stop() mid-download installs nothing", async () => {
    const u = fakeUpdate("1.6.0");
    const download = deferred<void>();
    u.download.mockReturnValue(download.promise);
    deps.check.mockResolvedValue(asUpdate(u));
    start();
    await flush();

    stop!();
    stop = null;
    download.resolve();
    await flush();

    expect(deps.readGateInput).not.toHaveBeenCalled();
    expect(u.install).not.toHaveBeenCalled();
    expect(deps.relaunch).not.toHaveBeenCalled();
    expect(getSilentUpdaterStatus()).toEqual({ kind: "idle" });
  });

  it("StrictMode start/stop/start: the stale generation is discarded", async () => {
    const u1 = fakeUpdate("1.6.0");
    const u2 = fakeUpdate("1.6.1");
    const firstCheck = deferred<Update | null>();
    const u2Download = deferred<void>();
    u2.download.mockReturnValue(u2Download.promise);
    deps.check
      .mockReturnValueOnce(firstCheck.promise)
      .mockResolvedValueOnce(asUpdate(u2))
      .mockResolvedValue(null);
    const notified = vi.fn();
    const unsubscribe = subscribeSilentUpdater(notified);

    const stopFirst = startSilentUpdater(deps);
    stopFirst();
    start();
    await flush();
    expect(u2.download).toHaveBeenCalledTimes(1);

    // The first mount's check lands late. Its continuation, finally included,
    // must not touch the live generation (u2's download still holds busy).
    firstCheck.resolve(asUpdate(u1));
    await flush();
    await vi.advanceTimersByTimeAsync(UPDATE_TICK_MS);
    expect(deps.check).toHaveBeenCalledTimes(2);

    u2Download.resolve();
    await flush();

    expect(u1.download).not.toHaveBeenCalled();
    expect(u1.install).not.toHaveBeenCalled();
    expect(u2.install).toHaveBeenCalledTimes(1);
    expect(deps.relaunch).toHaveBeenCalledTimes(1);
    expect(getSilentUpdaterStatus()).toEqual({ kind: "idle" });
    expect(notified).not.toHaveBeenCalled();
    unsubscribe();
  });

  it("the status getter returns a stable reference", async () => {
    expect(getSilentUpdaterStatus()).toBe(getSilentUpdaterStatus());

    const notified = vi.fn();
    const unsubscribe = subscribeSilentUpdater(notified);
    deps.check.mockResolvedValue(asUpdate(fakeUpdate("1.6.0")));
    deps.readGateInput.mockResolvedValue(busy());
    start();
    await flush();

    const waiting = getSilentUpdaterStatus();
    expect(waiting).toEqual({ kind: "waiting", version: "1.6.0" });
    expect(notified).toHaveBeenCalledTimes(1);
    expect(getSilentUpdaterStatus()).toBe(waiting);

    // Another closed-gate re-check is not a transition: same reference, no notify.
    await vi.advanceTimersByTimeAsync(INSTALL_RECHECK_MS);
    expect(deps.readGateInput).toHaveBeenCalledTimes(2);
    expect(getSilentUpdaterStatus()).toBe(waiting);
    expect(notified).toHaveBeenCalledTimes(1);
    unsubscribe();
  });

  it("the default check dep passes CHECK_TIMEOUT_MS", async () => {
    mocks.check.mockResolvedValue(null);
    stop = startSilentUpdater({
      relaunch: deps.relaunch,
      readGateInput: deps.readGateInput,
      now: deps.now,
    });
    await flush();

    expect(mocks.check).toHaveBeenCalledTimes(1);
    expect(mocks.check).toHaveBeenCalledWith({ timeout: CHECK_TIMEOUT_MS });
  });
});

describe("readGateInput", () => {
  it("readGateInput fails closed when get_capture_status rejects", async () => {
    mocks.invoke.mockRejectedValue(new Error("ipc down"));
    setMeetingActive(true);
    setCaptureActive("mic", true, NOW - 20);
    setCaptureActive("mic", false, NOW - 10);

    expect(await readGateInput()).toEqual({
      capturing: true,
      meetingActive: true,
      lastCaptureEndedAt: NOW - 10,
      now: NOW,
    });
    expect(mocks.invoke).toHaveBeenCalledWith("get_capture_status");
  });

  it.each([
    [false, false, false],
    [true, false, true],
    [false, true, true],
    [true, true, true],
  ])(
    "readGateInput: store %s, rust %s -> capturing %s",
    async (store, rust, expected) => {
      if (store) setCaptureActive("system-audio", true);
      mocks.invoke.mockResolvedValue(rust);

      expect((await readGateInput()).capturing).toBe(expected);
    }
  );
});
