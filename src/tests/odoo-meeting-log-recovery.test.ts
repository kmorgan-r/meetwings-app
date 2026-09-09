import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const action = vi.hoisted(() => ({
  getTranscriptWatermark: vi.fn(async () => 0),
  readUnloggedMessages: vi.fn(async () => [] as unknown[]),
  insertQueueRow: vi.fn(async () => true),
}));
vi.mock("@/lib/database/meeting-log.action", () => action);

const config = vi.hoisted(() => ({
  loadOdooConfigState: vi.fn(),
  instanceFingerprint: vi.fn((url: string, db: string) => `${url}|${db}`),
}));
vi.mock("@/lib/storage/odoo-config.storage", () => config);

// Stateful for the same reason useMeetingLog.enqueue.test.tsx's is: setup.ts
// swaps the global localStorage for an inert stub, so the real module would
// silently read 0 forever and the skip-watermark case would pass against an
// implementation that never consults it.
const watermarkStorage = vi.hoisted(() => {
  const state = { skip: 0 };
  return { state, getSkipWatermark: vi.fn(() => state.skip) };
});
vi.mock("@/lib/storage/meeting-log-watermark.storage", () => watermarkStorage);

import {
  RECOVERY_MAX_AGE_MS,
  resetMeetingRecoveryGuard,
  runMeetingRecovery,
} from "@/lib/odoo/meeting-log-recovery";
import { IDLE_FLUSH_MS } from "@/lib/odoo/meeting-log";

const CONFIG = { url: "http://h:8069", db: "odoo", login: "me@x.io", apiKey: "sk-secret" };
const INSTANCE = "http://h:8069|odoo";
const NOW = 1_700_000_000_000;

function said(conversationId: string, timestamp: number, original = "hello") {
  return { conversationId, original, timestamp, audioSource: "microphone" as const };
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(NOW);
  resetMeetingRecoveryGuard();
  watermarkStorage.state.skip = 0;
  action.getTranscriptWatermark.mockResolvedValue(0);
  action.readUnloggedMessages.mockResolvedValue([]);
  action.insertQueueRow.mockResolvedValue(true);
  config.loadOdooConfigState.mockResolvedValue({ state: "complete", config: CONFIG });
});

afterEach(() => {
  vi.useRealTimers();
  vi.clearAllMocks();
});

describe("runMeetingRecovery", () => {
  it("enqueues an unassigned row for a meeting no trigger ever wrote", async () => {
    // THE bug this exists for: Auto-record off, pill left on, app closed. The
    // transcript is in `messages` and nothing in the queue points at it.
    action.readUnloggedMessages.mockResolvedValue([
      said("conv-1", NOW - 60_000, "hello there"),
      said("conv-1", NOW - 50_000, "goodbye"),
    ]);

    expect(await runMeetingRecovery()).toBe(1);

    expect(action.insertQueueRow).toHaveBeenCalledTimes(1);
    expect(action.insertQueueRow.mock.calls[0][0]).toMatchObject({
      conversationId: "conv-1",
      instance: INSTANCE,
      sessionKey: `conv-1:${NOW - 60_000}`,
      status: "unassigned",
      targets: [],
      transcriptStartAt: NOW - 60_000,
      transcriptEndAt: NOW - 50_000,
      meetingStartedAt: NOW - 60_000,
    });
    expect(action.insertQueueRow.mock.calls[0][0].transcript).toContain("hello there");
  });

  it("NEVER assigns a target, so nothing recovered reaches Odoo on its own", async () => {
    // A recovered meeting has no contact anywhere - the pick that existed when
    // it was said is long gone. Guessing one posts a stranger's transcript into
    // a customer's chatter. `unassigned` puts the choice back on the user.
    action.readUnloggedMessages.mockResolvedValue([said("conv-1", NOW - 60_000)]);
    await runMeetingRecovery();
    const row = action.insertQueueRow.mock.calls[0][0];
    expect(row.targets).toEqual([]);
    expect(row.status).toBe("unassigned");
  });

  it("splits one conversation's two meetings into two rows", async () => {
    action.readUnloggedMessages.mockResolvedValue([
      said("conv-1", NOW - IDLE_FLUSH_MS - 20_000, "meeting one"),
      said("conv-1", NOW - 10_000, "meeting two"),
    ]);

    expect(await runMeetingRecovery()).toBe(2);

    const transcripts = action.insertQueueRow.mock.calls.map((c) => c[0].transcript);
    expect(transcripts[0]).toContain("meeting one");
    expect(transcripts[0]).not.toContain("meeting two");
    expect(transcripts[1]).toContain("meeting two");
  });

  it("keeps two conversations apart even when their entries interleave in time", async () => {
    action.readUnloggedMessages.mockResolvedValue([
      said("conv-1", NOW - 60_000, "theirs"),
      said("conv-2", NOW - 55_000, "someone else's"),
    ]);

    expect(await runMeetingRecovery()).toBe(2);

    const rows = action.insertQueueRow.mock.calls.map((c) => c[0]);
    expect(rows.map((r) => r.conversationId)).toEqual(["conv-1", "conv-2"]);
    expect(rows[0].transcript).not.toContain("someone else's");
  });

  it("reads from the queue watermark, so an already-logged meeting is not duplicated", async () => {
    action.getTranscriptWatermark.mockResolvedValue(NOW - 30_000);
    await runMeetingRecovery();
    expect(action.readUnloggedMessages).toHaveBeenCalledWith(NOW - 30_000);
  });

  it("IGNORES the skip watermark, however far ahead of the queue it sits", async () => {
    // Inverted deliberately. This case used to assert the opposite, on the
    // reasoning that the skip mark records a span a trigger consumed without
    // writing a row, so recovery honouring it avoids re-consuming that span.
    //
    // That reasoning conflates two different readers. The skip mark exists for
    // ONE hazard: a LATER live trigger re-slicing the span and posting it under
    // whatever contact is selected for the NEXT meeting - a cross-customer
    // mis-post (meeting-log-watermark.storage.ts:15-25). The live trigger still
    // reads it, at useMeetingLog.ts:323, and must.
    //
    // Recovery cannot commit that hazard. Every row it writes is `unassigned`
    // with NO targets, so it reaches no contact and no Odoo instance until a
    // human picks one. Honouring the mark here buys no safety and costs the
    // whole feature: skipUnwritten runs on the absent, incomplete AND catch
    // branches, i.e. on exactly the meetings that were said and never queued -
    // which is the definition of what recovery is for.
    action.getTranscriptWatermark.mockResolvedValue(NOW - 90_000);
    watermarkStorage.state.skip = NOW - 30_000;
    await runMeetingRecovery();
    // The FLOOR argument specifically - this case is about which watermark
    // recovery reaches back to, not about the rest of the read's shape.
    expect(action.readUnloggedMessages.mock.calls[0][0]).toBe(NOW - 90_000);
  });

  it("recovers a meeting held before Odoo was set up, which the idle flush skip-marked", async () => {
    // The end-to-end failure the inverted case above is the mechanism for.
    //
    // New user turns Meeting Assist on before configuring Odoo and holds a
    // meeting. Five idle minutes later the idle flush fires, trigger() takes
    // the `absent` branch (useMeetingLog.ts:311-316) and skip-marks the whole
    // span. The user finishes Odoo setup that afternoon. If recovery floors at
    // the skip mark, the next launch finds nothing and the meeting is gone with
    // no trace - directly contradicting RECOVERY_MAX_AGE_MS, whose entire
    // stated purpose is rescuing meetings held with Odoo unconfigured.
    watermarkStorage.state.skip = NOW - 40_000; // the idle flush consumed it all

    // Filtering on the floor it is HANDED, rather than the flat mockResolvedValue
    // the cases above use. The real query is `timestamp > ?`; a mock that
    // returns its rows whatever floor it gets cannot fail for the reason this
    // case is about, and would pass just as happily against the very code it is
    // meant to catch.
    const spoken = [
      said("conv-1", NOW - 60_000, "before odoo existed"),
      said("conv-1", NOW - 50_000, "still before"),
    ];
    action.readUnloggedMessages.mockImplementation(async (floor: number) =>
      spoken.filter((e) => e.timestamp > floor)
    );

    expect(await runMeetingRecovery()).toBe(1);
    expect(action.insertQueueRow.mock.calls[0][0].transcript).toContain("before odoo existed");
  });

  it("never reaches back further than the age limit", async () => {
    // On a machine that has spoken for months with Odoo unconfigured, both
    // watermarks are 0. Without this floor the first run after setup dumps
    // every meeting ever held into the strip as work to triage.
    await runMeetingRecovery();
    expect(action.readUnloggedMessages).toHaveBeenCalledWith(NOW - RECOVERY_MAX_AGE_MS);
  });

  it("writes nothing while Odoo is not configured, and leaves the work for later", async () => {
    config.loadOdooConfigState.mockResolvedValue({ state: "absent", config: null });
    action.readUnloggedMessages.mockResolvedValue([said("conv-1", NOW - 60_000)]);

    expect(await runMeetingRecovery()).toBe(0);

    expect(action.insertQueueRow).not.toHaveBeenCalled();
    // Nothing consumed: the entries are still above every watermark, so the
    // run after the user finishes setup still finds them.
    expect(action.readUnloggedMessages).not.toHaveBeenCalled();
  });

  it("retries after the user finishes setting Odoo up, with no app restart", async () => {
    // The latch must be set on the OUTCOME, not on entry - the same trap the
    // sweep effect documents at useMeetingLog.ts:515-523. Latching first means
    // a launch with no credentials permanently disables recovery for that
    // process, and finishing Odoo setup mid-session is EXACTLY when a user has
    // days of unlogged meetings waiting to be found.
    config.loadOdooConfigState.mockResolvedValueOnce({ state: "absent", config: null });
    action.readUnloggedMessages.mockResolvedValue([said("conv-1", NOW - 60_000)]);

    expect(await runMeetingRecovery()).toBe(0);
    expect(await runMeetingRecovery()).toBe(1);
  });

  it("runs once per process, not once per mount", async () => {
    action.readUnloggedMessages.mockResolvedValue([said("conv-1", NOW - 60_000)]);
    await runMeetingRecovery();
    await runMeetingRecovery();
    expect(action.insertQueueRow).toHaveBeenCalledTimes(1);
  });

  it("counts only rows actually created, so a duplicate session key is not claimed", async () => {
    // insertQueueRow returns false on ON CONFLICT(session_key) DO NOTHING -
    // the row was already there, which is a normal outcome, not a recovery.
    action.readUnloggedMessages.mockResolvedValue([said("conv-1", NOW - 60_000)]);
    action.insertQueueRow.mockResolvedValue(false);
    expect(await runMeetingRecovery()).toBe(0);
  });

  it("keeps going when one segment's insert throws", async () => {
    // Abandoning the rest would lose meetings for a transient SQLITE_BUSY on
    // the first of them.
    action.readUnloggedMessages.mockResolvedValue([
      said("conv-1", NOW - 60_000, "first"),
      said("conv-2", NOW - 50_000, "second"),
    ]);
    action.insertQueueRow.mockRejectedValueOnce(new Error("db busy"));

    expect(await runMeetingRecovery()).toBe(1);
    expect(action.insertQueueRow).toHaveBeenCalledTimes(2);
  });

  it("resolves rather than rejecting when the read fails", async () => {
    // The only production caller is a `void` inside a React effect - a
    // rejection there is an unhandled promise, not an error anyone sees.
    action.readUnloggedMessages.mockRejectedValue(new Error("db down"));
    await expect(runMeetingRecovery()).resolves.toBe(0);
  });
});
