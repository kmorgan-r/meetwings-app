import { beforeEach, describe, expect, it, vi } from "vitest";

// `vi.hoisted`, not a bare `const`. Vitest hoists every `vi.mock` call above the
// imports, so a factory that closes over a plain outer const runs while that
// const is still in its TDZ - the file then dies at load with
// `ReferenceError: Cannot access 'action' before initialization` and reports "no
// tests" rather than failures. See src/tests/useMeetingAutoRecord.lifecycle.test.tsx:12-15.
const action = vi.hoisted(() => ({
  claimSync: vi.fn(async () => true),
  releaseSync: vi.fn(async () => {}),
  finishSync: vi.fn(async () => {}),
  failSync: vi.fn(async () => {}),
  purgeOtherInstances: vi.fn(async () => {}),
  upsertContacts: vi.fn(async () => 0),
  getSyncState: vi.fn(async () => null as unknown),
}));
vi.mock("@/lib/database/odoo-contacts.action", () => action);

import { syncContacts } from "@/lib/odoo/contacts-sync";
import { OdooError } from "@/lib/odoo/errors";
import { resetOdooRedactor, setOdooRedactor } from "@/lib/odoo/redactor";

const INSTANCE = "http://h:8069|odoo";
const NOW = 1_800_000_000_000;

function partner(over: Record<string, unknown> = {}) {
  return {
    id: 1,
    name: "Ada",
    email: "ada@x.no",
    phone: false,
    parent_id: [9, "Analytical Ltd"],
    is_company: false,
    active: true,
    write_date: "2026-08-01 10:00:00",
    type: "contact",
    ...over,
  };
}

/** A client whose execute() returns each queued page in turn. */
function clientReturning(pages: unknown[][], dateHeader = "Tue, 04 Aug 2026 12:00:00 GMT") {
  const execute = vi.fn(async () => pages.shift() ?? []);
  return {
    client: { authenticate: vi.fn(async () => 7), execute, serverDate: dateHeader },
    execute,
  };
}

beforeEach(() => {
  // mockReset, NOT mockClear. mockClear wipes the call log and LEAVES the
  // implementation, so the one test that makes failSync/releaseSync reject
  // would leave them rejecting for every test after it - and those tests would
  // fail somewhere unrelated to what they assert.
  Object.values(action).forEach((fn) => fn.mockReset());
  action.claimSync.mockResolvedValue(true);
  action.releaseSync.mockResolvedValue(undefined);
  action.finishSync.mockResolvedValue(undefined);
  action.failSync.mockResolvedValue(undefined);
  action.purgeOtherInstances.mockResolvedValue(undefined);
  action.getSyncState.mockResolvedValue(null);
  action.upsertContacts.mockResolvedValue(0);
  resetOdooRedactor();
  setOdooRedactor(["secret"]);
});

describe("syncContacts", () => {
  it("purges other instances before it pulls anything", async () => {
    const { client } = clientReturning([[]]);
    await syncContacts({ client, instance: INSTANCE, now: NOW });
    expect(action.purgeOtherInstances).toHaveBeenCalledWith(INSTANCE);
  });

  // Passing `undefined` would throw ODOO_PAYLOAD_UNSERIALIZABLE before any
  // request is sent, so the cache would never populate and the picker would
  // sit permanently in "sync has never succeeded". '' is no better: Odoo
  // null-normalizes only = / != leaves, so write_date > '' reaches PostgreSQL
  // as an invalid timestamp cast and faults.
  it("OMITS the write_date leaf entirely on the first run", async () => {
    const { client, execute } = clientReturning([[]]);
    await syncContacts({ client, instance: INSTANCE, now: NOW });
    const domain = execute.mock.calls[0][2][0] as unknown[][];
    expect(domain.some((leaf) => leaf[0] === "write_date")).toBe(false);
  });

  it("includes the write_date leaf once a watermark exists", async () => {
    action.getSyncState.mockResolvedValue({ last_write_date: "2026-07-01 00:00:00" });
    const { client, execute } = clientReturning([[]]);
    await syncContacts({ client, instance: INSTANCE, now: NOW });
    const domain = execute.mock.calls[0][2][0] as unknown[][];
    expect(domain).toContainEqual(["write_date", ">", "2026-07-01 00:00:00"]);
  });

  it("sends the kwargs the design depends on", async () => {
    const { client, execute } = clientReturning([[]]);
    await syncContacts({ client, instance: INSTANCE, now: NOW });
    const [model, method, args, kwargs] = execute.mock.calls[0];
    expect(model).toBe("res.partner");
    expect(method).toBe("search_read");
    // Archived partners must keep coming back, or the cache holds a stale
    // live-looking row forever.
    expect(kwargs.context).toEqual({ active_test: false });
    // Ordering by id (unique, immutable) is what makes keyset paging stable.
    expect(kwargs.order).toBe("id asc");
    expect(kwargs.limit).toBe(200);
    expect(kwargs.fields).toContain("write_date");
    expect(kwargs.fields).toContain("parent_id");
    const domain = args[0] as unknown[][];
    expect(domain).toContainEqual(["type", "!=", "delivery"]);
    expect(domain).toContainEqual(["type", "!=", "invoice"]);
    expect(domain).toContainEqual(["type", "!=", "other"]);
  });

  it("pages on the keyset cursor until a short page", async () => {
    const full = (start: number) =>
      Array.from({ length: 200 }, (_v, i) => partner({ id: start + i }));
    const { client, execute } = clientReturning([full(1), full(201), [partner({ id: 401 })]]);
    await syncContacts({ client, instance: INSTANCE, now: NOW });
    expect(execute).toHaveBeenCalledTimes(3);
    const cursorOf = (call: number) =>
      (execute.mock.calls[call][2][0] as unknown[][]).find((l) => l[0] === "id")?.[2];
    expect(cursorOf(0)).toBe(0);
    expect(cursorOf(1)).toBe(200);
    expect(cursorOf(2)).toBe(400);
  });

  it("stores max(write_date) minus a second, clamped to the server Date header", async () => {
    const { client } = clientReturning(
      [[partner({ write_date: "2026-08-04 12:00:02" })]],
      "Tue, 04 Aug 2026 12:00:00 GMT"
    );
    await syncContacts({ client, instance: INSTANCE, now: NOW });
    expect(action.finishSync).toHaveBeenCalledWith(INSTANCE, "2026-08-04 11:59:59", NOW, 0);
  });

  it("does not advance the watermark when a page fails midway", async () => {
    const execute = vi
      .fn()
      .mockResolvedValueOnce(Array.from({ length: 200 }, (_v, i) => partner({ id: i + 1 })))
      .mockRejectedValueOnce(new OdooError("ODOO_UNREACHABLE", "down", {}));
    const client = { authenticate: vi.fn(), execute, serverDate: null };
    await expect(
      syncContacts({ client, instance: INSTANCE, now: NOW })
    ).rejects.toBeInstanceOf(OdooError);
    expect(action.finishSync).not.toHaveBeenCalled();
    expect(action.failSync).toHaveBeenCalledWith(INSTANCE, "ODOO_UNREACHABLE", NOW);
  });

  // Throwing per row would fail the whole run - and a failed run does not
  // advance the watermark, so ONE malformed partner among several thousand
  // would wedge syncing forever with no way past it.
  it("skips an unreadable row, counts it, and still completes", async () => {
    const { client } = clientReturning([[partner(), { id: "not-a-number" }, partner({ id: 2 })]]);
    const result = await syncContacts({ client, instance: INSTANCE, now: NOW });
    expect(result.skipped).toBe(1);
    expect(result.fetched).toBe(2);
    expect(action.finishSync).toHaveBeenCalledWith(INSTANCE, expect.any(String), NOW, 1);
  });

  it("maps a many2one parent_id to companyName and parentId, and false to null", async () => {
    const { client } = clientReturning([
      [partner(), partner({ id: 2, parent_id: false, email: false })],
    ]);
    await syncContacts({ client, instance: INSTANCE, now: NOW });
    const rows = action.upsertContacts.mock.calls[0][1];
    expect(rows[0]).toMatchObject({ parentId: 9, companyName: "Analytical Ltd" });
    expect(rows[1]).toMatchObject({ parentId: null, companyName: null, email: null });
  });

  // THE first-run zero-row case. Storing '' here makes every later run send
  // ["write_date", ">", ""], which Odoo casts to a timestamp and PostgreSQL
  // rejects - and a faulting run never advances the watermark, so it faults on
  // the same value forever. NULL is the only correct value.
  it("stores a NULL watermark when a first run returns nothing", async () => {
    const { client } = clientReturning([[]]);
    await syncContacts({ client, instance: INSTANCE, now: NOW });
    expect(action.finishSync).toHaveBeenCalledWith(INSTANCE, null, NOW, 0);
  });

  it("keeps the existing watermark when a later run returns nothing", async () => {
    action.getSyncState.mockResolvedValue({ last_write_date: "2026-07-01 00:00:00" });
    const { client } = clientReturning([[]]);
    await syncContacts({ client, instance: INSTANCE, now: NOW });
    expect(action.finishSync).toHaveBeenCalledWith(INSTANCE, "2026-07-01 00:00:00", NOW, 0);
  });

  // A full page of unreadable rows advances nothing. If the cursor is only
  // moved by successfully parsed rows, this loops forever on the same page,
  // holding the claim, with no error and no progress.
  it("fails instead of looping when a whole page has no usable id", async () => {
    const junk = Array.from({ length: 200 }, () => ({ name: "no id" }));
    const { client, execute } = clientReturning([junk, junk, junk]);
    await expect(
      syncContacts({ client, instance: INSTANCE, now: NOW })
    ).rejects.toMatchObject({ code: "ODOO_UNEXPECTED_ROW" });
    expect(execute).toHaveBeenCalledTimes(1);
  });

  // The cursor must advance past a row that failed to PARSE but still carried a
  // readable id, or the next page starts underneath it and re-fetches it.
  it("advances the cursor past an unparseable row that still has an id", async () => {
    const page = Array.from({ length: 200 }, (_v, i) =>
      i === 199 ? { id: 200, name: "x" } : partner({ id: i + 1 })
    );
    const { client, execute } = clientReturning([page, []]);
    await syncContacts({ client, instance: INSTANCE, now: NOW });
    const cursorOf = (call: number) =>
      (execute.mock.calls[call][2][0] as unknown[][]).find((l) => l[0] === "id")?.[2];
    expect(cursorOf(1)).toBe(200);
  });

  it("refuses to start when another window holds the claim", async () => {
    action.claimSync.mockResolvedValue(false);
    const { client, execute } = clientReturning([[]]);
    // ODOO_SYNC_BUSY, not ODOO_INTERNAL: callers ignore it rather than paint
    // the picker red.
    await expect(
      syncContacts({ client, instance: INSTANCE, now: NOW })
    ).rejects.toMatchObject({ code: "ODOO_SYNC_BUSY" });
    expect(execute).not.toHaveBeenCalled();
    // The claim was never taken, so nothing may be released or marked failed.
    expect(action.failSync).not.toHaveBeenCalled();
    expect(action.releaseSync).not.toHaveBeenCalled();
  });

  // Distinct from a REFUSED claim (claimSync resolving false): here the DB
  // write itself rejects - disk I/O, plugin-sql failure. Everything in
  // src/lib/odoo/ throws OdooError, so a raw driver error must not escape.
  // No claim was ever taken, so nothing may be released or marked failed
  // either - same as the refused-claim case above.
  it("normalizes a claimSync rejection to an OdooError instead of leaking it raw", async () => {
    action.claimSync.mockRejectedValue(new Error("disk I/O error"));
    const { client, execute } = clientReturning([[]]);
    let caught: unknown;
    try {
      await syncContacts({ client, instance: INSTANCE, now: NOW });
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(OdooError);
    expect(execute).not.toHaveBeenCalled();
    expect(action.failSync).not.toHaveBeenCalled();
    expect(action.releaseSync).not.toHaveBeenCalled();
  });

  // The bookkeeping writes must never become the reported failure. If failSync
  // rejects, the ODOO_FAULT the user actually needs to see is replaced by a
  // database error and the real cause is lost.
  it("reports the original error even when failSync and releaseSync both throw", async () => {
    action.failSync.mockRejectedValue(new Error("database is locked"));
    action.releaseSync.mockRejectedValue(new Error("database is locked"));
    const client = {
      authenticate: vi.fn(),
      execute: vi.fn().mockRejectedValue(new OdooError("ODOO_FAULT", "boom", {})),
      serverDate: null,
    };
    await expect(
      syncContacts({ client, instance: INSTANCE, now: NOW })
    ).rejects.toMatchObject({ code: "ODOO_FAULT" });
  });

  it("releases the claim on success AND on failure", async () => {
    const ok = clientReturning([[]]);
    await syncContacts({ client: ok.client, instance: INSTANCE, now: NOW });
    expect(action.releaseSync).toHaveBeenCalledTimes(1);

    action.releaseSync.mockClear();
    const bad = {
      authenticate: vi.fn(),
      execute: vi.fn().mockRejectedValue(new OdooError("ODOO_FAULT", "boom", {})),
      serverDate: null,
    };
    await expect(
      syncContacts({ client: bad, instance: INSTANCE, now: NOW })
    ).rejects.toBeInstanceOf(OdooError);
    expect(action.releaseSync).toHaveBeenCalledTimes(1);
  });
});
