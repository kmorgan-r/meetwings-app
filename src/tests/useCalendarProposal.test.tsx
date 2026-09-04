import { act, renderHook, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

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

  it("is statically absent while the contact cache is not ready", async () => {
    mockGraph([meeting("e1", "Sync")]);
    const { result } = setup({ contacts: null });
    await waitFor(() => expect(result.current.present).toBe(false));
  });

  it("is statically absent when the contact cache is empty", async () => {
    mockGraph([meeting("e1", "Sync")]);
    const { result } = setup({ contacts: [] });
    await waitFor(() => expect(result.current.present).toBe(false));
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

  // Recomputed each time the picker opens - which covers the realistic case
  // (the calendar entry changing mid-meeting) without a watcher.
  it("recomputes on each open and not on a calendar-data change", async () => {
    mockGraph([meeting("e1", "Sync")]);
    const props = { isPickerOpen: true, contacts: CONTACTS, setCalendarBlockPresent: vi.fn() };
    const { rerender } = renderHook((p: typeof props) => useCalendarProposal(p), {
      initialProps: props,
    });
    await waitFor(() =>
      expect(invoke).toHaveBeenCalledWith("graph_current_meetings", expect.anything())
    );
    const afterFirstOpen = invoke.mock.calls.filter(
      ([cmd]) => cmd === "graph_current_meetings"
    ).length;

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

    act(() => result.current.onPickCandidate("b"));
    expect(result.current.state).toMatchObject({ kind: "proposal", subject: "Standup" });
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
});
