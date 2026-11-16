import { useCallback, useEffect, useState } from "react";
import { emit, listen } from "@tauri-apps/api/event";
import {
  TEAM_ACTION_EVENT,
  TEAM_STATE_EVENT,
  type TeamAction,
  type TeamUiState,
} from "@/lib/team/team-controller";

/**
 * Renders the main window's team state and sends actions back. state-request
 * goes out only once the listener exists, or the reply could arrive before the
 * handler does (the race documented in useMeetingDetection).
 */
export function useTeamState(): [TeamUiState | null, (a: TeamAction) => void] {
  const [state, setState] = useState<TeamUiState | null>(null);

  useEffect(() => {
    let cancelled = false;
    let unlisten: (() => void) | null = null;
    listen<TeamUiState>(TEAM_STATE_EVENT, (e) => setState(e.payload))
      .then((un) => {
        if (cancelled) {
          un();
          return;
        }
        unlisten = un;
        void emit(TEAM_ACTION_EVENT, { type: "state-request" }).catch(() => {});
      })
      .catch(() => {});
    return () => {
      cancelled = true;
      unlisten?.();
    };
  }, []);

  const send = useCallback((a: TeamAction) => {
    void emit(TEAM_ACTION_EVENT, a).catch(() => {});
  }, []);

  return [state, send];
}
