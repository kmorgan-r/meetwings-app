import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import {
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { useState } from "react";
import { ContactPicker } from "@/pages/app/components/completion/ContactPicker";
import { MinimizedPill } from "@/pages/app/components/MinimizedPill";

// jsdom lacks the PointerEvent / pointer-capture machinery Radix's
// DismissableLayer needs to process outside-pointerdown dismissals at all.
// Without these, every dismissal test below passes vacuously.
beforeAll(() => {
  if (!window.PointerEvent) {
    window.PointerEvent = class PointerEvent extends MouseEvent {
      public pointerId: number;
      constructor(type: string, params: PointerEventInit = {}) {
        super(type, params);
        this.pointerId = params.pointerId ?? 0;
      }
    } as unknown as typeof PointerEvent;
  }
  if (!Element.prototype.hasPointerCapture) {
    Element.prototype.hasPointerCapture = () => false;
  }
  if (!Element.prototype.setPointerCapture) {
    Element.prototype.setPointerCapture = () => {};
  }
  if (!Element.prototype.releasePointerCapture) {
    Element.prototype.releasePointerCapture = () => {};
  }
});

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn(async () => {}) }));
vi.mock("@tauri-apps/api/event", () => ({
  listen: vi.fn(async () => () => {}),
}));
vi.mock("@tauri-apps/api/window", () => ({
  getCurrentWindow: () => ({ label: "main" }),
}));
vi.mock("sonner", () => ({
  toast: { error: vi.fn(), success: vi.fn(), info: vi.fn(), warning: vi.fn() },
}));
vi.mock("@/hooks/useWindow", () => ({
  resizeWindow: vi.fn(async () => {}),
  isAnyPopoverOpen: () => false,
}));
vi.mock("@/lib/database/odoo-contacts.action", () => ({
  listContacts: vi.fn(async () => []),
  getSyncState: vi.fn(async () => null),
  setColleague: vi.fn(async () => {}),
  stampLastMeeting: vi.fn(async () => {}),
  loadTargets: vi.fn(async () => []),
  addSelectedTarget: vi.fn(async () => ({ ok: true })),
  removeSelectedTarget: vi.fn(async () => {}),
  clearTargets: vi.fn(async () => {}),
  purgeOtherInstances: vi.fn(async () => {}),
}));
// The pure helpers stay REAL (compareContacts/filterContacts/kindLabel and
// the MAX_TARGETS constant are value-imported by ContactPicker and
// dereferenced during render — `filterContacts` throws if missing), so this
// spread MUST be the FULL @/lib/odoo barrel via importOriginal — NOT the
// entry-points pattern's spread of `@/lib/odoo/errors` only, which lacks all
// four names (MAX_TARGETS reaches the barrel via a re-export from
// @/lib/odoo/meeting-log). Only the network/instance surface is stubbed.
vi.mock("@/lib/odoo", async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  return {
    ...actual,
    runSync: vi.fn(async () => ({
      ran: true,
      changed: 0,
      fetched: 0,
      skipped: 0,
      clampSkipped: false,
    })),
    currentInstance: vi.fn(async () => "http://h:8069|odoo"),
    createOdooClient: vi.fn(() => ({
      authenticate: vi.fn(),
      execute: vi.fn(),
      serverDate: null,
    })),
    fetchOpportunities: vi.fn(async () => []),
  };
});
vi.mock("@/lib/storage/odoo-config.storage", () => ({
  loadOdooConfig: vi.fn(async () => ({
    url: "http://h:8069",
    db: "odoo",
    login: "b",
    apiKey: "k",
  })),
  instanceFingerprint: vi.fn(() => "http://h:8069|odoo"),
}));
vi.mock("@/pages/app/components/completion/CalendarProposal", () => ({
  CalendarProposal: () => null,
}));

const onOpenChange = vi.fn();

// Radix's DismissableLayer registers its document-level `pointerdown`
// listener inside `window.setTimeout(0)` (react-dismissable-layer/dist/
// index.mjs), so a pointerdown dispatched synchronously after render is
// fired before the listener exists and is silently dropped. Flush a tick
// after render, before dispatching, so the dismissal machinery is armed.
const flushDismissalListeners = () =>
  new Promise((resolve) => setTimeout(resolve, 20));

// The picker with one target, plus BOTH minimize-control surfaces. The
// Minimize BUTTON is a test-local stand-in — the real one lives inline in
// the overlay bar and this scaffold cannot mount app/index.tsx; the real
// button's attribute wiring is enforced by Task 4's attribute assertion.
// The PILL is the real component: its root carrying the marker is the
// restore-click regression, and rendering the real pill is what makes it
// an enforced assertion rather than a mirror of the stand-in.
const Harness = () => {
  const [open, setOpen] = useState(true);
  return (
    <>
      <div data-testid="plain-outside">outside</div>
      <button data-overlay-minimize-control="true" data-testid="minimize-standin">
        min
      </button>
      <ContactPicker
        contactId={null}
        leadId={null}
        leadName={null}
        contactName={null}
        cache={{ kind: "never-synced" } as never}
        opportunities={null}
        opportunityError={null}
        isLookingUp={false}
        onSelect={vi.fn(async () => {})}
        onSelectOpportunity={vi.fn(async () => {})}
        onToggleColleague={vi.fn(async () => {})}
        onRetryOpportunities={vi.fn(async () => {})}
        onRefresh={vi.fn(async () => {})}
        onOpenSettings={vi.fn()}
        onSearchLeads={vi.fn(async () => {})}
        targets={[{ model: "res.partner" as const, resId: 1, name: "A" }]}
        onAddTarget={vi.fn(async () => {})}
        onCreateContact={vi.fn(async () => ({ ok: true } as never))}
        onRemoveTarget={vi.fn(async () => {})}
        onClearTargets={vi.fn(async () => {})}
        onExpandContact={vi.fn(async () => {})}
        opportunitiesFor={vi.fn(() => null)}
        errorFor={vi.fn(() => null)}
        onRetryContactOpportunities={vi.fn(async () => {})}
        open={open}
        onOpenChange={onOpenChange}
      />
      <MinimizedPill style="status-count" />
    </>
  );
};

beforeEach(() => {
  onOpenChange.mockClear();
});

describe("the minimize controls do not dismiss an open ContactPicker (issue #72)", () => {
  it("SANITY: the dismissal machinery fires at all — a plain outside pointerdown closes the picker", async () => {
    render(<Harness />);
    expect(screen.getByTestId("logging-to-section")).toBeTruthy();
    await flushDismissalListeners();
    fireEvent.pointerDown(screen.getByTestId("plain-outside"));
    await waitFor(() => expect(onOpenChange).toHaveBeenCalledWith(false));
  });

  it("a pointerdown on the Minimize control keeps the picker open", async () => {
    render(<Harness />);
    await flushDismissalListeners();
    fireEvent.pointerDown(screen.getByTestId("minimize-standin"));
    // Radix fires onOpenChange(true) when the popover first opens — assert
    // it was never called with FALSE.
    expect(onOpenChange).not.toHaveBeenCalledWith(false);
  });

  it("a pointerdown on the restored pill keeps the picker open", async () => {
    const { container } = render(<Harness />);
    // The pill is a SIBLING of the picker; its root carries the marker.
    const pillRoot = container.querySelector(
      'div[data-overlay-minimize-control="true"]'
    );
    expect(pillRoot).toBeTruthy(); // the REAL MinimizedPill root is marked
    await flushDismissalListeners();
    fireEvent.pointerDown(pillRoot as HTMLElement);
    expect(onOpenChange).not.toHaveBeenCalledWith(false);
  });

  // The focus half of the guard: a real click on the Minimize button also
  // MOVES focus, and Radix treats that as a separate dismissal — the
  // `onFocusOutside` guard in ContactPicker.tsx runs against a document-level
  // `focusin` listener (react-dismissable-layer's useFocusOutside), which the
  // pointerdown pair above never reaches because fireEvent.pointerDown does
  // not move focus.
  //
  // A bare synthetic focusin is NOT enough: Radix's isFocusInsideReactTreeRef
  // is armed by the layer's focus capture (PopoverContent's mount auto-focus
  // leaves focus on an element INSIDE the popover), and only the layer's
  // onBlurCapture disarms it. A synthetic focusin moves no focus, so no blur
  // fires and Radix would silently skip the dismissal. A real focus move
  // emits focusout from the previously-focused element before focusin on the
  // new one — so each case below emits that same pair.
  it("SANITY: the focus dismissal machinery fires at all — a plain outside focus move closes the picker", async () => {
    render(<Harness />);
    await flushDismissalListeners();
    fireEvent.focusOut(document.activeElement as HTMLElement);
    fireEvent.focusIn(screen.getByTestId("plain-outside"));
    await waitFor(() => expect(onOpenChange).toHaveBeenCalledWith(false));
  });

  it("a focusin on the Minimize control keeps the picker open", async () => {
    render(<Harness />);
    await flushDismissalListeners();
    fireEvent.focusOut(document.activeElement as HTMLElement);
    fireEvent.focusIn(screen.getByTestId("minimize-standin"));
    // Radix fires onOpenChange(true) when the popover first opens — assert
    // it was never called with FALSE.
    expect(onOpenChange).not.toHaveBeenCalledWith(false);
  });

  it("the real MinimizedPill root carries the marker attribute", () => {
    const { container } = render(<MinimizedPill style="status-count" />);
    expect(
      container.querySelector('div[data-overlay-minimize-control="true"]')
    ).toBeTruthy();
  });
});