import { describe, expect, it } from "vitest";
import { resolveBadge } from "@/lib/odoo/meeting-log";

const row = (status: string, instance = "odoo-a") => ({ conversationId: "c1", status, instance } as any);

describe("resolveBadge", () => {
  it("badges an other-instance sent row", () => {
    expect(resolveBadge([row("sent", "odoo-old")], "odoo-a")).toMatchObject({ status: "sent" });
  });

  it("does NOT badge an other-instance failed row", () => {
    // Its actionable state belongs to the strip's other-database group: pushQueuedRow
    // refuses it at the instance check, so offering an action here would be a lie.
    expect(resolveBadge([row("failed", "odoo-old")], "odoo-a")).toBeNull();
  });

  it("resolves worst-status-wins across several rows", () => {
    expect(
      resolveBadge([row("sent"), row("pending"), row("failed"), row("held")], "odoo-a")
    ).toMatchObject({ status: "failed" });
  });

  it("shows a count when more than one row maps to the conversation", () => {
    expect(resolveBadge([row("sent"), row("sent")], "odoo-a")).toMatchObject({ status: "sent", count: 2 });
  });

  it.each(["cancelled", "deleted"])("renders no badge for %s", (status) => {
    // Both are meetings the user deliberately removed. Surfacing either as state
    // would resurrect a decision they already made.
    expect(resolveBadge([row(status)], "odoo-a")).toBeNull();
  });
});
