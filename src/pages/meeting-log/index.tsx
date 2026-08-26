import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { Link } from "react-router-dom";
import { getCurrentWebviewWindow } from "@tauri-apps/api/webviewWindow";
import { Button } from "@/components";
import { PageLayout } from "@/layouts";
import {
  countActionableQueued,
  getQueueRow,
  getQueueTranscript,
  listActionableRows,
} from "@/lib/database/meeting-log.action";
import { listContacts } from "@/lib/database/odoo-contacts.action";
import { reportOdooError } from "@/lib/odoo/errors";
import { groupOf, isClaimStale, type QueueGroup } from "@/lib/odoo/meeting-log";
import {
  assignMeetingLog,
  deleteMeetingLog,
  retryMeetingLog,
  type ActionOutcome,
  type ProviderConfigLike,
} from "@/lib/odoo/meeting-log-actions";
import {
  instanceFingerprint,
  loadOdooConfigState,
} from "@/lib/storage/odoo-config.storage";
import type { MeetingLogListRow, OdooContact } from "@/types";
import { AssignDialog, ProviderConfigReader, QueueRow, type AssignPayload } from "./components";
// The date fallback is imported, never re-derived: the shipped note body uses
// `meeting_started_at ?? transcript_start_at` too, and a second fallback for one
// nullable column lets the notice, the row and the customer's chatter disagree
// about the same meeting.
import { meetingDateOf, type TranscriptView } from "./components/QueueRow";

/**
 * The queue page. Dashboard window only - the overlay never navigates here.
 *
 * IT NEVER CALLS `runMeetingLogSweep` OR `reclaimStaleSending`. `claimed` and
 * `sweepInFlight` in meeting-log-push.ts are per-webview, so this window's
 * copies are empty and know nothing about a push the main window is running -
 * a reclaim from here re-`pending`s a row that is mid-push, producing two
 * attachments and two customer-visible chatter notes. It reaches Odoo only
 * through retryMeetingLog / assignMeetingLog / deleteMeetingLog, whose own
 * claim refuses every `sending` row.
 */

/** LIMIT 201 in the SQL: 200 render, and the 201st proves more are hidden. */
const PAGE_CAP = 200;

/**
 * How often the page re-reads the clock while a claim is outstanding.
 *
 * Nothing here polls the database - the tick exists solely so a row whose claim
 * has already expired stops saying "Sending..." while the window sits
 * untouched. STALE_CLAIM_MS is minutes, so the delay this adds to the sentence
 * is a rounding error against it, and the tick stops the moment no row is
 * `sending`.
 */
const STALE_TICK_MS = 30_000;

const REMAINDER_LINE = "Showing 200 of the meetings waiting — more are hidden.";

const GROUPS: ReadonlyArray<{ key: Exclude<QueueGroup, null>; title: string }> = [
  // Needs attention first: it is the only group where a meeting is not going to
  // reach Odoo without the user.
  { key: "needs-attention", title: "Needs attention" },
  { key: "unassigned", title: "Not assigned to a contact" },
  { key: "waiting", title: "Waiting to be logged" },
  { key: "other-database", title: "Queued for a different Odoo database" },
];

/**
 * The page's OWN code->copy map.
 *
 * Not `/odoo`'s `describe()`. That one special-cases ODOO_NOT_CONFIGURED alone
 * and otherwise returns `code: message` - and `reportOdooError` degrades
 * `message` to the bare code whenever the redactor is unarmed, which a fresh
 * dashboard webview and a config missing both apiKey and login BOTH are. The
 * result there is "ODOO_INTERNAL: ODOO_INTERNAL". Its ODOO_NOT_CONFIGURED copy
 * also names a form this page does not have.
 *
 * The report's `message` is deliberately never interpolated: for these outcomes
 * it carries no information the code does not, and leaving it out is what keeps
 * a credential rejection's text out of the DOM by construction rather than by
 * trusting the redactor to have been armed in time.
 */
const FAILURE_COPY: Record<string, string> = {
  ODOO_NOT_CONFIGURED:
    "Odoo is not set up yet. Finish the setup on the Odoo page. Nothing on this meeting changed.",
  ODOO_AUTH_FAILED:
    "Odoo rejected the credentials. Check the login and API key on the Odoo page. Nothing on this meeting changed.",
  ODOO_UNREACHABLE:
    "Odoo could not be reached. Check the URL and your connection. Nothing on this meeting changed.",
  ODOO_INTERNAL:
    "Something failed before anything was sent. Nothing on this meeting changed.",
};

/** The code appears ONCE for an unknown code, never as a doubled token. */
function describeFailure(code: string): string {
  return (
    FAILURE_COPY[code] ?? `The action stopped with ${code}. Nothing on this meeting changed.`
  );
}

/**
 * A whole-list read failure, which is NOT a row action.
 *
 * Separate from describeFailure because that one ends every line with "Nothing
 * on this meeting changed." - true of an action that stopped before its CAS,
 * and meaningless about a read that never named a meeting in the first place.
 */
function describeLoadFailure(code: string): string {
  return code === "ODOO_INTERNAL"
    ? "The meetings waiting to be logged could not be read."
    : `The meetings waiting to be logged could not be read (${code}).`;
}

/** Retry and Assign push. Delete does not - see `outcomeCopy`. */
const SENT_COPY = "Sent to Odoo.";

/**
 * Delete's own success line, and the negative clause is the whole point.
 *
 * `deleteMeetingLog` returns `{kind:"ok"}` like everything else, but the
 * module's own comment says "No push, ever" - so a single shared `ok` string
 * tells a user their DELETED meeting was sent to a customer's record.
 */
const DELETED_COPY = "Removed from the queue. Nothing was sent to Odoo.";

/**
 * One line per outcome, and all seven stay distinct.
 *
 * Conflating any two teaches users to distrust the page - most sharply
 * `degraded`, which is the difference between a real summary and a
 * "Summarization failed" note live on a customer's record.
 */
function outcomeCopy(outcome: ActionOutcome, successCopy: string): string {
  switch (outcome.kind) {
    case "ok":
      // Per action, never one shared string. Delete pushes nothing.
      return successCopy;
    case "degraded":
      return "Sent — but the note shows the transcript's first lines, because the summary could not be generated.";
    case "no-op":
      // NEVER "nothing was changed": the CAS committed, so the row was
      // requeued and its only diagnostic was cleared.
      return "This meeting was put back in the queue, but nothing reached Odoo. It will be retried the next time Meetwings starts.";
    case "still-sending":
      return "This meeting is still being sent. If it stays this way, it will be retried the next time Meetwings starts.";
    case "push-failed":
      // Defers to the row's own last_error and never claims a send.
      return "This meeting could not be sent. The error on the row says why.";
    case "conflict":
      return "This meeting changed in another window.";
    case "moved-unknown":
      return "This meeting was moved, but the result could not be read.";
    case "deleted-after-send":
      // Says the opposite of DELETED_COPY, because the opposite is true. The
      // transcript is gone from this app either way; the note on the customer's
      // record is not, and only they can remove it.
      return "Removed from the queue — but it had already been sent to Odoo. The note is on the customer's record and was not removed.";
    case "failed":
      return describeFailure(outcome.report.code);
  }
}

function plural(n: number): string {
  return `${n} ${n === 1 ? "meeting is" : "meetings are"} waiting.`;
}

/**
 * `contact_id` is set for every assigned row, including those targeting a
 * `crm.lead`, so one map serves both. A miss is NORMAL, not exceptional:
 * `purgeOtherInstances` deletes other-instance contacts on every sync, so every
 * row in the other-database group resolves to `Contact #<id>` by construction.
 */
function targetNameOf(row: MeetingLogListRow, contacts: Map<number, OdooContact>): string {
  if (row.contact_id === null) return "No contact chosen";
  const cached = contacts.get(row.contact_id);
  const base = cached ? cached.name : `Contact #${row.contact_id}`;
  return row.lead_id === null ? base : `${base} (opportunity)`;
}

type ConfigState = "loading" | "absent" | "incomplete" | "complete";

export default function MeetingLog() {
  const [configState, setConfigState] = useState<ConfigState>("loading");
  const [instance, setInstance] = useState("");
  const [rows, setRows] = useState<MeetingLogListRow[]>([]);
  const [contacts, setContacts] = useState<Map<number, OdooContact>>(new Map());
  const [stranded, setStranded] = useState(0);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [busy, setBusy] = useState<Set<string>>(new Set());
  /**
   * The busy row's OBJECT, not just its id.
   *
   * Every action's CAS demotes its row's group rank - retry moves rank 0 to
   * rank 2, assign moves rank 1 to rank 2 - so the post-CAS re-read can push it
   * past the LIMIT 201 cap. Once it is out of the read an id has no status, no
   * target and no last_error to render, so "union the busy ids into the
   * rendered set" would render nothing and the row would still vanish on click,
   * with its outcome message nowhere to go.
   */
  const [pinned, setPinned] = useState<Map<string, MeetingLogListRow>>(new Map());
  /**
   * ONE record per row id. Where it renders is DERIVED, never decided.
   *
   * A successful retry writes `status = 'sent'`, which is not in
   * `listActionable`'s WHERE clause - so the row leaves on the very next read,
   * QueueRow unmounts, and an inline-only message goes with it about one DB
   * round trip after it appeared. That destroys the one sentence the whole
   * summarize plumbing exists to produce: "Sent - but the note shows the
   * transcript's first lines". Assign vanishes identically, `unassigned` ->
   * `sent`.
   *
   * The fix is NOT a point-in-time promotion check. Deciding in the action's
   * `finally` whether the row survived RACES the loader: with two rows in
   * flight, row A's token-ordered reload is superseded by row B's and reports
   * nothing, while B's reload commits a list that already excludes A - so A
   * unmounts with no message anywhere, which is the same loss by another route.
   * Instead the record is stored once and rendered inline while its row is on
   * screen, in the notice region when it is not. There is no ordering to get
   * wrong and it re-derives on every commit, including B's.
   *
   * Keyed by id, never a single slot: the busy Set is plural by design, so a
   * newest-replaces slot would silently drop one `degraded` message. Persistent
   * until dismissed - an auto-dismissing toast is this same bug on a timer.
   */
  const [results, setResults] = useState<Map<string, { label: string; text: string }>>(
    new Map()
  );
  const [transcript, setTranscript] = useState<{ id: string; view: TranscriptView } | null>(
    null
  );

  /**
   * The row the dialog is open for, as an OBJECT rather than an id.
   *
   * `null` IS the closed state - the dialog is mounted only while open, so
   * creation and disposal bracket exactly one session and its one client
   * cannot outlive it. The snapshot is what `runRowAction` needs for its
   * pre-action label; a re-read that dropped the row while the dialog sat open
   * would otherwise leave Confirm with nothing to name, and a stale snapshot is
   * harmless because the CAS matches on id and status, not on this object.
   */
  const [assignRow, setAssignRow] = useState<MeetingLogListRow | null>(null);

  const providerConfigRef = useRef<ProviderConfigLike | null>(null);

  /**
   * Reads are token-ordered.
   *
   * A focus re-read issued while an action's re-read is in flight can resolve
   * second though it started first, repainting rows the finished action already
   * moved. Bump before each read, capture, drop the result once it has moved on
   * - the selectionToken pattern at useOdooTarget.ts:111,192-215.
   */
  const loadToken = useRef(0);

  /**
   * Returns nothing on purpose. An earlier revision returned the committed
   * rows so an action could decide, in its `finally`, whether its row had
   * survived - which races: a concurrent action's reload supersedes this one,
   * this one reports nothing, and the winner commits a list that already
   * dropped the row. Where a result renders is derived from state at render
   * time instead, so there is no result here worth reading.
   */
  const reload = useCallback(async (): Promise<void> => {
    const token = ++loadToken.current;
    try {
      // NOT currentInstance(): it wraps requireOdooConfig, which THROWS for
      // exactly the half-filled config a user comes here to fix - so the one
      // surface showing their backlog would render nothing.
      const state = await loadOdooConfigState();
      if (token !== loadToken.current) return;

      if (state.state !== "complete") {
        // countActionableQueued, NOT countAllQueued: that statement is scoped
        // to ('held','pending','sending') because it feeds /odoo's promise that
        // credentials alone will send them - false for `failed` and
        // `unassigned`. Reusing it would show a user whose backlog is entirely
        // those two a count of zero, i.e. a blank page while rows are queued.
        const total = await countActionableQueued();
        if (token !== loadToken.current) return;
        setConfigState(state.state);
        setInstance("");
        setRows([]);
        setStranded(total);
        setLoadError(null);
        return;
      }

      const fingerprint = instanceFingerprint(state.config.url, state.config.db);
      // The contact map is refreshed on the SAME CYCLE as the list. The
      // dashboard webview is hidden rather than destroyed, so a page left
      // mounted outlives every main-window runSync and a map built once at
      // mount never learns about contacts synced afterwards.
      const [list, cached] = await Promise.all([
        listActionableRows(fingerprint),
        listContacts(fingerprint),
      ]);
      if (token !== loadToken.current) return;
      setConfigState("complete");
      setInstance(fingerprint);
      setRows(list);
      setContacts(new Map(cached.map((c) => [c.id, c])));
      setStranded(0);
      setLoadError(null);
    } catch (err) {
      if (token !== loadToken.current) return;
      // Reported, never swallowed - a queue that cannot be read must not look
      // like an empty queue. The code only, for the reason the copy map states.
      setLoadError(
        describeLoadFailure(reportOdooError(err, "read the meeting log queue").code)
      );
    }
  }, []);

  /**
   * Write-only mirrors, exactly as useMeetingLog.ts:141-145 does it.
   *
   * The focus listener registers on `[]` and must not close over the mount
   * render; listing the loader in its deps would re-register a Tauri listener
   * on every list change, each carrying the lossy async listen() gap.
   */
  const loaderRef = useRef(reload);
  const busyRef = useRef(busy);
  const configRef = useRef(configState);
  // Read by the notice label capture, which runs inside a []-stable handler.
  const contactsRef = useRef(contacts);
  const transcriptRef = useRef(transcript);
  useLayoutEffect(() => {
    loaderRef.current = reload;
    busyRef.current = busy;
    configRef.current = configState;
    contactsRef.current = contacts;
    transcriptRef.current = transcript;
  });

  useEffect(() => {
    void loaderRef.current();

    // getCurrentWebviewWindow().onFocusChanged, NOT useWindowFocus
    // (useWindow.ts:90): that one assigns `unlisten` after an await while its
    // cleanup reads it before the promise resolves, so the first StrictMode
    // mount's listener leaks permanently.
    let cancelled = false;
    let un: (() => void) | undefined;
    void (async () => {
      const stop = await getCurrentWebviewWindow().onFocusChanged(({ payload }) => {
        // It fires on BLUR too. Without this filter every blur triggers a full
        // config + list + contact-map refresh.
        if (payload) void loaderRef.current();
      });
      if (cancelled) stop();
      else un = stop;
    })();
    return () => {
      cancelled = true;
      un?.();
    };
  }, []);

  const setResult = useCallback(
    (id: string, record: { label: string; text: string } | null) => {
      setResults((prev) => {
        const next = new Map(prev);
        if (record === null) next.delete(id);
        else next.set(id, record);
        return next;
      });
    },
    []
  );

  /**
   * Rewrites a record's text, keeping the label it was captured with.
   *
   * Delete's conflict branch refines its copy AFTER the action has settled.
   * With one store there is nowhere else the message could have gone, so this
   * no longer has to work out where it currently lives.
   */
  const refineResult = useCallback((id: string, text: string) => {
    setResults((prev) => {
      const current = prev.get(id);
      if (!current) return prev;
      const next = new Map(prev);
      next.set(id, { ...current, text });
      return next;
    });
  }, []);

  const runRowAction = useCallback(
    async (
      row: MeetingLogListRow,
      run: () => Promise<ActionOutcome>,
      successCopy: string
    ): Promise<ActionOutcome | null> => {
      if (busyRef.current.has(row.id)) return null;
      // Defensive. The buttons are gone once the config stops being complete,
      // but a click racing a focus re-resolve is not unreachable.
      if (configRef.current !== "complete") return null;

      // CAPTURED BEFORE ANYTHING RUNS. Once the row leaves the list - which a
      // successful retry guarantees, since `sent` is not in listActionable's
      // WHERE clause - neither the date nor the target name exists anywhere
      // else, and the notice would name no meeting at all.
      const label = `${meetingDateOf(row)} · ${targetNameOf(row, contactsRef.current)}`;

      // Synchronously, BEFORE the first await. The list is only re-read when
      // the action finishes, so without this the row keeps rendering its
      // pre-click status with every button enabled, and a second click runs a
      // CAS against a row that is now `sending`, gets rowsAffected 0, and shows
      // "changed in another window" - false, about a row nothing else touched.
      setBusy((prev) => new Set(prev).add(row.id));
      setPinned((prev) => new Map(prev).set(row.id, row));
      // A new action on this row replaces that row's record.
      setResult(row.id, null);

      try {
        const outcome = await run();
        setResult(row.id, { label, text: outcomeCopy(outcome, successCopy) });
        return outcome;
      } catch (err) {
        // Unreachable today: runAction catches at both boundaries and
        // pushQueuedRow never throws. Kept so a future change cannot strand the
        // row busy with no explanation.
        setResult(row.id, {
          label,
          text: describeFailure(reportOdooError(err, "meeting log action").code),
        });
        return null;
      } finally {
        // Awaited so the pin outlives the read that decides this row's fate:
        // clearing it first would unmount the row, flash its record into the
        // notice region, and move it back inline if the row turned out to still
        // be actionable. NOTHING HERE DECIDES WHERE THE RECORD RENDERS - that
        // is derived at render time, which is what makes a superseded reload
        // harmless.
        await loaderRef.current();
        setBusy((prev) => {
          const next = new Set(prev);
          next.delete(row.id);
          return next;
        });
        setPinned((prev) => {
          const next = new Map(prev);
          next.delete(row.id);
          return next;
        });
      }
    },
    [setResult]
  );

  const handleRetry = useCallback(
    (row: MeetingLogListRow) => {
      void runRowAction(
        row,
        () =>
          retryMeetingLog(row.id, {
            // Read from the ref the leaf ProviderConfigReader writes. `null`
            // here would send every retry of a `failed` row - whose
            // summary_json is null by construction - down the fallback-body
            // path.
            providerConfig: providerConfigRef.current,
            // The only way to observe the CAS: runAction owns it internally and
            // resolves only after both re-reads, so without this the row
            // renders its pre-click status for the whole push.
            onCommitted: () => void loaderRef.current(),
          }),
        SENT_COPY
      );
    },
    [runRowAction]
  );

  const handleDelete = useCallback(
    (row: MeetingLogListRow) => {
      void (async () => {
        const outcome = await runRowAction(row, () => deleteMeetingLog(row.id), DELETED_COPY);
        if (outcome?.kind !== "conflict") return;
        // A zero-row delete re-reads the row and branches on its status.
        // Without this read the `sending`-specific copy has no path that
        // produces it, and shipping unreachable text is worse than not having
        // it. A failed re-read keeps the generic line already on screen.
        try {
          const after = await getQueueRow(row.id);
          if (after?.status === "sending") {
            refineResult(row.id, "This meeting is being sent to Odoo right now.");
          }
        } catch (err) {
          console.error("[Odoo] could not re-read a conflicting queue row:", err);
        }
      })();
    },
    [runRowAction, refineResult]
  );

  const handleAssign = useCallback((row: MeetingLogListRow) => {
    setAssignRow(row);
  }, []);

  /**
   * The push the dialog deliberately does not own.
   *
   * The dialog unmounts FIRST, then the action runs on the page - so the busy
   * `Set`, the status line and both re-reads all live in the surface that
   * outlives the push, and the dialog's "disposal" means only dropping its ref.
   * `payload.providerConfig` is used rather than `providerConfigRef.current`:
   * the dialog is what pre-flighted the provider and told the user about it, so
   * confirming must push with the config that warning was about.
   */
  const handleAssignConfirm = useCallback(
    (row: MeetingLogListRow, payload: AssignPayload) => {
      setAssignRow(null);
      void runRowAction(
        row,
        () =>
          assignMeetingLog(row.id, payload.contactId, payload.leadId, {
            providerConfig: payload.providerConfig,
            // `summary_json` is null on an unassigned row, so this push makes
            // the AI call - up to 210s for a reassign. Without this hook the
            // row renders its pre-click status for all of it.
            onCommitted: () => void loaderRef.current(),
          }),
        SENT_COPY
      );
    },
    [runRowAction]
  );

  const handleAssignCancel = useCallback(() => {
    // Cancel writes nothing. The dialog closing is not a state change, and in
    // particular it does not mark the row busy - busy is set at Confirm.
    setAssignRow(null);
  }, []);

  const readTranscript = useCallback((row: MeetingLogListRow) => {
    const id = row.id;
    setTranscript({ id, view: { state: "loading" } });
    void (async () => {
      try {
        const text = await getQueueTranscript(id);
        setTranscript((current) => {
          if (!current || current.id !== id) return current;
          if (text === null) return { id, view: { state: "missing" } };
          if (text === "") return { id, view: { state: "removed" } };
          return { id, view: { state: "text", text } };
        });
        // Defensive only - nothing in this repo deletes a meeting_log_queue row
        // - but a row that is gone means the list is stale by definition.
        if (text === null) void loaderRef.current();
      } catch (err) {
        console.error("[Odoo] could not read a queued transcript:", err);
        setTranscript((current) =>
          current && current.id === id ? { id, view: { state: "error" } } : current
        );
      }
    })();
  }, []);

  const toggleTranscript = useCallback(
    (row: MeetingLogListRow) => {
      if (transcriptRef.current?.id === row.id) {
        setTranscript(null);
        return;
      }
      readTranscript(row);
    },
    [readTranscript]
  );

  /**
   * The capped list, with any pinned row the re-read dropped merged back.
   *
   * The merge happens AFTER the cap and is deduped against the CAPPED set: a
   * busy row still present in the read but sitting past position 200 was
   * dropped by the cap, and deduping against the uncapped read would drop it
   * again. The fresh object wins when there is one; the snapshot covers the row
   * leaving the read entirely.
   */
  const rendered = useMemo(() => {
    const capped = rows.slice(0, PAGE_CAP);
    if (pinned.size === 0) return capped;
    const shown = new Set(capped.map((r) => r.id));
    const fresh = new Map(rows.map((r) => [r.id, r]));
    const merged = [...capped];
    for (const [id, snapshot] of pinned) {
      if (!shown.has(id)) merged.push(fresh.get(id) ?? snapshot);
    }
    return merged;
  }, [rows, pinned]);

  /**
   * A clock, ticking only while some row holds a claim.
   *
   * The row cannot do this itself: `Date.now()` is not a prop, so
   * `propsAreEqual` never sees it move and a memoised row freezes its verdict
   * at whatever the clock read on its last DB-driven render. Before this, a
   * claim that expired while the dashboard sat in the foreground kept
   * rendering "Sending..." until an unrelated reload - a focus event, or an
   * action on some other row - happened to repaint it.
   *
   * Gated on `hasClaim` so the common case (nothing sending) runs no timer at
   * all. It keeps ticking once a row IS stale, which is wasted work for one
   * row's worth of already-correct text; stopping it would mean tracking which
   * rows have already flipped, and the timer is one setState every 30s.
   */
  const hasClaim = useMemo(
    () => rendered.some((row) => row.status === "sending" && row.claimed_at !== null),
    [rendered]
  );

  const [now, setNow] = useState(() => Date.now());

  useEffect(() => {
    if (!hasClaim) return;
    const id = setInterval(() => setNow(Date.now()), STALE_TICK_MS);
    return () => clearInterval(id);
  }, [hasClaim]);

  const grouped = useMemo(() => {
    const buckets = new Map<Exclude<QueueGroup, null>, MeetingLogListRow[]>(
      GROUPS.map((g) => [g.key, []])
    );
    for (const row of rendered) {
      const key = groupOf(row, instance);
      if (key) buckets.get(key)?.push(row);
    }
    return buckets;
  }, [rendered, instance]);

  /**
   * The ids that actually mount a QueueRow this commit.
   *
   * Derived from the GROUPED buckets, not from `rows`: a busy row the read
   * dropped is merged back by the pin and does render, and a row past the cap
   * does not - so `rows` would put a record in both places at once, or in
   * neither.
   */
  const inlineIds = useMemo(() => {
    const ids = new Set<string>();
    for (const list of grouped.values()) {
      for (const row of list) ids.add(row.id);
    }
    return ids;
  }, [grouped]);

  /**
   * Every stored record whose row is not on screen. No promotion step, no
   * point-in-time check, and nothing to get wrong when two reloads overlap:
   * this recomputes on the commit that dropped the row, whichever action's
   * reload produced it.
   */
  const notices = useMemo(
    () =>
      [...results]
        .filter(([id]) => !inlineIds.has(id))
        .map(([id, record]) => ({ id, ...record })),
    [results, inlineIds]
  );

  const isEmpty = rendered.length === 0;

  return (
    <PageLayout
      title="Meeting log"
      description="Meetings waiting to reach Odoo, and the ones that need you."
    >
      {/*
        A LEAF. AppProvider rebuilds its value every render and calls loadData()
        on cross-window `storage` events, so consuming the context in this shell
        would repaint a 200-row list that does not depend on it.
      */}
      <ProviderConfigReader configRef={providerConfigRef} />

      {loadError !== null && <p className="text-sm text-destructive">{loadError}</p>}

      {/*
        Records whose row is not on screen. Rendered ABOVE the groups so the one
        sentence `degraded` exists to produce is not below 200 rows, and
        persistent until dismissed - a toast here would be the same
        disappearing-message bug on a shorter timer.
      */}
      {notices.length > 0 && (
        <section aria-label="Finished meetings" className="flex flex-col gap-2">
          <ul className="flex flex-col gap-2">
            {notices.map((notice) => (
              <li
                key={notice.id}
                data-notice-id={notice.id}
                className="flex items-start justify-between gap-3 rounded-xl border p-3"
              >
                <div className="flex flex-col gap-1">
                  <span className="text-xs text-muted-foreground">{notice.label}</span>
                  <span className="text-sm">{notice.text}</span>
                </div>
                <Button
                  size="sm"
                  variant="ghost"
                  onClick={() => setResult(notice.id, null)}
                  aria-label={`Dismiss the result for ${notice.label}`}
                >
                  Dismiss
                </Button>
              </li>
            ))}
          </ul>
        </section>
      )}

      {configState !== "loading" && configState !== "complete" && (
        <p className="text-sm">
          {`${plural(stranded)} Finish setting Odoo up on the `}
          <Link to="/odoo" className="underline">
            Odoo page
          </Link>
          {" to see and send them."}
        </p>
      )}

      {configState === "complete" && isEmpty && (
        <p className="text-sm text-muted-foreground">No meetings waiting to be logged.</p>
      )}

      {configState === "complete" &&
        GROUPS.map(({ key, title }) => {
          const groupRows = grouped.get(key) ?? [];
          if (groupRows.length === 0) return null;
          return (
            <section key={key} aria-labelledby={`meeting-log-${key}`} className="flex flex-col gap-2">
              <h2 id={`meeting-log-${key}`} className="text-sm font-semibold">
                {title}
              </h2>
              <ul className="flex flex-col gap-2">
                {groupRows.map((row) => (
                  <QueueRow
                    key={row.id}
                    row={row}
                    targetName={targetNameOf(row, contacts)}
                    instance={instance}
                    busy={busy.has(row.id)}
                    stale={isClaimStale(row, now)}
                    outcome={results.get(row.id)?.text ?? null}
                    transcript={transcript?.id === row.id ? transcript.view : null}
                    onRetry={handleRetry}
                    onAssign={handleAssign}
                    onDelete={handleDelete}
                    onToggleTranscript={toggleTranscript}
                    onReloadTranscript={readTranscript}
                  />
                ))}
              </ul>
            </section>
          );
        })}

      {/*
        Bounded on purpose. A 201-row read proves only that AT LEAST ONE row is
        hidden, and under group-rank ordering these are the 200 highest-priority
        rows, not the most recent - the whole point of that ordering is that an
        old needs-attention row outranks 200 newer unassigned ones.
      */}
      {configState === "complete" && rows.length > PAGE_CAP && (
        <p className="text-xs text-muted-foreground">{REMAINDER_LINE}</p>
      )}

      {/*
        MOUNTED ONLY WHILE OPEN, and keyed on the row. Rendered unconditionally
        behind an `open` prop, its one-client-per-session ref would live as long
        as this page does - and the page stays mounted, because the dashboard
        webview is hidden rather than destroyed.
      */}
      {assignRow !== null && (
        <AssignDialog
          key={assignRow.id}
          row={assignRow}
          instance={instance}
          onConfirm={(payload) => handleAssignConfirm(assignRow, payload)}
          onCancel={handleAssignCancel}
        />
      )}
    </PageLayout>
  );
}
