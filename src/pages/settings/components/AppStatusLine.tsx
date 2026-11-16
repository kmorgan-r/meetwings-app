import { useEffect, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { Header } from "@/components";
import { STORAGE_KEYS } from "@/config";
import { safeLocalStorage } from "@/lib";
import { readUpdatedNote } from "@/lib/updater/version-note";

interface AppStatusLineProps {
  className?: string;
}

const readMs = (key: string): number | null => {
  const raw = safeLocalStorage.getItem(key);
  if (raw === null) return null;
  const n = Number(raw);
  return Number.isFinite(n) ? n : null;
};

/**
 * Plain status readout at the bottom of Settings: the running version, when
 * the silent updater last checked, when team settings last synced, and the
 * one-time "Updated to X" note after an update.
 */
export const AppStatusLine = ({ className }: AppStatusLineProps) => {
  const [version, setVersion] = useState<string | null>(null);
  const [checkedAt, setCheckedAt] = useState<number | null>(null);
  const [teamSyncedAt, setTeamSyncedAt] = useState<number | null>(null);

  useEffect(() => {
    let cancelled = false;

    const readKeys = () => {
      const checked = readMs(STORAGE_KEYS.UPDATER_LAST_CHECK_AT);
      const synced = readMs(STORAGE_KEYS.TEAM_LAST_SYNCED_AT);
      if (cancelled) return;
      setCheckedAt(checked);
      setTeamSyncedAt(synced);
    };

    readKeys();
    invoke<string>("get_app_version")
      .then((v) => {
        if (!cancelled) setVersion(v);
      })
      .catch(() => {});

    // Settings can be open while another window writes these keys.
    const onStorage = () => readKeys();
    window.addEventListener("storage", onStorage);
    return () => {
      cancelled = true;
      window.removeEventListener("storage", onStorage);
    };
  }, []);

  // Read at render time so a storage-event rerender also re-evaluates the note.
  const note = version === null ? null : readUpdatedNote(version);

  return (
    <div id="app-status" className={`space-y-2 ${className ?? ""}`}>
      <Header
        title="App Status"
        description="Version, update checks and team sync"
        isMainTitle
      />
      <div className="space-y-1 text-xs text-muted-foreground">
        <p>{version === null ? "Meetwings" : `Meetwings ${version}`}</p>
        <p>
          Last update check:{" "}
          {checkedAt === null ? "never" : new Date(checkedAt).toLocaleString()}
        </p>
        {teamSyncedAt !== null && (
          <p>
            Team settings synced: {new Date(teamSyncedAt).toLocaleString()}
          </p>
        )}
        {note !== null && <p>Updated to {note.version}</p>}
      </div>
    </div>
  );
};
