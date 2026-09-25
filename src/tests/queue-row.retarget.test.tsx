import { describe, expect, it, vi } from "vitest";
import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

vi.mock("@/lib/database", () => ({
  getMeetingSummaryByConversation: vi.fn(),
  getEntitiesForSummary: vi.fn(async () => []),
}));

import { QueueRow, type QueueRowProps } from "@/pages/meetings/components/QueueRow";
import type { MeetingLogListRow, MeetingLogTarget } from "@/types";

const INSTANCE = "http://h:8069|odoo";

// Same fixture shape as queue-row.summary-expand.test.tsx (BASE_ROW / baseProps),
// with `targets` and a failed status. The expand button is named "Expand
// targets" and each expanded target is a role="group" labelled "<name> (#<resId>)".
const BASE_ROW: MeetingLogListRow = {
  id: "qr-1",
  session_key: "s1",
  conversation_id: null,
  instance: INSTANCE,
  contact_id: null,
  lead_id: null,
  transcript_start_at: 1_700_000_000_000,
  transcript_end_at: 1_700_000_060_000,
  attachment_id: null,
  message_id: null,
  status: "failed",
  attempts: 4,
  claimed_at: null,
  last_error: null,
  last_error_code: null,
  meeting_started_at: 1_700_000_000_000,
  created_at: 1_700_000_000_000,
  sent_at: null,
  targets: [],
};

function target(over: Partial<MeetingLogTarget> = {}): MeetingLogTarget {
  return {
    id: "t-1", rowId: "qr-1", model: "res.partner", resId: 56, name: "Andres Vergara",
    status: "failed", attachmentId: null, messageId: null,
    lastError: "ODOO_FAULT: Odoo fault 2", lastErrorCode: "ODOO_FAULT",
    createdAt: 1, sentAt: null, ...over,
  };
}

function props(targets: MeetingLogTarget[], over: Partial<QueueRowProps> = {}): QueueRowProps {
  return {
    row: { ...BASE_ROW, targets },
    targetName: "Someone",
    conversationTitle: null,
    isRenaming: false,
    instance: INSTANCE,
    busy: false,
    stale: false,
    outcome: null,
    transcript: null,
    contacts: new Map(),
    onRetry: vi.fn(),
    onAssign: vi.fn(),
    onDelete: vi.fn(),
    onToggleTranscript: vi.fn(),
    onReloadTranscript: vi.fn(),
    onRetryTarget: vi.fn(),
    onRemoveTarget: vi.fn(),
    onRetargetTarget: vi.fn(),
    onStartRename: vi.fn(),
    onCommitRename: vi.fn(async () => true),
    onCancelRename: vi.fn(),
    ...over,
  };
}

async function expand() {
  await userEvent.click(screen.getByRole("button", { name: "Expand targets" }));
  return screen.getByRole("group", { name: /Andres Vergara/ });
}

describe("QueueRow retarget", () => {
  it("offers a different contact on a failed target, even beside a sent sibling", async () => {
    const sent = target({ id: "t-0", resId: 55, name: "Anja", status: "sent", messageId: 1 });
    render(<QueueRow {...props([sent, target()])} />);
    const group = await expand();
    expect(within(group).getByRole("button", { name: /choose a different contact/i })).toBeVisible();
  });

  it("hands up the row and the clicked target", async () => {
    const t = target();
    const p = props([t]);
    render(<QueueRow {...p} />);
    const group = await expand();
    await userEvent.click(within(group).getByRole("button", { name: /choose a different contact/i }));
    expect(p.onRetargetTarget).toHaveBeenCalledWith(p.row, t);
  });

  it("does not offer Remove on a target that already made an attachment", async () => {
    // removeQueueTarget refuses these, so the button would only ever say no.
    render(<QueueRow {...props([target({ attachmentId: 3265 })])} />);
    const group = await expand();
    expect(within(group).queryByRole("button", { name: /^remove$/i })).toBeNull();
    expect(within(group).getByRole("button", { name: /retry this one/i })).toBeVisible();
  });

  it("still offers Remove on a failed target that never made one", async () => {
    render(<QueueRow {...props([target()])} />);
    const group = await expand();
    expect(within(group).getByRole("button", { name: /^remove$/i })).toBeVisible();
  });

  it("offers nothing on a sent target", async () => {
    render(<QueueRow {...props([target({ status: "sent", messageId: 9, name: "Andres Vergara" })])} />);
    const group = await expand();
    expect(within(group).queryByRole("button", { name: /choose a different contact/i })).toBeNull();
  });

  // A retarget rewrites model/res_id/name/attachment_id/message_id under the
  // SAME target id. The same `p` is rerendered so the memo comparator is the
  // only thing that can let the change through (fresh callbacks would not).
  it("re-renders a retargeted target onto a same-named record", async () => {
    const p = props([target()]);
    const { rerender } = render(<QueueRow {...p} />);
    await expand();
    rerender(<QueueRow {...p} row={{ ...p.row, targets: [target({ resId: 57 })] }} />);
    expect(screen.getByRole("group", { name: "Andres Vergara (#57)" })).toBeVisible();
  });

  it("offers Remove once a retarget clears the attachment", async () => {
    const p = props([target({ attachmentId: 3265 })]);
    const { rerender } = render(<QueueRow {...p} />);
    const group = await expand();
    expect(within(group).queryByRole("button", { name: /^remove$/i })).toBeNull();
    rerender(<QueueRow {...p} row={{ ...p.row, targets: [target()] }} />);
    const after = screen.getByRole("group", { name: /Andres Vergara/ });
    expect(within(after).getByRole("button", { name: /^remove$/i })).toBeVisible();
  });

  it("disables it for a row that belongs to another database", async () => {
    render(<QueueRow {...props([target()], { instance: "http://elsewhere|odoo" })} />);
    const group = await expand();
    expect(within(group).getByRole("button", { name: /choose a different contact/i })).toBeDisabled();
  });
});
