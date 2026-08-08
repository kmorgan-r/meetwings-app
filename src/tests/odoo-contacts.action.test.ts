import fs from "node:fs";
import path from "node:path";
import initSqlJs, { type Database as SqlJsDatabase } from "sql.js";
import { beforeEach, describe, expect, it, vi } from "vitest";

let db: SqlJsDatabase;

// The real module under test goes through getDatabase(). We swap in a
// sql.js-backed adapter at that same seam, so the test exercises the REAL
// exported functions and their real SQL - not a hand-copied string.
vi.mock("@/lib/database/config", () => ({
  getDatabase: vi.fn(async () => ({
    execute: async (sql: string, params: unknown[] = []) => {
      db.run(sql, params as never[]);
      return { rowsAffected: db.getRowsModified(), lastInsertId: 0 };
    },
    // plugin-sql returns row objects; sql.js returns { columns, values }.
    select: async (sql: string, params: unknown[] = []) => {
      const stmt = db.prepare(sql);
      stmt.bind(params as never[]);
      const rows: Record<string, unknown>[] = [];
      while (stmt.step()) rows.push(stmt.getAsObject());
      stmt.free();
      return rows;
    },
  })),
}));

import {
  claimSync,
  clearTarget,
  failSync,
  finishSync,
  listContacts,
  loadTarget,
  purgeOtherInstances,
  releaseSync,
  saveTarget,
  setColleague,
  upsertContacts,
} from "@/lib/database/odoo-contacts.action";
import type { OdooContact } from "@/types";

const MIGRATION = path.resolve(
  __dirname,
  "../../src-tauri/src/db/migrations/odoo-contacts.sql"
);
const INSTANCE = "http://h:8069|odoo";
const OTHER = "http://h:8069|staging";

function contact(over: Partial<OdooContact> = {}): OdooContact {
  return {
    id: 1,
    name: "Ada Lovelace",
    email: "ada@example.com",
    phone: null,
    companyName: "Analytical Ltd",
    parentId: 9,
    isCompany: false,
    active: true,
    writeDate: "2026-08-01 10:00:00",
    isColleague: false,
    lastMeetingAt: null,
    ...over,
  };
}

beforeEach(async () => {
  // happy-dom is the GLOBAL vitest environment, and sql.js's Emscripten loader
  // takes the browser branch when `window` exists and tries to HTTP-fetch the
  // .wasm. Reading it with fs and passing wasmBinary sidesteps that without
  // opting this file out of src/tests/setup.ts.
  const wasmBinary = fs.readFileSync(
    path.resolve(__dirname, "../../node_modules/sql.js/dist/sql-wasm.wasm")
  );
  const SQL = await initSqlJs({ wasmBinary });
  db = new SQL.Database();
  db.run(fs.readFileSync(MIGRATION, "utf8"));
});

describe("the migration", () => {
  it("applies cleanly to an empty database", () => {
    const tables = db.exec(
      "SELECT name FROM sqlite_master WHERE type='table' ORDER BY name"
    )[0].values.flat();
    expect(tables).toEqual(["odoo_contacts", "odoo_selected_target", "odoo_sync_state"]);
  });
});

describe("upsertContacts", () => {
  // THE test. An INSERT OR REPLACE here erases every colleague mark on the
  // next sync - silently, and only for the contacts that happened to be edited
  // in Odoo, which is the hardest possible version of the bug to notice.
  it("preserves is_colleague and last_meeting_at across a sync that changes everything else", async () => {
    await upsertContacts(INSTANCE, [contact()], 1000);
    await setColleague(INSTANCE, 1, true);
    db.run("UPDATE odoo_contacts SET last_meeting_at = 5555 WHERE id = 1");

    await upsertContacts(
      INSTANCE,
      [
        contact({
          name: "Ada King",
          email: "ada.king@example.com",
          phone: "+47 123",
          companyName: "Other Ltd",
          parentId: 11,
          isCompany: true,
          active: false,
          writeDate: "2026-08-02 11:00:00",
        }),
      ],
      2000
    );

    const [row] = await listContacts(INSTANCE);
    expect(row.name).toBe("Ada King");
    expect(row.active).toBe(false);
    expect(row.isColleague).toBe(true);
    expect(row.lastMeetingAt).toBe(5555);
  });

  // The deliberate one-second overlap re-upserts the boundary batch on EVERY
  // run, so a blind DO UPDATE would report rows changed when nothing changed.
  it("counts only rows whose write_date actually changed", async () => {
    await expect(upsertContacts(INSTANCE, [contact()], 1000)).resolves.toBe(1);
    await expect(upsertContacts(INSTANCE, [contact()], 2000)).resolves.toBe(0);
    await expect(
      upsertContacts(INSTANCE, [contact({ writeDate: "2026-08-03 09:00:00" })], 3000)
    ).resolves.toBe(1);
  });

  it("keeps the same id under two instances as two rows", async () => {
    await upsertContacts(INSTANCE, [contact({ name: "Prod Ada" })], 1000);
    await upsertContacts(OTHER, [contact({ name: "Staging Ada" })], 1000);
    expect((await listContacts(INSTANCE))[0].name).toBe("Prod Ada");
    expect((await listContacts(OTHER))[0].name).toBe("Staging Ada");
  });

  it("never returns another instance's rows", async () => {
    await upsertContacts(OTHER, [contact({ id: 77 })], 1000);
    await expect(listContacts(INSTANCE)).resolves.toEqual([]);
  });
});

describe("purgeOtherInstances", () => {
  it("removes every trace of a switched-away instance", async () => {
    await upsertContacts(OTHER, [contact({ id: 77 })], 1000);
    await finishSync(OTHER, "2026-08-01 10:00:00", 1000, 0);
    await saveTarget({ instance: OTHER, contactId: 77, leadId: null, conversationId: null }, 1000);

    await purgeOtherInstances(INSTANCE);

    expect(await listContacts(OTHER)).toEqual([]);
    expect(await loadTarget(OTHER)).toBeNull();
    // The third table, and the one that matters most. A purge that dropped the
    // contacts but left odoo_sync_state keeps the OLD instance's watermark
    // alive, so switching back re-pulls nothing and the cache silently holds
    // ids that name different partners - the poisoned-cache path the instance
    // fingerprint exists to close. Without this assertion that purge passes.
    const { getSyncState } = await import("@/lib/database/odoo-contacts.action");
    expect(await getSyncState(OTHER)).toBeNull();
  });
});

describe("the sync claim", () => {
  // On the first sync for an instance no odoo_sync_state row exists, so a bare
  // conditional UPDATE matches zero rows and the very first sync would refuse
  // itself forever.
  it("succeeds on the first sync, when no row exists yet", async () => {
    await expect(claimSync(INSTANCE, 1000)).resolves.toBe(true);
  });

  it("refuses a second concurrent claim", async () => {
    await claimSync(INSTANCE, 1000);
    await expect(claimSync(INSTANCE, 1000)).resolves.toBe(false);
  });

  // Without a release, one completed sync blocks every Refresh for ten minutes.
  it("is released so the next run can claim immediately", async () => {
    await claimSync(INSTANCE, 1000);
    await releaseSync(INSTANCE);
    await expect(claimSync(INSTANCE, 1001)).resolves.toBe(true);
  });

  it("takes over a claim older than ten minutes", async () => {
    await claimSync(INSTANCE, 1000);
    await expect(claimSync(INSTANCE, 1000 + 10 * 60 * 1000 + 1)).resolves.toBe(true);
  });
});

describe("sync state", () => {
  it("clears the error markers on a completed run", async () => {
    await failSync(INSTANCE, "ODOO_UNREACHABLE", 500);
    await finishSync(INSTANCE, "2026-08-02 10:00:00", 1000, 3);
    const state = (await import("@/lib/database/odoo-contacts.action")).getSyncState;
    const row = await state(INSTANCE);
    expect(row?.last_error_code).toBeNull();
    expect(row?.last_error_at).toBeNull();
    expect(row?.last_write_date).toBe("2026-08-02 10:00:00");
    expect(row?.skipped_rows).toBe(3);
  });

  it("leaves the watermark untouched on a failed run", async () => {
    await finishSync(INSTANCE, "2026-08-02 10:00:00", 1000, 0);
    await failSync(INSTANCE, "ODOO_FAULT", 2000);
    const { getSyncState } = await import("@/lib/database/odoo-contacts.action");
    const row = await getSyncState(INSTANCE);
    expect(row?.last_write_date).toBe("2026-08-02 10:00:00");
    expect(row?.last_error_code).toBe("ODOO_FAULT");
  });

  // A first run that legitimately returns zero partners has no watermark to
  // store. It must store NULL, not ''. With '' the next run sends
  // ["write_date", ">", ""], Odoo casts it to a timestamp, PostgreSQL rejects
  // it, and every subsequent run faults on the same value forever - the failure
  // never advances past itself.
  it("stores NULL, never '', when a completed run has no watermark", async () => {
    await finishSync(INSTANCE, null, 1000, 0);
    const { getSyncState } = await import("@/lib/database/odoo-contacts.action");
    const row = await getSyncState(INSTANCE);
    expect(row?.last_write_date).toBeNull();
    // The run still counts as completed, so the picker leaves "never synced".
    expect(row?.last_sync_at).toBe(1000);
  });
});

describe("the selected target", () => {
  it("is a singleton - a second save replaces, never accumulates", async () => {
    await saveTarget({ instance: INSTANCE, contactId: 1, leadId: 5, conversationId: null }, 1000);
    await saveTarget({ instance: INSTANCE, contactId: 2, leadId: null, conversationId: "c" }, 2000);
    expect(db.exec("SELECT COUNT(*) FROM odoo_selected_target")[0].values[0][0]).toBe(1);
    await expect(loadTarget(INSTANCE)).resolves.toEqual({ contactId: 2, leadId: null });
  });

  it("does not return a target belonging to another instance", async () => {
    await saveTarget({ instance: OTHER, contactId: 1, leadId: null, conversationId: null }, 1000);
    await expect(loadTarget(INSTANCE)).resolves.toBeNull();
  });

  it("clears", async () => {
    await saveTarget({ instance: INSTANCE, contactId: 1, leadId: null, conversationId: null }, 1000);
    await clearTarget();
    await expect(loadTarget(INSTANCE)).resolves.toBeNull();
  });
});
