import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { MeetingLogStrip } from "@/pages/app/components/completion/MeetingLogStrip";

describe("MeetingLogStrip", () => {
  it("renders nothing when not holding", () => {
    const { container } = render(
      <MeetingLogStrip holding={false} contactName="Ada" onUndo={vi.fn()} undoBlockedMessage={null} />
    );
    expect(container).toBeEmptyDOMElement();
  });

  it("names the contact while holding", () => {
    render(<MeetingLogStrip holding contactName="Ada Lovelace" onUndo={vi.fn()} undoBlockedMessage={null} />);
    expect(screen.getByTestId("meeting-log-strip")).toHaveTextContent("Logging to Ada Lovelace");
  });

  it("falls back when the name is unresolved", () => {
    // pickerProps.contactName is null whenever the cache is not `ready` - the
    // normal state of a target rehydrated after a mid-call remount.
    render(<MeetingLogStrip holding contactName={null} onUndo={vi.fn()} undoBlockedMessage={null} />);
    expect(screen.getByTestId("meeting-log-strip")).toHaveTextContent("Logging this meeting");
  });

  it("calls onUndo when the button is clicked", async () => {
    const onUndo = vi.fn();
    render(<MeetingLogStrip holding contactName="Ada" onUndo={onUndo} undoBlockedMessage={null} />);
    await userEvent.click(screen.getByRole("button", { name: /undo/i }));
    expect(onUndo).toHaveBeenCalledTimes(1);
  });

  it("shows the blocked message instead of the undo button once the timer won", () => {
    render(
      <MeetingLogStrip
        holding={false}
        contactName="Ada"
        onUndo={vi.fn()}
        undoBlockedMessage="This meeting is already being sent to Odoo."
      />
    );
    expect(screen.getByTestId("meeting-log-strip")).toHaveTextContent("already being sent");
    expect(screen.queryByRole("button", { name: /undo/i })).toBeNull();
  });
});
