import { useEffect, useMemo, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { emit, listen } from "@tauri-apps/api/event";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { toast } from "sonner";
import { safeLocalStorage } from "@/lib";
import { isWindows } from "@/lib/platform";
import {
  MEETING_DETECT_FALLBACK_LABEL,
  MEETING_DETECT_LABELS,
  MEETING_DETECT_PROCESSES,
  STOP_TIMED_OUT,
  STORAGE_KEYS,
} from "@/config/constants";

const label = (process?: string) =>
  (process && MEETING_DETECT_LABELS[process.toLowerCase()]) ||
  MEETING_DETECT_FALLBACK_LABEL;

const readSetting = () =>
  safeLocalStorage.getItem(STORAGE_KEYS.MEETING_DETECTION_ENABLED) === "true";

/**
 * Owns the Teams call detection watcher and its toasts.
 *
 * Single-owner: the whole React tree mounts in both the `main` and `dashboard`
 * windows and Tauri events broadcast to all of them, so only the main window may
 * drive the watcher. Mount it once, in the app page.
 *
 * This hook must never touch capture state - notification only.
 */
export const useMeetingDetection = () => {
  const isOwner = useMemo(
    () => getCurrentWindow().label === "main" && isWindows(),
    []
  );

  const [enabled, setEnabled] = useState(readSetting);

  // Read inside listener callbacks that are registered once for the window's
  // lifetime, where a state value would be captured at mount and never refresh.
  // Synced in an effect rather than assigned during render: eslint.config.js
  // enables react-hooks/refs, and the retry handler always reads it from a Tauri
  // event callback, i.e. after commit.
  const enabledRef = useRef(enabled);
  useEffect(() => {
    enabledRef.current = enabled;
  }, [enabled]);

  // Serializes every watcher command. Held in a ref so it survives a StrictMode
  // remount; an effect-local chain would serialize nothing.
  //
  // LOAD-BEARING BEYOND THIS FILE. Two races in the Rust watcher are documented
  // as accepted rather than fixed - the start-path orphan window
  // (meeting_detect/mod.rs, at the `running.store(true)` before the spawn) and
  // the ReapCorpse TOCTOU (same file, in `stop_meeting_watcher`). Both need two
  // OVERLAPPING watcher commands, and both are unreachable only because this
  // chain guarantees there is never more than one in flight. Relaxing the
  // serialization here makes them live bugs, and nothing in Rust - no compiler
  // check, no test - will catch it. Fix them there first.
  const chainRef = useRef<Promise<unknown>>(Promise.resolve());

  // Resolves once the four detection listeners are actually registered. listen()
  // is async, so without this gate the first start_meeting_watcher reliably wins
  // the race and an immediate-failure meeting-watcher-stopped fires into a void.
  // `useRef<T>()` with no argument does not type-check: @types/react 19 removed
  // the zero-argument overload, and tsconfig has strict: true.
  const listenersReadyRef = useRef<{
    promise: Promise<void>;
    resolve: () => void;
  } | null>(null);

  /** (Re-)arm the gate. Called synchronously at the top of effect 2's body. */
  const armListenersGate = () => {
    let resolve!: () => void;
    const promise = new Promise<void>((r) => {
      resolve = r;
    });
    listenersReadyRef.current = { promise, resolve };
  };
  if (!listenersReadyRef.current) armListenersGate();

  const enqueue = (op: () => Promise<unknown>) => {
    // Each link ends in its own catch, or the first rejection leaves the ref
    // holding a rejected promise and every later command is silently skipped.
    chainRef.current = chainRef.current.then(op).catch((error) => {
      console.error("Meeting detection command failed:", error);
    });
    return chainRef.current;
  };

  const startWatcher = () =>
    invoke("start_meeting_watcher", { processes: MEETING_DETECT_PROCESSES });

  // Effect 1: the setting and retry channels. Mount-only - putting the setting
  // listener in the [enabled] effect means the first toggle-on is never received,
  // because the setting defaults to false and the effect body returns early.
  useEffect(() => {
    if (!isOwner) return;
    let cancelled = false;
    const unlisteners: Array<() => void> = [];

    const register = async (
      event: string,
      handler: (payload: any) => void
    ) => {
      const un = await listen(event, (e) => handler(e.payload));
      if (cancelled) un();
      else unlisteners.push(un);
    };

    Promise.all([
      register("meeting-detection-setting-changed", (payload) => {
        setEnabled(Boolean(payload?.enabled));
      }),

      register("meeting-detection-retry-requested", () => {
        if (!enabledRef.current) {
          emit("meeting-detection-watcher-restarted", { ok: false }).catch(
            (error) => console.error("Failed to reply to retry:", error)
          );
          return;
        }
        enqueue(async () => {
          // Every exit path must reply. Retry is pressed precisely when the
          // watcher is unhealthy, so a start that rejects with
          // "watcher is still stopping, retry" is the expected case - swallowing
          // it into the chain's catch would make the button a silent no-op that
          // never clears or updates the note.
          try {
            await invoke("stop_meeting_watcher");
            await startWatcher();
            await emit("meeting-detection-watcher-restarted", { ok: true });
          } catch (error) {
            await emit("meeting-detection-watcher-restarted", {
              ok: false,
              error: String(error),
            });
          }
        });
      }),
    ]).catch((error) =>
      console.error("Failed to subscribe to meeting detection controls:", error)
    );

    return () => {
      cancelled = true;
      unlisteners.forEach((un) => un());
    };
  }, [isOwner]);

  // Effect 2: the four detection events. Keyed on isOwner, NOT enabled - they
  // must be in place before any start, and the retry path can start a watcher
  // without `enabled` changing. Subscribing with no watcher running is harmless.
  useEffect(() => {
    if (!isOwner) return;
    let cancelled = false;
    const unlisteners: Array<() => void> = [];

    // Re-arm synchronously, before any await. Under StrictMode the first run's
    // registrations are all cancelled and unlistened, yet its `finally` still
    // fires - so a gate armed once per hook instance would already be open when
    // the second mount's start runs, defeating the ordering it exists to enforce.
    armListenersGate();
    const gate = listenersReadyRef.current!;

    const register = async (
      event: string,
      handler: (payload: any) => void
    ) => {
      const un = await listen(event, (e) => handler(e.payload));
      if (cancelled) un();
      else unlisteners.push(un);
    };

    Promise.all([
      register("meeting-detected", (payload) => {
        toast.info(`${label(payload?.process)} call detected`);
      }),

      register("meeting-ended", (payload) => {
        toast.info(`${label(payload?.process)} call ended`);
      }),

      register("meeting-watcher-error", (payload) => {
        // Log only - the settings card owns the user-facing note.
        console.warn("Meeting detection error:", payload?.message);
      }),

      register("meeting-watcher-stopped", (payload) => {
        // The persisted setting deliberately stays on: it is what keeps the
        // settings note and its retry button reachable. The "never persist on with
        // no watcher" rule is scoped to a start that never succeeded.
        console.warn("Meeting detection stopped:", payload?.reason);
        toast.info("Meeting detection stopped");
      }),
    ])
      .catch((error) =>
        console.error("Failed to subscribe to meeting detection events:", error)
      )
      // Resolves THIS run's gate (not whatever is currently in the ref), and
      // does so whether or not every subscription succeeded, so a listen()
      // failure can never wedge the watcher lifecycle permanently.
      .finally(() => gate.resolve());

    return () => {
      cancelled = true;
      unlisteners.forEach((un) => un());
    };
  }, [isOwner]);

  // Effect 3: watcher lifecycle only. The stop lives solely in the cleanup - an
  // else branch in the body would fire a spurious stop on every mount with the
  // feature off and double-stop on disable.
  useEffect(() => {
    if (!isOwner || !enabled) return;

    // Mirrors the cancelled-flag discipline in effects 1 and 2. Under StrictMode
    // the mount -> cleanup -> mount cycle enqueues start1 -> stop1 -> start2 onto
    // chainRef; without this guard, start1 awaits the listeners gate (re-armed by
    // the second mount's effect 2) and then fires start_meeting_watcher a SECOND
    // time after stop1, so the assertion in F8 (starts <= 1) fails against an
    // otherwise-correct hook. The cleanup sets this before enqueuing its stop, so
    // an in-flight start from this same run short-circuits instead of double-firing.
    let cancelled = false;

    enqueue(async () => {
      // Listeners first, always - see listenersReadyRef.
      await listenersReadyRef.current!.promise;
      if (cancelled) return;
      try {
        await startWatcher();
      } catch (error) {
        safeLocalStorage.setItem(STORAGE_KEYS.MEETING_DETECTION_ENABLED, "false");
        setEnabled(false);
        await emit("meeting-detection-setting-changed", { enabled: false });
        toast.error("Could not start meeting detection");
        throw error;
      }
      await emit("meeting-detection-watcher-restarted", { ok: true });
    });

    return () => {
      cancelled = true;
      enqueue(async () => {
        // A stop that REJECTS is treated exactly like one that resolves
        // TIMED_OUT. Branching only on the resolved value would let a rejection
        // escape to the chain's catch, skipping the retry, the status query and
        // the report - leaving a live poll thread emitting detection toasts for
        // a feature the user just turned off, with no signal anywhere.
        const stopOnce = async () => {
          try {
            return await invoke<string>("stop_meeting_watcher");
          } catch (error) {
            console.error("stop_meeting_watcher rejected:", error);
            return STOP_TIMED_OUT;
          }
        };

        if ((await stopOnce()) !== STOP_TIMED_OUT) return;
        if ((await stopOnce()) !== STOP_TIMED_OUT) return;

        let running = true;
        try {
          const status = await invoke<{ running: boolean }>(
            "get_meeting_watcher_status"
          );
          running = Boolean(status?.running);
        } catch (error) {
          console.error("get_meeting_watcher_status rejected:", error);
        }

        if (running) {
          await emit("meeting-detection-watcher-restarted", {
            ok: false,
            error: "the watcher did not stop",
          });
        }
      });
    };
  }, [enabled, isOwner]);
};
