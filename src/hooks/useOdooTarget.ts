import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { getCurrentWindow } from "@tauri-apps/api/window";
import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type RefObject,
} from "react";
import { toast } from "sonner";
import {
  addSelectedTarget,
  clearTargets,
  getSyncState,
  listContacts,
  loadTargets,
  removeSelectedTarget,
  setColleague,
  stampLastMeeting,
} from "@/lib/database/odoo-contacts.action";
import {
  createOdooClient,
  currentInstance,
  fetchOpportunities,
  odooError,
  OdooError,
  reportOdooError,
  runSync,
  searchLeads,
  LEAD_SEARCH_MIN_CHARS,
} from "@/lib/odoo";
import { loadOdooConfig } from "@/lib/storage/odoo-config.storage";
import type {
  OdooContact,
  OdooOpportunity,
  ResolvedTarget,
  SelectedTarget,
  SelectedTargets,
} from "@/types";
import type {
  ContactPickerProps,
  PickerCacheState,
} from "@/pages/app/components/completion/ContactPicker";

/**
 * MODULE SCOPE, not the component body.
 *
 * It takes the state as an argument and closes over nothing, so there is no
 * reason for a fresh identity every render. Kept here even though this repo's
 * installed eslint-plugin-react-hooks (v7.0.1, the reactivity-aware rule set)
 * does NOT flag it if moved into the component body - verified directly: it
 * performs data-flow analysis and correctly sees this function closes over no
 * render-scope binding, so it does not require it as a dependency wherever
 * declared. Module scope is kept anyway: it is strictly safer against a future
 * edit that gives this function a real closure (at which point the identity
 * WOULD need to be stable for `onToggleColleague`/`onRetryOpportunities` to
 * keep ContactPicker's React.memo effective), and it costs nothing today.
 *
 * THE CONTACT LIST HAS EXACTLY ONE HOME: `cache`. A separate `contacts` state
 * alongside `cache.contacts` is the obvious first draft and it is wrong.
 * ContactPicker renders exclusively from `props.cache`, so an optimistic
 * colleague patch applied to a second array produces precisely the failure the
 * optimistic patch exists to prevent - the star does not move and the ordering
 * does not change until the next load.
 */
const contactsOf = (state: PickerCacheState): OdooContact[] =>
  state.kind === "ready" ? state.contacts : [];

/**
 * The single-flow's own persistence key, coalescing a `ResolvedTarget` down
 * to the one `SelectedTarget` row it maps onto in `odoo_selected_targets`.
 *
 * Mirrors `useMeetingLog.ts`'s `resolvedToSelected` exactly (lead wins, name
 * only kept for a lead) - which itself matches migration 14's own backfill
 * SQL (`CASE WHEN lead_id IS NOT NULL THEN 'crm.lead' ELSE 'res.partner' END,
 * COALESCE(lead_id, contact_id)`). `saveTarget`/`loadTarget` queried
 * `odoo_selected_target`, a table migration 14 drops - this hook's
 * persistence goes through the shared multi-target table instead, Task 4's
 * `addSelectedTarget`/`removeSelectedTarget`.
 *
 * Returns null rather than asserting: `ResolvedTarget.contactId` is
 * `number | null` and `SelectedTarget.resId` is `number`, so an assertion
 * would fail TS strict. `commit`'s own null-target callers already treat
 * "nothing selected" as "nothing to write".
 */
function toSelectedTarget(t: ResolvedTarget): SelectedTarget | null {
  if (t.leadId !== null) return { model: "crm.lead", resId: t.leadId, name: t.leadName };
  if (t.contactId !== null) return { model: "res.partner", resId: t.contactId, name: null };
  return null;
}

/**
 * The reverse of `toSelectedTarget`, for rehydrating the single flow's
 * `target` from the shared table. LOSSY, on purpose and unavoidably: a
 * `crm.lead` row never recorded the partner it was picked under (the same
 * loss migration 14's backfill already accepts), so a rehydrated lead target
 * always comes back with `contactId: null`.
 */
function fromSelectedTarget(t: SelectedTarget): ResolvedTarget {
  return t.model === "crm.lead"
    ? { contactId: null, leadId: t.resId, leadName: t.name }
    : { contactId: t.resId, leadId: null, leadName: null };
}

/** True when `err` is the OdooError this feature raises for a busy sync claim. */
function isSyncBusy(err: unknown): boolean {
  return err instanceof OdooError && err.code === "ODOO_SYNC_BUSY";
}

/** True when `err` is the OdooError this feature raises for missing credentials. */
function isNotConfigured(err: unknown): boolean {
  return err instanceof OdooError && err.code === "ODOO_NOT_CONFIGURED";
}

/**
 * Owns the Odoo selection for <Completion />.
 *
 * The RESOLVED TARGET is persisted, not merely held in state: <Completion />
 * can unmount mid-call (the !setupLoading && setupComplete gate at
 * src/pages/app/index.tsx:84 is reactive, not latched, and useSetupStatus
 * re-runs on the cross-window storage reload at contexts/app.context.tsx:505 -
 * another window changing provider selection is enough). React state would
 * vanish silently and slice 2 would file the meeting as unassigned while the
 * user believes they picked someone.
 */
export interface UseOdooTargetReturn {
  targetRef: RefObject<ResolvedTarget | null>;
  pickerProps: ContactPickerProps;
  /**
   * The multi-target selection (Task 4's `odoo_selected_targets`), separate
   * from `targetRef`'s single flow above. NOT wired into `useMeetingLog` yet
   * - `targetRef` stays what slice 2 pushes until Task 14 - this is purely
   * picker-facing state for Task 12's UI.
   */
  targets: SelectedTargets;
  targetCount: number;
  addTarget: (t: SelectedTarget) => Promise<{ ok: boolean; reason?: "cap" }>;
  removeTarget: (model: SelectedTarget["model"], resId: number) => Promise<void>;
  /** Runs (or joins) the per-contact deal lookup a "Logging to" row expands into. */
  expandContact: (contactId: number) => Promise<void>;
  opportunitiesFor: (contactId: number) => OdooOpportunity[] | null;
  errorFor: (contactId: number) => string | null;
  retryOpportunitiesFor: (contactId: number) => Promise<void>;
}

export function useOdooTarget({
  meetingAssistMode,
  isPickerOpen,
  setIsPickerOpen,
}: {
  meetingAssistMode: boolean;
  // Threaded through from useCompletion (see Files.tsx's isFilesPopoverOpen
  // for the identical pattern), NOT owned here. This hook is mounted in the
  // `main` overlay window, which is 600x54 and grows only through
  // useCompletion's resize effect - the sole caller of resizeWindow(true) -
  // watching a fixed flag list. `pickerProps.open`/`onOpenChange` below pass
  // these straight through to ContactPicker so that effect can observe this
  // popover exactly like it already observes the Files popover.
  isPickerOpen: boolean;
  setIsPickerOpen: (open: boolean) => void;
}): UseOdooTargetReturn {
  const [target, setTarget] = useState<ResolvedTarget | null>(null);
  const [cache, setCache] = useState<PickerCacheState>({ kind: "never-synced" });
  const [opportunities, setOpportunities] = useState<OdooOpportunity[] | null>(null);
  const [opportunityError, setOpportunityError] = useState<string | null>(null);
  const [isLookingUp, setIsLookingUp] = useState(false);
  /**
   * The lead SEARCH, which is a different read from the opportunity lookup and
   * keeps its own state for it.
   *
   * The lookup hangs off a chosen contact; this one hangs off the text in the
   * search box and is the only way to reach a lead that has no res.partner
   * behind it at all. Sharing one `isLookingUp`/`opportunityError` pair
   * between them would paint a failed search as a failed lookup under a
   * contact the user had already picked successfully.
   */
  const [leadResults, setLeadResults] = useState<OdooOpportunity[] | null>(null);
  const [leadSearchError, setLeadSearchError] = useState<string | null>(null);
  const [isSearchingLeads, setIsSearchingLeads] = useState(false);

  /**
   * Task 11's list. Non-nullable: `useState<SelectedTargets | null>(null)`
   * would make the natural pickerProps fallback `targets: target ?? []`,
   * which allocates a fresh array on every render at zero targets - the
   * steady state before anyone picks anything - and a memoized picker's
   * default shallow comparator would then re-render on every streamed AI
   * chunk.
   */
  const [targets, setTargets] = useState<SelectedTargets>([]);

  const instanceRef = useRef<string | null>(null);
  const selectionToken = useRef(0);
  /**
   * Its OWN token, not `selectionToken`.
   *
   * Searches are superseded by later SEARCHES, not by selections - and a
   * selection made while a search is in flight must not silently discard the
   * results the user is about to pick from.
   */
  const searchToken = useRef(0);
  // Remembers the contact behind the current opportunity lookup, so retry can
  // re-run it without asking the caller to hand a whole OdooContact back in.
  const contactRef = useRef<OdooContact | null>(null);

  /**
   * `meetingAssistMode` is a CHANGING prop read from the mount effect and from
   * onRefresh, mirrored into a ref exactly as useMeetingAutoRecord.ts:154-164
   * does with its own.
   *
   * Both alternatives are wrong. A `useCallback(..., [])` closure freezes it at
   * mount, so onRefresh feeds decideSync a stale flag forever - and no test
   * would catch it, because none asserts on runSync's arguments from onRefresh.
   * Listing it in the mount effect's deps re-runs the whole app-start sync AND
   * the loadTarget rehydrate on every pill toggle.
   */
  const meetingAssistModeRef = useRef(meetingAssistMode);
  useLayoutEffect(() => {
    meetingAssistModeRef.current = meetingAssistMode;
  });

  /**
   * The ref slice 2 reads.
   *
   * useLayoutEffect, because slice 2's meeting-ended listener is registered
   * ONCE PER WINDOW LIFETIME and would otherwise close over the mount-time
   * value. It follows that slice 2's listener effect must be keyed on
   * OWNERSHIP ONLY, never on the selection - keying it on the selection tears
   * down and re-registers on every commit, i.e. per streamed AI chunk, with an
   * async listen() gap each time during which a real meeting-ended is lost.
   * See useMeetingAutoRecord.ts:646-654.
   */
  const targetRef = useRef<ResolvedTarget | null>(null);
  useLayoutEffect(() => {
    targetRef.current = target;
  });

  /**
   * Read by `reload`'s archival filter and by `addTarget`/`removeTarget`,
   * neither of which may take `targets` itself as a dependency without
   * rebinding on every list change - the same reasoning as `targetRef` above.
   */
  const targetsRef = useRef(targets);
  useLayoutEffect(() => {
    targetsRef.current = targets;
  });

  /**
   * Read by `onSelectOpportunity`, which runs from a click handler rather than
   * during render. Mirrored so that callback keeps the stable identity
   * ContactPicker's React.memo depends on - taking `opportunities` as a dep
   * would give it a new identity on every lookup.
   */
  const opportunitiesRef = useRef(opportunities);
  useLayoutEffect(() => {
    opportunitiesRef.current = opportunities;
  });

  // Read from onRetryOpportunities' fallback, which is called from an
  // event handler rather than during render - mirrored so that callback can
  // stay referentially stable ([] of its own genuinely-changing deps) instead
  // of taking `cache` itself as a dep and losing its identity on every reload.
  const cacheRef = useRef(cache);
  useLayoutEffect(() => {
    cacheRef.current = cache;
  });

  /**
   * The per-contact deal-lookup cache backing each "Logging to" row's
   * disclosure, keyed by contact id - independent of `opportunities`/
   * `opportunityError` above, which back the single-select flow's own panel.
   *
   * `rowGen` is a per-contact generation, so adding or removing a target
   * elsewhere in the list cannot invalidate an unrelated open disclosure -
   * unlike the single flow's shared `selectionToken`, which would strand
   * every other open row on "Looking up..." the moment any one of them
   * changed. A ref: it backs no rendered UI.
   */
  const rowGen = useRef(new Map<number, number>());
  // Mirrored so `expandContact`/`retryOpportunitiesFor` can read fresh values
  // without taking rowCache/rowError as dependencies - same reasoning as
  // cacheRef above.
  const rowCacheRef = useRef(new Map<number, OdooOpportunity[]>());
  const rowErrorRef = useRef(new Map<number, string>());
  // RENDERED. A new Map on every write, or ContactPicker never learns a
  // lookup landed and the row sits on "Looking up..." forever - a useRef
  // write schedules no render, unlike every other ref above that backs
  // rendered UI (opportunitiesRef, cacheRef).
  const [rowCache, setRowCache] = useState<Map<number, OdooOpportunity[]>>(new Map());
  const [rowError, setRowError] = useState<Map<number, string>>(new Map());
  useLayoutEffect(() => {
    rowCacheRef.current = rowCache;
  });
  useLayoutEffect(() => {
    rowErrorRef.current = rowError;
  });

  /**
   * NOT independent of everything, despite being keyed per contact.
   * `handleInstanceChanged` bumps this precisely to supersede data from a
   * database just switched away from - ContactPicker's rows are long-lived
   * across that switch (Radix unmounts PopoverContent's subtree, not the
   * component instance holding these maps), so without an epoch the cache
   * would go on serving opportunities from the old database under contact
   * ids that may now name entirely different Odoo records.
   */
  const epoch = useRef(0);

  const bumpEpoch = useCallback(() => {
    epoch.current += 1;
    rowGen.current.clear(); // a ref: .current is right here
    setRowCache(new Map()); // STATE: no .current, and a NEW Map, not .clear()
    setRowError(new Map()); // an in-place clear schedules no render
  }, []);

  /**
   * `createOdooClient(config)` is the only consumer of `loadOdooConfig` here -
   * without this function it sits in the import block unused, and
   * tsconfig.json sets `noUnusedLocals: true`.
   */
  const getClient = useCallback(async () => {
    const config = await loadOdooConfig();
    if (!config) {
      throw odooError("ODOO_NOT_CONFIGURED", "Odoo is not set up yet", {});
    }
    return createOdooClient(config);
  }, []);

  /**
   * `odoo_selected_target.instance` is TEXT NOT NULL, and `instanceRef` is
   * populated only by the async mount effect - so a selection made during the
   * rehydrate round trip would write `null` and hit a constraint violation
   * thrown out of a click handler, i.e. an unhandled rejection. Every write
   * goes through this so that can never happen.
   */
  const resolveInstance = useCallback(async () => {
    if (instanceRef.current) return instanceRef.current;
    const instance = await currentInstance();
    instanceRef.current = instance;
    return instance;
  }, []);

  /**
   * Replaces `targets` wholesale, EXCEPT it skips the write when both the
   * current and the next list are empty - so a mount/instance-change rehydrate
   * that finds nothing to restore does not allocate a fresh `[]` over the
   * initial one. `targets: target ?? []` allocating fresh at zero targets was
   * exactly the failure the initial `useState<SelectedTargets>([])` above was
   * chosen to avoid; this is the same guarantee applied to every LATER write,
   * not just the first render.
   */
  const applyTargets = useCallback((next: SelectedTargets) => {
    setTargets((prev) => (prev.length === 0 && next.length === 0 ? prev : next));
  }, []);

  /**
   * `token !== selectionToken.current` is re-checked on BOTH the entry and the
   * rejection path. Re-checking only on entry lets a stale commit's rollback
   * overwrite a NEWER selection that persisted fine: pick Ada (token 1, slow
   * write), pick Bea (token 2, writes, row = Bea), then Ada's write rejects and
   * rolls state back to null while SQLite still holds Bea. A superseded commit
   * must fail SILENTLY - no setTarget, no toast.
   *
   * Task 11: persists through the shared `odoo_selected_targets` table now,
   * not the dropped `odoo_selected_target` singleton - `saveTarget`/
   * `loadTarget` queried a table migration 14 drops. `next`/`previous` are
   * each coalesced to at most one `SelectedTarget` row (`toSelectedTarget`);
   * the new row is added before the old one - if it named a DIFFERENT row -
   * is removed, so a failed add never leaves the previous selection's row
   * deleted out from under it.
   */
  const commit = useCallback(
    async (next: ResolvedTarget | null, token: number) => {
      if (token !== selectionToken.current) return;
      const previous = targetRef.current;
      setTarget(next);
      try {
        const instance = await resolveInstance();
        const nextKey = next ? toSelectedTarget(next) : null;
        const previousKey = previous ? toSelectedTarget(previous) : null;

        if (nextKey) {
          const result = await addSelectedTarget(instance, nextKey, null, Date.now());
          if (!result.ok) {
            throw odooError(
              "ODOO_INTERNAL",
              "Could not save the selected target",
              { reason: result.reason ?? "unknown" }
            );
          }
        }
        if (
          previousKey &&
          (!nextKey || previousKey.model !== nextKey.model || previousKey.resId !== nextKey.resId)
        ) {
          await removeSelectedTarget(instance, previousKey.model, previousKey.resId);
        }
      } catch (err) {
        if (token !== selectionToken.current) return;
        setTarget(previous);
        const report = reportOdooError(err, "save target");
        toast.error(`${report.code}: ${report.message}`);
      }
    },
    [resolveInstance]
  );

  /**
   * NEVER REJECTS. Called from the mount effect's happy path, its CATCH
   * branches (already outside any try), and onRefresh's click handler - none
   * of which can absorb a rejection.
   */
  const reload = useCallback(
    async (token: number) => {
      try {
        const instance = await resolveInstance();
        const [contacts, state] = await Promise.all([
          listContacts(instance),
          getSyncState(instance),
        ]);

        const lastSyncAt = state?.last_sync_at ?? null;
        const lastErrorCode = state?.last_error_code ?? null;
        if (contacts.length > 0 || lastSyncAt !== null) {
          setCache({ kind: "ready", contacts, lastError: lastErrorCode });
        } else if (lastErrorCode !== null) {
          setCache({ kind: "sync-failed", code: lastErrorCode });
        } else {
          setCache({ kind: "never-synced" });
        }

        // Absent from the list is not the same as archived: an incremental
        // sync that returned nothing about this contact must not clear it.
        // `token` here is the snapshot the CALLER captured before its own
        // awaits, passed straight through to commit() unchanged - passing the
        // live selectionToken.current instead would make commit's own
        // staleness check a no-op and let a stale snapshot clear a selection
        // made while this reload was in flight.
        const selected = targetRef.current;
        if (selected) {
          const row = contacts.find((c) => c.id === selected.contactId);
          if (row && !row.active) {
            await commit(null, token);
          }
        }

        // Task 11: the SAME archival rule, applied PER TARGET to the list
        // instead of clearing it wholesale. A `crm.lead` target is never
        // touched here - contact sync says nothing about a lead's own
        // lifecycle - and a `res.partner` target survives unless its contact
        // is BOTH present and inactive, exactly the single-target rule above.
        const currentTargets = targetsRef.current;
        const survivors = currentTargets.filter((t) => {
          if (t.model !== "res.partner") return true;
          const row = contacts.find((c) => c.id === t.resId);
          return !(row && !row.active);
        });
        if (survivors.length !== currentTargets.length) {
          if (token !== selectionToken.current) return;
          const dropped = currentTargets.filter((t) => !survivors.includes(t));
          for (const t of dropped) {
            await removeSelectedTarget(instance, t.model, t.resId);
          }
          if (token !== selectionToken.current) return;
          applyTargets(survivors);
        }
      } catch (err) {
        const report = reportOdooError(err, "load contacts");
        toast.error(`${report.code}: ${report.message}`);
      }
    },
    [applyTargets, commit, resolveInstance]
  );

  const triageSyncFailure = useCallback(
    async (err: unknown, token: number) => {
      if (isNotConfigured(err)) {
        if (token === selectionToken.current) setCache({ kind: "not-configured" });
        return;
      }
      if (isSyncBusy(err)) {
        // Not a failure: another window is syncing. Whatever it wrote is
        // worth showing.
        await reload(token);
        return;
      }
      // Reported so the user learns syncing is dead even when the failure was
      // raised before syncContacts wrote any marker at all.
      const report = reportOdooError(err, "sync odoo contacts");
      toast.error(`${report.code}: ${report.message}`);
      await reload(token);
    },
    [reload]
  );

  // Mount effect: resolve the instance, rehydrate the persisted selection,
  // sync (main window only) and reload the cache.
  useEffect(() => {
    const token = selectionToken.current;
    void (async () => {
      try {
        const instance = await resolveInstance();
        const persistedTargets = await loadTargets(instance);
        if (token === selectionToken.current) {
          applyTargets(persistedTargets);
          // The single flow's own rehydrate: the MOST RECENT row (the list
          // is `ORDER BY selected_at`), converted back through the same
          // lossy coalesce `commit` writes through.
          const last = persistedTargets[persistedTargets.length - 1];
          if (last) setTarget(fromSelectedTarget(last));
        }

        if (getCurrentWindow().label === "main") {
          // The outcome itself is not consulted here: reload() below reads
          // the cache tables directly, which already distinguish "ran,
          // nothing changed" from "did not run" via last_sync_at.
          await runSync("app-start", meetingAssistModeRef.current);
        }
        await reload(token);
      } catch (err) {
        await triageSyncFailure(err, token);
      }
    })();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Cross-window credential changes. `saveOdooConfig` reports whether the
  // instance changed or became usable; the settings page (in the `dashboard`
  // window) emits "odoo-instance-changed" on either, and this listener - which
  // lives in `main` - re-resolves and re-syncs.
  const handleInstanceChanged = useCallback(async () => {
    selectionToken.current += 1;
    const token = selectionToken.current;
    instanceRef.current = null;

    // The row this hook is about to synchronize against belongs to a
    // DIFFERENT Odoo database. `runSync` below purges
    // `odoo_selected_target` rows for every OTHER instance
    // (purgeOtherInstances), so the DB half of the old selection is already
    // gone by the time reload() runs - but `target`/`targetRef` still hold
    // it in memory. Left uncleared, the picker would keep rendering a
    // contactId that resolves to nothing in the new cache, and a later
    // onSelectOpportunity would commit that stale id under the NEW
    // instance's fingerprint, writing a poisoned row. Bumping the token
    // first also supersedes any selection still in flight from before the
    // switch, exactly like onSelect does for its own stale writes.
    setTarget(null);
    targetRef.current = null;
    // Task 11: the list gets the SAME eager reset, for the same reason - and
    // the disclosure cache too, since a row's cached deals came from the
    // database just switched away from.
    applyTargets([]);
    bumpEpoch();

    try {
      const instance = await resolveInstance();
      await runSync("refresh", meetingAssistModeRef.current);
      const persistedTargets = await loadTargets(instance);
      if (token === selectionToken.current) {
        applyTargets(persistedTargets);
        const last = persistedTargets[persistedTargets.length - 1];
        if (last) setTarget(fromSelectedTarget(last));
      }
      await reload(token);
    } catch (err) {
      await triageSyncFailure(err, token);
    }
  }, [applyTargets, bumpEpoch, reload, resolveInstance, triageSyncFailure]);

  /**
   * `listen()` returns a PROMISE of the unlisten function, so a plain
   * `return () => un()` has nothing to call yet. Under StrictMode both mounts
   * resolve their listen() AFTER the first cleanup ran, and without the
   * `cancelled` flag the second handler leaks permanently. See
   * useMeetingAutoRecord.ts:581-587.
   */
  useEffect(() => {
    let cancelled = false;
    let un: (() => void) | undefined;
    void listen("odoo-instance-changed", handleInstanceChanged).then((fn) => {
      if (cancelled) fn();
      else un = fn;
    });
    return () => {
      cancelled = true;
      un?.();
    };
  }, [handleInstanceChanged]);

  /**
   * "Starting a new chat" is one of the three DB-deletion triggers the spec
   * names for `odoo_selected_target` (the other two: an instance change, and
   * a sync that archives the selected partner - both handled above). A
   * finished meeting with customer A must not silently carry its target into
   * a fresh chat with customer B.
   *
   * `newConversationStarted` is a WINDOW event, not a Tauri one: unlike
   * odoo-instance-changed (dashboard window -> main window),
   * useCompletion.ts's startNewConversation and this hook both live in the
   * `main` webview, so `window.addEventListener` is the bus already used
   * there for conversationSelected/newConversation/conversationDeleted -
   * this is one more listener on it, not a new one. It is emitted from
   * startNewConversation() itself so every path that starts a new chat
   * (the newConversation request event, a deleted-conversation fallback, and
   * Input.tsx's keepEngaged close button) is covered from a single place.
   */
  /**
   * Bypasses `commit`: a new chat clears EVERYTHING (`clearTargets`, the
   * full-instance wipe), not just the single flow's own coalesced row -
   * `commit(null, token)`'s removal is scoped to one row and would leave the
   * rest of `odoo_selected_targets` behind.
   */
  const handleNewChat = useCallback(() => {
    selectionToken.current += 1;
    const token = selectionToken.current;
    setTarget(null);
    targetRef.current = null;
    applyTargets([]);
    bumpEpoch();
    void (async () => {
      try {
        const instance = await resolveInstance();
        if (token !== selectionToken.current) return;
        await clearTargets(instance);
      } catch (err) {
        if (token !== selectionToken.current) return;
        const report = reportOdooError(err, "clear targets");
        toast.error(`${report.code}: ${report.message}`);
      }
    })();
  }, [applyTargets, bumpEpoch, resolveInstance]);

  useEffect(() => {
    window.addEventListener("newConversationStarted", handleNewChat);
    return () => window.removeEventListener("newConversationStarted", handleNewChat);
  }, [handleNewChat]);

  const onSelect = useCallback(
    async (contact: OdooContact) => {
      selectionToken.current += 1;
      const token = selectionToken.current;
      contactRef.current = contact;

      // Reset unconditionally, FIRST - otherwise contact A's deals stay on
      // screen under contact B until B's lookup lands, and forever for a
      // colleague, which skips the lookup entirely.
      setOpportunities(null);
      setOpportunityError(null);
      setIsLookingUp(!contact.isColleague);

      await commit({ contactId: contact.id, leadId: null, leadName: null }, token);

      // Cosmetic recency stamp. Fired AFTER the load-bearing commit, never
      // awaited by it - a locked DB here must not take the commit down with
      // it. resolveInstance() itself can throw (e.g. credentials vanished
      // between the commit and here), so it is inside this same swallow
      // rather than evaluated in onSelect's own flow, where a rejection would
      // escape this click handler unhandled.
      void (async () => {
        try {
          const instance = await resolveInstance();
          await stampLastMeeting(instance, contact.id, Date.now());
        } catch {
          toast.info("Could not update recency for this contact");
        }
      })();

      if (contact.isColleague) return;

      try {
        const client = await getClient();
        const rows = await fetchOpportunities(client, contact);
        if (token !== selectionToken.current) return;
        setOpportunities(rows);
        setIsLookingUp(false);
      } catch (err) {
        if (token !== selectionToken.current) return;
        const report = reportOdooError(err, "fetch opportunities");
        setOpportunityError(report.code);
        setIsLookingUp(false);
      }
    },
    [commit, getClient, resolveInstance]
  );

  const onSelectOpportunity = useCallback(
    async (leadId: number | null) => {
      const current = targetRef.current;
      if (!current) return;
      // Captured HERE, from the list that is on screen, because this is the
      // last moment anything knows it: `opportunities` is in-memory state and
      // a <Completion /> remount takes it with it, leaving a persisted lead id
      // with nothing able to name it.
      const name =
        leadId === null
          ? null
          : (opportunitiesRef.current?.find((o) => o.id === leadId)?.name ?? null);
      await commit(
        { contactId: current.contactId, leadId, leadName: name },
        selectionToken.current
      );
    },
    [commit]
  );

  /**
   * A crm.lead picked straight out of the search, with no contact step.
   *
   * `contactId` is the lead's OWN partner when it has one - keeping that link
   * costs nothing and the queue page can name the row from it - and null when
   * it does not, which is the case this whole path exists for.
   *
   * The opportunity lookup is reset rather than re-run: the user has already
   * named the record they mean, and re-running it under a partner they did not
   * choose would paint a list of that partner's other deals beneath it.
   */
  const onSelectLead = useCallback(
    async (lead: OdooOpportunity) => {
      selectionToken.current += 1;
      const token = selectionToken.current;
      // A lead-only target has no contact to retry a lookup for. Left set,
      // `onRetryOpportunities` would fetch the PREVIOUS contact's deals and
      // paint them under this lead.
      contactRef.current = null;
      setOpportunities(null);
      setOpportunityError(null);
      setIsLookingUp(false);
      await commit(
        { contactId: lead.partnerId, leadId: lead.id, leadName: lead.name },
        token
      );
    },
    [commit]
  );

  /**
   * NEVER REJECTS - the picker calls it from a debounce timer, where a
   * rejection is unhandled by construction.
   */
  const onSearchLeads = useCallback(
    async (query: string) => {
      searchToken.current += 1;
      const token = searchToken.current;
      const trimmed = query.trim();

      if (trimmed.length < LEAD_SEARCH_MIN_CHARS) {
        // Not an empty RESULT - no search at all. `null` is what the picker
        // renders as "nothing asked for yet"; [] would say "none found" for a
        // query nobody ran.
        setLeadResults(null);
        setLeadSearchError(null);
        setIsSearchingLeads(false);
        return;
      }

      setLeadSearchError(null);
      setIsSearchingLeads(true);
      try {
        const client = await getClient();
        const rows = await searchLeads(client, trimmed);
        if (token !== searchToken.current) return;
        setLeadResults(rows);
        setIsSearchingLeads(false);
      } catch (err) {
        if (token !== searchToken.current) return;
        setLeadSearchError(reportOdooError(err, "search leads").code);
        setIsSearchingLeads(false);
      }
    },
    [getClient]
  );

  /**
   * The contact comes from `contactRef.current`, falling back to the cache.
   * The fallback is not defensive: Task 11's `opportunities === null` branch
   * is reachable with NO prior onSelect - the normal state of a target
   * rehydrated after a <Completion /> remount, exactly when contactRef is
   * empty.
   */
  const onRetryOpportunities = useCallback(async () => {
    const contact =
      contactRef.current ??
      contactsOf(cacheRef.current).find((c) => c.id === targetRef.current?.contactId) ??
      null;
    // Mirrors onSelect's own guard: a colleague has no crm.lead lookup to
    // retry. Without this, ContactPicker's "Look up" button - which renders
    // whenever opportunities === null with no isColleague signal of its own -
    // is reachable for a colleague (onSelect leaves opportunities === null
    // for them, by design) and would fire the lookup this feature states
    // colleagues skip entirely.
    if (!contact || contact.isColleague) return;

    const token = selectionToken.current;
    setOpportunityError(null);
    setIsLookingUp(true);
    try {
      const client = await getClient();
      const rows = await fetchOpportunities(client, contact);
      if (token !== selectionToken.current) return;
      setOpportunities(rows);
      setIsLookingUp(false);
    } catch (err) {
      if (token !== selectionToken.current) return;
      const report = reportOdooError(err, "fetch opportunities");
      setOpportunityError(report.code);
      setIsLookingUp(false);
    }
  }, [getClient]);

  /**
   * Shared by `expandContact` and `retryOpportunitiesFor`.
   *
   * The generation guard is PER CONTACT (`rowGen`), not the single flow's
   * shared `selectionToken`: adding or removing a target elsewhere in the
   * list must not strand this row's own in-flight lookup. `epoch` is the
   * one thing that CAN still supersede it - an instance change invalidates
   * every row at once, on purpose (see `bumpEpoch`'s doc comment).
   */
  const runContactLookup = useCallback(
    async (contactId: number, contact: OdooContact) => {
      const myEpoch = epoch.current;
      const gen = (rowGen.current.get(contactId) ?? 0) + 1;
      rowGen.current.set(contactId, gen);
      try {
        const client = await getClient();
        const rows = await fetchOpportunities(client, contact);
        if (epoch.current !== myEpoch || rowGen.current.get(contactId) !== gen) return;
        setRowCache((prev) => new Map(prev).set(contactId, rows));
        setRowError((prev) => {
          if (!prev.has(contactId)) return prev;
          const next = new Map(prev);
          next.delete(contactId);
          return next;
        });
      } catch (err) {
        if (epoch.current !== myEpoch || rowGen.current.get(contactId) !== gen) return;
        const report = reportOdooError(err, "fetch opportunities");
        setRowError((prev) => {
          const next = new Map(prev);
          next.set(contactId, report.code);
          return next;
        });
      }
    },
    [getClient]
  );

  /**
   * Runs (or joins) a "Logging to" row's own deal lookup. Early-returns for a
   * colleague (no crm.lead lookup to run, same as the single flow), when a
   * fetch is already in flight for this contact (`rowGen` has an entry and
   * neither `rowCache` nor `rowError` has settled it yet), or when the cache
   * already holds a result - repeated expand/collapse must not re-fetch.
   *
   * A PREVIOUS FAILURE does not block a re-expand: only `rowCache` gates the
   * skip, so closing and reopening a failed row tries again on its own,
   * leaving `retryOpportunitiesFor` for the explicit Retry control on an
   * already-open row.
   */
  const expandContact = useCallback(
    async (contactId: number) => {
      const contact = contactsOf(cacheRef.current).find((c) => c.id === contactId);
      if (!contact || contact.isColleague) return;
      if (rowCacheRef.current.has(contactId)) return;
      const inFlight = rowGen.current.has(contactId) && !rowErrorRef.current.has(contactId);
      if (inFlight) return;
      await runContactLookup(contactId, contact);
    },
    [runContactLookup]
  );

  const retryOpportunitiesFor = useCallback(
    async (contactId: number) => {
      const contact = contactsOf(cacheRef.current).find((c) => c.id === contactId);
      if (!contact || contact.isColleague) return;
      await runContactLookup(contactId, contact);
    },
    [runContactLookup]
  );

  const opportunitiesFor = useCallback(
    (contactId: number) => rowCache.get(contactId) ?? null,
    [rowCache]
  );

  const errorFor = useCallback(
    (contactId: number) => rowError.get(contactId) ?? null,
    [rowError]
  );

  /**
   * The cap is enforced by `addSelectedTarget` (Task 4), by REJECTING - this
   * surfaces that rejection verbatim rather than re-implementing the count
   * itself, and writes `targets` only on success so a capped call leaves the
   * list exactly as it was.
   */
  const addTarget = useCallback(
    async (t: SelectedTarget): Promise<{ ok: boolean; reason?: "cap" }> => {
      const instance = await resolveInstance();
      const result = await addSelectedTarget(instance, t, null, Date.now());
      if (result.ok) {
        const current = targetsRef.current;
        const existingIndex = current.findIndex(
          (x) => x.model === t.model && x.resId === t.resId
        );
        applyTargets(
          existingIndex === -1
            ? [...current, t]
            : current.map((x, i) => (i === existingIndex ? t : x))
        );
      }
      return result;
    },
    [applyTargets, resolveInstance]
  );

  const removeTarget = useCallback(
    async (model: SelectedTarget["model"], resId: number): Promise<void> => {
      const instance = await resolveInstance();
      await removeSelectedTarget(instance, model, resId);
      applyTargets(targetsRef.current.filter((x) => !(x.model === model && x.resId === resId)));
    },
    [applyTargets, resolveInstance]
  );

  const onToggleColleague = useCallback(
    async (contact: OdooContact) => {
      const nextValue = !contact.isColleague;
      setCache((prev) =>
        prev.kind === "ready"
          ? {
              ...prev,
              contacts: prev.contacts.map((c) =>
                c.id === contact.id ? { ...c, isColleague: nextValue } : c
              ),
            }
          : prev
      );
      try {
        const instance = await resolveInstance();
        await setColleague(instance, contact.id, nextValue);
      } catch (err) {
        setCache((prev) =>
          prev.kind === "ready"
            ? {
                ...prev,
                contacts: prev.contacts.map((c) =>
                  c.id === contact.id ? { ...c, isColleague: contact.isColleague } : c
                ),
              }
            : prev
        );
        const report = reportOdooError(err, "toggle colleague");
        toast.error(`${report.code}: ${report.message}`);
      }
    },
    [resolveInstance]
  );

  const onRefresh = useCallback(async () => {
    const token = selectionToken.current;
    try {
      await runSync("refresh", meetingAssistModeRef.current);
      await reload(token);
    } catch (err) {
      await triageSyncFailure(err, token);
    }
  }, [reload, triageSyncFailure]);

  /**
   * The overlay never navigates. <Completion /> lives in the `main` window,
   * which tauri.conf.json defines as a 600x54 undecorated overlay; `/odoo`
   * renders inside DashboardLayout in the SEPARATE `dashboard` webview.
   */
  const onOpenSettings = useCallback(() => {
    void invoke("open_dashboard");
  }, []);

  // `target` state, not `targetRef` - the ref is mirrored in a useLayoutEffect
  // that runs AFTER this render, so reading it here would show the previous
  // selection's name for a render every time target actually changes.
  const contactName = contactsOf(cache).find((c) => c.id === target?.contactId)?.name ?? null;

  const pickerProps: ContactPickerProps = {
    contactId: target?.contactId ?? null,
    leadId: target?.leadId ?? null,
    leadName: target?.leadName ?? null,
    contactName,
    leadResults,
    leadSearchError,
    isSearchingLeads,
    onSelectLead,
    onSearchLeads,
    cache,
    opportunities,
    opportunityError,
    isLookingUp,
    onSelect,
    onSelectOpportunity,
    onToggleColleague,
    onRetryOpportunities,
    onRefresh,
    onOpenSettings,
    open: isPickerOpen,
    onOpenChange: setIsPickerOpen,
  };

  return {
    targetRef,
    pickerProps,
    targets,
    targetCount: targets.length,
    addTarget,
    removeTarget,
    expandContact,
    opportunitiesFor,
    errorFor,
    retryOpportunitiesFor,
  };
}
