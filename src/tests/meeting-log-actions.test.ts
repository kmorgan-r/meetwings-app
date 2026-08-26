import { beforeEach, describe, expect, it, vi } from "vitest";

const action = vi.hoisted(() => ({
  retryQueueRow: vi.fn(async () => true),
  assignQueueRow: vi.fn(async () => true),
  deleteQueueRow: vi.fn(async () => true),
  getQueueRow: vi.fn(async () => null as unknown),
  pruneTranscripts: vi.fn(async () => 0),
}));
vi.mock("@/lib/database/meeting-log.action", () => action);

const push = vi.hoisted(() => ({
  pushQueuedRow: vi.fn(async () => {}),
  runMeetingLogSweep: vi.fn(async () => ({ ran: true, pushed: 0 })),
  // Declared so the ban below is ASSERTABLE. Without this key the guard's
  // property path is permanently absent and the assertion passes no matter what
  // the implementation does - the highest-stakes constraint in the slice,
  // guarded by an expression that cannot fail.
  reclaimStaleSending: vi.fn(async () => {}),
  claimed: new Set<string>(),
}));
vi.mock("@/lib/odoo/meeting-log-push", () => push);

const summarizer = vi.hoisted(() => ({
  generateMeetingLogSummary: vi.fn(async () => ({ title: "T", summary: "S" })),
}));
vi.mock("@/lib/functions/meeting-summarizer", () => summarizer);

const config = vi.hoisted(() => ({
  requireOdooConfig: vi.fn(async () => ({
    url: "http://h:8069", db: "odoo", login: "a@b.c", apiKey: "k",
  })),
  instanceFingerprint: vi.fn(() => "http://h:8069|odoo"),
}));
vi.mock("@/lib/storage/odoo-config.storage", () => config);

vi.mock("@/lib/odoo/client", () => ({ createOdooClient: vi.fn(() => ({ execute: vi.fn() })) }));

import {
  assignMeetingLog, deleteMeetingLog, retryMeetingLog,
} from "@/lib/odoo/meeting-log-actions";

const INSTANCE = "http://h:8069|odoo";

function dbRow(over: Record<string, unknown> = {}) {
  return {
    id: "r", session_key: "k", conversation_id: null, instance: INSTANCE,
    contact_id: 42, lead_id: null, transcript: "You: hi",
    transcript_start_at: 1, transcript_end_at: 2, summary_json: null,
    attachment_id: null, message_id: null, status: "pending", attempts: 1,
    claimed_at: null, last_error: null, last_error_code: null,
    meeting_started_at: 1, created_at: 1, sent_at: null,
    ...over,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  // `clearAllMocks` clears CALLS, not IMPLEMENTATIONS. Several cases below use
  // `getQueueRow.mockResolvedValue(...)`, which permanently replaces the
  // factory's `async () => null` for every LATER case in the file - so a case
  // that queues two `...Once` values and expects the third read to return null
  // would silently get the previous case's row instead. Order-coupled flake.
  // `mockReset` restores the implementation the factory passed to `vi.fn`.
  action.getQueueRow.mockReset();
  action.retryQueueRow.mockResolvedValue(true);
  action.assignQueueRow.mockResolvedValue(true);
  action.deleteQueueRow.mockResolvedValue(true);
  push.pushQueuedRow.mockResolvedValue(undefined);
  config.requireOdooConfig.mockResolvedValue({
    url: "http://h:8069", db: "odoo", login: "a@b.c", apiKey: "k",
  });
  summarizer.generateMeetingLogSummary.mockResolvedValue({ title: "T", summary: "S" });
});

// `runAction` reads the row THREE times, and every `...Once` chain below must
// supply all three or the un-stubbed call falls through to the factory default
// (`null`) and the case returns `moved-unknown` instead of what it asserts:
//
//   1. BEFORE the CAS  - the instance check
//   2. `fresh`, after the CAS - the object handed to pushQueuedRow
//   3. `after`, after the push - the object the outcome is classified from
//
// Read that order off `runAction` in Step 3 before editing any sequence here.
describe("retryMeetingLog", () => {
  it("pushes the RE-READ row, not the caller's stale object", async () => {
    // The Retry-side discriminator. contact_id/lead_id do NOT change on a
    // retry, so a mutant that re-reads for assign and hands the list-time
    // object to retry survives every assign-side case. Assert on what the CAS
    // actually changed: status and last_error.
    action.getQueueRow
      .mockResolvedValueOnce(dbRow({ status: "failed", last_error: "boom" }))  // 1: pre-CAS
      .mockResolvedValueOnce(dbRow({ status: "pending", last_error: null, attempts: 4 })) // 2: fresh
      .mockResolvedValueOnce(dbRow({ status: "sent", attempts: 5 }));          // 3: after

    await retryMeetingLog("r", { providerConfig: null });

    expect(push.pushQueuedRow.mock.calls[0][0]).toMatchObject({
      status: "pending", last_error: null, attempts: 4,
    });
  });

  it("passes the fresher attempts count when the sweep ran in between", async () => {
    // attemptsBefore drives the idempotency-search guard. A list-time snapshot
    // can be stale by one attempt.
    action.getQueueRow
      .mockResolvedValueOnce(dbRow({ attempts: 7 }))                 // 1: pre-CAS
      .mockResolvedValueOnce(dbRow({ attempts: 7 }))                 // 2: fresh
      .mockResolvedValueOnce(dbRow({ attempts: 8, status: "sent" })); // 3: after

    await retryMeetingLog("r", { providerConfig: null });

    expect(push.pushQueuedRow.mock.calls[0][0]).toMatchObject({ attempts: 7 });
  });

  it("does not push when the CAS returns false", async () => {
    // The pre-CAS read must still succeed, or this returns `moved-unknown`
    // and stops testing the CAS at all.
    action.getQueueRow.mockResolvedValue(dbRow());
    action.retryQueueRow.mockResolvedValue(false);
    const out = await retryMeetingLog("r", { providerConfig: null });
    expect(push.pushQueuedRow).not.toHaveBeenCalled();
    expect(out).toEqual({ kind: "conflict" });
  });

  it("resolves credentials BEFORE the CAS, so a config throw leaves the row alone", async () => {
    // requireOdooConfig throws for exactly the half-filled config a user comes
    // to this page to fix. With the CAS first, that throw lands with the row
    // already flipped and its last_error already NULLed - making the error
    // table's "row unchanged" false and leaving nothing on screen.
    config.requireOdooConfig.mockRejectedValueOnce(new Error("nope"));

    const out = await retryMeetingLog("r", { providerConfig: null });

    expect(action.retryQueueRow).not.toHaveBeenCalled();
    expect(out.kind).toBe("failed");
  });

  it("samples `now` after the credentials resolve, never before", async () => {
    // claimRow writes `now` straight into claimed_at. A pre-aged claimed_at
    // makes the row eligible for the main window's reclaim WHILE this push is
    // live - two attachments and two customer-visible chatter notes.
    //
    // The credential step is given MEASURABLE DURATION on purpose. Against an
    // immediately-resolving mock the discriminating window is 0 ms, so
    // `now >= (a timestamp taken before the call)` is satisfied by a `now`
    // sampled anywhere inside it - INCLUDING the mutant this case is named for.
    let afterCreds = 0;
    config.requireOdooConfig.mockImplementation(async () => {
      await new Promise((r) => setTimeout(r, 25));
      afterCreds = Date.now();
      return { url: "http://h:8069", db: "odoo", login: "a@b.c", apiKey: "k" };
    });
    action.getQueueRow.mockResolvedValue(dbRow());

    await retryMeetingLog("r", { providerConfig: null });

    expect(push.pushQueuedRow.mock.calls[0][1].now).toBeGreaterThanOrEqual(afterCreds);
  });

  it("reports a no-op when the push wrote nothing", async () => {
    // pushQueuedRow has FOUR silent early exits that write nothing at all.
    // attempts unchanged proves the claim never happened. All three reads
    // return the same row, so `mockResolvedValue` is clearer than three onces.
    action.getQueueRow.mockResolvedValue(dbRow({ attempts: 3 }));

    expect(await retryMeetingLog("r", { providerConfig: null })).toEqual({ kind: "no-op" });
  });

  it("reports push-failed when the push ran and the row did NOT reach sent", async () => {
    // pushQueuedRow's post-wire catch (releaseRowToPending / failRow) bumps
    // attempts and leaves a non-sending status with last_error written, so
    // neither the attempts check nor the sending check sees it. Without the
    // `after.status !== "sent"` gate this is classified `degraded` and the page
    // tells the user a note is live on a customer's record.
    summarizer.generateMeetingLogSummary.mockResolvedValue(null);
    action.getQueueRow
      .mockResolvedValueOnce(dbRow({ attempts: 1, status: "failed" }))    // 1: pre-CAS
      .mockResolvedValueOnce(dbRow({ attempts: 1, status: "pending" }))   // 2: fresh
      .mockResolvedValueOnce(dbRow({                                      // 3: after
        attempts: 2, status: "failed", last_error: "ODOO_UNREACHABLE: ...",
      }));

    expect(await retryMeetingLog("r", { providerConfig: null }))
      .toEqual({ kind: "push-failed" });
  });

  it("refuses an other-instance row BEFORE the CAS, leaving last_error intact", async () => {
    // Checking after the CAS would have already NULLed last_error on a row
    // belonging to a database this install no longer points at - and
    // selectSweepable filters by instance, so nothing would ever pick it up.
    action.getQueueRow.mockResolvedValue(dbRow({ instance: "http://h:8069|staging" }));

    const out = await retryMeetingLog("r", { providerConfig: null });

    expect(action.retryQueueRow).not.toHaveBeenCalled();
    expect(push.pushQueuedRow).not.toHaveBeenCalled();
    expect(out).toEqual({ kind: "conflict" });
  });

  it("reports still-sending when the row is left sending with attempts bumped", async () => {
    // The FIFTH path: the terminal status write itself failed, so the inner
    // catch wrote nothing, but attempts DID increment. An attempts-only
    // comparison calls this success while the row shows "Sending..." for a full
    // STALE_CLAIM_MS.
    action.getQueueRow
      .mockResolvedValueOnce(dbRow({ attempts: 3, status: "failed" }))    // 1: pre-CAS
      .mockResolvedValueOnce(dbRow({ attempts: 3, status: "pending" }))   // 2: fresh
      .mockResolvedValueOnce(dbRow({ attempts: 4, status: "sending" }));  // 3: after

    expect(await retryMeetingLog("r", { providerConfig: null }))
      .toEqual({ kind: "still-sending" });
  });

  it("reports moved-unknown when the post-CAS re-read throws", async () => {
    // Two mandated awaits sit AFTER the CAS and reject into the same catch. A
    // SQLITE_BUSY there must not render "row genuinely unchanged" about a row
    // that was requeued and error-cleared.
    //
    // The PRE-CAS read must RESOLVE and only the `fresh` read reject. A bare
    // `mockRejectedValueOnce` lands on read 1 instead, where nothing has been
    // written yet - that path correctly returns `failed`, so the case would
    // assert the wrong branch and pass for the wrong reason.
    action.getQueueRow
      .mockResolvedValueOnce(dbRow())                               // 1: pre-CAS, resolves
      .mockRejectedValueOnce(new Error("SQLITE_BUSY"));             // 2: fresh, throws

    expect(await retryMeetingLog("r", { providerConfig: null }))
      .toEqual({ kind: "moved-unknown" });
  });
});

describe("assignMeetingLog", () => {
  it("pushes the re-read row carrying the NEW target", async () => {
    action.getQueueRow
      // 1: pre-CAS - the UNASSIGNED shape, no target yet. Using the post-CAS
      // row here would let a mutant that pushes read 1 pass.
      .mockResolvedValueOnce(dbRow({ status: "unassigned", contact_id: null, lead_id: null }))
      .mockResolvedValueOnce(dbRow({ status: "pending", contact_id: 42, lead_id: 7 })) // 2: fresh
      .mockResolvedValueOnce(dbRow({ status: "sent", attempts: 2 }));                  // 3: after

    await assignMeetingLog("r", 42, 7, { providerConfig: null });

    expect(push.pushQueuedRow.mock.calls[0][0]).toMatchObject({ contact_id: 42, lead_id: 7 });
  });

  it("does not push when the CAS returns false", async () => {
    action.getQueueRow.mockResolvedValue(dbRow());
    action.assignQueueRow.mockResolvedValue(false);
    const out = await assignMeetingLog("r", 42, null, { providerConfig: null });
    expect(push.pushQueuedRow).not.toHaveBeenCalled();
    expect(out).toEqual({ kind: "conflict" });
  });

  it("INVOKES the summarize dep it hands to the push", async () => {
    // Not just passes it. The mutant is a summarize that resolves null
    // unconditionally - which is how slice 2 shipped three green AI-summary
    // tests over a path where the summary never reached Odoo.
    action.getQueueRow.mockResolvedValue(dbRow());

    await assignMeetingLog("r", 42, null, { providerConfig: null });

    const deps = push.pushQueuedRow.mock.calls[0][1];
    const result = await deps.summarize({
      entries: [{ original: "hi", timestamp: 1 }], startAt: 1, endAt: 2,
    });

    expect(summarizer.generateMeetingLogSummary).toHaveBeenCalled();
    expect(result).not.toBeNull();
  });

  it("reports degraded when the summarize resolved null", async () => {
    // A configured-but-FAILING provider returns null identically to a missing
    // one, and pushQueuedRow swallows it a second time - so without this the
    // row reaches `sent`, toSent clears last_error, and the page reports
    // unqualified success while a "Summarization failed" note is live on the
    // customer's record.
    summarizer.generateMeetingLogSummary.mockResolvedValue(null);
    push.pushQueuedRow.mockImplementation(async (_row, deps) => {
      await deps.summarize({ entries: [{ original: "hi", timestamp: 1 }], startAt: 1, endAt: 2 });
    });
    action.getQueueRow
      .mockResolvedValueOnce(dbRow())                                  // 1: pre-CAS
      .mockResolvedValueOnce(dbRow())                                  // 2: fresh, attempts 1
      .mockResolvedValueOnce(dbRow({ status: "sent", attempts: 2 }));  // 3: after

    expect(await assignMeetingLog("r", 42, null, { providerConfig: null }))
      .toEqual({ kind: "degraded" });
  });
});

describe("deleteMeetingLog", () => {
  it("never pushes", async () => {
    await deleteMeetingLog("r");
    expect(push.pushQueuedRow).not.toHaveBeenCalled();
  });

  it("reports a conflict when the CAS refuses", async () => {
    action.deleteQueueRow.mockResolvedValue(false);
    expect(await deleteMeetingLog("r")).toEqual({ kind: "conflict" });
  });
});

describe("the cross-window rule", () => {
  it("NEITHER action calls runMeetingLogSweep or reclaimStaleSending", async () => {
    // The single most likely way this slice regresses slice 2, and it is
    // invisible in every other test. reclaimStaleSending excludes only the
    // CALLING realm's `claimed` set - empty in the dashboard window - so a
    // reclaim from here re-`pending`s a row the main window is mid-push on.
    action.getQueueRow.mockResolvedValue(dbRow());

    await retryMeetingLog("r", { providerConfig: null });
    await assignMeetingLog("r", 42, null, { providerConfig: null });
    await deleteMeetingLog("r");

    expect(push.runMeetingLogSweep).not.toHaveBeenCalled();
    expect(push.reclaimStaleSending).not.toHaveBeenCalled();
  });
});

describe("an other-instance row", () => {
  it("never reaches pushQueuedRow from ASSIGN either", async () => {
    // Retry's half is covered by the pre-CAS case above. Both actions share
    // runAction's guard, but assert assign too: it is the path a user reaches
    // from the other-database group.
    action.getQueueRow.mockResolvedValue(dbRow({ instance: "http://h:8069|staging" }));

    await assignMeetingLog("r", 42, null, { providerConfig: null });

    expect(action.assignQueueRow).not.toHaveBeenCalled();
    expect(push.pushQueuedRow).not.toHaveBeenCalled();
  });
});
