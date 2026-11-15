import { useEffect, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { Button } from "@/components/ui/button";
import { reconnectGoogle } from "@/lib/calendar/google-connect";
import { GOOGLE_COPY } from "@/lib/calendar/google-errors";
import {
  cardHeight,
  holdCard,
  setAmberError,
  snoozeAmber,
  STOP_NOTICE_TEXT,
  stopActiveRecording,
  type CardEvent,
  type MeetingCardState,
} from "@/lib/meeting-cards.store";
import { cn } from "@/lib/utils";

type Card = NonNullable<MeetingCardState>;

const AMBER_HEADLINE = "If this is a Meet call, it isn't being recorded";
const AMBER_BODY = {
  reconnect:
    "Google Calendar is disconnected, so Meetwings can't confirm the call. Reconnect and recording starts on its own. You won't need to rejoin.",
  settings:
    "Meetwings can't read your saved Google Calendar setup. Open Integrations → Google Calendar in settings to fix it.",
  offline:
    "Meetwings can't reach Google Calendar right now. If this is a Meet call, start recording by hand, or it will start on its own once Google is reachable again.",
} as const;

const pad = (n: number) => String(n).padStart(2, "0");
const hhmm = (ms: number) => {
  const d = new Date(ms);
  return `${pad(d.getHours())}:${pad(d.getMinutes())}`;
};

/** A 1s ticking clock; `startedAt` is the Date.now() clock. */
function useElapsed(startedAt: number): string {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(id);
  }, []);
  const s = Math.max(0, Math.floor((now - startedAt) / 1000));
  return `${pad(Math.floor(s / 60))}:${pad(s % 60)}`;
}

function People({ event }: { event: CardEvent }) {
  const more = event.extraCount > 0 ? ` +${event.extraCount}` : "";
  return (
    <span className="min-w-0 truncate font-medium text-foreground" data-testid="meeting-card-people">
      {`with ${event.names.join(", ")}${more}`}
    </span>
  );
}

// select-none: a stray Ctrl+A or drag on the overlay otherwise paints selection
// boxes over every line of the card and makes it unreadable.
const SHELL =
  "relative w-full select-none overflow-hidden rounded-xl border bg-card text-card-foreground shadow-lg " +
  "transition-opacity duration-300 starting:opacity-0 " +
  "motion-safe:animate-in motion-safe:fade-in motion-safe:slide-in-from-top-3";

function RecordingCard({ card, compact }: { card: Extract<Card, { kind: "recording" }>; compact: boolean }) {
  const elapsed = useElapsed(card.startedAt);
  const [paused, setPaused] = useState(false);
  const pausedRef = useRef(false);
  const setHeld = (held: boolean) => {
    pausedRef.current = held;
    setPaused(held);
    holdCard(held);
  };
  // A remount (compact toggle) while hovered would otherwise leave the store timer held.
  useEffect(
    () => () => {
      if (pausedRef.current) holdCard(false);
    },
    [],
  );

  const { event } = card;
  const stop = (
    <Button
      type="button"
      size="sm"
      variant="destructive"
      className="h-6 px-2 text-xs"
      onClick={() => stopActiveRecording()}
    >
      <span aria-hidden="true">■</span> Stop
    </Button>
  );
  const when = event && (
    <span className="flex min-w-0 items-center gap-2 text-sm text-foreground/75">
      <span className="shrink-0 tabular-nums">
        {hhmm(event.startMs)} – {hhmm(event.endMs)}
      </span>
      {event.names.length > 0 && (
        <>
          <span aria-hidden>·</span>
          <People event={event} />
        </>
      )}
    </span>
  );

  return (
    <div
      data-testid="meeting-card"
      data-kind="recording"
      data-paused={paused ? "true" : "false"}
      className={cn(SHELL, "border-destructive/40 bg-gradient-to-br from-destructive/10 to-card")}
      style={{ height: cardHeight(card, compact) }}
      onMouseEnter={() => setHeld(true)}
      onMouseLeave={() => setHeld(false)}
    >
      <div className="flex h-full flex-col px-3 pb-2 pt-2">
        <div className="flex items-center gap-2 text-sm">
          <span className="flex items-center gap-1.5 font-bold tracking-wide text-destructive">
            <span aria-hidden="true" className="motion-safe:animate-pulse">◉</span> REC
          </span>
          {/* The live region is the static headline only: the ticking timer stays outside it. */}
          <span role="status" className="min-w-0 flex-1 truncate font-medium">
            {compact ? (event?.title ?? card.app) : `${card.app} · recording started`}
          </span>
          <span className="tabular-nums text-muted-foreground" data-testid="meeting-card-timer">
            {elapsed}
          </span>
          {compact && stop}
        </div>
        {event && compact && event.names.length > 0 && (
          <div className="mt-0.5 flex min-w-0 pl-5 text-sm">
            <People event={event} />
          </div>
        )}
        {event && !compact && (
          <>
            <div className="my-1.5 h-px bg-border" />
            <div className="truncate text-sm font-semibold" data-testid="meeting-card-title">
              {event.title ?? card.app}
            </div>
            <div className="mt-0.5">{when}</div>
          </>
        )}
        {!compact && <div className="mt-auto flex justify-end">{stop}</div>}
      </div>
      {/* Purely visual, and 6000ms must equal RECORDING_CARD_MS (a literal: Tailwind scans class strings). The store's timer removes the card, never this animation. */}
      <div
        data-testid="meeting-card-drain"
        className="absolute inset-x-0 bottom-0 h-1 origin-left bg-destructive motion-safe:animate-[meeting-card-drain_6000ms_linear_forwards] motion-reduce:hidden"
        style={{ animationPlayState: paused ? "paused" : "running" }}
      />
    </div>
  );
}

function EndedCard({ card, compact }: { card: Extract<Card, { kind: "ended" }>; compact: boolean }) {
  return (
    <div
      data-testid="meeting-card"
      data-kind="ended"
      role="status"
      className={cn(SHELL, "flex items-center gap-3 border-emerald-500/40 bg-gradient-to-br from-emerald-500/10 to-card px-3")}
      style={{ height: cardHeight(card, compact) }}
    >
      <span aria-hidden="true" className="flex h-7 w-7 shrink-0 items-center justify-center rounded-full bg-emerald-500/20 text-base font-bold text-emerald-600 dark:text-emerald-400">
        ✓
      </span>
      {compact ? (
        <span className="min-w-0 truncate text-sm">{STOP_NOTICE_TEXT[card.reason]}</span>
      ) : (
        <div className="min-w-0">
          <div className="text-sm font-semibold">{STOP_NOTICE_TEXT[card.reason]}</div>
        </div>
      )}
    </div>
  );
}

function AmberCard({ card, compact }: { card: Extract<Card, { kind: "amber" }>; compact: boolean }) {
  const [busy, setBusy] = useState(false);

  const reconnect = async () => {
    setBusy(true);
    setAmberError(null);
    try {
      const r = await reconnectGoogle();
      if (!r.ok) setAmberError(GOOGLE_COPY[r.code]);
    } finally {
      setBusy(false);
    }
  };
  const openSettings = () => {
    invoke("open_dashboard").catch((e) => console.error("Failed to open dashboard:", e));
  };

  const btn = "h-6 px-2.5 text-xs";
  const notNow = (
    <Button type="button" size="sm" variant="outline" className={btn} onClick={() => snoozeAmber()}>
      Not now
    </Button>
  );
  const buttons =
    card.variant === "reconnect" ? (
      <>
        {notNow}
        <Button type="button" size="sm" className={btn} disabled={busy} onClick={() => void reconnect()}>
          Reconnect Google
        </Button>
      </>
    ) : card.variant === "settings" ? (
      <>
        {notNow}
        <Button type="button" size="sm" className={btn} onClick={openSettings}>
          Open settings
        </Button>
      </>
    ) : (
      <Button type="button" size="sm" className={btn} onClick={() => snoozeAmber()}>
        Got it
      </Button>
    );

  return (
    <div
      data-testid="meeting-card"
      data-kind="amber"
      role="alert"
      // z-[60]: the response popover is a z-50 portal and must not cover this card (R8).
      className={cn(SHELL, "relative z-[60] border-amber-500/50 bg-gradient-to-br from-amber-500/15 to-card")}
      style={{ height: cardHeight(card, compact) }}
    >
      <div className="flex h-full flex-col px-3 py-2.5">
        <div className="flex items-center gap-2 text-sm font-semibold">
          <span aria-hidden="true" className="text-amber-600 dark:text-amber-400">
            ⚠
          </span>
          {compact && card.error ? (
            <span className="min-w-0 line-clamp-2 text-xs text-destructive" title={card.error} data-testid="meeting-card-error">
              {card.error}
            </span>
          ) : (
            <span className={cn("min-w-0", compact ? "line-clamp-2 text-xs" : "truncate")}>{AMBER_HEADLINE}</span>
          )}
        </div>
        {!compact && (
          <p className="mt-0.5 pl-6 text-xs leading-4 text-muted-foreground">{AMBER_BODY[card.variant]}</p>
        )}
        {!compact && card.error && (
          <p className="mt-1 pl-6 text-xs leading-4 text-destructive" data-testid="meeting-card-error">
            {card.error}
          </p>
        )}
        <div className="mt-auto flex items-center justify-end gap-2">{buttons}</div>
      </div>
    </div>
  );
}

export function MeetingCard({ card, compact = false }: { card: Card; compact?: boolean }) {
  switch (card.kind) {
    case "recording":
      return <RecordingCard key={`recording:${card.recordingId}`} card={card} compact={compact} />;
    case "ended":
      return <EndedCard key="ended" card={card} compact={compact} />;
    case "amber":
      return <AmberCard key={`amber:${card.episode}`} card={card} compact={compact} />;
  }
}

