import { describe, expect, it } from "vitest";
import {
  ESCALATE_AFTER_ATTEMPTS,
  RETENTION_MS,
  groupOf,
  pruneCutoff,
} from "@/lib/odoo/meeting-log";
import type { MeetingLogListRow, MeetingLogStatus } from "@/types";

const HERE = "http://h:8069|odoo";
const THERE = "http://h:8069|staging";

function row(
  status: MeetingLogStatus,
  over: { instance?: string; attempts?: number } = {}
): Pick<MeetingLogListRow, "instance" | "status" | "attempts"> {
  return { instance: over.instance ?? HERE, status, attempts: over.attempts ?? 0 };
}

describe("groupOf", () => {
  it("escalates a pending row at the threshold and REMOVES it from waiting", () => {
    // The negative half is the point. Without it a naive implementation counts
    // an escalated row in BOTH groups and every total still looks plausible.
    expect(groupOf(row("pending", { attempts: ESCALATE_AFTER_ATTEMPTS - 1 }), HERE)).toBe("waiting");
    const escalated = groupOf(row("pending", { attempts: ESCALATE_AFTER_ATTEMPTS }), HERE);
    expect(escalated).toBe("needs-attention");
    expect(escalated).not.toBe("waiting");
  });

  it("groups a partly-failed pending row as needing attention", () => {
    // A row derives `pending` under deriveRowStatus's rule 1 whenever any
    // target is still retryable, even with a terminally failed sibling on
    // the same row. Below the escalation threshold, the OLD implementation
    // would call this "waiting" - burying the failure summary shown beside
    // it.
    const base = row("pending", { attempts: 0 });
    expect(groupOf({ ...base, failedTargets: 1 }, HERE)).toBe("needs-attention");
    expect(groupOf({ ...base, failedTargets: 0 }, HERE)).toBe("waiting");
  });

  it("puts a current-instance sending row in waiting", () => {
    // Deliberate divergence from QUEUE_SQL.counts, which omits sending rows.
    // On a page, a row that vanished for the duration of a push and reappeared
    // only on failure would read as data loss.
    expect(groupOf(row("sending"), HERE)).toBe("waiting");
  });

  it("puts a current-instance failed row in needs-attention", () => {
    expect(groupOf(row("failed"), HERE)).toBe("needs-attention");
  });

  it("puts a current-instance unassigned row in its own group", () => {
    expect(groupOf(row("unassigned"), HERE)).toBe("unassigned");
  });

  it.each<MeetingLogStatus>(["held", "pending", "sending", "unassigned", "failed"])(
    "puts an other-instance %s row in the other-database group",
    (status) => {
      expect(groupOf(row(status, { instance: THERE }), HERE)).toBe("other-database");
    }
  );

  it("TESTS INSTANCE BEFORE STATUS for failed and escalated rows", () => {
    // A groupOf that checks status first puts these in needs-attention, where
    // the page offers a Retry that pushQueuedRow refuses at its instance check
    // - the enabled-button-that-does-nothing the disabled-action rules exist to
    // prevent. Assert the negative half explicitly.
    const failedThere = groupOf(row("failed", { instance: THERE }), HERE);
    expect(failedThere).toBe("other-database");
    expect(failedThere).not.toBe("needs-attention");

    const escalatedThere = groupOf(
      row("pending", { instance: THERE, attempts: ESCALATE_AFTER_ATTEMPTS }),
      HERE
    );
    expect(escalatedThere).toBe("other-database");
    expect(escalatedThere).not.toBe("needs-attention");
  });

  it.each<MeetingLogStatus>(["sent", "cancelled", "deleted"])(
    "puts an other-instance %s row in NO group",
    (status) => {
      // This is what stops the other-database group growing monotonically with
      // the user's entire logging history - the reason QUEUE_SQL.counts carries
      // a status predicate on its other_instance arm.
      expect(groupOf(row(status, { instance: THERE }), HERE)).toBeNull();
    }
  );

  it.each<MeetingLogStatus>(["sent", "cancelled", "deleted"])(
    "puts a current-instance %s row in NO group",
    (status) => {
      expect(groupOf(row(status), HERE)).toBeNull();
    }
  );
});

describe("pruneCutoff", () => {
  it("is now minus the retention window", () => {
    expect(pruneCutoff(1_700_000_000_000)).toBe(1_700_000_000_000 - RETENTION_MS);
  });

  it("retains for 30 days", () => {
    expect(RETENTION_MS).toBe(30 * 24 * 60 * 60 * 1000);
  });
});
