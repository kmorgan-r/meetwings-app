import { normalizeAddress, participantsOf } from "@/lib/calendar/match-attendees";
import type { AmberKind } from "@/lib/meeting-detect";
import { PILL_DIMENSIONS } from "@/lib/overlay-minimize.store";
import type { OverlayPillStyle } from "@/lib/storage";
import type { CalendarEvent } from "@/types";

export const RESTART_QUIET_MS = 120_000;
export const AMBER_SNOOZE_MS = 3_600_000;
export const RECORDING_CARD_MS = 6_000;
export const ENDED_CARD_MS = 5_000;
export const BAR_HEIGHT = 54;
export const CARD_GAP = 8;
export const PILL_CARD_WIDTH = 300;

export interface CardEvent {
  title: string | null;
  startMs: number;
  endMs: number;
  /** Up to three other guests: display name, else address. Never you. */
  names: string[];
  extraCount: number;
}

// Named MeetingCardState, not MeetingCard: Task 9's component is `MeetingCard`,
// and importing a same-named type into that file is TS2440.
export type MeetingCardState =
  | { kind: "recording"; recordingId: number; app: string; startedAt: number; event: CardEvent | null }
  | { kind: "ended"; reason: StopNoticeReason }
  | { kind: "amber"; variant: AmberKind; episode: number; error: string | null }
  // The one-time "turn on auto-record?" question at launch. `busy` while the
  // Mac permission checks run; `error` holds a failed turn-on's one-line reason.
  | { kind: "offer"; busy: boolean; error: string | null }
  | null;

/** Why an automatic stop happened; drives the stop notice's copy. */
export type StopNoticeReason = "call-ended" | "silence";

export const STOP_NOTICE_TEXT: Record<StopNoticeReason, string> = {
  "call-ended": "Recording stopped - call ended",
  silence: "Recording stopped - 15 min of silence",
};

export interface ActiveAutoRecording {
  id: number;
  app: string;
  gated: boolean;
  startedAt: number;
  event: CardEvent | null;
}

interface LastStop {
  at: number;
  startedAt: number;
  event: CardEvent | null;
}

interface CardTimer {
  handle: ReturnType<typeof setTimeout> | null;
  deadline: number; // Date.now()-clock ms when the card should leave
  remaining: number; // kept while held
  held: boolean;
}

let card: MeetingCardState = null;
let active: ActiveAutoRecording | null = null;
let stopFn: (() => void) | null = null;
let seq = 0;
let snoozedUntil = 0;
let cardTimer: CardTimer | null = null;
const lastStops = new Map<string, LastStop>();
const listeners = new Set<() => void>();

const notify = (): void => listeners.forEach((l) => l());

export const getMeetingCard = (): MeetingCardState => card;

export const subscribeToMeetingCard = (l: () => void): (() => void) => {
  listeners.add(l);
  return () => {
    listeners.delete(l);
  };
};

function clearCardTimer(): void {
  if (cardTimer?.handle) clearTimeout(cardTimer.handle);
  cardTimer = null;
}

function armCardTimer(ms: number, now: number): void {
  const timer: CardTimer = { handle: null, deadline: now + ms, remaining: ms, held: false };
  cardTimer = timer;
  timer.handle = setTimeout(() => {
    if (cardTimer !== timer) return;
    cardTimer = null;
    card = null;
    notify();
  }, ms);
}

/** Replace the slot. Cancels the old card's timer; `ttl` arms a new one. */
function setCard(next: MeetingCardState, ttl: number | null, now: number): void {
  clearCardTimer();
  card = next;
  if (next && ttl !== null) armCardTimer(ttl, now);
  notify();
}

function clearCard(): void {
  if (card === null) return;
  setCard(null, null, Date.now());
}

function toCardEvent(ev: CalendarEvent, ownAddress: string | null): CardEvent {
  const own = ownAddress === null ? null : normalizeAddress(ownAddress);
  const all = participantsOf(ev)
    .filter((p) => normalizeAddress(p.address) !== own)
    .filter((p) => p.response?.toLowerCase() !== "declined")
    .map((p) => p.name?.trim() || p.address);
  return {
    title: ev.subject,
    startMs: ev.startMs,
    endMs: ev.endMs,
    names: all.slice(0, 3),
    extraCount: Math.max(0, all.length - 3),
  };
}

export function autoRecordingStarted(
  input: { app: string; gated: boolean; stop: () => void },
  now: number = Date.now(),
): number {
  const id = ++seq;
  const last = lastStops.get(input.app);
  const quiet = last !== undefined && now - last.at < RESTART_QUIET_MS;
  stopFn = input.stop;
  if (quiet) {
    // A notice from the earlier stop is now stale: the call is back on.
    if (card?.kind === "ended") clearCard();
    lastStops.delete(input.app);
    active = { id, app: input.app, gated: input.gated, startedAt: last.startedAt, event: last.event };
    return id;
  }
  active = { id, app: input.app, gated: input.gated, startedAt: now, event: null };
  setCard(
    { kind: "recording", recordingId: id, app: input.app, startedAt: now, event: null },
    RECORDING_CARD_MS,
    now,
  );
  return id;
}

/**
 * `auto` is true only for the detection-driven stop (meeting-ended). Only that
 * opens the quiet-restart window (spec 6.6, "previous auto stop"); a user stop
 * must not, and clears any older auto stop of the app.
 */
export function autoRecordingStopped(
  { auto = false }: { auto?: boolean } = {},
  now: number = Date.now(),
): void {
  if (!active) return;
  const { id, app, startedAt, event } = active;
  active = null;
  stopFn = null;
  if (auto) lastStops.set(app, { at: now, startedAt, event });
  else lastStops.delete(app);
  if (card?.kind === "recording" && card.recordingId === id) clearCard();
  // A reason-specific stop notice, when wanted, comes from showStopNotice()
  // (or Task 3+'s automatic stops); a bare auto stop publishes nothing.
}

export const getActiveAutoRecording = (): ActiveAutoRecording | null => active;

/**
 * Immediate, reason-specific notice that an automatic stop produced. An amber
 * card keeps its slot (it carries actionable buttons); everything else —
 * including a recording card left over from a hand-opened mic — is replaced.
 */
export function showStopNotice(reason: StopNoticeReason, now: number = Date.now()): void {
  if (card?.kind === "amber") return;
  setCard({ kind: "ended", reason }, ENDED_CARD_MS, now);
}

export function stopActiveRecording(): void {
  stopFn?.();
}

export function setCardEvent(
  recordingId: number,
  ev: CalendarEvent,
  ownAddress: string | null = null,
): void {
  if (!active || active.id !== recordingId) return;
  const event = toCardEvent(ev, ownAddress);
  active = { ...active, event };
  // Same recording's card: swap the object but leave the timer untouched.
  if (card?.kind === "recording" && card.recordingId === recordingId) {
    card = { ...card, event };
  }
  notify();
}

// Amber now reports a failed calendar read during a recording: only the snooze
// can refuse it, not an active auto-recording.
export function showAmber(a: { variant: AmberKind; episode: number }, now: number = Date.now()): void {
  if (now < snoozedUntil) return;
  if (card?.kind === "amber" && card.episode === a.episode) {
    // Same episode: the React key is the episode, so AmberCard must not remount.
    if (card.variant === a.variant) return;
    card = { ...card, variant: a.variant };
    notify();
    return;
  }
  setCard({ kind: "amber", variant: a.variant, episode: a.episode, error: null }, null, now);
}

export function setAmberError(message: string | null): void {
  if (card?.kind !== "amber") return;
  card = { ...card, error: message };
  notify();
}

/** A bare call clears any amber; an episode clears only that episode's. */
export function dismissAmber(episode?: number): void {
  if (card?.kind === "amber" && (episode === undefined || episode === card.episode)) clearCard();
}

export function snoozeAmber(now: number = Date.now()): void {
  snoozedUntil = now + AMBER_SNOOZE_MS;
  dismissAmber();
}

/**
 * Show the first-launch auto-record offer. Only into an EMPTY slot, and with no
 * timer: it stays until answered. Any other card replaces it (setCard), and a
 * replaced offer is not brought back. Returns whether it is now showing.
 */
export function showOffer(now: number = Date.now()): boolean {
  if (card !== null) return false;
  setCard({ kind: "offer", busy: false, error: null }, null, now);
  return true;
}

export function setOfferState(s: { busy: boolean; error: string | null }): void {
  if (card?.kind !== "offer") return;
  card = { kind: "offer", busy: s.busy, error: s.error };
  notify();
}

export function dismissOffer(): void {
  if (card?.kind === "offer") clearCard();
}

export const dismissCard = clearCard;

export function holdCard(held: boolean, now: number = Date.now()): void {
  const t = cardTimer;
  if (!t || t.held === held) return;
  t.held = held;
  if (held) {
    if (t.handle) clearTimeout(t.handle);
    t.handle = null;
    t.remaining = Math.max(0, t.deadline - now);
    return;
  }
  t.deadline = now + t.remaining;
  t.handle = setTimeout(() => {
    if (cardTimer !== t) return;
    cardTimer = null;
    card = null;
    notify();
  }, t.remaining);
}

// Per-variant heights, not measured (jsdom has no layout). MeetingCard.tsx
// renders each variant at exactly this many px.
export function cardHeight(c: MeetingCardState, compact: boolean): number {
  if (!c) return 0;
  switch (c.kind) {
    case "recording":
      // Compact is the title row, plus a people line when there are other
      // guests. Full with an event adds divider, title, time row and a separate
      // Stop row (spec 6.6).
      if (compact) return c.event && c.event.names.length > 0 ? 64 : 48;
      return c.event ? 124 : 72;
    case "ended":
      return compact ? 48 : 64;
    case "amber":
      // The error wraps under the body: two more 16px lines. Compact swaps the
      // headline for the error, so its height does not change.
      return compact ? 80 : c.error ? 136 : 104;
    case "offer":
      // Title, two body lines, footnote and buttons; an error adds two lines.
      // Compact (the 300px pill card) wraps the body one line more.
      if (compact) return c.error ? 152 : 120;
      return c.error ? 136 : 104;
  }
}

export function pillWindowSize(
  style: OverlayPillStyle,
  c: MeetingCardState,
): { width: number; height: number } {
  const pill = PILL_DIMENSIONS[style];
  if (!c) return pill;
  return {
    width: Math.max(pill.width, PILL_CARD_WIDTH),
    height: pill.height + CARD_GAP + cardHeight(c, true),
  };
}

export function resetMeetingCardsForTests(): void {
  clearCardTimer();
  lastStops.clear();
  card = null;
  active = null;
  stopFn = null;
  seq = 0;
  snoozedUntil = 0;
  listeners.clear();
}
