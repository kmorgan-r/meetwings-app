import { act, renderHook, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

const fetchCurrentMeetings = vi.hoisted(() => vi.fn());
vi.mock("@/lib/calendar/fetch-current-meetings", () => ({ fetchCurrentMeetings }));

const listeners = vi.hoisted(() => new Map<string, Set<(e: unknown) => void>>());
vi.mock("@tauri-apps/api/event", () => ({
  listen: vi.fn(async (name: string, handler: (e: unknown) => void) => {
    const set = listeners.get(name) ?? new Set();
    set.add(handler);
    listeners.set(name, set);
    return () => set.delete(handler);
  }),
}));

import { useCalendarAutoSelect } from "@/hooks/useCalendarAutoSelect";
import type {
  CalendarParticipant,
  CreateContactResult,
  OdooContact,
  SelectedTarget,
} from "@/types";

const MIN = 60_000;

function contact(id: number, email: string, name = `Contact ${id}`): OdooContact {
  return {
    id, name, email, phone: null, companyName: null, parentId: null, isCompany: false,
    active: true, writeDate: "2026-10-01 00:00:00", isColleague: false, lastMeetingAt: null,
  };
}

function person(address: string, name: string): CalendarParticipant {
  return { address, name, type: "required", isOrganizer: false };
}

const CFO = contact(7, "cfo@acme.example", "Cleo Cfo");
const CTO = contact(8, "cto@acme.example", "Theo Cto");
const CONTACTS = [CFO, CTO];
const AT_CFO = person("cfo@acme.example", "Cleo Cfo");
const AT_CTO = person("cto@acme.example", "Theo Cto");
const NEW_A = person("ana@newco.example", "Ana Newco");
const NEW_B = person("ben@otherco.example", "Ben Otherco");

/** One current meeting with these attendees, as fetchCurrentMeetings returns it. */
function meetingWith(...people: CalendarParticipant[]) {
  const now = Date.now();
  return {
    kind: "ok" as const,
    ownAddress: "me@corp.test",
    events: [
      {
        id: "ev1", subject: "Sync", startMs: now - 5 * MIN, endMs: now + 25 * MIN,
        isCancelled: false, isAllDay: false, ownResponse: "accepted",
        participants: [
          { address: "me@corp.test", name: "Me", type: "required" as const, isOrganizer: true },
          ...people,
        ],
      },
    ],
  };
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}

type AddResult = { ok: boolean; reason?: "cap" };

function setup(contacts: OdooContact[] | null = CONTACTS) {
  const addTarget = vi.fn(async (_t: SelectedTarget): Promise<AddResult> => ({ ok: true }));
  const onCreateContact = vi.fn(
    async (p: CalendarParticipant, _d: { name: string; parentId: number | null }): Promise<CreateContactResult> => ({
      kind: "created",
      contact: contact(200, p.address, p.name ?? ""),
    })
  );
  const targetsRef = { current: [] as SelectedTarget[] };
  const view = renderHook(
    (p: { contacts: OdooContact[] | null }) =>
      useCalendarAutoSelect({ contacts: p.contacts, targetsRef, addTarget, onCreateContact }),
    { initialProps: { contacts } }
  );
  return { ...view, addTarget, onCreateContact, targetsRef };
}

async function captureStarts() {
  await act(async () => {
    window.dispatchEvent(new CustomEvent("meetingCaptureStarted"));
  });
}

/** Lets a run that is not parked on a deferred reach its end. */
async function settle() {
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  listeners.clear();
  vi.mocked(localStorage.getItem).mockReset();
  fetchCurrentMeetings.mockReset();
  fetchCurrentMeetings.mockImplementation(async () => meetingWith(AT_CFO));
});

describe("useCalendarAutoSelect", () => {
  it("does nothing until meeting capture starts", async () => {
    setup();
    await settle();
    expect(fetchCurrentMeetings).not.toHaveBeenCalled();
  });

  it("adds the meeting's matched contact when capture starts", async () => {
    const { addTarget } = setup();
    await captureStarts();
    await waitFor(() =>
      expect(addTarget).toHaveBeenCalledWith({ model: "res.partner", resId: 7, name: "Cleo Cfo" })
    );
  });

  it("does not fetch when the setting is off", async () => {
    vi.mocked(localStorage.getItem).mockImplementation((key: string) =>
      key === "calendar_auto_select_enabled" ? "false" : null
    );
    setup();
    await captureStarts();
    await settle();
    expect(fetchCurrentMeetings).not.toHaveBeenCalled();
  });

  it.each([
    ["not ready", null],
    ["empty", []],
  ])("does not fetch when the contact cache is %s", async (_label, contacts) => {
    setup(contacts as OdooContact[] | null);
    await captureStarts();
    await settle();
    expect(fetchCurrentMeetings).not.toHaveBeenCalled();
  });

  it("treats the cache as stale after an instance change until the contacts are replaced", async () => {
    const { rerender } = setup();
    await waitFor(() => expect(listeners.get("odoo-instance-changed")?.size).toBe(1));
    await act(async () => {
      for (const handler of listeners.get("odoo-instance-changed") ?? []) handler({ payload: null });
    });

    await captureStarts();
    await settle();
    expect(fetchCurrentMeetings).not.toHaveBeenCalled();

    rerender({ contacts: [...CONTACTS] });
    await captureStarts();
    await waitFor(() => expect(fetchCurrentMeetings).toHaveBeenCalledTimes(1));
  });

  it("writes nothing when the calendar call fails", async () => {
    fetchCurrentMeetings.mockImplementation(async () => ({ kind: "error", code: "GRAPH_NETWORK" }));
    const { addTarget, onCreateContact } = setup();
    await captureStarts();
    await settle();
    expect(fetchCurrentMeetings).toHaveBeenCalledTimes(1);
    expect(addTarget).not.toHaveBeenCalled();
    expect(onCreateContact).not.toHaveBeenCalled();
  });

  it("writes one target at a time", async () => {
    fetchCurrentMeetings.mockImplementation(async () => meetingWith(AT_CFO, AT_CTO));
    const first = deferred<AddResult>();
    const { addTarget } = setup();
    addTarget.mockImplementationOnce(() => first.promise);

    await captureStarts();
    await waitFor(() => expect(addTarget).toHaveBeenCalledTimes(1));
    await settle();
    expect(addTarget).toHaveBeenCalledTimes(1);

    await act(async () => {
      first.resolve({ ok: true });
    });
    await waitFor(() => expect(addTarget).toHaveBeenCalledTimes(2));
  });

  it("adds every matched contact before creating anyone", async () => {
    fetchCurrentMeetings.mockImplementation(async () => meetingWith(NEW_A, AT_CFO));
    const { addTarget, onCreateContact } = setup();
    await captureStarts();
    await waitFor(() => expect(onCreateContact).toHaveBeenCalledTimes(1));
    expect(addTarget.mock.invocationCallOrder[0]).toBeLessThan(
      onCreateContact.mock.invocationCallOrder[0]
    );
  });

  const MADE = contact(100, NEW_A.address, "Ana Newco");
  it.each<[CreateContactResult, boolean]>([
    [{ kind: "created", contact: MADE }, true],
    [{ kind: "adopted-active", contact: MADE }, true],
    [{ kind: "adopted-archived", contact: MADE }, false],
    [{ kind: "created-invisible" }, false],
    [{ kind: "cached-failed" }, false],
    [{ kind: "failed", code: "ODOO_UNREACHABLE" }, false],
    [{ kind: "abandoned" }, false],
    [{ kind: "busy" }, false],
  ])("after a create returning %o, adds it: %s, and moves on to the next attendee", async (outcome, adds) => {
    fetchCurrentMeetings.mockImplementation(async () => meetingWith(NEW_A, NEW_B));
    const { addTarget, onCreateContact } = setup();
    onCreateContact.mockResolvedValueOnce(outcome);

    await captureStarts();
    await waitFor(() => expect(onCreateContact).toHaveBeenCalledTimes(2));
    await waitFor(() =>
      expect(addTarget).toHaveBeenCalledWith({ model: "res.partner", resId: 200, name: "Ben Otherco" })
    );
    expect(addTarget.mock.calls.some(([t]) => t.resId === 100)).toBe(adds);
  });

  it.each<[AddResult]>([[{ ok: false, reason: "cap" }], [{ ok: false }]])(
    "stops at the first refused add (%o)",
    async (refusal) => {
      fetchCurrentMeetings.mockImplementation(async () => meetingWith(AT_CFO, AT_CTO, NEW_A));
      const { addTarget, onCreateContact } = setup();
      addTarget.mockResolvedValueOnce(refusal);

      await captureStarts();
      await waitFor(() => expect(addTarget).toHaveBeenCalledTimes(1));
      await settle();
      expect(addTarget).toHaveBeenCalledTimes(1);
      expect(onCreateContact).not.toHaveBeenCalled();
    }
  );

  it("stops when the add after a create is refused", async () => {
    fetchCurrentMeetings.mockImplementation(async () => meetingWith(NEW_A, NEW_B));
    const { addTarget, onCreateContact } = setup();
    addTarget.mockResolvedValueOnce({ ok: false, reason: "cap" });

    await captureStarts();
    await waitFor(() => expect(addTarget).toHaveBeenCalledTimes(1));
    await settle();
    expect(onCreateContact).toHaveBeenCalledTimes(1);
  });

  it.each<[string, () => void]>([
    ["a new conversation starts", () => window.dispatchEvent(new CustomEvent("newConversationStarted"))],
    ["the user clears the targets", () => window.dispatchEvent(new CustomEvent("odooTargetsCleared"))],
    [
      "the Odoo instance changes",
      () => {
        for (const handler of listeners.get("odoo-instance-changed") ?? []) handler({ payload: null });
      },
    ],
  ])("stops before the next write when %s mid-run", async (_label, interrupt) => {
    fetchCurrentMeetings.mockImplementation(async () => meetingWith(AT_CFO, AT_CTO));
    const first = deferred<AddResult>();
    const { addTarget } = setup();
    addTarget.mockImplementationOnce(() => first.promise);
    await waitFor(() => expect(listeners.get("odoo-instance-changed")?.size).toBe(1));

    await captureStarts();
    await waitFor(() => expect(addTarget).toHaveBeenCalledTimes(1));
    await act(async () => {
      interrupt();
      first.resolve({ ok: true });
    });
    await settle();
    expect(addTarget).toHaveBeenCalledTimes(1);
  });

  it("writes nothing when a new conversation starts during the calendar call", async () => {
    const parked = deferred<ReturnType<typeof meetingWith>>();
    fetchCurrentMeetings.mockImplementationOnce(() => parked.promise);
    const { addTarget, onCreateContact } = setup();

    await captureStarts();
    await act(async () => {
      window.dispatchEvent(new CustomEvent("newConversationStarted"));
      parked.resolve(meetingWith(AT_CFO, NEW_A));
    });
    await settle();
    expect(addTarget).not.toHaveBeenCalled();
    expect(onCreateContact).not.toHaveBeenCalled();
  });

  it("does not add a created contact when a new conversation starts during the create", async () => {
    fetchCurrentMeetings.mockImplementation(async () => meetingWith(NEW_A));
    const created = deferred<CreateContactResult>();
    const { addTarget, onCreateContact } = setup();
    onCreateContact.mockImplementationOnce(() => created.promise);

    await captureStarts();
    await waitFor(() => expect(onCreateContact).toHaveBeenCalledTimes(1));
    await act(async () => {
      window.dispatchEvent(new CustomEvent("newConversationStarted"));
      created.resolve({ kind: "created", contact: contact(100, NEW_A.address, "Ana Newco") });
    });
    await settle();
    expect(addTarget).not.toHaveBeenCalled();
  });

  it("ignores a capture start while a run is in flight", async () => {
    const parked = deferred<ReturnType<typeof meetingWith>>();
    fetchCurrentMeetings.mockImplementationOnce(() => parked.promise);
    const { addTarget } = setup();

    await captureStarts();
    await captureStarts();
    expect(fetchCurrentMeetings).toHaveBeenCalledTimes(1);

    await act(async () => {
      parked.resolve(meetingWith(AT_CFO));
    });
    await waitFor(() => expect(addTarget).toHaveBeenCalledTimes(1));
  });

  it("runs again for a later capture, after a failed run and after a finished one", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    fetchCurrentMeetings.mockImplementationOnce(async () => {
      throw new Error("boom");
    });
    setup();

    await captureStarts();
    await settle();
    await captureStarts();
    await settle();
    await captureStarts();
    await settle();
    expect(fetchCurrentMeetings).toHaveBeenCalledTimes(3);
  });
});