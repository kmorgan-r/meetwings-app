import { beforeEach, describe, expect, it, vi } from "vitest";

const h = vi.hoisted(() => ({
  label: "main",
  calls: [] as string[],
  rootOptions: [] as Array<{ onCaughtError?: unknown } | undefined>,
  reportCaughtError: vi.fn(),
}));

vi.mock("@tauri-apps/api/window", () => ({
  getCurrentWindow: () => ({ label: h.label }),
}));
vi.mock("react-dom/client", () => ({
  default: {
    createRoot: (_el: unknown, options?: { onCaughtError?: unknown }) => {
      h.rootOptions.push(options);
      h.calls.push("createRoot");
      return { render: () => h.calls.push("render") };
    },
  },
}));
vi.mock("@/lib/updater/main-window-updater", () => ({
  startMainWindowUpdater: () => {
    h.calls.push("startMainWindowUpdater");
    return () => {};
  },
}));
vi.mock("@/lib/report-caught-error", () => ({ reportCaughtError: h.reportCaughtError }));
vi.mock("@/components/Overlay", () => ({ default: () => null }));
vi.mock("@/contexts", () => ({ AppProvider: () => null, ThemeProvider: () => null }));
vi.mock("@/components", () => ({ Toaster: () => null }));
vi.mock("@/routes", () => ({ default: () => null }));

const boot = async (label: string) => {
  h.label = label;
  vi.resetModules();
  await import("@/main");
};

beforeEach(() => {
  h.calls.length = 0;
  h.rootOptions.length = 0;
});

// The updater runs outside the React root, so a render crash anywhere in the
// tree (nothing above App catches) can neither stop nor prevent it.
describe("main.tsx entry", () => {
  it("starts the main-window updater before creating the React root", async () => {
    await boot("main");
    expect(h.calls).toEqual(["startMainWindowUpdater", "createRoot", "render"]);
  });

  it("does not start it in other windows", async () => {
    await boot("dashboard");
    await boot("capture-overlay-0");
    expect(h.calls).not.toContain("startMainWindowUpdater");
  });

  it.each(["main", "dashboard"])("passes reportCaughtError as onCaughtError in %s", async (label) => {
    await boot(label);
    expect(h.rootOptions[0]?.onCaughtError).toBe(h.reportCaughtError);
  });

  it("does not pass onCaughtError in overlay windows", async () => {
    await boot("capture-overlay-0");
    expect(h.rootOptions[0]?.onCaughtError).toBeUndefined();
  });
});
