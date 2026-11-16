import { invoke } from "@tauri-apps/api/core";
import { relaunch } from "@tauri-apps/plugin-process";
import { check, type Update } from "@tauri-apps/plugin-updater";
import { STORAGE_KEYS } from "@/config/constants";
import { safeLocalStorage } from "@/lib/storage/helper";
import { canInstallNow, type GateInput } from "./install-gate";
import { getActivitySnapshot } from "./recording-activity.store";

export const UPDATE_TICK_MS = 4 * 60 * 60 * 1000;
export const INSTALL_RECHECK_MS = 5 * 60 * 1000;
export const CHECK_TIMEOUT_MS = 60 * 1000;

export type SilentUpdaterStatus =
  | { kind: "idle" }
  | { kind: "waiting"; version: string }
  | { kind: "relaunch-pending"; version: string }
  | { kind: "install-failed"; version: string };

export interface SilentUpdaterDeps {
  check: () => Promise<Update | null>;
  relaunch: () => Promise<void>;
  readGateInput: () => Promise<GateInput>;
  now: () => number;
}

/**
 * The install gate's input. A rejected `get_capture_status` counts as
 * capturing: an unknown Rust capture state must defer, never install.
 */
export async function readGateInput(): Promise<GateInput> {
  const rust = await invoke<boolean>("get_capture_status").catch(() => true);
  const snapshot = getActivitySnapshot();
  return {
    capturing: snapshot.capturing || rust,
    meetingActive: snapshot.meetingActive,
    lastCaptureEndedAt: snapshot.lastCaptureEndedAt,
    now: Date.now(),
  };
}

const DEFAULT_DEPS: SilentUpdaterDeps = {
  // The timeout makes a stalled request reject instead of holding `busy` forever.
  check: () => check({ timeout: CHECK_TIMEOUT_MS }),
  relaunch,
  readGateInput,
  now: () => Date.now(),
};

const IDLE: SilentUpdaterStatus = { kind: "idle" };

let deps: SilentUpdaterDeps = DEFAULT_DEPS;
let status: SilentUpdaterStatus = IDLE;
const subscribers = new Set<() => void>();
// One flag for a check, a download, an install and a relaunch.
let busy = false;
let held: { update: Update; installed: boolean } | null = null;
// Memory only, so the next app start clears it.
let failedVersion: string | null = null;
// Bumped by stop(). A continuation whose captured generation is stale returns
// at once and never touches module state, including the next run's `busy`.
let generation = 0;
let tickTimer: ReturnType<typeof setInterval> | null = null;
let recheckTimer: ReturnType<typeof setTimeout> | null = null;

const statusKey = (s: SilentUpdaterStatus) =>
  s.kind === "idle" ? s.kind : `${s.kind}:${s.version}`;

/** Replaces the status only on a real transition, and only then notifies. */
function setStatus(next: SilentUpdaterStatus): void {
  if (statusKey(next) === statusKey(status)) return;
  status = next;
  subscribers.forEach((cb) => cb());
}

/**
 * MUST return the stored reference, not a fresh object: useSyncExternalStore
 * loops on a new snapshot reference (same contract as overlay-minimize.store).
 */
export const getSilentUpdaterStatus = (): SilentUpdaterStatus => status;

export function subscribeSilentUpdater(cb: () => void): () => void {
  subscribers.add(cb);
  return () => {
    subscribers.delete(cb);
  };
}

/** Runs `step` under the busy flag; a no-op while another step holds it. */
async function exclusive(step: (gen: number) => Promise<void>): Promise<void> {
  if (busy) return;
  const gen = generation;
  busy = true;
  try {
    await step(gen);
  } finally {
    if (gen === generation) busy = false;
  }
}

function clearRecheck(): void {
  if (recheckTimer !== null) clearTimeout(recheckTimer);
  recheckTimer = null;
}

/** A re-check that fires while `busy` is set reschedules itself. */
function scheduleRecheck(step: (gen: number) => Promise<void>): void {
  recheckTimer = setTimeout(() => {
    recheckTimer = null;
    if (busy) scheduleRecheck(step);
    else void exclusive(step);
  }, INSTALL_RECHECK_MS);
}

async function checkAndDownload(gen: number): Promise<void> {
  let update: Update | null;
  try {
    update = await deps.check();
    if (gen !== generation) return;
    safeLocalStorage.setItem(
      STORAGE_KEYS.UPDATER_LAST_CHECK_AT,
      String(deps.now())
    );
    if (
      !update ||
      update.version === failedVersion ||
      update.version === held?.update.version
    ) {
      return;
    }
    // No hard cap on the download.
    await update.download();
    if (gen !== generation) return;
  } catch {
    if (gen !== generation) return;
    console.error("[updater] check/download failed");
    return;
  }
  // A newer release replaces one still waiting for the gate.
  held = { update, installed: false };
  await attemptInstall(gen);
}

function tick(): void {
  // An installed update awaiting relaunch belongs to the re-check timer.
  if (held?.installed) return;
  void exclusive(checkAndDownload);
}

async function attemptInstall(gen: number): Promise<void> {
  clearRecheck();
  const target = held;
  if (!target) return;
  const gate = await deps.readGateInput();
  if (gen !== generation) return;
  if (!canInstallNow(gate)) {
    setStatus({ kind: "waiting", version: target.update.version });
    scheduleRecheck(attemptInstall);
    return;
  }
  try {
    await target.update.install();
  } catch {
    // Includes a cancelled macOS password prompt. Only this version stays
    // blocked; a newer release still installs on the next tick.
    if (gen !== generation) return;
    failedVersion = target.update.version;
    held = null;
    setStatus({ kind: "install-failed", version: target.update.version });
    return;
  }
  if (gen !== generation) return;
  target.installed = true;
  await attemptRelaunch(gen);
}

async function attemptRelaunch(gen: number): Promise<void> {
  const target = held;
  if (!target) return;
  const gate = await deps.readGateInput();
  if (gen !== generation) return;
  if (!canInstallNow(gate)) {
    setStatus({ kind: "relaunch-pending", version: target.update.version });
    scheduleRecheck(attemptRelaunch);
    return;
  }
  try {
    await deps.relaunch();
  } catch {
    // The update stays marked installed, so a retry only relaunches.
    if (gen !== generation) return;
    setStatus({ kind: "install-failed", version: target.update.version });
  }
}

/** Runs a tick now and every UPDATE_TICK_MS. Returns stop. */
export function startSilentUpdater(
  overrides: Partial<SilentUpdaterDeps> = {}
): () => void {
  deps = { ...DEFAULT_DEPS, ...overrides };
  tick();
  tickTimer = setInterval(tick, UPDATE_TICK_MS);
  return stopSilentUpdater;
}

/**
 * Under StrictMode the first mount's in-flight download cannot be cancelled;
 * the generation bump discards whatever it resolves to.
 */
function stopSilentUpdater(): void {
  if (tickTimer !== null) clearInterval(tickTimer);
  tickTimer = null;
  clearRecheck();
  busy = false;
  held = null;
  generation++;
}

/**
 * The retry button. An installed update only relaunches (no second install,
 * no second macOS password prompt); otherwise the failed version is unblocked
 * and checked again.
 */
export function retryInstall(): void {
  if (held?.installed) {
    void exclusive(attemptRelaunch);
    return;
  }
  failedVersion = null;
  setStatus(IDLE);
  tick();
}

/** Wipe all module state between tests. */
export function __resetSilentUpdaterForTests(): void {
  stopSilentUpdater();
  deps = DEFAULT_DEPS;
  status = IDLE;
  failedVersion = null;
}
