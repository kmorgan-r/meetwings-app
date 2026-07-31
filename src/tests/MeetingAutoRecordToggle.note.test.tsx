import { describe, it, expect, beforeEach, vi } from "vitest";
import { render, screen, act, fireEvent } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";

const listeners = new Map<string, Set<(e: { payload: unknown }) => void>>();

const listen = vi.fn(async (event: string, cb: (e: { payload: unknown }) => void) => {
  if (!listeners.has(event)) listeners.set(event, new Set());
  listeners.get(event)!.add(cb);
  return () => {
    listeners.get(event)?.delete(cb);
  };
});
const emit = vi.fn(async () => {});
const invoke = vi.fn(async () => undefined as unknown);

vi.mock("@tauri-apps/api/event", () => ({
  listen: (...a: Parameters<typeof listen>) => listen(...a),
  emit: (...a: Parameters<typeof emit>) => emit(...a),
}));
vi.mock("@tauri-apps/api/core", () => ({
  invoke: (...a: Parameters<typeof invoke>) => invoke(...a),
}));

let stored: Record<string, string> = {};
vi.mock("@/lib", async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  return {
    ...actual,
    safeLocalStorage: {
      getItem: (k: string) => stored[k] ?? null,
      setItem: (k: string, v: string) => {
        stored[k] = v;
      },
      removeItem: (k: string) => {
        delete stored[k];
      },
    },
  };
});

import { MeetingAutoRecordToggle } from "@/pages/settings/components/MeetingAutoRecordToggle";
import { STORAGE_KEYS } from "@/config/constants";

const flush = async () => {
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
  });
};

const fire = (event: string, payload?: unknown) =>
  act(() => {
    listeners.get(event)?.forEach((cb) => cb({ payload }));
  });

const note = () => screen.queryByText(/detection unavailable/i);

// The component renders <Header>, which calls useNavigate() unconditionally
// (src/components/Header/index.tsx). A bare render throws
// "useNavigate() may be used only in the context of a <Router> component."
const renderToggle = () =>
  render(
    <MemoryRouter>
      <MeetingAutoRecordToggle />
    </MemoryRouter>
  );

beforeEach(() => {
  listeners.clear();
  vi.clearAllMocks();
  stored = {};
  invoke.mockResolvedValue({ running: true, lastError: null });
});

describe("MeetingAutoRecordToggle", () => {
  // F20
  it("persists and announces a toggle", async () => {
    renderToggle();
    await flush();

    fireEvent.click(screen.getByLabelText(/automatically record teams calls/i));
    await flush();

    expect(stored[STORAGE_KEYS.MEETING_AUTO_RECORD_ENABLED]).toBe("true");
    expect(emit).toHaveBeenCalledWith("meeting-detection-setting-changed", {
      enabled: true,
    });
  });

  // F21 - the note predicate, all four combinations
  it("shows the note only when the feature is on and something is wrong", async () => {
    // off + healthy-looking-but-idle status: the ordinary state for a user who
    // never enabled the feature. A bare !running predicate gets this wrong.
    stored = {};
    invoke.mockResolvedValue({ running: false, lastError: null });
    const { unmount: u1 } = renderToggle();
    await flush();
    expect(note()).toBeNull();
    u1();

    // on + not running -> desync, note
    stored = { [STORAGE_KEYS.MEETING_AUTO_RECORD_ENABLED]: "true" };
    const { unmount: u2 } = renderToggle();
    await flush();
    expect(note()).not.toBeNull();
    u2();

    // on + last error -> note
    invoke.mockResolvedValue({ running: false, lastError: "com failure" });
    const { unmount: u3 } = renderToggle();
    await flush();
    expect(note()).not.toBeNull();
    u3();

    // on + healthy -> no note
    invoke.mockResolvedValue({ running: true, lastError: null });
    renderToggle();
    await flush();
    expect(note()).toBeNull();
  });

  // F22 - fail-visible
  it("shows the note when the status query rejects", async () => {
    stored = { [STORAGE_KEYS.MEETING_AUTO_RECORD_ENABLED]: "true" };
    invoke.mockRejectedValue(new Error("unknown command"));
    renderToggle();
    await flush();
    expect(note()).not.toBeNull();
  });

  // F23 / F31
  it("shows one note for repeated errors and clears it on recovery", async () => {
    stored = { [STORAGE_KEYS.MEETING_AUTO_RECORD_ENABLED]: "true" };
    renderToggle();
    await flush();

    fire("meeting-watcher-error", { message: "a" });
    fire("meeting-watcher-error", { message: "b" });
    fire("meeting-watcher-error", { message: "c" });
    expect(screen.getAllByText(/detection unavailable/i)).toHaveLength(1);

    fire("meeting-watcher-recovered");
    expect(note()).toBeNull();
  });

  // F24
  it("offers retry only while the feature is on", async () => {
    stored = { [STORAGE_KEYS.MEETING_AUTO_RECORD_ENABLED]: "true" };
    invoke.mockResolvedValue({ running: false, lastError: "x" });
    renderToggle();
    await flush();

    fireEvent.click(screen.getByRole("button", { name: /retry/i }));
    expect(emit).toHaveBeenCalledWith("meeting-detection-retry-requested", undefined);

    fire("meeting-detection-watcher-restarted", { ok: true });
    // Synchronously the note clears either way (pending vs a trusting impl),
    // so that alone proves nothing. Let the re-query settle: the component
    // re-reads status rather than believing ok:true, and the still-unhealthy
    // status repaints the note. An impl that trusted ok:true leaves it gone.
    await flush();
    expect(invoke).toHaveBeenCalledWith("get_meeting_watcher_status");
    expect(note()).not.toBeNull();
  });

  // F25 - payload-driven, NOT localStorage-driven. Deliver true with storage
  // unset: the false case passes against a component with no handler at all.
  it("reflects a received setting change from the payload", async () => {
    stored = {};
    renderToggle();
    await flush();

    const toggle = screen.getByLabelText(/automatically record teams calls/i);
    expect(toggle).not.toBeChecked();

    fire("meeting-detection-setting-changed", { enabled: true });
    expect(toggle).toBeChecked();
  });

  // F26 - non-vacuous leak assertion, twice
  it("registers and releases its listeners on every visit", async () => {
    for (let visit = 0; visit < 2; visit += 1) {
      const { unmount } = renderToggle();
      await flush();
      expect(listeners.get("meeting-watcher-error")?.size).toBe(1);
      unmount();
      await flush();
      expect(listeners.get("meeting-watcher-error")?.size ?? 0).toBe(0);
    }
  });

  // F27 - the sole-invoker invariant
  it("never invokes the watcher commands directly", async () => {
    stored = { [STORAGE_KEYS.MEETING_AUTO_RECORD_ENABLED]: "true" };
    renderToggle();
    await flush();
    fireEvent.click(screen.getByLabelText(/automatically record teams calls/i));
    await flush();

    expect(invoke).not.toHaveBeenCalledWith("start_meeting_watcher", expect.anything());
    expect(invoke).not.toHaveBeenCalledWith("stop_meeting_watcher");
  });

  // F30 - no note flash on toggle-on
  it("does not show the note while the status query is pending", async () => {
    stored = { [STORAGE_KEYS.MEETING_AUTO_RECORD_ENABLED]: "true" };
    let resolveStatus: (v: unknown) => void = () => {};
    invoke.mockImplementation(
      () => new Promise((resolve) => {
        resolveStatus = resolve;
      })
    );

    renderToggle();
    expect(note()).toBeNull();

    await act(async () => {
      resolveStatus({ running: true, lastError: null });
      await Promise.resolve();
    });
    expect(note()).toBeNull();
  });

  it("renders off when only the legacy detection key is set", async () => {
    // #31's toggle copy promised "Does not start or stop recording", so its
    // persisted `true` is NOT consent to being recorded. The old key must not be
    // migrated - a user who had detection on opts in again, to honest copy.
    stored = { meeting_detection_enabled: "true" };

    renderToggle();
    // Every other case in this file flushes. Without it the component's mount
    // get_meeting_watcher_status resolves after the test and setStatus runs
    // outside act.
    await flush();

    expect(
      screen.getByLabelText("Automatically record Teams calls")
    ).not.toBeChecked();
  });
});
