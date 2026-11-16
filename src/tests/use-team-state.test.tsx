import { beforeEach, describe, expect, it, vi } from "vitest";
import { act, renderHook } from "@testing-library/react";

const h = vi.hoisted(() => ({
  listen: vi.fn(),
  emit: vi.fn(),
}));

vi.mock("@tauri-apps/api/event", () => ({ listen: h.listen, emit: h.emit }));

import { useTeamState } from "@/hooks/useTeamState";
import { TEAM_ACTION_EVENT, TEAM_STATE_EVENT } from "@/lib/team/team-controller";

beforeEach(() => {
  h.listen.mockReset();
  h.emit.mockReset().mockResolvedValue(undefined);
});

describe("useTeamState", () => {
  it("emits state-request only after the state listener resolves", async () => {
    let resolveListen!: (un: () => void) => void;
    h.listen.mockImplementation(
      () => new Promise<() => void>((r) => (resolveListen = r))
    );
    renderHook(() => useTeamState());
    expect(h.listen).toHaveBeenCalledWith(TEAM_STATE_EVENT, expect.any(Function));
    await act(async () => {});
    expect(h.emit).not.toHaveBeenCalled();
    await act(async () => resolveListen(vi.fn()));
    expect(h.emit).toHaveBeenCalledWith(TEAM_ACTION_EVENT, { type: "state-request" });
  });

  it("a listener resolving after unmount is unlistened at once", async () => {
    let resolveListen!: (un: () => void) => void;
    h.listen.mockImplementation(
      () => new Promise<() => void>((r) => (resolveListen = r))
    );
    const { unmount } = renderHook(() => useTeamState());
    unmount();
    const un = vi.fn();
    await act(async () => resolveListen(un));
    expect(un).toHaveBeenCalledTimes(1);
    expect(h.emit).not.toHaveBeenCalled();
  });

  it("exposes pushed state and sends actions on the action event", async () => {
    let handler!: (e: { payload: unknown }) => void;
    h.listen.mockImplementation(async (_e: string, cb: typeof handler) => {
      handler = cb;
      return vi.fn();
    });
    const { result } = renderHook(() => useTeamState());
    await act(async () => {});
    expect(result.current[0]).toBeNull();
    act(() => handler({ payload: { joined: true } }));
    expect(result.current[0]).toEqual({ joined: true });
    act(() => result.current[1]({ type: "leave" }));
    expect(h.emit).toHaveBeenCalledWith(TEAM_ACTION_EVENT, { type: "leave" });
  });
});
