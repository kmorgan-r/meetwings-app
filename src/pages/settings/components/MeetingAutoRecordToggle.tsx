import { useEffect, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { emit, listen } from "@tauri-apps/api/event";
import { Switch, Label, Header, Button } from "@/components";
import { safeLocalStorage } from "@/lib";
import { STORAGE_KEYS } from "@/config/constants";
import { currentWatchLists, meetingLabel } from "@/lib/meeting-detect";
import {
  clearStartFailure,
  macToggleOnCheck,
  readStartFailure,
  writeStartFailure,
  type StartFailure,
} from "@/lib/meeting-start-failure";
import { openMicSettings, openSystemAudioSettings } from "@/lib/mac-permissions";
import { isMacOS } from "@/lib/platform";
import { cn } from "@/lib/utils";

interface MeetingAutoRecordToggleProps {
  className?: string;
}

interface MicSession {
  name: string;
  pid: number;
  active: boolean;
  kind: "direct" | "gated" | "ignored";
}

type Readout =
  | { kind: "idle" }
  | { kind: "checking" }
  | { kind: "ok"; sessions: MicSession[] }
  | { kind: "failed"; reason: string };

const WINDOWS_COPY = {
  title: "Auto-record meetings",
  description: "Record Teams and Google Meet calls automatically",
  label: "Automatically record Teams and Google Meet calls",
  paragraph:
    "Starts recording when a Teams call begins, or when Chrome starts using the microphone (a Google Meet call or anything else), and stops when it ends. Requires voice detection to be enabled in audio settings. Participants may need to be told the call is being recorded — rules vary by country.",
};

const MAC_COPY = {
  title: "Auto-record meetings",
  description: "Record Google Meet calls in Chrome automatically",
  label: "Automatically record Google Meet calls in Chrome",
  paragraph:
    "Starts recording when Chrome starts using the microphone (a Google Meet call or anything else), and stops when it ends. Requires voice detection to be enabled in audio settings. Turning this on asks for microphone and system audio permission. Participants may need to be told the call is being recorded — rules vary by country.",
};

type Status =
  | { kind: "pending" }
  | { kind: "ok"; running: boolean; lastError: string | null }
  | { kind: "rejected" };

export const MeetingAutoRecordToggle = ({
  className,
}: MeetingAutoRecordToggleProps) => {
  const [isEnabled, setIsEnabled] = useState(
    () =>
      safeLocalStorage.getItem(STORAGE_KEYS.MEETING_AUTO_RECORD_ENABLED) ===
      "true"
  );
  // Three-valued: `pending` renders no note, or the note flashes on every visit
  // to this page before the query resolves.
  const [status, setStatus] = useState<Status>({ kind: "pending" });
  const [startFailure, setStartFailure] = useState<StartFailure | null>(() =>
    isMacOS() ? readStartFailure() : null
  );
  const [requesting, setRequesting] = useState(false);

  useEffect(() => {
    let cancelled = false;
    const unlisteners: Array<() => void> = [];

    const refreshStatus = () =>
      invoke<{ running: boolean; lastError: string | null }>(
        "get_meeting_watcher_status"
      )
        .then((result) => {
          if (!cancelled) {
            setStatus({
              kind: "ok",
              running: Boolean(result?.running),
              lastError: result?.lastError ?? null,
            });
          }
        })
        .catch(() => {
          // Fail-visible: a rejected query renders the note, never the healthy state.
          if (!cancelled) setStatus({ kind: "rejected" });
        });

    void refreshStatus();

    const register = async (event: string, handler: (payload: any) => void) => {
      const un = await listen(event, (e) => handler(e.payload));
      if (cancelled) un();
      else unlisteners.push(un);
    };

    Promise.all([
      register("meeting-watcher-error", (payload) =>
        setStatus({
          kind: "ok",
          running: true,
          lastError: payload?.message ?? "detection error",
        })
      ),
      register("meeting-watcher-stopped", (payload) =>
        setStatus({
          kind: "ok",
          running: false,
          lastError: payload?.reason ?? "detection stopped",
        })
      ),
      register("meeting-watcher-recovered", () =>
        setStatus({ kind: "ok", running: true, lastError: null })
      ),
      register("meeting-detection-watcher-restarted", (payload) => {
        if (!payload?.ok) {
          setStatus({
            kind: "ok",
            running: false,
            lastError: payload?.error ?? "retry failed",
          });
          return;
        }
        // Never assume `running: true` from an ok reply. `start_meeting_watcher`
        // resolves Ok(()) even when the thread died immediately (a CoInitializeEx
        // failure whose Drop guard ran before the Generation was stored). That
        // failure's meeting-watcher-stopped reaches this card FIRST and paints the
        // note; a reply that asserted health would then erase it, leaving the
        // switch on, no note, no retry button, and nothing polling.
        setStatus({ kind: "pending" });
        void refreshStatus();
      }),
      register("meeting-detection-setting-changed", (payload) => {
        // Derived from the payload, not from re-reading storage: the emitter has
        // already persisted, and a storage read would add a cross-window sharing
        // assumption no test here could falsify.
        const enabled = Boolean(payload?.enabled);
        setIsEnabled(enabled);
        if (payload?.failure) setStartFailure(payload.failure);
        if (enabled) {
          setStartFailure(null);
          // The card's `running` is otherwise the stale mount value, so enabling
          // would paint "auto-record unavailable" over a watcher that started fine.
          setStatus({ kind: "pending" });
          void refreshStatus();
        }
      }),
    ]).catch((error) => {
      console.error("Meeting detection listener setup failed:", error);
    });

    return () => {
      cancelled = true;
      unlisteners.forEach((un) => un());
    };
  }, []);

  const saveAndAnnounce = async (checked: boolean) => {
    setIsEnabled(checked);
    safeLocalStorage.setItem(
      STORAGE_KEYS.MEETING_AUTO_RECORD_ENABLED,
      String(checked)
    );
    setStatus({ kind: "pending" });
    try {
      await emit("meeting-detection-setting-changed", { enabled: checked });
    } catch (error) {
      console.error("Failed to announce the meeting detection setting:", error);
    }
  };

  const handleSwitchChange = async (checked: boolean) => {
    if (!isMacOS() || !checked) {
      await saveAndAnnounce(checked);
      return;
    }
    // On a Mac, nothing is saved or announced until the probe and both
    // permission requests pass; a failure stays visible as a note instead.
    setRequesting(true);
    clearStartFailure();
    setStartFailure(null);
    try {
      const failure = await macToggleOnCheck();
      if (failure) {
        writeStartFailure(failure);
        setStartFailure(failure);
        return;
      }
      await saveAndAnnounce(true);
    } finally {
      setRequesting(false);
    }
  };

  const [readout, setReadout] = useState<Readout>({ kind: "idle" });

  const handleCheck = async () => {
    setReadout({ kind: "checking" });
    try {
      const sessions = await invoke<MicSession[]>("list_capture_sessions", {
        ...(await currentWatchLists()),
      });
      setReadout({ kind: "ok", sessions });
    } catch (error) {
      console.error("Failed to list microphone apps:", error);
      setReadout({ kind: "failed", reason: String(error) });
    }
  };

  const handleRetry = async () => {
    try {
      await emit("meeting-detection-retry-requested", undefined);
    } catch (error) {
      console.error("Failed to request a detection retry:", error);
    }
  };

  // The `isEnabled` conjunct is load-bearing: `running: false` is the ordinary
  // state for every user who never turned the feature on, so a bare !running
  // predicate would show "auto-record unavailable" to all of them.
  const showNote =
    isEnabled &&
    (status.kind === "rejected" ||
      (status.kind === "ok" && (!status.running || status.lastError !== null)));

  const copy = isMacOS() ? MAC_COPY : WINDOWS_COPY;

  return (
    <div id="meeting-auto-record" className={`space-y-2 ${className ?? ""}`}>
      <Header
        title={copy.title}
        description={copy.description}
        isMainTitle
      />
      <div className="flex items-center justify-between">
        <div className="flex items-center space-x-3">
          <div>
            <Label className="text-sm font-medium">{copy.label}</Label>
            <p className="text-xs text-muted-foreground mt-1">
              {copy.paragraph}
            </p>
          </div>
        </div>
        <Switch
          checked={isEnabled}
          onCheckedChange={handleSwitchChange}
          disabled={requesting}
          aria-label={copy.label}
        />
      </div>
      {startFailure && (
        <div className="flex items-center justify-between gap-3 rounded-md border border-destructive/40 px-3 py-2">
          <p className="text-xs text-destructive">{startFailure.message}</p>
          {startFailure.kind === "mic-denied" && (
            <Button size="sm" variant="outline" onClick={openMicSettings}>
              Open Microphone settings
            </Button>
          )}
          {startFailure.kind === "audio-denied" && (
            <Button size="sm" variant="outline" onClick={openSystemAudioSettings}>
              Open System Audio settings
            </Button>
          )}
        </div>
      )}
      {showNote && (
        <div className="flex items-center justify-between rounded-md border border-destructive/40 px-3 py-2">
          <p className="text-xs text-destructive">
            Auto-record unavailable
            {status.kind === "ok" && status.lastError
              ? ` — ${status.lastError}`
              : ""}
          </p>
          <Button size="sm" variant="outline" onClick={handleRetry}>
            Retry
          </Button>
        </div>
      )}
      <div className="space-y-2">
        <Button
          size="sm"
          variant="outline"
          onClick={handleCheck}
          disabled={readout.kind === "checking"}
        >
          Check microphone apps
        </Button>
        {readout.kind === "failed" && (
          <p className="text-xs text-destructive">
            Couldn't list microphone apps.
            <span className="text-muted-foreground"> — {readout.reason}</span>
          </p>
        )}
        {readout.kind === "ok" && readout.sessions.length === 0 && (
          <p className="text-xs text-muted-foreground">
            No apps are using the microphone.
          </p>
        )}
        {readout.kind === "ok" &&
          readout.sessions.map((session, i) => (
            <div
              key={`${session.pid}-${i}`}
              className="flex items-center justify-between gap-3 text-xs"
            >
              <span className="font-medium">{session.name}</span>
              <span className="text-muted-foreground">
                {session.active ? "On the microphone" : "Idle"}
              </span>
              <span
                className={cn(
                  session.kind === "ignored" && "text-muted-foreground"
                )}
              >
                {session.kind === "ignored"
                  ? "Not watched"
                  : `Watched (${meetingLabel(session.name)})`}
              </span>
            </div>
          ))}
      </div>
    </div>
  );
};
