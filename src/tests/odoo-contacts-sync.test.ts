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

import { PAGE_LIMIT, PARTNER_FIELDS, syncContacts } from "@/lib/odoo/contacts-sync";
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

/** The "id in [batch]" leaf of a machinery call's domain, or null for a plain page fetch. */
function idsIn(args: unknown[]): number[] | null {
  const domain = (args[0] as unknown[][] | undefined) ?? [];
  const leaf = domain.find((l) => Array.isArray(l) && l[0] === "id" && l[1] === "in");
  return leaf ? (leaf[2] as number[]) : null;
}

function fault() {
  return new OdooError("ODOO_FAULT", "Odoo fault 2", { faultCode: 2, faultString: "read blew up" });
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

  describe("the page-fault machinery", () => {
    it("isolates a faulting page: id-only search, halved sub-batches, one counted singleton skip", async () => {
      // Page fetch faults -> plain search names [1,2,3] -> the batch read
      // faults (id 3 is the bad record) -> bisect [1] ok, [2,3] faults ->
      // [2] ok, [3] singleton faults -> skipped. Two rows upserted; the
      // watermark advances from the UPSERTED rows' write_date only.
      const execute = vi.fn(async (_m: string, method: string, args: unknown[], kwargs: unknown) => {
        const batch = idsIn(args);
        if (method === "search") {
          // The machinery's own `fields`-kwarg trap, made mock-visible.
          expect(kwargs).toEqual({
            order: "id asc",
            limit: PAGE_LIMIT,
            context: { active_test: false },
          });
          return [1, 2, 3];
        }
        if (batch) {
          if (batch.includes(3)) throw fault();
          return batch.map((id) => partner({ id }));
        }
        throw fault(); // the page fetch
      });
      const client = { authenticate: vi.fn(), execute, serverDate: "Tue, 04 Aug 2026 12:00:00 GMT" };

      const result = await syncContacts({ client, instance: INSTANCE, now: NOW });

      expect(result.skipped).toBe(1);
      expect(result.fetched).toBe(2);
      expect(action.upsertContacts).toHaveBeenCalledTimes(1);
      expect(action.upsertContacts.mock.calls[0][1]).toMatchObject([{ id: 1 }, { id: 2 }]);
      expect(action.finishSync).toHaveBeenCalledWith(INSTANCE, "2026-08-01 09:59:59", NOW, 1);

      // Deterministic bisection: the whole batch first, then the halves.
      const batches = execute.mock.calls
        .filter(([, m, a]) => m === "search_read" && idsIn(a))
        .map(([, , a]) => idsIn(a));
      expect(batches).toEqual([[1, 2, 3], [1], [2, 3], [2], [3]]);

      // Wire shapes: the id-only search carries NO fields key; every sub-batch
      // read keeps fields, the type filters and the context flag.
      const searchCall = execute.mock.calls.find(([, m]) => m === "search")!;
      expect(searchCall[3]).not.toHaveProperty("fields");
      const subBatchCalls = execute.mock.calls.filter(
        ([, m, a]) => m === "search_read" && idsIn(a)
      );
      for (const [, , a, kw] of subBatchCalls) {
        expect((kw as { fields: string[] }).fields).toEqual(PARTNER_FIELDS);
        expect((kw as { context: unknown }).context).toEqual({ active_test: false });
        const domain = (a as unknown[][][])[0];
        for (const t of ["delivery", "invoice", "other"]) {
          expect(domain).toContainEqual(["type", "!=", t]);
        }
      }
    });

    it("advances the cursor past a skipped singleton", async () => {
      // 200 ids, the id-200 singleton keeps faulting. The cursor must move past
      // it, or the next page's domain re-fetches the identical window forever.
      const execute = vi.fn(async (_m: string, method: string, args: unknown[]) => {
        const batch = idsIn(args);
        if (method === "search") {
          // The mock honours the domain's id-cursor leaf, as the real server
          // does: a search that ignored it would name the same 200 ids for the
          // NEXT page's window too, the machinery would re-read ids at or
          // below the cursor, and the run would die on the existing
          // "no usable id" backstop - never showing the cursor move this test
          // is about. With the cursor honoured, the second page's search
          // returns [] and the loop breaks cleanly.
          const floor = ((args[0] as unknown[][]).find((l) => l[0] === "id")?.[2] as number) ?? 0;
          return Array.from({ length: PAGE_LIMIT }, (_v, i) => i + 1).filter((id) => id > floor);
        }
        if (batch) {
          // includes(200), not a singleton-only throw: bisection only reaches
          // the singleton through a faulting read that CONTAINS id 200, so the
          // fault must ride the record, not the batch shape.
          if (batch.includes(200)) throw fault();
          return batch.map((id) => partner({ id }));
        }
        throw fault(); // page fetch faults every time in this run
      });
      const client = { authenticate: vi.fn(), execute, serverDate: null };

      await syncContacts({ client, instance: INSTANCE, now: NOW });

      // The next page fetch's domain moved past the skipped id (raw id 200).
      const pageFetches = execute.mock.calls.filter(
        ([, m, a]) => m === "search_read" && !idsIn(a)
      );
      const lastDomain = (pageFetches[pageFetches.length - 1][2] as unknown[][][])[0];
      expect(lastDomain).toContainEqual(["id", ">", 200]);
    });

    it("keeps the raw-id cursor rule inside the machinery: a parse-malformed row in a successful sub-batch advances the cursor from its raw id", async () => {
      const execute = vi.fn(async (_m: string, method: string, args: unknown[]) => {
        const batch = idsIn(args);
        if (method === "search") {
          // Domain-aware, as above - the next page's window must come back
          // empty or the stale re-delivery trips the "no usable id" backstop
          // instead of the cursor move under test.
          const floor = ((args[0] as unknown[][]).find((l) => l[0] === "id")?.[2] as number) ?? 0;
          return Array.from({ length: PAGE_LIMIT }, (_v, i) => i + 1).filter((id) => id > floor);
        }
        if (batch) {
          const rows = batch.map((id) => partner({ id }));
          if (batch.includes(200)) {
            // Row 200 parse-fails (no write_date) but still carries a raw id.
            rows[rows.length - 1] = { id: 200, name: "x" };
          }
          return rows;
        }
        throw fault();
      });
      const client = { authenticate: vi.fn(), execute, serverDate: null };

      const result = await syncContacts({ client, instance: INSTANCE, now: NOW });

      expect(result.skipped).toBe(1);
      const pageFetches = execute.mock.calls.filter(
        ([, m, a]) => m === "search_read" && !idsIn(a)
      );
      const lastDomain = (pageFetches[pageFetches.length - 1][2] as unknown[][][])[0];
      // The cursor advanced from the RAW id 200, not from the parsed max (199) -
      // a parsed-only cursor would re-fetch row 200 every run and spin.
      expect(lastDomain).toContainEqual(["id", ">", 200]);
    });

    it("fails the run loudly when a page yields zero upserted rows from the machinery (every singleton faults)", async () => {
      // A PARTNER_FIELDS drift faults with code 2 on every read yet spares the
      // id-only search. Without the breaker the cursor walks past the whole
      // table, the run "succeeds", nothing is ingested and the watermark is
      // unadvanced - a silent total failure where today's code fails loudly.
      const execute = vi.fn(async (_m: string, method: string, args: unknown[]) => {
        const batch = idsIn(args);
        if (method === "search") return [1, 2];
        if (batch) throw fault(); // every read faults, down to the singletons
        throw fault(); // page fetch
      });
      const client = { authenticate: vi.fn(), execute, serverDate: null };

      await expect(
        syncContacts({ client, instance: INSTANCE, now: NOW })
      ).rejects.toMatchObject({ code: "ODOO_UNEXPECTED_ROW" });
      expect(action.failSync).toHaveBeenCalledWith(INSTANCE, "ODOO_UNEXPECTED_ROW", NOW);
      expect(action.finishSync).not.toHaveBeenCalled();
    });

    it("fails the run loudly when every row of a non-empty page fails parse (the breaker does not care which route the zero came by)", async () => {
      const broken = Array.from({ length: PAGE_LIMIT }, (_v, i) => partner({ id: i + 1, write_date: 123 }));
      const { client, execute } = clientReturning([broken, broken]);
      await expect(
        syncContacts({ client, instance: INSTANCE, now: NOW })
      ).rejects.toMatchObject({ code: "ODOO_UNEXPECTED_ROW" });
      expect(execute).toHaveBeenCalledTimes(1);
      expect(action.failSync).toHaveBeenCalledWith(INSTANCE, "ODOO_UNEXPECTED_ROW", NOW);
      expect(action.finishSync).not.toHaveBeenCalled();
    });

    it("re-throws when the id-only search itself faults: the fault is not record-shaped", async () => {
      const execute = vi.fn(async () => {
        throw fault(); // page fetch AND the id-only search both fault
      });
      const client = { authenticate: vi.fn(), execute, serverDate: null };
      await expect(
        syncContacts({ client, instance: INSTANCE, now: NOW })
      ).rejects.toMatchObject({ code: "ODOO_FAULT" });
      expect(execute).toHaveBeenCalledTimes(2); // page fetch + id-only search, no bisection
      expect(action.failSync).toHaveBeenCalledWith(INSTANCE, "ODOO_FAULT", NOW);
    });

    it("never enters the machinery for ODOO_UNREACHABLE or ODOO_UNEXPECTED_ROW - zero bisection calls", async () => {
      for (const code of ["ODOO_UNREACHABLE", "ODOO_UNEXPECTED_ROW"] as const) {
        const execute = vi.fn(async () => {
          throw new OdooError(code, "down", {});
        });
        const client = { authenticate: vi.fn(), execute, serverDate: null };
        await expect(
          syncContacts({ client, instance: INSTANCE, now: NOW })
        ).rejects.toMatchObject({ code });
        expect(execute).toHaveBeenCalledTimes(1); // the page fetch, nothing else
        expect(action.failSync).toHaveBeenCalledWith(INSTANCE, code, NOW);
      }
    });

    it("bisects only on FAULT: a successful sub-batch is never re-fetched", async () => {
      // The recursion-duplication killer: after [1,2] succeeds its rows are in,
      // and the machinery must NOT re-read them (the fault catch is the only
      // place bisection happens).
      const execute = vi.fn(async (_m: string, method: string, args: unknown[]) => {
        const batch = idsIn(args);
        if (method === "search") return [1, 2, 3, 4];
        if (batch) {
          if (batch.length === 4) throw fault(); // the whole-page read faults
          if (batch.includes(4)) throw fault(); // [3,4] and the [4] singleton fault
          return batch.map((id) => partner({ id })); // [1,2] ok, [3] ok
        }
        throw fault(); // page fetch
      });
      const client = { authenticate: vi.fn(), execute, serverDate: null };

      const result = await syncContacts({ client, instance: INSTANCE, now: NOW });

      const batches = execute.mock.calls
        .filter(([, m, a]) => m === "search_read" && idsIn(a))
        .map(([, , a]) => idsIn(a));
      expect(batches).toEqual([[1, 2, 3, 4], [1, 2], [3, 4], [3], [4]]);
      expect(result.skipped).toBe(1);
      expect(result.fetched).toBe(3); // 1, 2, 3 - each exactly once
      expect(action.upsertContacts.mock.calls[0][1]).toMatchObject([
        { id: 1 }, { id: 2 }, { id: 3 },
      ]);
    });

    it("does not fail the run when a page's ONLY record singleton-faults (the single-record exemption)", async () => {
      // Item 4's fate, not item 5's: one id, singleton fault, skip counted,
      // cursor past it, run completes, watermark untouched so the record is
      // re-fetched next run and the machinery recovers when a page-mate joins.
      const execute = vi.fn(async (_m: string, method: string, args: unknown[]) => {
        const batch = idsIn(args);
        if (method === "search") return [7];
        if (batch) throw fault(); // the singleton read faults
        throw fault(); // page fetch
      });
      const client = { authenticate: vi.fn(), execute, serverDate: null };

      const result = await syncContacts({ client, instance: INSTANCE, now: NOW });

      expect(result.skipped).toBe(1);
      expect(result.fetched).toBe(0);
      expect(action.finishSync).toHaveBeenCalledWith(INSTANCE, null, NOW, 1);
      expect(action.failSync).not.toHaveBeenCalled();
    });

    it("re-throws a non-fault failure from INSIDE the machinery: a sub-batch ODOO_UNREACHABLE is never laundered into a skip", async () => {
      // Only ODOO_FAULT narrows. A transport failure on a sub-batch read must
      // fail the run - skipping rows on a dead server would silently drop them.
      const execute = vi.fn(async (_m: string, method: string, args: unknown[]) => {
        const batch = idsIn(args);
        if (method === "search") return [1, 2];
        if (batch) {
          if (batch.length === 2) throw fault();
          throw new OdooError("ODOO_UNREACHABLE", "down", {}); // the singleton read
        }
        throw fault(); // page fetch
      });
      const client = { authenticate: vi.fn(), execute, serverDate: null };

      await expect(
        syncContacts({ client, instance: INSTANCE, now: NOW })
      ).rejects.toMatchObject({ code: "ODOO_UNREACHABLE" });
      expect(action.failSync).toHaveBeenCalledWith(INSTANCE, "ODOO_UNREACHABLE", NOW);
      expect(action.finishSync).not.toHaveBeenCalled();
    });
  });
});
