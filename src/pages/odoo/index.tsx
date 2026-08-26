import { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { emit } from "@tauri-apps/api/event";
import { Button, Input, Label } from "@/components";
import { PageLayout } from "@/layouts";
import { reportOdooError, type OdooErrorReport } from "@/lib/odoo/errors";
import { runSync, testOdooConnection } from "@/lib/odoo";
import {
  countAllQueued,
  getQueueCounts,
  type QueueCounts,
} from "@/lib/database/meeting-log.action";
import {
  instanceFingerprint,
  loadOdooConfig,
  loadOdooConfigState,
  saveOdooConfig,
} from "@/lib/storage/odoo-config.storage";
import type { OdooConfig } from "@/types";

const EMPTY: OdooConfig = { url: "", db: "", login: "", apiKey: "" };

/**
 * Agrees with the count on both the noun and the verb: "1 meeting waiting" /
 * "2 meetings waiting", "1 meeting needs attention" / "2 meetings need
 * attention" - a fixed noun form can't be right for both.
 */
function plural(n: number): string {
  return `${n} ${n === 1 ? "meeting" : "meetings"}`;
}

/**
 * ODOO_NOT_CONFIGURED gets the page's OWN copy rather than the report's
 * message. reportOdooError suppresses text whenever the redactor is
 * uninitialised, and a cold start with nothing stored is exactly that state -
 * without this branch the user would read "ODOO_NOT_CONFIGURED:
 * ODOO_NOT_CONFIGURED" instead of an instruction they can act on.
 */
function describe(report: OdooErrorReport): string {
  if (report.code === "ODOO_NOT_CONFIGURED") {
    return "Odoo is not set up yet - fill in the fields below and press Save.";
  }
  return `${report.code}: ${report.message}`;
}

/**
 * Best-effort. By the time this is called, the credentials are already
 * written or the sync has already completed - this window's own state is
 * correct regardless of whether the other window hears about it. A failure
 * here must never relabel an already-successful save or sync as a failure,
 * which is why it has its own try/catch rather than sharing the caller's.
 *
 * The failure is swallowed, not reported: this is best-effort cross-window
 * IPC, not a user-facing operation, so it does not warrant its own toast -
 * and there is no other logging path in this file to route it through
 * instead (every other catch here reports a REAL operation failure to a
 * status the user reads). Inventing a log line whose only reader would be a
 * test is worse than a documented no-op.
 */
async function notifyOtherWindows(): Promise<void> {
  try {
    await emit("odoo-instance-changed");
  } catch {
    // best-effort; see doc comment above.
  }
}

export default function OdooSettings() {
  const [config, setConfig] = useState<OdooConfig>(EMPTY);
  const [loadStatus, setLoadStatus] = useState<string | null>(null);
  const [saveStatus, setSaveStatus] = useState<string | null>(null);
  const [testStatus, setTestStatus] = useState<string | null>(null);
  const [syncStatus, setSyncStatus] = useState<string | null>(null);
  const [queue, setQueue] = useState<QueueCounts | null>(null);
  const [strandedTotal, setStrandedTotal] = useState(0);
  // Bumped by handleSave. Without it the stranded line still says "finish
  // setting Odoo up above" - with a stale count - immediately after the user
  // has done exactly that, on the same page, which is the one flow that line
  // exists to serve.
  const [queueReadKey, setQueueReadKey] = useState(0);

  // "Saved" is only true of the config that was actually written. The next
  // keystroke makes it stale, so it is cleared on every field edit rather
  // than left to read as confirmation of unsaved changes.
  function updateField<K extends keyof OdooConfig>(key: K, value: OdooConfig[K]) {
    setConfig((c) => ({ ...c, [key]: value }));
    setSaveStatus(null);
  }

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const loaded = await loadOdooConfig();
        if (!cancelled && loaded) setConfig(loaded);
      } catch (err) {
        // Reported, never swallowed - a config that cannot load must not look
        // like a config that was never set.
        if (!cancelled) setLoadStatus(describe(reportOdooError(err, "load config")));
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      // Reset BOTH, not just strandedTotal: saveOdooConfig does not validate
      // completeness, so a complete config can go complete -> incomplete on
      // save (e.g. clearing the api key) without ever passing through
      // "absent". Without clearing queue too, the previous instance's
      // four-group block survives into the incomplete branch below and
      // renders stale counts for credentials the page no longer has, right
      // next to the stranded line telling the user to finish setting up.
      setStrandedTotal(0);
      setQueue(null);
      try {
        // NOT currentInstance(): it wraps requireOdooConfig, which THROWS for
        // exactly the half-filled config a user comes to this page to fix - so
        // the one surface that would show their backlog would be the one that
        // renders nothing. loadOdooConfigState returns a state instead of
        // throwing.
        const state = await loadOdooConfigState();
        if (state.state === "complete") {
          const counts = await getQueueCounts(
            instanceFingerprint(state.config.url, state.config.db)
          );
          if (!cancelled) setQueue(counts);
          return;
        }
        // Incomplete or absent: there is no fingerprint to scope by, and every
        // queued row is stuck for the same reason - the credentials on this
        // page. Counting them all is the honest answer, and without it the
        // backlog is invisible precisely when it is largest, since a
        // not-configured push never claims and so never escalates either.
        const total = await countAllQueued();
        if (!cancelled) setStrandedTotal(total);
      } catch (err) {
        // Diagnostic only. A failed count must not take down the credentials
        // form the user came here to fix.
        console.error("[Odoo] could not read the meeting log queue counts:", err);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [queueReadKey]);

  async function handleSave() {
    // The one action that can silently convince a user their credentials are
    // stored when they are not: saveOdooConfig awaits secureGet, secureSet and
    // the plugin-store's own save(), all of which throw raw, and it has no try
    // of its own. With no catch here the rejection escapes an async click
    // handler and the user sees nothing.
    try {
      const result = await saveOdooConfig(config);
      setSaveStatus("Saved");
      setQueueReadKey((k) => k + 1);
      // Fires on EITHER flag, not instanceChanged alone. instanceChanged is
      // false for the common repair case (fixing a blank login on the same
      // url+db), and without becameUsable the picker sits on "not set up" - a
      // state with no Refresh button - until the app restarts.
      if (result.instanceChanged || result.becameUsable) {
        await notifyOtherWindows();
      }
    } catch (err) {
      setSaveStatus(describe(reportOdooError(err, "save odoo config")));
    }
  }

  async function handleTestConnection() {
    try {
      const uid = await testOdooConnection();
      setTestStatus(`Connected as uid ${uid}`);
    } catch (err) {
      setTestStatus(describe(reportOdooError(err, "test connection")));
    }
  }

  async function handleSync() {
    try {
      const outcome = await runSync("settings");
      if (!outcome.ran) {
        // Never "0 contacts updated": that sentence describes a working, empty
        // Odoo and is why runSync returns an outcome rather than a bare count.
        setSyncStatus(`Sync did not run (${outcome.reason})`);
        return;
      }
      const summary =
        outcome.changed === 0
          ? "No contacts changed"
          : `${outcome.changed} contacts updated`;
      setSyncStatus(
        outcome.skipped > 0 ? `${summary}, ${outcome.skipped} could not be read` : summary
      );
      // A completed sync runs in THIS window; without an emit the main
      // window's picker keeps rendering the stale lastError banner over rows
      // that were just refreshed, because reload() runs only on mount, on
      // Refresh, and on this event.
      await notifyOtherWindows();
    } catch (err) {
      const report = reportOdooError(err, "sync contacts");
      // Another window syncing is a normal outcome, not a fault - it must not
      // read as an error.
      setSyncStatus(
        report.code === "ODOO_SYNC_BUSY" ? report.message : `Sync failed: ${describe(report)}`
      );
    }
  }

  return (
    <PageLayout
      title="Odoo"
      description="Connect to Odoo to pick contacts and log meetings from your CRM."
    >
      {loadStatus && <p>{loadStatus}</p>}

      <div className="space-y-4 max-w-md">
        <div className="space-y-1.5">
          <Label htmlFor="odoo-url">URL</Label>
          <Input
            id="odoo-url"
            value={config.url}
            onChange={(e) => updateField("url", e.target.value)}
          />
        </div>

        <div className="space-y-1.5">
          <Label htmlFor="odoo-db">Database</Label>
          <Input
            id="odoo-db"
            value={config.db}
            onChange={(e) => updateField("db", e.target.value)}
          />
        </div>

        <div className="space-y-1.5">
          <Label htmlFor="odoo-login">Login</Label>
          <Input
            id="odoo-login"
            value={config.login}
            onChange={(e) => updateField("login", e.target.value)}
          />
        </div>

        <div className="space-y-1.5">
          <Label htmlFor="odoo-api-key">API key</Label>
          <Input
            id="odoo-api-key"
            type="password"
            value={config.apiKey}
            onChange={(e) => updateField("apiKey", e.target.value)}
          />
          <p className="text-xs text-muted-foreground">
            Stored via Tauri's secure store - a plaintext JSON file in the app-data directory. It
            is NOT encrypted at rest.
          </p>
        </div>

        <Button type="button" onClick={() => void handleSave()}>
          Save
        </Button>
        {saveStatus && <p>{saveStatus}</p>}
      </div>

      <div className="space-y-2 mt-6">
        <Button type="button" variant="outline" onClick={() => void handleTestConnection()}>
          Test connection
        </Button>
        {testStatus && <p>{testStatus}</p>}
      </div>

      <div className="space-y-2 mt-6">
        <Button type="button" variant="outline" onClick={() => void handleSync()}>
          Sync Contacts
        </Button>
        {syncStatus && <p>{syncStatus}</p>}
      </div>

      {strandedTotal > 0 && (
        <p data-testid="meeting-log-stranded" className="mt-6 text-sm">
          {plural(strandedTotal)} waiting to be logged. Finish setting Odoo up above and they
          will be sent.
        </p>
      )}

      {queue &&
        queue.waiting + queue.needsAttention + queue.unassigned + queue.otherInstance > 0 && (
          <div data-testid="meeting-log-queue-status" className="space-y-1 mt-6 text-sm">
            {/* Four groups, separately worded: "Odoo rejected this", "you never
                told me who this was with" and "this retries on its own" need
                three different user actions, and one number fits none of them.
                Without this block a failed row is invisible until slice 3 ships
                and the user believes every meeting was logged. */}
            {queue.waiting > 0 && <p>{plural(queue.waiting)} waiting to be logged</p>}
            {queue.needsAttention > 0 && (
              <>
                <p>
                  {plural(queue.needsAttention)}{" "}
                  {queue.needsAttention === 1 ? "needs" : "need"} attention
                </p>
                {queue.lastError && <p className="text-muted-foreground">{queue.lastError}</p>}
              </>
            )}
            {queue.unassigned > 0 && <p>{plural(queue.unassigned)} not assigned to a contact</p>}
            {queue.otherInstance > 0 && (
              <p>{plural(queue.otherInstance)} queued for a different Odoo database</p>
            )}
            <Link to="/meeting-log" className="underline">
              Open the meeting log
            </Link>
          </div>
        )}
    </PageLayout>
  );
}
