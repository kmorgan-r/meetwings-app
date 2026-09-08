import { beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";

const toggleContentProtection = vi.fn(async () => {});

// The toggle is a thin view over the app context: it reads
// customizable.contentProtection.isEnabled and forwards switch flips to
// toggleContentProtection. Everything else belongs to the context/storage.
let customizableState = { contentProtection: { isEnabled: true } };
vi.mock("@/contexts", () => ({
  useApp: () => ({
    customizable: customizableState,
    toggleContentProtection,
  }),
}));

import { ContentProtectionToggle } from "@/pages/settings/components/ContentProtectionToggle";

// <Header> calls useNavigate() unconditionally, so the toggle needs a Router.
const renderToggle = () =>
  render(
    <MemoryRouter>
      <ContentProtectionToggle />
    </MemoryRouter>
  );

beforeEach(() => {
  vi.clearAllMocks();
  customizableState = { contentProtection: { isEnabled: true } };
});

describe("ContentProtectionToggle", () => {
  it("renders the switch reflecting the stored state", () => {
    renderToggle();

    expect(
      screen.getByLabelText(/screen capture protection/i)
    ).toBeChecked();

    customizableState = { contentProtection: { isEnabled: false } };
    renderToggle();
    expect(
      screen.getAllByLabelText(/screen capture protection/i)[1]
    ).not.toBeChecked();
  });

  it("forwards a flip to toggleContentProtection with the new value", () => {
    renderToggle();

    fireEvent.click(screen.getByLabelText(/screen capture protection/i));

    expect(toggleContentProtection).toHaveBeenCalledTimes(1);
    expect(toggleContentProtection).toHaveBeenCalledWith(false);
  });
});