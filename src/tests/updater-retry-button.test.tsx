import { beforeEach, describe, expect, it, vi } from "vitest";
import { act, fireEvent, render, screen } from "@testing-library/react";

type Status =
  | { kind: "idle" }
  | { kind: "install-failed"; version: string };

const h = vi.hoisted(() => ({
  linux: false,
  status: { kind: "idle" } as Status,
  subscribers: new Set<() => void>(),
  retryInstall: vi.fn(),
  check: vi.fn(),
}));

vi.mock("@/lib/platform", () => ({ isLinux: () => h.linux }));
vi.mock("@/lib/updater/silent-updater", () => ({
  getSilentUpdaterStatus: () => h.status,
  subscribeSilentUpdater: (cb: () => void) => {
    h.subscribers.add(cb);
    return () => h.subscribers.delete(cb);
  },
  retryInstall: h.retryInstall,
}));
vi.mock("@tauri-apps/plugin-updater", () => ({ check: h.check }));
vi.mock("@tauri-apps/plugin-process", () => ({ relaunch: vi.fn() }));
// Thin barrel stubs: the real ones pull in every hook and component.
vi.mock("@/hooks", () => ({
  useWindowResize: () => ({ resizeWindow: () => {} }),
}));
vi.mock("@/components", () => {
  const Pass = ({ children }: { children?: any }) => (
    <div>{children}</div>
  );
  return {
    Button: ({ children, size: _size, variant: _variant, ...rest }: any) => (
      <button {...rest}>{children}</button>
    ),
    Popover: Pass,
    PopoverTrigger: Pass,
    PopoverContent: Pass,
    ScrollArea: Pass,
    Markdown: Pass,
  };
});

import { Updater } from "@/components/updater";

const RETRY_LABEL = /failed - retry/;

beforeEach(() => {
  h.linux = false;
  h.status = { kind: "idle" };
  h.subscribers.clear();
  h.retryInstall.mockReset();
  h.check.mockReset();
});

describe("Updater", () => {
  it("renders nothing while idle", () => {
    const { container } = render(<Updater />);

    expect(container).toBeEmptyDOMElement();
    expect(h.check).not.toHaveBeenCalled();
  });

  it("shows a retry button after an install failure and retries on click", () => {
    const { container } = render(<Updater />);
    expect(container).toBeEmptyDOMElement();

    act(() => {
      h.status = { kind: "install-failed", version: "1.6.0" };
      h.subscribers.forEach((cb) => cb());
    });

    const button = screen.getByRole("button", {
      name: "Update to 1.6.0 failed - retry",
    });
    expect(button).toHaveAttribute("title", "Update to 1.6.0 failed - retry");

    fireEvent.click(button);

    expect(h.retryInstall).toHaveBeenCalledTimes(1);
    expect(h.check).not.toHaveBeenCalled();
  });

  it("on Linux renders the legacy updater and never the retry button", async () => {
    h.linux = true;
    h.status = { kind: "install-failed", version: "1.6.0" };
    h.check.mockResolvedValue({ version: "1.6.1", body: "" });

    render(<Updater />);

    expect(
      await screen.findByRole("button", { name: "Update available: 1.6.1" })
    ).toBeInTheDocument();
    expect(h.check).toHaveBeenCalledTimes(1);
    expect(screen.queryByRole("button", { name: RETRY_LABEL })).toBeNull();
    expect(h.subscribers.size).toBe(0);
  });
});
