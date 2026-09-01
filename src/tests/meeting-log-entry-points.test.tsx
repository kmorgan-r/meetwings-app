import { render, screen } from "@testing-library/react";
import { renderHook } from "@testing-library/react";
import { Outlet } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Review finding: a repo-wide grep across src/tests/** found no reference to
// the /meeting-log route, the "Meeting log" menu item, or the "Open the
// meeting log" link on /odoo - deleting any one of the three left the full
// suite green while making 4,875 lines of feature unreachable from the UI.
// The link is covered separately, alongside its sibling count fixtures, in
// src/tests/odoo-settings-page.test.tsx ("the queue status block"). This file
// covers the other two: the route itself, and the menu entry's shared gate.
//
// No suite in this repo already exercised routes/index.tsx or useMenuItems -
// this file is new.

// ---------------------------------------------------------------------------
// (a) the /meeting-log route resolves to the page.
//
// Every page @/pages exports is stubbed - routes/index.tsx builds every
// <Route element={...}> eagerly (React.createElement runs for all of them,
// not just the one that matches), so an undefined stub for an UNVISITED page
// would still crash the render. DashboardLayout is stubbed to a bare
// <Outlet /> so this stays a routing-table test, not a Sidebar/useApp test -
// the same "harness, not full render" call the repo already makes in
// src/tests/odoo-target-new-chat-entry-points.test.tsx.
// ---------------------------------------------------------------------------

vi.mock("@/pages", () => {
  const stub = (name: string) => () => <div data-testid={`stub-${name}`}>{name}</div>;
  return {
    Dashboard: stub("dashboard"),
    App: stub("app"),
    SystemPrompts: stub("system-prompts"),
    ViewChat: stub("view-chat"),
    Settings: stub("settings"),
    DevSpace: stub("dev-space"),
    Shortcuts: stub("shortcuts"),
    Audio: stub("audio"),
    Screenshot: stub("screenshot"),
    Responses: stub("responses"),
    CostTracking: stub("cost-tracking"),
    ContextMemory: stub("context-memory"),
    Speakers: stub("speakers"),
    Language: stub("language"),
    Odoo: stub("odoo"),
    Meetings: stub("meetings"),
  };
});

vi.mock("@/layouts", () => ({
  DashboardLayout: () => <Outlet />,
}));

import AppRoutes from "@/routes";

afterEach(() => {
  window.history.pushState({}, "", "/");
});

describe("the meetings route", () => {
  it("resolves /meetings to the Meetings page", () => {
    window.history.pushState({}, "", "/meetings");
    render(<AppRoutes />);
    expect(screen.getByTestId("stub-meetings")).toBeInTheDocument();
  });

  it("still lands the old /meeting-log entry point on it", () => {
    // The queue page merged into /meetings; the old path redirects rather than
    // 404-ing, because the menu entry and the /odoo link both still point here
    // until they are moved.
    window.history.pushState({}, "", "/meeting-log");
    render(<AppRoutes />);
    expect(screen.getByTestId("stub-meetings")).toBeInTheDocument();
  });
});

// ---------------------------------------------------------------------------
// (b) the "Meeting log" menu item exists and shares the Odoo entry's gate.
//
// Pinning the item's mere presence would pass a mutant that disables it under
// a DIFFERENT condition, or never disables it at all. What actually matters
// is that it uses the SAME gateOnSetup as the Odoo entry beside it - so this
// asserts both states (gate on, gate off) AND that the two items agree in
// each state, not just their own hard-coded value.
// ---------------------------------------------------------------------------

const setupStatus = vi.hoisted(() => ({ isComplete: true, isLoading: false }));
vi.mock("@/hooks/useSetupStatus", () => ({
  useSetupStatus: () => setupStatus,
}));
vi.mock("@/contexts", () => ({
  useApp: () => ({ hasActiveLicense: false }),
}));

import { useMenuItems } from "@/hooks/useMenuItems";

interface MenuItem {
  label: string;
  href: string;
  disabled?: boolean;
}

function findItem(menu: MenuItem[], label: string): MenuItem {
  const item = menu.find((m) => m.label === label);
  if (!item) throw new Error(`menu item not found: ${label}`);
  return item;
}

beforeEach(() => {
  setupStatus.isComplete = true;
  setupStatus.isLoading = false;
});

describe("the Meetings menu entry", () => {
  it("is present, points at /meetings, and shares the Odoo entry's setup gate", () => {
    const { result, rerender } = renderHook(() => useMenuItems());

    const meetingsOpen = findItem(result.current.menu, "Meetings");
    const odooOpen = findItem(result.current.menu, "Odoo");
    expect(meetingsOpen.href).toBe("/meetings");
    // Gate OFF: setup is complete. Both entries enabled, and agreeing.
    expect(meetingsOpen.disabled).toBe(false);
    expect(meetingsOpen.disabled).toBe(odooOpen.disabled);

    setupStatus.isComplete = false;
    rerender();

    const meetingsGated = findItem(result.current.menu, "Meetings");
    const odooGated = findItem(result.current.menu, "Odoo");
    // Gate ON: setup incomplete. Both entries disabled, and STILL agreeing -
    // this is what proves it is the SHARED gate, not two independent ones
    // that happen to start out matching.
    expect(meetingsGated.disabled).toBe(true);
    expect(meetingsGated.disabled).toBe(odooGated.disabled);
  });

  // The merge's whole point: two entry points collapse into one. A regression
  // that brings back "Chats" or "Meeting log" as a second item would pass
  // every assertion above (both still find "Meetings"), so this checks the
  // menu has exactly one meetings-shaped entry, not zero-or-two.
  it("collapses the old Meeting log and Chats entries into the one Meetings entry", () => {
    const { result } = renderHook(() => useMenuItems());

    expect(result.current.menu.filter((item) => item.href === "/meetings")).toHaveLength(1);
    expect(result.current.menu.find((item) => item.label === "Meeting log")).toBeUndefined();
    expect(result.current.menu.find((item) => item.label === "Chats")).toBeUndefined();
  });
});
