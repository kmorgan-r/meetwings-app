import { useCallback, useEffect, useMemo, useRef, useState } from "react";
// `GraphErrorCode` is a type-only import alongside the others below.
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import {
  matchAttendees,
  participantsOf,
  pickCurrentMeeting,
  toGraphError,
} from "@/lib/calendar";
import { loadGraphConfigState } from "@/lib/storage/graph-config.storage";
import type {
  CalendarEvent,
  CalendarProposalState,
  CandidateSummary,
  CurrentMeetings,
  GraphErrorCode,
  GraphStatus,
  OdooContact,
} from "@/types";

/** Deliberately WIDER than the acceptance window in current-meeting.ts, so the
 * pure function sees the events either side of the boundary rather than having
 * them filtered away by the query. */
const QUERY_WINDOW_MS = 15 * 60 * 1000;

/**
 * Module scope, so the derived loading state below is referentially stable. A
 * fresh `{ kind: "loading" }` per render would change `calendarProps`'s
 * identity and defeat `ContactPicker`'s memo.
 */
const LOADING_STATE: CalendarProposalState = { kind: "loading" };

// `CalendarProposalState` and `CandidateSummary` are imported from @/types, not
// declared here - see the placement note in src/types/calendar.ts.

export interface UseCalendarProposalReturn {
  present: boolean;
  state: CalendarProposalState;
  onPickCandidate: (eventId: string) => void;
  onRetry: () => void;
}

function summarize(event: CalendarEvent): CandidateSummary {
  return { id: event.id, subject: event.subject, startMs: event.startMs, endMs: event.endMs };
}

export function useCalendarProposal({
  isPickerOpen,
  contacts,
  setCalendarBlockPresent,
}: {
  isPickerOpen: boolean;
  /**
   * The synced contact cache, or `null` while it is not ready. Deliberately NOT
   * `PickerCacheState`: this hook never needed the cache variant, only the
   * rows, and importing a page's type here (while that page imports this hook's
   * state union back) closes the dependency cycle Task 3's note describes.
   */
  contacts: OdooContact[] | null;
  /**
   * useCompletion owns the slot; this hook writes into it. Mirrors
   * setTargetCount exactly (useCompletion.ts:143), and for the same reason:
   * useCompletion runs BEFORE this hook in <Completion />, so it cannot read
   * the value off this hook's return - only own a slot this one fills.
   */
  setCalendarBlockPresent: (present: boolean) => void;
}): UseCalendarProposalReturn {
  const [connected, setConnected] = useState(false);
  /** Non-null when the connection state itself could not be read. */
  const [statusError, setStatusError] = useState<GraphErrorCode | null>(null);
  const [state, setState] = useState<CalendarProposalState>({ kind: "idle" });
  /** Every resolved fetch checks this before writing. A close/reopen or an
   * instance change bumps it, so a superseded response is discarded rather
   * than overwriting a newer one. */
  const generation = useRef(0);
  /** Same discipline as `generation`, but for `readStatus`: the mount effect,
   * the `graph-connection-changed` listener, and `retryStatus` can all be
   * in flight at once, and an older read resolving last must not overwrite a
   * newer one's `connected`/`statusError` - that pair drives `blockPresent`,
   * the one value published to useCompletion's resize effect. */
  const statusGen = useRef(0);
  /** The last fetch's raw events, so picking a candidate needs no second call. */
  const eventsRef = useRef<CalendarEvent[]>([]);
  const ownAddressRef = useRef<string | null>(null);

  // Memoized, not a bare `contacts ?? []`: that literal is a fresh array on
  // every render, and `project` below closes over it as a useCallback
  // dependency - eslint's react-hooks/exhaustive-deps correctly flags a
  // dependency that changes identity every render regardless of `contacts`.
  const rows = useMemo(() => contacts ?? [], [contacts]);
  /**
   * `project` reads THIS, not `rows` directly - see the sync effect below
   * `project`'s own declaration (it has to come after: it calls `project`,
   * which is a `const` declared further down). Closing over `rows` made
   * `project` (and everything chained off it: `fetchNow`, `onPickCandidate`,
   * `onRetry`) change identity every time the `contacts` prop's reference
   * changed, which is exactly the identity `<Completion />`'s `calendarProps`
   * memo depends on to keep `ContactPicker`'s `React.memo` intact - a plan
   * review already caught one memo defect on this exact component, so this
   * hook keeps its returned callbacks stable rather than pushing that
   * requirement onto Task 15's caller.
   */
  const rowsRef = useRef(rows);
  // All three inputs are known BEFORE the popover opens. That is what makes
  // this the STATIC absence the resize effect can route on.
  const present = connected && rows.length > 0;

  /**
   * ONE value, published to `useCompletion` AND returned to the caller.
   *
   * They must not diverge. Publishing the computed `present` while returning a
   * forced `true` for the error case would render the 112px region while
   * `calendarBlockPresent` stayed false — and that flag's ONLY job is to sit in
   * the resize effect's dependency array, so nothing would re-run the resize.
   * A status read failing or recovering while the picker is open would then
   * change the footprint with no resize behind it, which is precisely the case
   * the static/dynamic split exists to cover.
   *
   * A failed status read forces the block present because it is the one failure
   * worth the reserved space: the alternative is the feature silently vanishing.
   */
  const blockPresent = statusError !== null || present;

  useEffect(() => {
    setCalendarBlockPresent(blockPresent);
  }, [blockPresent, setCalendarBlockPresent]);

  /**
   * Read the connection state. Runs on mount AND whenever the /odoo page
   * broadcasts a change.
   *
   * The two failure branches are deliberately DIFFERENT. A config that is
   * absent means "never set up", which is the routine v1 state and must stay
   * silent — the block is statically absent and the picker is exactly what it
   * is today. A config that is UNREADABLE, or a `graph_status` that throws,
   * means something is genuinely broken; swallowing that into `connected =
   * false` makes the whole feature disappear with nothing on screen to explain
   * it, which is indistinguishable from never having set it up.
   */
  const readStatus = useCallback(async () => {
    statusGen.current += 1;
    const mine = statusGen.current;
    const config = await loadGraphConfigState();
    if (config.state === "absent") {
      if (mine === statusGen.current) {
        setConnected(false);
        setStatusError(null);
      }
      return;
    }
    if (config.state === "unreadable") {
      // GRAPH_AUTH_REJECTED, not GRAPH_NOT_CONNECTED. Task 12 drew the
      // absent/unreadable distinction precisely so a bad stored config is
      // distinguishable from a disconnected account, and collapsing it back to
      // the disconnected code here would throw that away at the last step: the
      // user reads "not connected" for a config that IS there but invalid, and
      // Try again re-reads the same bad value forever. AUTH_REJECTED matches
      // what Rust's own `validate_authority` returns for the same input.
      if (mine === statusGen.current) {
        setConnected(false);
        setStatusError("GRAPH_AUTH_REJECTED");
      }
      return;
    }
    try {
      const status = await invoke<GraphStatus>("graph_status");
      if (mine === statusGen.current) {
        setConnected(status.connected);
        setStatusError(null);
      }
    } catch (err) {
      if (mine === statusGen.current) {
        setConnected(false);
        setStatusError(toGraphError(err).code);
      }
    }
  }, []);

  useEffect(() => {
    void readStatus();
  }, [readStatus]);

  /**
   * `/odoo` runs in the `dashboard` webview; `<Completion />` runs in `main`.
   * Without this listener, connecting on that page would not make the block
   * appear here until the app restarted, and disconnecting there would leave
   * this window believing it is connected — so every open would produce a
   * GRAPH_NOT_CONNECTED error state. Same cross-window pattern the picker
   * already uses for `odoo-instance-changed`.
   */
  useEffect(() => {
    // A disposed flag, not just an `unlisten` closure: unmounting before
    // `listen()` resolves would otherwise assign the unsubscribe function into
    // a cleanup that already ran, leaking the subscription for the rest of the
    // window's lifetime. `disposed` makes the late resolution unsubscribe
    // immediately instead of stashing a function nothing will ever call.
    let disposed = false;
    let unlisten: (() => void) | undefined;
    void listen("graph-connection-changed", () => void readStatus()).then((fn) => {
      if (disposed) {
        fn();
        return;
      }
      unlisten = fn;
    });
    return () => {
      disposed = true;
      unlisten?.();
    };
  }, [readStatus]);

  const reset = useCallback(() => {
    generation.current += 1;
    eventsRef.current = [];
    ownAddressRef.current = null;
    setState({ kind: "idle" });
  }, []);

  // Same listener the picker's own hook uses: an id from one instance names a
  // different partner in another.
  useEffect(() => {
    // Same disposed-flag guard as the connection listener above, for the same
    // unmount-before-resolve race.
    let disposed = false;
    let unlisten: (() => void) | undefined;
    void listen("odoo-instance-changed", () => reset()).then((fn) => {
      if (disposed) {
        fn();
        return;
      }
      unlisten = fn;
    });
    return () => {
      disposed = true;
      unlisten?.();
    };
  }, [reset]);

  const project = useCallback(
    (events: CalendarEvent[], ownAddress: string | null, forcedId?: string) => {
      const forced = forcedId === undefined ? null : events.find((e) => e.id === forcedId) ?? null;
      const picked = forced !== null
        ? ({ kind: "one", event: forced } as const)
        : pickCurrentMeeting(events, Date.now());
      if (picked.kind === "none") return { kind: "no-meeting" } as const;
      if (picked.kind === "several") {
        return { kind: "several", candidates: picked.candidates.map(summarize) } as const;
      }
      const result = matchAttendees({
        participants: participantsOf(picked.event),
        contacts: rowsRef.current,
        ownAddress,
      });
      return {
        kind: "proposal",
        eventId: picked.event.id,
        subject: picked.event.subject,
        matched: result.matched,
        unmatched: result.unmatched,
      } as const;
    },
    // Permanently stable: `rowsRef.current` is always the latest `rows`
    // (synced below), so `project` never needs to change identity for
    // `contacts` to be current. That makes `fetchNow`, `onPickCandidate` and
    // `onRetry` - all chained off `project` - permanently stable too.
    //
    // That currency is true for every FUTURE call to `project` - a fetch, a
    // candidate pick - but on its own says nothing about a `proposal` state
    // already sitting on screen from an EARLIER call. The re-projection
    // effect right below is what keeps that one current too.
    []
  );

  /**
   * Two jobs in one effect, because the second only makes sense once the
   * first has run for this commit: sync `rowsRef` (this is that sync effect
   * - `project` reads `rowsRef.current`, never `rows` directly, exactly as
   * the comment above says), then re-project whatever `proposal` is
   * currently on screen against the contacts that just changed.
   *
   * WHY re-project at all: `state` is a snapshot computed once, at fetch
   * time. Nothing else re-derives it, so a matched attendee who becomes a
   * colleague after the proposal is already showing - the colleague toggle
   * in ContactPicker.tsx, or an `isColleague`/`active` flip that lands via
   * Refresh - stays rendered as a checkable, PRE-TICKED row. `matchAttendees`
   * would now place that contact in `excluded` (reason "colleague") or move
   * an archived one from `matched` to `unmatched`; confirming before this
   * effect catches up logs the meeting onto the wrong record, or misses that
   * a contact is no longer safe to write to - the exact outcome exclusion and
   * the archived/no-contact split exist to prevent.
   *
   * `forcedId: prev.eventId` is what keeps this from silently changing WHICH
   * meeting is proposed: it forces `project` to re-use the event already
   * picked rather than falling through to `pickCurrentMeeting(events,
   * Date.now())`, which could pick a different meeting entirely purely
   * because time has passed since the original fetch. This effect corrects
   * the MATCH, never the selection.
   *
   * VALUE-COMPARED before writing, not written unconditionally. An
   * unconditional `setState(project(...))` produces a brand-new object every
   * time `rows` changes at all - including a change with no bearing on THIS
   * meeting's attendees, like an unrelated contact being added by a sync -
   * and CalendarProposal.tsx's own pre-check effect keys off exactly that
   * object identity (by way of `writableKey`) to decide whether the proposal
   * is a NEW one (safe to auto-select fitting rows) or the SAME one with a
   * shrunk `writable` set (must only ever drop ids from `checked`, never add
   * them back - see that file's comment on the exact defect this closes).
   * Comparing by contact id / participant address+reason first and bailing
   * out to `prev` when nothing actually changed is what lets
   * useCalendarProposal.test.tsx's "recomputes on each open and not on a
   * calendar-data change" pin `state`'s reference through an irrelevant
   * `contacts` change, while a REAL change (a ticked row's contact moving out
   * of `matched`) still produces a new object CalendarProposal.tsx can react
   * to correctly.
   *
   * NOT a fetch, and does not interact with `hasFetched`/`generation`: it
   * runs synchronously off data already in `eventsRef`/`ownAddressRef` from
   * the last fetch, so "contacts changing must still not refetch" (the fetch
   * effect's own comment, further below) stays true - this effect changes
   * `state`, never calls Graph.
   */
  useEffect(() => {
    rowsRef.current = rows;
    setState((prev) => {
      if (prev.kind !== "proposal") return prev;
      const next = project(eventsRef.current, ownAddressRef.current, prev.eventId);
      if (next.kind !== "proposal") return next;
      // STRUCTURAL guard, not an argued one: `project` falls through to
      // `pickCurrentMeeting(events, Date.now())` whenever `forcedId` is not
      // found in `events` (see `project`'s own body), which can name a
      // DIFFERENT meeting than `prev.eventId`. Unreachable today - the only
      // thing that empties `eventsRef` is `reset()`, which also queues
      // `idle` in the same call - but "corrects the match, never the
      // selection" (the block comment above) must not depend on that staying
      // true elsewhere in this file.
      if (next.eventId !== prev.eventId) return prev;
      const sameMatched =
        prev.matched.length === next.matched.length &&
        prev.matched.every(
          (m, i) =>
            m.participant.address === next.matched[i].participant.address &&
            m.contact.id === next.matched[i].contact.id
        );
      const sameUnmatched =
        prev.unmatched.length === next.unmatched.length &&
        prev.unmatched.every(
          (u, i) =>
            u.participant.address === next.unmatched[i].participant.address &&
            u.reason === next.unmatched[i].reason
        );
      return sameMatched && sameUnmatched ? prev : next;
    });
  }, [rows, project]);

  const fetchNow = useCallback(async () => {
    // BEFORE any await, all three of them:
    //
    // - `setState({ kind: "loading" })` — setting it AFTER the config round
    //   trip left `idle` rendering `null` for however long plugin-store took,
    //   so the block appeared well after open and grew the popover's footprint.
    //   This effect is PASSIVE, so this alone still cannot cover the commit the
    //   popover opens on; `visibleState` below derives `loading` during render
    //   for exactly that commit. Between the two, the region is on screen from
    //   the first render and its footprint never changes — which is what the
    //   Global Constraints require and why the static/dynamic split exists.
    // - the generation bump, so ordering is decided by call order rather than
    //   by which config load happens to resolve first.
    generation.current += 1;
    const mine = generation.current;
    setState({ kind: "loading" });

    const config = await loadGraphConfigState();
    if (config.state !== "complete") {
      if (mine === generation.current) {
        // Same code `readStatus` uses for the same condition: an invalid stored
        // config is a rejected authority, not a disconnected account.
        setState(
          config.state === "absent"
            ? { kind: "idle" }
            : { kind: "error", code: "GRAPH_AUTH_REJECTED" }
        );
      }
      return;
    }
    const now = Date.now();
    try {
      const response = await invoke<CurrentMeetings>("graph_current_meetings", {
        clientId: config.config.clientId,
        authority: config.config.authority,
        startIso: new Date(now - QUERY_WINDOW_MS).toISOString(),
        endIso: new Date(now + QUERY_WINDOW_MS).toISOString(),
      });
      if (mine !== generation.current) return;
      eventsRef.current = response.events;
      ownAddressRef.current = response.ownAddress;
      setState(project(response.events, response.ownAddress));
    } catch (err) {
      if (mine !== generation.current) return;
      setState({ kind: "error", code: toGraphError(err).code });
    }
  }, [project]);

  /**
   * Recomputed each time the picker OPENS — not on a calendar-data change,
   * which would need a watcher for a case that reopening already covers.
   *
   * `present` IS in the dependency array, and that is load-bearing rather than
   * lint appeasement. It is composed of two values that resolve asynchronously
   * after mount (`connected`, and the contact cache). With `[isPickerOpen]`
   * alone, opening the picker shortly after launch evaluated `present` as false,
   * returned, and — because nothing re-ran the effect when `present` later
   * flipped true — never fetched at all for that whole open session. The user
   * saw no block, not even "Checking your calendar…", until they closed and
   * reopened.
   *
   * `hasFetched` is what keeps that from becoming a refetch loop: `present` can
   * only transition false -> true once per open, and the ref makes the second
   * pass a no-op, so this still fetches exactly once per open.
   *
   * `fetchNow` and `reset` ARE listed below now, with no eslint-disable: both
   * are permanently stable (`project`'s deps are `[]` - it reads `contacts`
   * via `rowsRef`, not by closing over `rows` directly), so listing them
   * cannot cause an extra run the way it would have before that change. This
   * is the ONE property that made `fetchNow` safe to add - `contacts`
   * changing must still not refetch, and now it structurally can't, rather
   * than relying on keeping it out of the array.
   *
   * `connected` is ALSO in the dependency array, and its handling is the same
   * shape as `odoo-instance-changed`'s listener above, for a reason that
   * listener does not cover: the picker can stay open (`isPickerOpen` never
   * goes false) across a disconnect-then-reconnect on `/odoo`, possibly to a
   * DIFFERENT account or tenant. `readStatus` updates `connected` on that
   * broadcast, but nothing previously cleared `hasFetched` for it - so on
   * reconnect `present` flips back true, `hasFetched.current` is still `true`
   * from the earlier session, and the block above just skips past, leaving
   * the PREVIOUS account's meeting, attendees and matches on screen with a
   * live confirm button. `prevConnectedRef` is what tells a genuine
   * true<->false transition apart from `connected` merely being read for the
   * first time; on a real transition, this clears `hasFetched` and resets
   * `state` to `idle` exactly as the `!isPickerOpen` branch above does,
   * before falling through to the normal present/hasFetched check - which is
   * what lets a reconnect that resolves `present` true immediately refetch in
   * the very same effect run, rather than needing a second trigger.
   */
  const hasFetched = useRef(false);
  const prevConnectedRef = useRef(connected);
  useEffect(() => {
    const connectedChanged = prevConnectedRef.current !== connected;
    prevConnectedRef.current = connected;

    if (!isPickerOpen) {
      hasFetched.current = false;
      reset();
      return;
    }
    if (connectedChanged) {
      hasFetched.current = false;
      reset();
    }
    if (!present || hasFetched.current) return;
    hasFetched.current = true;
    void fetchNow();
  }, [isPickerOpen, present, connected, fetchNow, reset]);

  const onPickCandidate = useCallback(
    (eventId: string) => {
      setState(project(eventsRef.current, ownAddressRef.current, eventId));
    },
    [project]
  );

  const onRetry = useCallback(() => {
    void fetchNow();
  }, [fetchNow]);

  /**
   * A status read that FAILED outranks whatever the proposal state happens to
   * be. Without this the hook reports the same absence for an unreadable
   * keychain as for "never configured", and the feature vanishes silently
   * instead of saying what went wrong.
   *
   * Both of these are memoized, and that is not tidiness. `<Completion />`
   * feeds `state` and `onRetry` into the `calendarProps` useMemo that keeps
   * `ContactPicker`'s `React.memo` intact; a fresh object literal and a fresh
   * arrow here would change identity every render, so the memo would recompute
   * every render and the picker would re-render on every streamed AI token —
   * reintroducing the exact defect the memo was added to fix, and doing it for
   * the whole session because `blockPresent` is forced true in this branch.
   */
  const retryStatus = useCallback(() => void readStatus(), [readStatus]);
  const errorState = useMemo<CalendarProposalState>(
    () => ({ kind: "error", code: statusError ?? "GRAPH_NETWORK" }),
    [statusError]
  );

  /**
   * `idle` renders nothing, and `fetchNow` sets `loading` from a PASSIVE
   * effect — so on the commit where `isPickerOpen` flips true the state is
   * still `idle` and the region is absent for exactly one commit, after which
   * it appears. That is the footprint growing after open, in miniature.
   *
   * Deriving the loading state during render closes that commit. It is not the
   * same as setting it in the effect: this is what is on screen for the render
   * the popover opens on.
   *
   * `!hasFetched.current` scopes this to that ONE commit. Without it, a reset
   * that lands while the picker stays open - an Odoo instance change is the
   * case this guards against - would read back as `idle` from `reset()` and
   * get relabeled `loading` here forever, because nothing re-triggers a fetch
   * (an instance change does not touch `isPickerOpen`, `present`, `fetchNow`
   * or `reset` - the fetch effect's deps just above - so it never re-runs) to
   * ever resolve that phantom spinner. Once a fetch has already run for this
   * open, `idle` means "reset, nothing pending" and must render as idle, not
   * as a lie about work in flight.
   *
   * A `connected` transition (the fetch effect's other `reset()` call site)
   * resets too, but does not land in this same trap: `hasFetched.current` is
   * cleared in that SAME effect run, right before the present/hasFetched
   * check that decides whether to fetch - so a transition that resolves
   * `present` true fetches again immediately, and one that resolves it false
   * unmounts this component entirely (`calendar.present` gates whether
   * `<Completion />` even passes `calendar` to `ContactPicker`). Neither path
   * leaves an `idle` sitting here with no fetch ever coming.
   *
   * Reading `hasFetched.current` here IS a render-phase ref read, and
   * react-hooks/refs correctly flags that - the same warning this codebase
   * already carries, uncorrected, at useMeetingDetection.ts:83 and
   * completion/Audio.tsx:68, as part of its accepted baseline. `hasFetched`
   * is only ever WRITTEN inside the effect below, never during render, so a
   * concurrent re-render cannot observe a value some OTHER in-progress render
   * mutated. Avoiding the warning structurally would mean materializing
   * `hasFetched` as state - a second reactive value driving this same effect,
   * purely to satisfy a lint rule for a derived DISPLAY value with no
   * correctness stake in the distinction - which is a larger change than the
   * warning warrants.
   */
  const visibleState =
    // eslint-disable-next-line react-hooks/refs -- read-only; see the comment above.
    isPickerOpen && blockPresent && state.kind === "idle" && !hasFetched.current
      ? LOADING_STATE
      : state;

  if (statusError !== null) {
    return {
      present: blockPresent,
      state: errorState,
      onPickCandidate,
      onRetry: retryStatus,
    };
  }

  return { present: blockPresent, state: visibleState, onPickCandidate, onRetry };
}
