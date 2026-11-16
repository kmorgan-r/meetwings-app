import { useEffect } from "react";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { startTeamController } from "@/lib/team/team-controller";

/** Runs the team controller (deep links, joins, re-syncs) in the `main` window only. */
export function useTeamSync(): void {
  useEffect(() => {
    if (getCurrentWindow().label !== "main") return;
    return startTeamController();
  }, []);
}
