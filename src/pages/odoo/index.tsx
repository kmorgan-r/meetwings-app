import { useEffect, useState } from "react";
import { emit } from "@tauri-apps/api/event";
import { Button, Input, Label } from "@/components";
import { PageLayout } from "@/layouts";
import { reportOdooError, type OdooErrorReport } from "@/lib/odoo/errors";
import { runSync, testOdooConnection } from "@/lib/odoo";
import { loadOdooConfig, saveOdooConfig } from "@/lib/storage/odoo-config.storage";
import type { OdooConfig } from "@/types";

const EMPTY: OdooConfig = { url: "", db: "", login: "", apiKey: "" };

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

export default function OdooSettings() {
  const [config, setConfig] = useState<OdooConfig>(EMPTY);
  const [loadStatus, setLoadStatus] = useState<string | null>(null);
  const [saveStatus, setSaveStatus] = useState<string | null>(null);
  const [testStatus, setTestStatus] = useState<string | null>(null);
  const [syncStatus, setSyncStatus] = useState<string | null>(null);

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

  async function handleSave() {
    // The one action that can silently convince a user their credentials are
    // stored when they are not: saveOdooConfig awaits secureGet, secureSet and
    // the plugin-store's own save(), all of which throw raw, and it has no try
    // of its own. With no catch here the rejection escapes an async click
    // handler and the user sees nothing.
    try {
      const result = await saveOdooConfig(config);
      setSaveStatus(null);
      // Fires on EITHER flag, not instanceChanged alone. instanceChanged is
      // false for the common repair case (fixing a blank login on the same
      // url+db), and without becameUsable the picker sits on "not set up" - a
      // state with no Refresh button - until the app restarts.
      if (result.instanceChanged || result.becameUsable) {
        await emit("odoo-instance-changed");
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
      await emit("odoo-instance-changed");
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
            onChange={(e) => setConfig((c) => ({ ...c, url: e.target.value }))}
          />
        </div>

        <div className="space-y-1.5">
          <Label htmlFor="odoo-db">Database</Label>
          <Input
            id="odoo-db"
            value={config.db}
            onChange={(e) => setConfig((c) => ({ ...c, db: e.target.value }))}
          />
        </div>

        <div className="space-y-1.5">
          <Label htmlFor="odoo-login">Login</Label>
          <Input
            id="odoo-login"
            value={config.login}
            onChange={(e) => setConfig((c) => ({ ...c, login: e.target.value }))}
          />
        </div>

        <div className="space-y-1.5">
          <Label htmlFor="odoo-api-key">API key</Label>
          <Input
            id="odoo-api-key"
            type="password"
            value={config.apiKey}
            onChange={(e) => setConfig((c) => ({ ...c, apiKey: e.target.value }))}
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
    </PageLayout>
  );
}
