import { invoke } from "@tauri-apps/api/core";
import { emit, listen, type UnlistenFn } from "@tauri-apps/api/event";
import { getCurrent, onOpenUrl } from "@tauri-apps/plugin-deep-link";
import { reconnectGoogle } from "@/lib/calendar/google-connect";
import type { GraphStatus } from "@/types";
import type { ApplyResult } from "./team-apply";
import type { TeamErrorCode } from "./team-file";
import { parseTeamLink, shortGistId, type TeamLink } from "./team-link";
import {
  fetchTeamFile,
  leaveTeam,
  loadOwnerTeamLink,
  loadStoredTeamLink,
  syncTeam,
} from "./team-sync";

export const TEAM_STATE_EVENT = "team-state";
export const TEAM_ACTION_EVENT = "team-action";
export const TEAM_REFRESH_MS = 4 * 60 * 60 * 1000;
export const TEAM_START_RETRY_MS = 60_000;

export interface TeamUiState {
  joined: boolean;
  /** `owner` is the gist owner's GitHub login: public, and the only lasting trust signal. */
  pending: { gistShort: string; owner: string; switching: boolean } | null;
  busy: boolean;
  error: TeamErrorCode | null;
  /** Up by one on every non-null `error`, so the same error twice toasts twice. */
  errorSeq: number;
  check: { ok: true } | { ok: false; code: TeamErrorCode } | null;
  googleNeedsConnect: boolean;
}

export type TeamAction =
  | { type: "state-request" }
  | { type: "join"; link: string }
  | { type: "confirm" }
  | { type: "decline" }
  | { type: "leave" }
  | { type: "check-owner-link" }
  | { type: "connect-google" };

const initialState = (): TeamUiState => ({
  joined: false,
  pending: null,
  busy: false,
  error: null,
  errorSeq: 0,
  check: null,
  googleNeedsConnect: false,
});

// The link is a secret (its fragment is the AES key): it lives only here,
// never in state, emits, logs or errors.
let pendingLink: TeamLink | null = null;
// Bumped per incoming link, so a preview that resolves after a newer link is dropped.
let linkSeq = 0;
let state: TeamUiState = initialState();
// Bumped by stop(). Every continuation after an await checks it, so a stale
// run (StrictMode's first mount) never touches state, timers or listeners.
let generation = 0;
const unlisteners: UnlistenFn[] = [];
let refreshTimer: ReturnType<typeof setInterval> | null = null;
let retryTimer: ReturnType<typeof setTimeout> | null = null;

function emitState(): void {
  void emit(TEAM_STATE_EVENT, { ...state }).catch(() => {});
}

function setError(code: TeamErrorCode): void {
  state.error = code;
  state.errorSeq += 1;
}

const openDashboard = () => void invoke("open_dashboard").catch(() => {});

/** A rejected google_status counts as not connected. */
const googleConnected = () =>
  invoke<GraphStatus>("google_status").then(
    (s) => s.connected,
    () => false
  );

/**
 * Never throws and always ends with an emit. `busy` is cleared by confirm's
 * own finally (its only setter), so a concurrent step never clears it mid-join.
 */
async function step(gen: number, body: () => Promise<void>): Promise<void> {
  if (gen !== generation) return;
  try {
    await body();
  } catch {
    if (gen !== generation) return;
    // Never the error object: it may name the link.
    console.warn("[team] controller step failed");
    setError("TEAM_WRITE_FAILED");
  } finally {
    if (gen === generation) emitState();
  }
}

/** A registration that resolves after stop() is unlistened at once. */
function register(gen: number, subscribe: () => Promise<UnlistenFn>): void {
  void step(gen, async () => {
    const un = await subscribe();
    if (gen !== generation) un();
    else unlisteners.push(un);
  });
}

const sameLink = (a: TeamLink, b: TeamLink) => a.gistId === b.gistId && a.key === b.key;

/**
 * A sync that changed the Google client asks for a reconnect; it never opens a
 * browser. Not after a leave that landed while the sync ran.
 */
function noteGoogleChange(result: ApplyResult): void {
  if (!state.joined) return;
  if (result.ok ? result.value.googleClientChanged : result.googleClientChanged) {
    state.googleNeedsConnect = true;
  }
}

async function resync(gen: number, link: TeamLink): Promise<void> {
  const result = await syncTeam(link, { firstJoin: false });
  if (gen !== generation) return;
  noteGoogleChange(result);
}

/** Reads the store fresh, so a team left since start is never re-applied. */
async function refresh(gen: number): Promise<void> {
  const stored = await loadStoredTeamLink();
  if (gen !== generation || !stored) return;
  await resync(gen, stored);
}

async function handleIncomingLink(gen: number, raw: string): Promise<void> {
  const seq = ++linkSeq;
  state.error = null;
  const link = parseTeamLink(raw);
  if (!link) {
    setError("TEAM_LINK_INVALID");
    openDashboard();
    return;
  }
  const stored = await loadStoredTeamLink();
  if (gen !== generation) return;
  if (stored && sameLink(stored, link)) {
    await resync(gen, link);
    return;
  }
  if (seq !== linkSeq) return;
  // A new link replaces any open prompt at once, so a confirm racing the
  // preview can never apply the older link.
  pendingLink = null;
  state.pending = null;
  emitState();
  // Applies nothing; names the gist owner, the only lasting trust signal.
  const preview = await fetchTeamFile(link);
  if (gen !== generation || seq !== linkSeq) return;
  if (!preview.ok) {
    setError(preview.code);
    openDashboard();
    return;
  }
  pendingLink = link;
  state.pending = {
    gistShort: shortGistId(link.gistId),
    owner: preview.value.ownerLogin,
    switching: stored !== null,
  };
  openDashboard();
}

async function confirm(gen: number): Promise<void> {
  const link = pendingLink;
  if (!link) return;
  // Cleared before any await, so a second confirm finds nothing to join.
  pendingLink = null;
  state.error = null;
  state.busy = true;
  emitState();
  let result: ApplyResult;
  try {
    result = await syncTeam(link, { firstJoin: true });
  } finally {
    if (gen === generation) {
      state.busy = false;
      // A link that arrived during the join keeps its prompt.
      if (pendingLink === null) state.pending = null;
    }
  }
  if (gen !== generation) return;
  if (!result.ok) {
    setError(result.code);
    return;
  }
  state.joined = true;
  // google_connect blocks until the browser callback: show the landed join first.
  emitState();
  const connected = await googleConnected();
  if (gen !== generation) return;
  if (connected) {
    state.googleNeedsConnect = false;
    return;
  }
  const google = await reconnectGoogle();
  if (gen !== generation) return;
  // The sign-in can block for minutes; a leave meanwhile wins.
  state.googleNeedsConnect = state.joined && !google.ok;
}

async function handleAction(gen: number, action: TeamAction): Promise<void> {
  switch (action.type) {
    case "state-request":
      return;
    case "join":
      return handleIncomingLink(gen, action.link);
    case "confirm":
      return confirm(gen);
    case "decline":
      pendingLink = null;
      state.pending = null;
      return;
    case "leave": {
      // A join in flight would land after the leave.
      if (state.busy) return;
      state.error = null;
      await leaveTeam();
      if (gen !== generation) return;
      state.joined = false;
      state.googleNeedsConnect = false;
      return;
    }
    case "check-owner-link": {
      state.error = null;
      const owner = await loadOwnerTeamLink();
      if (gen !== generation) return;
      if (!owner) {
        state.check = { ok: false, code: "TEAM_LINK_INVALID" };
        return;
      }
      const file = await fetchTeamFile(owner);
      if (gen !== generation) return;
      state.check = file.ok ? { ok: true } : { ok: false, code: file.code };
      return;
    }
    case "connect-google": {
      state.error = null;
      const google = await reconnectGoogle();
      if (gen !== generation) return;
      state.googleNeedsConnect = state.joined && !google.ok;
      return;
    }
  }
}

async function startup(gen: number): Promise<void> {
  const stored = await loadStoredTeamLink();
  if (gen !== generation) return;
  const sync = stored ? syncTeam(stored, { firstJoin: false }) : null;
  // Handled below; this only stops an early return leaving it unhandled.
  sync?.catch(() => {});
  // Both fields land together, so no emit shows joined with a stale Google flag.
  const connected = stored ? await googleConnected() : true;
  if (gen !== generation) return;
  state.joined = stored !== null;
  state.googleNeedsConnect = state.joined && !connected;
  if (!sync) return;
  // A dashboard that asked for state before this point gets the real values.
  emitState();
  const result = await sync;
  if (gen !== generation) return;
  // Applied after google_status, which would otherwise overwrite it.
  noteGoogleChange(result);
  if (!result.ok && result.code === "TEAM_FETCH_FAILED") {
    retryTimer = setTimeout(() => {
      retryTimer = null;
      void step(gen, () => refresh(gen));
    }, TEAM_START_RETRY_MS);
  }
}

/** Main window only. Returns stop. */
export function startTeamController(): () => void {
  const gen = generation;
  // Both subscribe calls go out before either resolves.
  register(gen, () =>
    listen<TeamAction>(TEAM_ACTION_EVENT, (e) => void step(gen, () => handleAction(gen, e.payload)))
  );
  register(gen, () =>
    onOpenUrl((urls) => {
      if (urls?.[0]) void step(gen, () => handleIncomingLink(gen, urls[0]));
    })
  );
  void step(gen, async () => {
    const urls = await getCurrent();
    if (gen !== generation || !urls?.[0]) return;
    await handleIncomingLink(gen, urls[0]);
  });
  void step(gen, () => startup(gen));
  refreshTimer = setInterval(() => void step(gen, () => refresh(gen)), TEAM_REFRESH_MS);
  return stopTeamController;
}

function stopTeamController(): void {
  generation++;
  if (refreshTimer !== null) clearInterval(refreshTimer);
  if (retryTimer !== null) clearTimeout(retryTimer);
  refreshTimer = null;
  retryTimer = null;
  unlisteners.splice(0).forEach((un) => un());
  // A join cut off by stop() must not leave the next run busy, or showing a
  // prompt whose link is gone.
  state.busy = false;
  pendingLink = null;
  state.pending = null;
}

export function __resetTeamControllerForTests(): void {
  stopTeamController();
  linkSeq = 0;
  state = initialState();
}
