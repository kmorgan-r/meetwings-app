import { participantsOf } from "@/lib/calendar/match-attendees";
import type { AmberKind } from "@/lib/meeting-detect";
import { PILL_DIMENSIONS } from "@/lib/overlay-minimize.store";
import type { OverlayPillStyle } from "@/lib/storage";
import type { CalendarEvent } from "@/types";

export const RESTART_QUIET_MS = 120_000;
export const ENDED_CARD_DELAY_MS = 30_000;
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
  initials: string[];
  extraCount: number;
}

// Named MeetingCardState, not MeetingCard: Task 9's component is `MeetingCard`,
// and importing a same-named type into that file is TS2440.
export type MeetingCardState =
  | { kind: "recording"; recordingId: number; app: string; startedAt: number; event: CardEvent | null }
  | { kind: "ended"; app: string; title: string | null; durationMs: number }
  | { kind: "amber"; variant: AmberKind; episode: number; error: string | null }
  | null;

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
const endedTimers = new Map<string, ReturnType<typeof setTimeout>>();
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

function initialOf(name: string | null, address: string): string {
  const words = (name ?? "").trim().split(/\s+/).filter(Boolean);
  const letters =
    words.length === 0
      ? address.trim().charAt(0)
      : words.length === 1
        ? words[0].charAt(0)
        : words[0].charAt(0) + words[words.length - 1].charAt(0);
  return letters.toUpperCase();
}

function toCardEvent(ev: CalendarEvent): CardEvent {
  const all = participantsOf(ev).map((p) => initialOf(p.name, p.address));
  return {
    title: ev.subject,
    startMs: ev.startMs,
    endMs: ev.endMs,
    initials: all.slice(0, 3),
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
    const pending = endedTimers.get(input.app);
    if (pending) clearTimeout(pending);
    endedTimers.delete(input.app);
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

export function autoRecordingStopped(now: number = Date.now()): void {
  if (!active) return;
  const { id, app, startedAt, event } = active;
  active = null;
  stopFn = null;
  lastStops.set(app, { at: now, startedAt, event });
  if (card?.kind === "recording" && card.recordingId === id) clearCard();
  const prior = endedTimers.get(app);
  if (prior) clearTimeout(prior);
  endedTimers.set(
    app,
    setTimeout(() => {
      endedTimers.delete(app);
      if (card?.kind === "amber") return;
      setCard(
        { kind: "ended", app, title: event?.title ?? null, durationMs: now - startedAt },
        ENDED_CARD_MS,
        Date.now(),
      );
    }, ENDED_CARD_DELAY_MS),
  );
}

export const getActiveAutoRecording = (): ActiveAutoRecording | null => active;

export function stopActiveRecording(): void {
  stopFn?.();
}

export function setCardEvent(recordingId: number, ev: CalendarEvent): void {
  if (!active || active.id !== recordingId) return;
  const event = toCardEvent(ev);
  active = { ...active, event };
  // Same recording's card: swap the object but leave the timer untouched.
  if (card?.kind === "recording" && card.recordingId === recordingId) {
    card = { ...card, event };
  }
  notify();
}

export function showAmber(a: { variant: AmberKind; episode: number }, now: number = Date.now()): void {
  if (now < snoozedUntil || active) return;
  setCard({ kind: "amber", variant: a.variant, episode: a.episode, error: null }, null, now);
}

export function setAmberError(message: string | null): void {
  if (card?.kind !== "amber") return;
  card = { ...card, error: message };
  notify();
}

export function dismissAmber(): void {
  if (card?.kind === "amber") clearCard();
}

export function snoozeAmber(now: number = Date.now()): void {
  snoozedUntil = now + AMBER_SNOOZE_MS;
  dismissAmber();
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
      // Compact is one line with or without an event. Full with an event adds
      // divider, title, time row and a separate Stop row (spec 6.6).
      return compact ? 48 : c.event ? 124 : 72;
    case "ended":
      return compact ? 48 : 64;
    case "amber":
      // The error wraps under the body: two more 16px lines. Compact swaps the
      // headline for the error, so its height does not change.
      return compact ? 80 : c.error ? 136 : 104;
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
  endedTimers.forEach((h) => clearTimeout(h));
  endedTimers.clear();
  lastStops.clear();
  card = null;
  active = null;
  stopFn = null;
  seq = 0;
  snoozedUntil = 0;
  listeners.clear();
}
