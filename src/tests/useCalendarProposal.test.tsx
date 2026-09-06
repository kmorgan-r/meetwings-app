import { act, renderHook, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
// The mock factory below owns this reference too - importing it here (rather
// than adding a second vi.hoisted export) gets the SAME mock `listen`
// function the hook calls, so `.mockImplementationOnce` on it intercepts the
// hook's own next `listen()` call. `vi.mocked` is a TYPE-ONLY cast (it
// returns its argument unchanged at runtime) - needed because the import
// itself resolves to `@tauri-apps/api/event`'s real .d.ts, which has no
// `mockImplementationOnce`.
import { listen as listenImport } from "@tauri-apps/api/event";
const listen = vi.mocked(listenImport);

const invoke = vi.hoisted(() => vi.fn());
vi.mock("@tauri-apps/api/core", () => ({ invoke }));

const listeners = vi.hoisted(() => new Map<string, Set<(e: unknown) => void>>());
vi.mock("@tauri-apps/api/event", () => ({
  listen: vi.fn(async (name: string, handler: (e: unknown) => void) => {
    const set = listeners.get(name) ?? new Set();
    set.add(handler);
    listeners.set(name, set);
    return () => set.delete(handler);
  }),
  emit: vi.fn(async () => {}),
}));

const config = vi.hoisted(() => ({
  loadGraphConfigState: vi.fn(async () => ({
    state: "complete" as const,
    config: { clientId: "c", authority: "https://login.microsoftonline.com/organizations" },
  })),
}));
vi.mock("@/lib/storage/graph-config.storage", () => config);

import { useCalendarProposal } from "@/hooks/useCalendarProposal";
import type { OdooContact } from "@/types";

const NOW = Date.UTC(2026, 8, 2, 14, 0, 0);
const MIN = 60_000;

function contact(id: number, email: string): OdooContact {
  return {
    id, name: `Contact ${id}`, email, phone: null, companyName: null, parentId: null,
    isCompany: false, active: true, writeDate: "2026-09-01 00:00:00",
    isColleague: false, lastMeetingAt: null,
  };
}

const CONTACTS: OdooContact[] = [contact(7, "cfo@acme.example")];

function meeting(id: string, subject: string) {
  return {
    id, subject, startMs: NOW - 5 * MIN, endMs: NOW + 25 * MIN,
    isCancelled: false, isAllDay: false, ownResponse: "accepted",
    participants: [
      { address: "me@corp.test", name: null, type: "required", isOrganizer: true },
      { address: "cfo@acme.example", name: "CFO", type: "required", isOrganizer: false },
    ],
  };
}

function mockGraph(events: unknown[]) {
  invoke.mockImplementation(async (cmd: string) => {
    if (cmd === "graph_status") return { connected: true, sessionOnly: false };
    if (cmd === "graph_current_meetings") return { ownAddress: "me@corp.test", events };
    throw new Error(`unexpected command ${cmd}`);
  });
}

function setup(over: Partial<Parameters<typeof useCalendarProposal>[0]> = {}) {
  const setCalendarBlockPresent = vi.fn();
  const props = { isPickerOpen: false, contacts: CONTACTS, setCalendarBlockPresent, ...over };
  const view = renderHook((p: typeof props) => useCalendarProposal(p), {
    initialProps: props,
  });
  return { ...view, setCalendarBlockPresent };
}

beforeEach(() => {
  vi.clearAllMocks();
  listeners.clear();
  vi.setSystemTime(NOW);
  config.loadGraphConfigState.mockResolvedValue({
    state: "complete",
    config: { clientId: "c", authority: "https://login.microsoftonline.com/organizations" },
  });
});

describe("presence", () => {
  // All three are known BEFORE the popover opens, so they route into
  // useCompletion's flag list and nothing is reserved. This is the common case
  // for the default v1 user and it must cost nothing.
  it("is statically absent when no calendar is connected", async () => {
    invoke.mockResolvedValue({ connected: false, sessionOnly: false });
    const { result, setCalendarBlockPresent } = setup();
    await waitFor(() => expect(result.current.present).toBe(false));
    expect(setCalendarBlockPresent).toHaveBeenLastCalledWith(false);
  });

  /**
   * `present` reads `false` at t=0 regardless of `rows.length` - `connected`
   * itself starts `false` - so a bare `waitFor(() => expect(present).toBe(false))`
   * passes on its FIRST synchronous check, before `connected` ever resolves
   * true, and would pass identically if the `rows.length > 0` half of
   * `present`'s guard were deleted entirely. Waiting on `graph_status` having
   * actually been called forces a real flush: `connected` genuinely resolves
   * `true` here (mockGraph), so this only stays `false` because the cache
   * check is doing its job.
   */
  it("is statically absent while the contact cache is not ready", async () => {
    mockGraph([meeting("e1", "Sync")]);
    const { result } = setup({ contacts: null });
    await waitFor(() => expect(invoke).toHaveBeenCalledWith("graph_status"));
    expect(result.current.present).toBe(false);
  });

  // Same non-discrimination risk as above, and the same fix.
  it("is statically absent when the contact cache is empty", async () => {
    mockGraph([meeting("e1", "Sync")]);
    const { result } = setup({ contacts: [] });
    await waitFor(() => expect(invoke).toHaveBeenCalledWith("graph_status"));
    expect(result.current.present).toBe(false);
  });

  it("is present when connected with a populated cache", async () => {
    mockGraph([]);
    const { result, setCalendarBlockPresent } = setup();
    await waitFor(() => expect(result.current.present).toBe(true));
    expect(setCalendarBlockPresent).toHaveBeenLastCalledWith(true);
  });

  /**
   * A status read that FAILED is not "not connected". Collapsing the two makes
   * the feature vanish with nothing on screen, which looks exactly like never
   * having set it up - so a user with a momentarily unreadable keychain has no
   * way to tell the difference.
   */
  it("surfaces an unreadable connection state as an error, not a silent absence", async () => {
    invoke.mockImplementation(async (cmd: string) => {
      if (cmd === "graph_status") throw new Error("GRAPH_NO_KEYCHAIN");
      throw new Error(`unexpected command ${cmd}`);
    });
    const { result } = setup();
    await waitFor(() =>
      expect(result.current.state).toEqual({ kind: "error", code: "GRAPH_NO_KEYCHAIN" })
    );
    // Forced present: this is the one failure worth the reserved space.
    expect(result.current.present).toBe(true);
  });

  /**
   * What the hook RETURNS and what it PUBLISHES to useCompletion must be the
   * same value. `calendarBlockPresent` exists solely to sit in the resize
   * effect's dependency array, so a returned `true` alongside a published
   * `false` renders the 112px region with nothing re-running the resize.
   */
  it("publishes the same presence it returns, including on a status error", async () => {
    invoke.mockImplementation(async (cmd: string) => {
      if (cmd === "graph_status") throw new Error("GRAPH_NO_KEYCHAIN");
      throw new Error(`unexpected command ${cmd}`);
    });
    const { result, setCalendarBlockPresent } = setup();
    await waitFor(() => expect(result.current.present).toBe(true));
    expect(setCalendarBlockPresent).toHaveBeenLastCalledWith(true);
  });

  /**
   * `idle` renders nothing and the fetch is triggered from a PASSIVE effect, so
   * without deriving the loading state during render the region would be absent
   * for the commit the popover opens on and appear on the next one — the
   * footprint growing after open, in miniature.
   */
  it("reports loading on the very first render after the picker opens", async () => {
    // Never resolves: the state under test is the one before any response.
    invoke.mockImplementation(async (cmd: string) => {
      if (cmd === "graph_status") return { connected: true, sessionOnly: false };
      return new Promise(() => {});
    });
    const { result, rerender } = setup();
    await waitFor(() => expect(result.current.present).toBe(true));

    rerender({ isPickerOpen: true, contacts: CONTACTS, setCalendarBlockPresent: vi.fn() });
    // Synchronously on the opening render - no await, no flush.
    expect(result.current.state).toEqual({ kind: "loading" });
  });

  // "Never set up" is the routine v1 state and must stay silent.
  it("stays silently absent when no client ID is configured", async () => {
    config.loadGraphConfigState.mockResolvedValue({ state: "absent", config: null });
    const { result } = setup();
    await waitFor(() => expect(result.current.present).toBe(false));
    expect(result.current.state).toEqual({ kind: "idle" });
  });

  /**
   * The existing "unreadable" test (above) actually drives `graph_status` to
   * THROW - it never gives `loadGraphConfigState` an `unreadable` result, so a
   * mutant collapsing the `unreadable` branch into the `absent` one (silent,
   * no error) passes the whole suite untouched. "Never collapse absent and
   * unreadable" is a global constraint of this feature; this is what actually
   * pins it on the `readStatus` path; the next describe block pins it on
   * `fetchNow`.
   */
  it("treats an unreadable config as an error, not a disconnected account", async () => {
    config.loadGraphConfigState.mockResolvedValue({ state: "unreadable", config: null });
    const { result } = setup();
    await waitFor(() =>
      expect(result.current.state).toEqual({ kind: "error", code: "GRAPH_AUTH_REJECTED" })
    );
    expect(result.current.present).toBe(true);
  });

  /**
   * `/odoo` lives in the `dashboard` webview and this hook runs in `main`.
   * Without the cross-window listener, connecting there would not reach here
   * until an app restart, and disconnecting there would leave this window
   * erroring on every open.
   */
  it("re-reads the connection state when /odoo broadcasts a change", async () => {
    invoke.mockImplementation(async (cmd: string) => {
      if (cmd === "graph_status") return { connected: false, sessionOnly: false };
      throw new Error(`unexpected command ${cmd}`);
    });
    const { result } = setup();
    await waitFor(() => expect(result.current.present).toBe(false));

    invoke.mockImplementation(async (cmd: string) => {
      if (cmd === "graph_status") return { connected: true, sessionOnly: false };
      throw new Error(`unexpected command ${cmd}`);
    });
    await act(async () => {
      for (const handler of listeners.get("graph-connection-changed") ?? []) {
        handler({ payload: null });
      }
    });
    await waitFor(() => expect(result.current.present).toBe(true));
  });
});

describe("fetching", () => {
  /**
   * The race the frozen-`present` gate produced: open the picker before
   * `connected` and the contact cache have resolved, and the effect saw
   * `present === false`, returned, and — with `present` out of its dependency
   * array — never ran again. No block at all for the whole open session, not
   * even "Checking your calendar…", until the user closed and reopened.
   */
  it("still fetches when present resolves true AFTER the picker is already open", async () => {
    mockGraph([meeting("e1", "Sync")]);
    const props = { isPickerOpen: true, contacts: null as OdooContact[] | null, setCalendarBlockPresent: vi.fn() };
    const { result, rerender } = renderHook((p: typeof props) => useCalendarProposal(p), {
      initialProps: props,
    });
    // Cache not ready yet: nothing to fetch against.
    expect(invoke).not.toHaveBeenCalledWith("graph_current_meetings", expect.anything());

    rerender({ ...props, contacts: CONTACTS });
    await waitFor(() =>
      expect(result.current.state).toMatchObject({ kind: "proposal", subject: "Sync" })
    );
    // Exactly once, not once per render - the fetch-guard ref is what keeps
    // adding `present` to the deps from becoming a refetch loop.
    expect(
      invoke.mock.calls.filter(([cmd]) => cmd === "graph_current_meetings")
    ).toHaveLength(1);
  });

  it("does not call Graph until the picker opens", async () => {
    mockGraph([meeting("e1", "Sync")]);
    const { result, rerender } = setup();
    await waitFor(() => expect(result.current.present).toBe(true));
    expect(invoke).not.toHaveBeenCalledWith("graph_current_meetings", expect.anything());

    rerender({ isPickerOpen: true, contacts: CONTACTS, setCalendarBlockPresent: vi.fn() });
    await waitFor(() =>
      expect(result.current.state).toMatchObject({ kind: "proposal", subject: "Sync" })
    );
  });

  /**
   * The companion to the two "statically absent" presence tests: THIS is the
   * case that actually discriminates the `rows.length > 0` half of
   * `present`'s guard, because it observes something that would be different
   * under the `const present = connected` mutant - a fetch that never
   * happens - rather than a value (`present === false`) that mutant also
   * produces, just for the wrong reason. The picker opens immediately and
   * `connected` genuinely resolves `true` (mockGraph); only the cache never
   * arriving is why `graph_current_meetings` must never be called.
   */
  it("never calls Graph when the picker opens against a cache that never arrives", async () => {
    mockGraph([meeting("e1", "Sync")]);
    const props = { isPickerOpen: true, contacts: null as OdooContact[] | null, setCalendarBlockPresent: vi.fn() };
    renderHook((p: typeof props) => useCalendarProposal(p), { initialProps: props });
    await waitFor(() => expect(invoke).toHaveBeenCalledWith("graph_status"));
    expect(invoke).not.toHaveBeenCalledWith("graph_current_meetings", expect.anything());
  });

  /**
   * `fetchNow` reads `loadGraphConfigState` a SECOND time (readStatus already
   * read it once at mount) - the config can go bad between mount and open.
   * Without this, only `readStatus`'s own unreadable branch is pinned; a
   * mutant collapsing fetchNow's `unreadable` arm into its `absent` one (no
   * error, just `idle`) would still pass every other test in this file.
   */
  it("surfaces GRAPH_AUTH_REJECTED from fetchNow when the config goes unreadable after mount", async () => {
    mockGraph([]);
    config.loadGraphConfigState
      .mockResolvedValueOnce({
        state: "complete",
        config: { clientId: "c", authority: "https://login.microsoftonline.com/organizations" },
      })
      .mockResolvedValueOnce({ state: "unreadable", config: null });
    const props = { isPickerOpen: true, contacts: CONTACTS, setCalendarBlockPresent: vi.fn() };
    const { result } = renderHook((p: typeof props) => useCalendarProposal(p), {
      initialProps: props,
    });
    await waitFor(() =>
      expect(result.current.state).toEqual({ kind: "error", code: "GRAPH_AUTH_REJECTED" })
    );
  });

  // Recomputed each time the picker opens - which covers the realistic case
  // (the calendar entry changing mid-meeting) without a watcher.
  it("recomputes on each open and not on a calendar-data change", async () => {
    mockGraph([meeting("e1", "Sync")]);
    const props = { isPickerOpen: true, contacts: CONTACTS, setCalendarBlockPresent: vi.fn() };
    const { result, rerender } = renderHook((p: typeof props) => useCalendarProposal(p), {
      initialProps: props,
    });
    await waitFor(() =>
      expect(invoke).toHaveBeenCalledWith("graph_current_meetings", expect.anything())
    );
    const afterFirstOpen = invoke.mock.calls.filter(
      ([cmd]) => cmd === "graph_current_meetings"
    ).length;
    // Captured before the contacts-reference-changing rerenders below, so the
    // toBe assertions after them prove these three members survive a
    // `contacts` identity change with no new fetch behind it - not just that
    // no fetch happened (the invoke-count assertions already cover that).
    const stateBeforeRerenders = result.current.state;
    const onRetryBeforeRerenders = result.current.onRetry;
    const onPickCandidateBeforeRerenders = result.current.onPickCandidate;

    // A NEW array reference with identical contents, while the picker stays
    // open. Rerendering with the SAME `contacts` reference could not fail this
    // test: `project`/`fetchNow` would keep their identity whatever the
    // dependency array said, so a future edit that put `contacts` back into the
    // fetch effect's deps would still pass. Changing the reference is what
    // actually exercises the rule.
    rerender({ ...props, contacts: [...CONTACTS] });
    expect(
      invoke.mock.calls.filter(([cmd]) => cmd === "graph_current_meetings")
    ).toHaveLength(afterFirstOpen);

    rerender({ ...props, contacts: [...CONTACTS, contact(8, "new@acme.example")] });
    expect(
      invoke.mock.calls.filter(([cmd]) => cmd === "graph_current_meetings")
    ).toHaveLength(afterFirstOpen);

    // The other half of the property completion-calendar-wiring.test.tsx pins
    // at the call site: that test proves <Completion />'s calendarProps memo
    // survives a rerender GIVEN a hook that returns stable members; this
    // proves the real hook IS that stable member source, not just a mock
    // standing in for one. `project`'s deps are `[]` (it reads `contacts` via
    // `rowsRef`, per the doc comment on `project` in useCalendarProposal.ts),
    // which is what keeps `onPickCandidate`/`onRetry`/`state` from changing
    // identity here even though `contacts` itself is a fresh array on both
    // rerenders above.
    expect(result.current.state).toBe(stateBeforeRerenders);
    expect(result.current.onRetry).toBe(onRetryBeforeRerenders);
    expect(result.current.onPickCandidate).toBe(onPickCandidateBeforeRerenders);

    rerender({ ...props, isPickerOpen: false });
    rerender({ ...props, isPickerOpen: true });
    await waitFor(() =>
      expect(
        invoke.mock.calls.filter(([cmd]) => cmd === "graph_current_meetings").length
      ).toBe(afterFirstOpen + 1)
    );
  });

  it("moves from several survivors to a single proposal when one is picked", async () => {
    mockGraph([meeting("a", "Client sync"), meeting("b", "Standup")]);
    const props = { isPickerOpen: true, contacts: CONTACTS, setCalendarBlockPresent: vi.fn() };
    const { result } = renderHook((p: typeof props) => useCalendarProposal(p), {
      initialProps: props,
    });
    await waitFor(() => expect(result.current.state.kind).toBe("several"));

    // Full shape, not just `state.kind` - `matched`/`unmatched`/`candidates`
    // are asserted nowhere else in this file. `toEqual`, not `toMatchObject`:
    // a mutant that drops `summarize` (useCalendarProposal.ts) and returns
    // `picked.candidates` raw type-checks (a `CalendarEvent` is structurally
    // assignable to `CandidateSummary`) and would push every attendee's
    // address into UI state - a `toMatchObject` subset check tolerates the
    // extra `participants` field the raw event carries and would not catch
    // that; `toEqual` requires an exact key set and does.
    expect(result.current.state).toEqual({
      kind: "several",
      candidates: [
        { id: "a", subject: "Client sync", startMs: NOW - 5 * MIN, endMs: NOW + 25 * MIN },
        { id: "b", subject: "Standup", startMs: NOW - 5 * MIN, endMs: NOW + 25 * MIN },
      ],
    });

    act(() => result.current.onPickCandidate("b"));
    // `matched`/`unmatched` here also catch two mutants a bare `subject`
    // check misses: `ownAddress: null` hardcoded into `project`'s
    // `matchAttendees` call (the organizer stops being excluded as self and
    // shows up in `unmatched` instead), and `contacts: []` hardcoded in place
    // of `rows` (the CFO drops out of `matched` entirely).
    expect(result.current.state).toMatchObject({
      kind: "proposal",
      eventId: "b",
      subject: "Standup",
      matched: [{ contact: { id: 7 } }],
      unmatched: [],
    });
  });

  it("reports no-meeting rather than an error when nothing is live", async () => {
    mockGraph([]);
    const props = { isPickerOpen: true, contacts: CONTACTS, setCalendarBlockPresent: vi.fn() };
    const { result } = renderHook((p: typeof props) => useCalendarProposal(p), {
      initialProps: props,
    });
    await waitFor(() => expect(result.current.state).toEqual({ kind: "no-meeting" }));
  });

  it("surfaces a GRAPH_* code as an error state", async () => {
    invoke.mockImplementation(async (cmd: string) => {
      if (cmd === "graph_status") return { connected: true, sessionOnly: false };
      throw new Error("GRAPH_BAD_RESPONSE");
    });
    const props = { isPickerOpen: true, contacts: CONTACTS, setCalendarBlockPresent: vi.fn() };
    const { result } = renderHook((p: typeof props) => useCalendarProposal(p), {
      initialProps: props,
    });
    await waitFor(() =>
      expect(result.current.state).toEqual({ kind: "error", code: "GRAPH_BAD_RESPONSE" })
    );
  });
});

describe("reprojection", () => {
  /**
   * IMPORTANT 1's fail-first case. `state` is a snapshot computed once, at
   * fetch time - nothing previously re-derived it, so a matched attendee who
   * becomes a colleague WHILE their proposal is already on screen stayed
   * rendered as a checkable, pre-ticked row forever (until the picker closed
   * and reopened). `matchAttendees` would now exclude this contact (reason
   * "colleague"), so a fixed hook must drop it out of `matched` on the very
   * next `contacts` update, without a new fetch.
   *
   * Against the unfixed hook this fails: `state.matched` keeps the stale
   * `{ contact: { id: 7 } }` entry forever, since nothing re-projects it.
   */
  it("drops a matched contact from the proposal once it becomes a colleague, with no new fetch", async () => {
    mockGraph([meeting("e1", "Sync")]);
    const props = { isPickerOpen: true, contacts: CONTACTS, setCalendarBlockPresent: vi.fn() };
    const { result, rerender } = renderHook((p: typeof props) => useCalendarProposal(p), {
      initialProps: props,
    });
    await waitFor(() =>
      expect(result.current.state).toMatchObject({
        kind: "proposal",
        matched: [{ contact: { id: 7 } }],
      })
    );
    const fetchesBefore = invoke.mock.calls.filter(
      ([cmd]) => cmd === "graph_current_meetings"
    ).length;

    const colleague = { ...contact(7, "cfo@acme.example"), isColleague: true };
    rerender({ ...props, contacts: [colleague] });

    await waitFor(() =>
      expect(result.current.state).toMatchObject({ kind: "proposal", matched: [] })
    );
    // Re-projected locally against the events/ownAddress already in hand -
    // never a second round trip to Graph.
    expect(
      invoke.mock.calls.filter(([cmd]) => cmd === "graph_current_meetings")
    ).toHaveLength(fetchesBefore);
  });
});

describe("lifecycle", () => {
  // ContactPicker stays MOUNTED when the popover closes (ContactPicker.tsx:205-206),
  // so without an explicit reset the previous meeting's matches are what the
  // user sees on reopen - and the feature's own motivating case is the SAME
  // attendees recurring week to week.
  it("clears state on the open -> false transition", async () => {
    mockGraph([meeting("e1", "Sync")]);
    const props = { isPickerOpen: true, contacts: CONTACTS, setCalendarBlockPresent: vi.fn() };
    const { result, rerender } = renderHook((p: typeof props) => useCalendarProposal(p), {
      initialProps: props,
    });
    await waitFor(() => expect(result.current.state.kind).toBe("proposal"));

    rerender({ ...props, isPickerOpen: false });
    expect(result.current.state).toEqual({ kind: "idle" });
  });

  // An id from one instance names a DIFFERENT partner in another - the same
  // reason the matcher is instance-scoped.
  it("clears state on an Odoo instance change", async () => {
    mockGraph([meeting("e1", "Sync")]);
    const props = { isPickerOpen: true, contacts: CONTACTS, setCalendarBlockPresent: vi.fn() };
    const { result } = renderHook((p: typeof props) => useCalendarProposal(p), {
      initialProps: props,
    });
    await waitFor(() => expect(result.current.state.kind).toBe("proposal"));

    await act(async () => {
      for (const handler of listeners.get("odoo-instance-changed") ?? []) {
        handler({ payload: null });
      }
    });
    expect(result.current.state).toEqual({ kind: "idle" });
  });

  /**
   * IMPORTANT 2's fail-first case. The picker stays open across a
   * disconnect-then-reconnect broadcast from `/odoo` - `isPickerOpen` never
   * goes false, so `hasFetched.current` was never cleared for it. Against the
   * unfixed hook, `state` is untouched by the disconnect (nothing resets it),
   * and on reconnect `hasFetched.current` is still `true`, so the fetch
   * effect skips straight past and the PREVIOUS account's proposal - subject,
   * attendees, matches, a live confirm button - resurfaces once `present`
   * flips back true, even though the account behind it is now a different
   * one.
   */
  it("discards a stale proposal and refetches on a disconnect-then-reconnect while the picker stays open", async () => {
    mockGraph([meeting("e1", "Sync")]);
    const props = { isPickerOpen: true, contacts: CONTACTS, setCalendarBlockPresent: vi.fn() };
    const { result } = renderHook((p: typeof props) => useCalendarProposal(p), {
      initialProps: props,
    });
    await waitFor(() =>
      expect(result.current.state).toMatchObject({ kind: "proposal", subject: "Sync" })
    );

    // Disconnected on /odoo; broadcast reaches this window.
    invoke.mockImplementation(async (cmd: string) => {
      if (cmd === "graph_status") return { connected: false, sessionOnly: false };
      throw new Error(`unexpected command ${cmd}`);
    });
    await act(async () => {
      for (const handler of listeners.get("graph-connection-changed") ?? []) {
        handler({ payload: null });
      }
    });
    await waitFor(() => expect(result.current.present).toBe(false));

    // Reconnected - a DIFFERENT account, with a different meeting live now.
    mockGraph([meeting("e2", "Someone else's meeting")]);
    await act(async () => {
      for (const handler of listeners.get("graph-connection-changed") ?? []) {
        handler({ payload: null });
      }
    });

    await waitFor(() =>
      expect(result.current.state).toMatchObject({
        kind: "proposal",
        subject: "Someone else's meeting",
      })
    );
  });

  // React 19 StrictMode double-invokes effects, and a close-then-reopen can
  // leave two Graph calls in flight. Without a generation guard the OLDER
  // response overwrites the newer one.
  it("discards a superseded in-flight response", async () => {
    const resolvers: Array<(value: unknown) => void> = [];
    invoke.mockImplementation(async (cmd: string) => {
      if (cmd === "graph_status") return { connected: true, sessionOnly: false };
      return new Promise((resolve) => resolvers.push(resolve));
    });
    const props = { isPickerOpen: true, contacts: CONTACTS, setCalendarBlockPresent: vi.fn() };
    const { result, rerender } = renderHook((p: typeof props) => useCalendarProposal(p), {
      initialProps: props,
    });
    await waitFor(() => expect(resolvers).toHaveLength(1));

    rerender({ ...props, isPickerOpen: false });
    rerender({ ...props, isPickerOpen: true });
    await waitFor(() => expect(resolvers).toHaveLength(2));

    // Second (current) request answers first, then the stale one answers.
    await act(async () => {
      resolvers[1]({ ownAddress: "me@corp.test", events: [meeting("new", "Newer")] });
      resolvers[0]({ ownAddress: "me@corp.test", events: [meeting("old", "Stale")] });
    });
    expect(result.current.state).toMatchObject({ kind: "proposal", subject: "Newer" });
  });

  /**
   * The only test in this file that can actually catch a regression of the
   * disposed-flag guard on the `listen()` cleanups. Every other test's
   * `listen` mock (from the module factory above) resolves synchronously, so
   * the unmount-before-resolve race those guards exist for never occurs
   * elsewhere - a cleanup that reverted to a bare `let unlisten; ... return
   * () => unlisten?.();` would still pass every other test in this file.
   * Intercepting exactly the NEXT `listen()` call and holding it open until
   * after `unmount()` is what forces that race.
   */
  it("unsubscribes a listener whose listen() promise resolves after unmount", async () => {
    mockGraph([]);
    let resolveListen: ((unlisten: () => void) => void) | undefined;
    listen.mockImplementationOnce(
      () => new Promise((resolve) => { resolveListen = resolve; })
    );
    const { unmount } = setup();
    expect(resolveListen).toBeDefined();

    unmount();
    const un = vi.fn();
    resolveListen!(un);
    await waitFor(() => expect(un).toHaveBeenCalled());
  });

  /**
   * The `odoo-instance-changed` effect carries the identical disposed-flag
   * guard, on its own separate `listen()` call - a regression there would
   * ship undetected if only the connection listener above were ever tested.
   * The connection-changed effect is declared first in the hook, so its
   * `listen()` call always fires before this one on mount; the leading
   * `mockImplementationOnce` below reproduces the module mock's own default
   * behaviour for that first call, purely so the SECOND `mockImplementationOnce`
   * lands on the `odoo-instance-changed` call this test actually targets.
   */
  it("unsubscribes the odoo-instance-changed listener whose listen() promise resolves after unmount", async () => {
    mockGraph([]);
    listen.mockImplementationOnce(async (name: string, handler: (e: unknown) => void) => {
      const set = listeners.get(name) ?? new Set();
      set.add(handler);
      listeners.set(name, set);
      return () => set.delete(handler);
    });
    let resolveListen: ((unlisten: () => void) => void) | undefined;
    listen.mockImplementationOnce(
      () => new Promise((resolve) => { resolveListen = resolve; })
    );
    const { unmount } = setup();
    expect(resolveListen).toBeDefined();

    unmount();
    const un = vi.fn();
    resolveListen!(un);
    await waitFor(() => expect(un).toHaveBeenCalled());
  });
});
