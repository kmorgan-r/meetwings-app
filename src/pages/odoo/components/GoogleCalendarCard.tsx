import { useEffect, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { emit } from "@tauri-apps/api/event";
import { openUrl } from "@tauri-apps/plugin-opener";
import { Button, Input, Label } from "@/components";
import { GOOGLE_COPY, toGoogleCode } from "@/lib/calendar/google-errors";
import {
  classifyGoogleConfig,
  GOOGLE_CONNECTION_CHANGED_EVENT,
  loadGoogleConfigState,
  saveGoogleConfig,
} from "@/lib/storage/google-config.storage";
import type { GraphStatus } from "@/types";

const SETUP_URL = "https://github.com/kmorgan-r/meetwings-app/blob/main/docs/google-calendar-setup.md";
const INCOMPLETE = "Enter both the Client ID and the Client secret.";
const SESSION_ONLY =
  "No system keychain found: you'll need to connect again after restarting Meetwings.";

/** Best-effort: a failed broadcast never turns a successful connect into an error. */
async function broadcast(): Promise<void> {
  try {
    await emit(GOOGLE_CONNECTION_CHANGED_EVENT);
  } catch {
    // best-effort
  }
}

export function GoogleCalendarCard() {
  const [clientId, setClientId] = useState("");
  const [clientSecret, setClientSecret] = useState("");
  const [status, setStatus] = useState<GraphStatus>({ connected: false, sessionOnly: false });
  // Only ever fixed copy: raw error text never reaches the UI.
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      const state = await loadGoogleConfigState();
      if (cancelled) return;
      if (state.state === "complete") {
        setClientId(state.config.clientId);
        setClientSecret(state.config.clientSecret);
        // Silent for never-configured users, like the Graph page.
        try {
          const s = await invoke<GraphStatus>("google_status");
          if (!cancelled) setStatus(s);
        } catch (err) {
          if (!cancelled) setError(GOOGLE_COPY[toGoogleCode(err)]);
        }
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  async function handleConnect() {
    setError(null);
    const form = classifyGoogleConfig({ clientId, clientSecret });
    if (form.state !== "complete") {
      setError(INCOMPLETE);
      return;
    }
    setBusy(true);
    try {
      await saveGoogleConfig(form.config);
      setStatus(await invoke<GraphStatus>("google_connect", {
          clientId: form.config.clientId,
          clientSecret: form.config.clientSecret,
        })
      );
      await broadcast();
    } catch (err) {
      setError(GOOGLE_COPY[toGoogleCode(err)]);
    } finally {
      setBusy(false);
    }
  }

  async function handleDisconnect() {
    setError(null);
    setBusy(true);
    try {
      await invoke("google_disconnect");
      setStatus({ connected: false, sessionOnly: false });
      await broadcast();
    } catch (err) {
      setError(GOOGLE_COPY[toGoogleCode(err)]);
    } finally {
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
        <p data-testid="google-status" className="text-sm text-muted-foreground">
          {status.connected ? "Connected" : "Not connected"}
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
