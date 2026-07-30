import { useEffect, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { emit, listen } from "@tauri-apps/api/event";
import { Switch, Label, Header, Button } from "@/components";
import { safeLocalStorage } from "@/lib";
import { STORAGE_KEYS } from "@/config/constants";

interface MeetingDetectionToggleProps {
  className?: string;
}

type Status =
  | { kind: "pending" }
  | { kind: "ok"; running: boolean; lastError: string | null }
  | { kind: "rejected" };

export const MeetingDetectionToggle = ({
  className,
}: MeetingDetectionToggleProps) => {
  const [isEnabled, setIsEnabled] = useState(
    () =>
      safeLocalStorage.getItem(STORAGE_KEYS.MEETING_DETECTION_ENABLED) === "true"
  );
  // Three-valued: `pending` renders no note, or the note flashes on every visit
  // to this page before the query resolves.
  const [status, setStatus] = useState<Status>({ kind: "pending" });

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
        if (enabled) {
          // The card's `running` is otherwise the stale mount value, so enabling
          // would paint "detection unavailable" over a watcher that started fine.
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

  const handleSwitchChange = async (checked: boolean) => {
    setIsEnabled(checked);
    safeLocalStorage.setItem(
      STORAGE_KEYS.MEETING_DETECTION_ENABLED,
      String(checked)
    );
    setStatus({ kind: "pending" });
    try {
      await emit("meeting-detection-setting-changed", { enabled: checked });
    } catch (error) {
      console.error("Failed to announce the meeting detection setting:", error);
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
  // predicate would show "detection unavailable" to all of them.
  const showNote =
    isEnabled &&
    (status.kind === "rejected" ||
      (status.kind === "ok" && (!status.running || status.lastError !== null)));

  return (
    <div id="meeting-detection" className={`space-y-2 ${className ?? ""}`}>
      <Header
        title="Meeting Detection"
        description="Get notified when a Microsoft Teams call starts"
        isMainTitle
      />
      <div className="flex items-center justify-between">
        <div className="flex items-center space-x-3">
          <div>
            <Label className="text-sm font-medium">
              Notify me when a Teams call starts
            </Label>
            <p className="text-xs text-muted-foreground mt-1">
              Shows a notification when a Teams call begins or ends. Does not
              start or stop recording.
            </p>
          </div>
        </div>
        <Switch
          checked={isEnabled}
          onCheckedChange={handleSwitchChange}
          aria-label="Notify me when a Teams call starts"
        />
      </div>
      {showNote && (
        <div className="flex items-center justify-between rounded-md border border-destructive/40 px-3 py-2">
          <p className="text-xs text-destructive">
            Detection unavailable
            {status.kind === "ok" && status.lastError
              ? ` — ${status.lastError}`
              : ""}
          </p>
          <Button size="sm" variant="outline" onClick={handleRetry}>
            Retry
          </Button>
        </div>
      )}
    </div>
  );
};
