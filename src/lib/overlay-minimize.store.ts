import type { OverlayPillStyle } from "@/lib/storage";

/**
 * Logical (CSS-px) window dimensions for each minimized pill style. These
 * feed the `minimize_overlay` invoke — Rust converts them to physical pixels
 * through the window's scale factor. From the spec's styles table; do not
 * change one without the other.
 */
export const PILL_DIMENSIONS: Record<
  OverlayPillStyle,
  { width: number; height: number }
> = {
  "status-count": { width: 148, height: 40 },
  "icon-only": { width: 52, height: 52 },
  "status-last-line": { width: 320, height: 48 },
};

/**
 * The three scalars the minimized pill displays. Written ONLY by
 * <Completion /> (see the spec's "Pill data source"); read by MinimizedPill
 * through useSyncExternalStore.
 */
export interface OverlayPillData {
  segmentCount: number;
  lastLine: string;
  status: "capturing" | "error" | "idle";
}

let minimized = false;
const minimizedListeners = new Set<() => void>();

export const getMinimized = (): boolean => minimized;

/**
 * Module-level on purpose: the MutationObserver callback in useWindow.ts has
 * no render scope and cannot read a hook or context. setMinimized also owns
 * the `data-overlay-minimized` body attribute, which global.css uses to hide
 * Radix's portaled popovers while minimized (they portal to document.body,
 * outside every React wrapper). attributeFilter there is ["data-state"], so
 * writing this attribute does not retrigger the observer.
 */
export const setMinimized = (value: boolean): void => {
  if (minimized === value) return;
  minimized = value;
  if (value) {
    document.body.setAttribute("data-overlay-minimized", "true");
  } else {
    document.body.removeAttribute("data-overlay-minimized");
  }
  minimizedListeners.forEach((listener) => listener());
};

export const subscribeToMinimized = (listener: () => void): (() => void) => {
  minimizedListeners.add(listener);
  return () => {
    minimizedListeners.delete(listener);
  };
};

const INITIAL_PILL_DATA: OverlayPillData = {
  segmentCount: 0,
  lastLine: "",
  status: "idle",
};

let pillData: OverlayPillData = INITIAL_PILL_DATA;
const pillDataListeners = new Set<() => void>();

/**
 * MUST return the stored reference, not a fresh object: useSyncExternalStore
 * compares snapshots with Object.is, and a getter that assembles per call
 * never compares equal, looping React 19's snapshot check. The reference is
 * replaced only by setPillData.
 */
export const getPillData = (): OverlayPillData => pillData;

export const setPillData = (data: OverlayPillData): void => {
  pillData = data;
  pillDataListeners.forEach((listener) => listener());
};

export const subscribeToPillData = (listener: () => void): (() => void) => {
  pillDataListeners.add(listener);
  return () => {
    pillDataListeners.delete(listener);
  };
};