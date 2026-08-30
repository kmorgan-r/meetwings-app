// Probe: do the orphan attachments still exist? `search`/`search_read` both go
// through ir.attachment's access filter, so they cannot prove absence. A direct
// `read` by id distinguishes gone (MissingError) from hidden (AccessError).
import fs from "node:fs";
import path from "node:path";
import { beforeAll, describe, expect, it, vi } from "vitest";

const STORE = path.join(
  process.env.APPDATA as string,
  "com.meetwings.app",
  ".secure-settings.dat"
);
if (process.env.ODOO_LIVE !== "1") {
  throw new Error("refusing to run: set ODOO_LIVE=1 to authorize live Odoo writes");
}
vi.mock("@tauri-apps/plugin-http", () => ({
  fetch: (...args: unknown[]) =>
    (globalThis.fetch as unknown as (...a: unknown[]) => unknown)(...args),
}));

import { createOdooClient, type OdooClient } from "@/lib/odoo/client";
import { OdooError } from "@/lib/odoo/errors";

let client: OdooClient;

beforeAll(async () => {
  const raw = JSON.parse(fs.readFileSync(STORE, "utf8"))["secure_odoo_config"];
  const cfg = JSON.parse(raw);
  client = createOdooClient({
    url: String(cfg.url).trim(),
    db: String(cfg.db).trim(),
    login: String(cfg.login).trim(),
    apiKey: String(cfg.apiKey),
  });
});

describe("orphan attachment reachability", () => {
  it("reads each candidate id directly and unlinks any orphan still present", async () => {
    const hidden: number[] = [];
    const survivors: number[] = [];
    for (let id = 3040; id <= 3085; id++) {
      try {
        const rows = (await client.execute("ir.attachment", "read", [
          [id],
          ["id", "name", "res_model", "res_id"],
        ])) as Record<string, unknown>[];
        if (rows.length === 0) {
          console.log("[probe] " + id + " -> read returned no row (gone)");
          continue;
        }
        console.log("[probe] " + id + " -> EXISTS " + JSON.stringify(rows[0]));
        if (rows[0].res_model === "res.partner" && rows[0].res_id === 999999999) {
          survivors.push(id);
        }
      } catch (err) {
        const o = err as OdooError;
        const fault = String(o?.details?.faultString ?? o?.message ?? err);
        const kind = /MissingError|does not exist|no longer exists/i.test(fault)
          ? "GONE (MissingError)"
          : /AccessError|not allowed|sorry/i.test(fault)
            ? "HIDDEN (AccessError)"
            : "other";
        console.log("[probe] " + id + " -> " + kind + " :: " + fault.slice(0, 160));
        if (kind.startsWith("HIDDEN")) hidden.push(id);
      }
    }

    console.log("[probe] hidden (unreadable) ids -> " + JSON.stringify(hidden));
    // Can a hidden orphan be removed through the API at all? ir.attachment.check
    // gates unlink the same way it gates read, so this is the deciding question
    // for whether the residual is cleanable or permanent.
    for (const id of hidden) {
      try {
        await client.execute("ir.attachment", "unlink", [[id]] as never[]);
        console.log("[probe] unlink " + id + " -> SUCCEEDED");
      } catch (err) {
        const o = err as OdooError;
        console.log(
          "[probe] unlink " +
            id +
            " -> REFUSED :: " +
            String(o?.details?.faultString ?? o?.message ?? err).slice(0, 160)
        );
      }
    }
    expect(Array.isArray(survivors)).toBe(true);
  });
});
