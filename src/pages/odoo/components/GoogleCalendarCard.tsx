import { useEffect, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { TEAM_SETTINGS_APPLIED_EVENT } from "@/config";
import { openUrl } from "@tauri-apps/plugin-opener";
import { Button, Input, Label } from "@/components";
import {
  broadcastGoogleConnectionChanged as broadcast,
  connectGoogle,
} from "@/lib/calendar/google-connect";
import { fetchCurrentGoogleMeetings } from "@/lib/calendar/fetch-google-meetings";
import { GOOGLE_COPY, toGoogleCode } from "@/lib/calendar/google-errors";
import { cn } from "@/lib/utils";
import type { GoogleErrorCode } from "@/types/calendar";
import {
  classifyGoogleConfig,
  GOOGLE_CONNECTION_CHANGED_EVENT,
  loadGoogleConfigState,
} from "@/lib/storage/google-config.storage";
import type { GraphStatus } from "@/types";

const SETUP_URL = "https://github.com/kmorgan-r/meetwings-app/blob/main/docs/google-calendar-setup.md";
const INCOMPLETE = "Enter both the Client ID and the Client secret.";
const SESSION_ONLY =
  "No system keychain found: you'll need to connect again after restarting Meetwings.";

export function GoogleCalendarCard() {
  const [clientId, setClientId] = useState("");
  const [clientSecret, setClientSecret] = useState("");
  const [status, setStatus] = useState<GraphStatus>({ connected: false, sessionOnly: false });
  // Only ever fixed copy: raw error text never reaches the UI.
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  // The refresh token alone says "connected"; one real read proves the calendar works.
  const [calendar, setCalendar] = useState<"checking" | "ok" | GoogleErrorCode | null>(null);

  const mountedRef = useRef(true);
  // Newest read wins: bumped by every verify and by Disconnect / a not-connected status.
  const seqRef = useRef(0);

  async function verify() {
    const seq = ++seqRef.current;
    if (!mountedRef.current) return;
    setCalendar("checking");
    const r = await fetchCurrentGoogleMeetings();
    if (!mountedRef.current || seq !== seqRef.current) return;
    setCalendar(r.kind === "ok" ? "ok" : r.kind === "error" ? r.code : null);
  }

  function applyStatus(s: GraphStatus) {
    setStatus(s);
    if (s.connected) void verify();
    else {
      seqRef.current++;
      setCalendar(null);
    }
  }

  async function reload() {
    const state = await loadGoogleConfigState();
    if (!mountedRef.current) return;
    if (state.state !== "absent") {
      if (state.state === "complete") {
        setClientId(state.config.clientId);
        setClientSecret(state.config.clientSecret);
      }
      // Silent only for never-configured users, like the Graph page: the
      // keychain alone says connected, even when the stored config is corrupt.
      try {
        const s = await invoke<GraphStatus>("google_status");
        if (mountedRef.current) applyStatus(s);
      } catch (err) {
        if (mountedRef.current) setError(GOOGLE_COPY[toGoogleCode(err)]);
      }
    }
  }

  useEffect(() => {
    mountedRef.current = true;
    void reload();
    const unlisteners = [
      listen(TEAM_SETTINGS_APPLIED_EVENT, () => void reload()),
      // Status only: this card broadcasts the event itself, and a form reload
      // would wipe unsaved Client ID / secret edits. A failed background
      // refresh keeps the shown status and raises no banner.
      listen(GOOGLE_CONNECTION_CHANGED_EVENT, async () => {
        try {
          const s = await invoke<GraphStatus>("google_status");
          if (mountedRef.current) applyStatus(s);
        } catch {
          // keep the current status
        }
      }),
    ];
    for (const p of unlisteners) p.catch(() => {});
    return () => {
      mountedRef.current = false;
      for (const p of unlisteners) p.then((fn) => fn()).catch(() => {});
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  async function handleConnect() {
    setError(null);
    const form = classifyGoogleConfig({ clientId, clientSecret });
    if (form.state !== "complete") {
      setError(INCOMPLETE);
      return;
    }
    setBusy(true);
    // connectGoogle saves, connects, fills the Notion name and broadcasts.
    const r = await connectGoogle(form.config);
    if (r.ok) applyStatus(r.status);
    else setError(GOOGLE_COPY[r.code]);
    setBusy(false);
  }

  async function handleDisconnect() {
    setError(null);
    setBusy(true);
    // Drop any read still running from before.
    seqRef.current++;
    setCalendar(null);
    try {
      await invoke("google_disconnect");
      setStatus({ connected: false, sessionOnly: false });
    } catch (err) {
      setError(GOOGLE_COPY[toGoogleCode(err)]);
    } finally {
      // Rust clears memory even when the keychain delete fails, so always tell listeners.
      await broadcast();
      setBusy(false);
    }
  }

  return (
    <div className="rounded-lg border border-border bg-card p-4 max-w-md space-y-4" data-testid="google-card">
      <h2 className="text-sm font-semibold text-foreground">Google Calendar</h2>
      <p className="text-xs text-muted-foreground">
        Adds who was invited to your Notion meeting notes, and keeps one Notion page per meeting when
        teammates record the same call. Read-only.
      </p>

      <div className="space-y-1.5">
        <Label htmlFor="google-client-id">Client ID</Label>
        <Input
          id="google-client-id"
          autoComplete="off"
          value={clientId}
          onChange={(e) => setClientId(e.target.value)}
        />
      </div>
      <div className="space-y-1.5">
        <Label htmlFor="google-client-secret">Client secret</Label>
        <Input
          id="google-client-secret"
          type="password"
          autoComplete="off"
          value={clientSecret}
          onChange={(e) => setClientSecret(e.target.value)}
        />
      </div>

      <div className="flex items-center gap-2">
        <Button type="button" disabled={busy} onClick={() => void handleConnect()}>
          Connect
        </Button>
        {status.connected && (
          <Button type="button" variant="outline" disabled={busy} onClick={() => void handleDisconnect()}>
            Disconnect
          </Button>
        )}
      </div>

      {error ? (
        <p data-testid="google-status" className="text-sm text-destructive">
          {error}
        </p>
      ) : (
        <p
          data-testid="google-status"
          className={cn(
            "text-sm",
            status.connected && calendar && calendar !== "checking" && calendar !== "ok"
              ? "text-destructive"
              : "text-muted-foreground"
          )}
        >
          {!status.connected
            ? "Not connected"
            : calendar === "checking"
              ? "Connected · checking calendar…"
              : calendar === "ok"
                ? "Connected · calendar readable"
                : calendar
                  ? GOOGLE_COPY[calendar]
                  : "Connected"}
        </p>
      )}
      {status.connected && status.sessionOnly && (
        <p className="text-xs text-muted-foreground">{SESSION_ONLY}</p>
      )}

      <button
        type="button"
        className="text-xs underline text-muted-foreground"
        onClick={() => void openUrl(SETUP_URL)}
      >
        How to set up the Google app
      </button>
    </div>
  );
}
