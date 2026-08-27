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
  clearTarget,
  getSyncState,
  listContacts,
  loadTarget,
  saveTarget,
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
} from "@/lib/odoo";
import { loadOdooConfig } from "@/lib/storage/odoo-config.storage";
import type { OdooContact, OdooOpportunity, ResolvedTarget } from "@/types";
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

  const instanceRef = useRef<string | null>(null);
  const selectionToken = useRef(0);
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

  // Read from onRetryOpportunities' fallback, which is called from an
  // event handler rather than during render - mirrored so that callback can
  // stay referentially stable ([] of its own genuinely-changing deps) instead
  // of taking `cache` itself as a dep and losing its identity on every reload.
  const cacheRef = useRef(cache);
  useLayoutEffect(() => {
    cacheRef.current = cache;
  });

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
   * `token !== selectionToken.current` is re-checked on BOTH the entry and the
   * rejection path. Re-checking only on entry lets a stale commit's rollback
   * overwrite a NEWER selection that persisted fine: pick Ada (token 1, slow
   * write), pick Bea (token 2, writes, row = Bea), then Ada's write rejects and
   * rolls state back to null while SQLite still holds Bea. A superseded commit
   * must fail SILENTLY - no setTarget, no toast.
   */
  const commit = useCallback(
    async (next: ResolvedTarget | null, token: number) => {
      if (token !== selectionToken.current) return;
      const previous = targetRef.current;
      setTarget(next);
      try {
        if (next) {
          const instance = await resolveInstance();
          await saveTarget(
            { instance, contactId: next.contactId, leadId: next.leadId, conversationId: null },
            Date.now()
          );
        } else {
          await clearTarget();
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
      } catch (err) {
        const report = reportOdooError(err, "load contacts");
        toast.error(`${report.code}: ${report.message}`);
      }
    },
    [commit, resolveInstance]
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
        const persisted = await loadTarget(instance);
        if (token === selectionToken.current && persisted) {
          setTarget(persisted);
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

    try {
      const instance = await resolveInstance();
      await runSync("refresh", meetingAssistModeRef.current);
      const persisted = await loadTarget(instance);
      if (token === selectionToken.current && persisted) {
        setTarget(persisted);
      }
      await reload(token);
    } catch (err) {
      await triageSyncFailure(err, token);
    }
  }, [reload, resolveInstance, triageSyncFailure]);

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
  const handleNewChat = useCallback(() => {
    selectionToken.current += 1;
    void commit(null, selectionToken.current);
  }, [commit]);

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

      await commit({ contactId: contact.id, leadId: null }, token);

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
      await commit({ contactId: current.contactId, leadId }, selectionToken.current);
    },
    [commit]
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
    contactName,
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

  return { targetRef, pickerProps };
}
