import { useEffect, useMemo, useState } from "react";
import { Link } from "react-router-dom";
import { emit } from "@tauri-apps/api/event";
import { CheckCircle2, Circle, XCircle } from "lucide-react";
import { Button, Input, Label, StatusIcon } from "@/components";
import { PageLayout } from "@/layouts";
import { cn } from "@/lib/utils";
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
 * Every status line on this page is one of three OUTCOMES, not a bare string.
 *
 * The string form could not be rendered honestly: "Sync did not run (busy)"
 * and "ODOO_AUTH_FAILED: ..." are both non-success, but only one of them is a
 * fault, and handleSync's own catch says in so many words that
 * ODOO_SYNC_BUSY "must not read as an error". With only text to go on, a
 * renderer has to sniff the copy to pick an icon - so the kind is carried
 * explicitly and every construction site below chooses it deliberately.
 */
type StatusKind = "ok" | "error" | "info";
type Status = { kind: StatusKind; text: string };

const okStatus = (text: string): Status => ({ kind: "ok", text });
const errorStatus = (text: string): Status => ({ kind: "error", text });
const infoStatus = (text: string): Status => ({ kind: "info", text });

/**
 * A field counts as filled only once it is non-blank AFTER trimming.
 *
 * Deliberately stricter than the storage layer's `isComplete`, which is a bare
 * truthiness test. A pasted "  https://host  " is truthy, so it passes the
 * save path and then fails at the socket, because saveOdooConfig stores the
 * string verbatim and the client concatenates it straight into the XML-RPC
 * URL. Showing a green check for a value that cannot connect is the one thing
 * this checklist must never do.
 */
function filledCount(config: OdooConfig): number {
  return [config.url, config.db, config.login, config.apiKey].filter((v) => v.trim() !== "")
    .length;
}

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

/**
 * One outcome line, under the button that produced it.
 *
 * Has the failure variant StatusIcon deliberately lacks. The checklist above
 * renders progress (done / your turn / not yet); this renders what an action
 * just DID, and "Odoo rejected the credentials" has to look different from
 * "you have not finished the form" or the user re-types a correct API key.
 */
function StatusLine({ status, testId }: { status: Status; testId?: string }) {
  const Icon = status.kind === "ok" ? CheckCircle2 : status.kind === "error" ? XCircle : Circle;
  return (
    <p
      data-testid={testId}
      className={cn(
        "flex items-start gap-2 text-sm",
        status.kind === "ok" && "text-green-600 dark:text-green-400",
        status.kind === "error" && "text-destructive",
        status.kind === "info" && "text-muted-foreground"
      )}
    >
      <Icon className="size-4 shrink-0 mt-0.5" />
      <span>{status.text}</span>
    </p>
  );
}

/**
 * The three steps that stand between a blank page and a working Odoo link,
 * rendered with the same checklist vocabulary as the API Setup page.
 *
 * `verified` and `synced` are SESSION state, not persisted: pressing Test
 * connection proves the credentials worked just now, which is a different
 * claim from "these credentials are known-good forever". Storing it would
 * mean a slot in verification.storage alongside AI and STT - a secure-store
 * schema change - and would let a checklist keep showing a green check for an
 * API key that was revoked in Odoo an hour ago. A check that resets on reload
 * is the honest one.
 *
 * `filled` counts what is TYPED; `stored` is whether a complete config is on
 * DISK, and the first row makes the second claim. testOdooConnection and
 * runSync both read persisted storage (requireOdooConfig), never this form, so
 * a green "Credentials stored" derived from the live fields would pass on a
 * fresh install and then be contradicted by the very next button, which
 * answers ODOO_NOT_CONFIGURED.
 *
 * `stored` is deliberately NOT cleared when a field is edited, unlike the two
 * rows below it. An edit does not un-store anything - the credentials on disk
 * are still there, and still the ones Test connection will use. Clearing it
 * would swap this bug for its mirror image: a card reporting nothing stored
 * while the button under it connects fine.
 */
function OdooSetupCard({
  filled,
  stored,
  verified,
  verifiedDetail,
  synced,
}: {
  filled: number;
  stored: boolean;
  verified: boolean;
  verifiedDetail: string | null;
  synced: boolean;
}) {
  const done = (stored ? 1 : 0) + (verified ? 1 : 0) + (synced ? 1 : 0);
  const percent = (done / 3) * 100;
  const isComplete = done === 3;

  return (
    <div className="rounded-lg border border-border bg-card p-4 mb-6 max-w-md">
      <div className="flex items-center justify-between mb-3">
        <h2 className="text-sm font-semibold text-foreground">Odoo Connection</h2>
        <span
          className={cn(
            "text-xs font-medium px-2 py-0.5 rounded-full",
            isComplete
              ? "bg-green-500/10 text-green-600 dark:text-green-400"
              : "bg-yellow-500/10 text-yellow-600 dark:text-yellow-400"
          )}
        >
          {isComplete ? "Connected" : `${Math.round(percent)}% Done`}
        </span>
      </div>

      <div className="h-2 bg-muted rounded-full overflow-hidden mb-4">
        <div
          className={cn(
            "h-full transition-all duration-500 rounded-full",
            isComplete ? "bg-green-500" : "bg-yellow-500"
          )}
          style={{ width: `${percent}%` }}
        />
      </div>

      <div className="space-y-2">
        <div className="flex items-center gap-2">
          <StatusIcon done={stored} />
          <span className="text-sm text-foreground">
            {stored ? (
              // "stored", not "saved" - the button below reports "Saved", and
              // two lines saying the same word about different things (a
              // complete config is on disk vs. this click wrote it) reads as
              // one duplicated message.
              "Credentials stored"
            ) : filled === 4 ? (
              // The step the user is actually on. Without this branch the row
              // falls through to "Fill in all four fields below (4 of 4)",
              // which is both false and no help.
              <span className="text-muted-foreground">
                All four fields filled - press Save to store them
              </span>
            ) : (
              <span className="text-muted-foreground">
                Fill in all four fields below ({filled} of 4)
              </span>
            )}
          </span>
        </div>

        <div className="flex items-center gap-2 pl-6">
          <StatusIcon done={verified} pending={!stored} />
          <span className="text-sm">
            {verified ? (
              <span className="text-foreground">
                Connection verified
                {verifiedDetail && (
                  <span className="text-muted-foreground ml-1">({verifiedDetail})</span>
                )}
              </span>
            ) : (
              <span className={cn(stored ? "text-muted-foreground" : "text-muted-foreground/50")}>
                Not tested yet
              </span>
            )}
          </span>
        </div>

        <div className="flex items-center gap-2 pl-6">
          <StatusIcon done={synced} pending={!verified} />
          <span className="text-sm">
            {synced ? (
              <span className="text-foreground">Contacts synced</span>
            ) : (
              <span className={cn(verified ? "text-muted-foreground" : "text-muted-foreground/50")}>
                Contacts not synced yet
              </span>
            )}
          </span>
        </div>
      </div>
    </div>
  );
}

export default function OdooSettings() {
  const [config, setConfig] = useState<OdooConfig>(EMPTY);
  // Whether a COMPLETE config is on disk - the claim the first checklist row
  // makes, and one `config` cannot answer: on a fresh install every field is
  // full before Save has ever run, while requireOdooConfig reads storage.
  const [stored, setStored] = useState(false);
  const [loadStatus, setLoadStatus] = useState<Status | null>(null);
  const [saveStatus, setSaveStatus] = useState<Status | null>(null);
  const [testStatus, setTestStatus] = useState<Status | null>(null);
  const [syncStatus, setSyncStatus] = useState<Status | null>(null);
  // Kept beside testStatus rather than parsed back out of its text: the card
  // shows the uid as a detail, and re-deriving it from a display string would
  // make the copy load-bearing.
  const [verifiedUid, setVerifiedUid] = useState<number | null>(null);
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
  //
  // The verification goes with it, and for a sharper reason: a green
  // "Connection verified" check describes the credentials that were tested,
  // so leaving it up while the user edits the API key would show a passing
  // check for a value that has never been tried.
  //
  // The sync check goes for that same reason, only harder. runSync reads the
  // PERSISTED config (requireOdooConfig), never this form state, so a green
  // "Contacts synced" describes the credentials as they were on disk when it
  // ran - exactly the claim an edit invalidates. Leaving it would also break
  // the card's own done-in-order chain, since the sync row is drawn
  // pending={!verified}: step 3 would show done while step 2 showed untested.
  function updateField<K extends keyof OdooConfig>(key: K, value: OdooConfig[K]) {
    setConfig((c) => ({ ...c, [key]: value }));
    setSaveStatus(null);
    setTestStatus(null);
    setVerifiedUid(null);
    setSyncStatus(null);
  }

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const loaded = await loadOdooConfig();
        if (!cancelled && loaded) {
          setConfig(loaded);
          // The check has to survive a reload, or every returning user is told
          // to fill in fields that are already on disk. filledCount rather than
          // the storage layer's own truthiness test, so a padded value is not
          // counted as stored here after being refused there.
          setStored(filledCount(loaded) === 4);
        }
      } catch (err) {
        // Reported, never swallowed - a config that cannot load must not look
        // like a config that was never set.
        if (!cancelled) setLoadStatus(errorStatus(describe(reportOdooError(err, "load config"))));
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
      // Recomputed from what was just written, not set to true: saveOdooConfig
      // does not validate completeness, so a save can take the config complete
      // -> incomplete (clearing the api key) exactly as the queue effect below
      // already accounts for.
      setStored(filledCount(config) === 4);
      setSaveStatus(okStatus("Saved"));
      setQueueReadKey((k) => k + 1);
      // Fires on EITHER flag, not instanceChanged alone. instanceChanged is
      // false for the common repair case (fixing a blank login on the same
      // url+db), and without becameUsable the picker sits on "not set up" - a
      // state with no Refresh button - until the app restarts.
      if (result.instanceChanged || result.becameUsable) {
        await notifyOtherWindows();
      }
    } catch (err) {
      setSaveStatus(errorStatus(describe(reportOdooError(err, "save odoo config"))));
    }
  }

  async function handleTestConnection() {
    try {
      const uid = await testOdooConnection();
      setVerifiedUid(uid);
      setTestStatus(okStatus(`Connected as uid ${uid}`));
    } catch (err) {
      // Clears the uid as well as setting the failure: a second Test
      // connection that fails after a first that passed must not leave the
      // checklist showing the earlier green check.
      setVerifiedUid(null);
      setTestStatus(errorStatus(describe(reportOdooError(err, "test connection"))));
    }
  }

  async function handleSync() {
    try {
      const outcome = await runSync("settings");
      if (!outcome.ran) {
        // Never "0 contacts updated": that sentence describes a working, empty
        // Odoo and is why runSync returns an outcome rather than a bare count.
        //
        // `info`, not `error`: a sync that declined to run (no credentials, a
        // watermark that says there is nothing to do) has not failed, and a
        // red cross here would send the user looking for a fault that is not
        // there.
        setSyncStatus(infoStatus(`Sync did not run (${outcome.reason})`));
        return;
      }
      const summary =
        outcome.changed === 0
          ? "No contacts changed"
          : `${outcome.changed} contacts updated`;
      setSyncStatus(
        okStatus(
          outcome.skipped > 0 ? `${summary}, ${outcome.skipped} could not be read` : summary
        )
      );
      // A completed sync runs in THIS window; without an emit the main
      // window's picker keeps rendering the stale lastError banner over rows
      // that were just refreshed, because reload() runs only on mount, on
      // Refresh, and on this event.
      await notifyOtherWindows();
    } catch (err) {
      const report = reportOdooError(err, "sync contacts");
      // Another window syncing is a normal outcome, not a fault - it must not
      // read as an error. That was already true of the copy; carrying `info`
      // here is what stops the ICON from contradicting it.
      setSyncStatus(
        report.code === "ODOO_SYNC_BUSY"
          ? infoStatus(report.message)
          : errorStatus(`Sync failed: ${describe(report)}`)
      );
    }
  }

  const filled = useMemo(() => filledCount(config), [config]);

  return (
    <PageLayout
      title="Odoo"
      description="Connect to Odoo to pick contacts and log meetings from your CRM."
    >
      {loadStatus && <StatusLine status={loadStatus} testId="odoo-load-status" />}

      <OdooSetupCard
        filled={filled}
        stored={stored}
        verified={testStatus?.kind === "ok"}
        verifiedDetail={verifiedUid === null ? null : `uid ${verifiedUid}`}
        synced={syncStatus?.kind === "ok"}
      />

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
        {saveStatus && <StatusLine status={saveStatus} testId="odoo-save-status" />}
      </div>

      <div className="space-y-2 mt-6">
        <Button type="button" variant="outline" onClick={() => void handleTestConnection()}>
          Test connection
        </Button>
        {testStatus && <StatusLine status={testStatus} testId="odoo-test-status" />}
      </div>

      <div className="space-y-2 mt-6">
        <Button type="button" variant="outline" onClick={() => void handleSync()}>
          Sync Contacts
        </Button>
        {syncStatus && <StatusLine status={syncStatus} testId="odoo-sync-status" />}
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
            <Link to="/meetings" className="underline">
              Open the meeting log
            </Link>
          </div>
        )}
    </PageLayout>
  );
}
