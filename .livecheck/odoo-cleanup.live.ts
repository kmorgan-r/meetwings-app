// Removes what the live smoke test left behind on the real Odoo instance.
// Prints everything it matched BEFORE deleting anything.
//
// Run:  ODOO_LIVE=1 npx vitest run --config .livecheck/vitest.cleanup.config.ts
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

// Prefix match, case-sensitive (=like, not ilike). Nothing a human would name a
// real record can start with this.
const PREFIX = "ZZ Meetwings smoke%";
// The nonexistent res_id the smoke test's deterministic-failure leg points at.
const MISSING_ID = 999999999;

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

/** Lists what matched, then unlinks it. Never unlinks without printing first. */
async function sweep(
  model: string,
  domain: unknown[],
  fields: string[],
  ctx: Record<string, unknown> = {}
): Promise<number> {
  const found = (await client.execute(
    model,
    "search_read",
    [domain, fields] as never[],
    { context: { active_test: false, ...ctx } }
  )) as Record<string, unknown>[];

  if (found.length === 0) {
    console.log("[cleanup] " + model + ": nothing matched");
    return 0;
  }
  console.log("[cleanup] " + model + ": " + found.length + " matched");
  for (const r of found) console.log("          " + JSON.stringify(r));

  const ids = found.map((r) => r.id as number);
  await client.execute(model, "unlink", [ids] as never[]);
  console.log("[cleanup] " + model + ": unlinked " + ids.length);
  return ids.length;
}

describe("live Odoo cleanup", () => {
  it("removes the scratch crm.lead records", async () => {
    // Leads first: a lead can reference a partner, and unlinking the partner
    // out from under it is the ordering that fails.
    const n = await sweep("crm.lead", [["name", "=like", PREFIX]], ["id", "name"]);
    expect(n).toBeGreaterThanOrEqual(0);
  });

  it("removes the orphan attachments the failed-target leg left behind", async () => {
    const n = await sweep(
      "ir.attachment",
      [
        ["res_model", "=", "res.partner"],
        ["res_id", "=", MISSING_ID],
      ],
      ["id", "name", "res_model", "res_id"]
    );
    expect(n).toBeGreaterThanOrEqual(0);
  });

  it("removes the scratch res.partner records, archived ones included", async () => {
    const n = await sweep(
      "res.partner",
      [["name", "=like", PREFIX]],
      ["id", "name", "active"]
    );
    expect(n).toBeGreaterThanOrEqual(0);
  });

  it("confirms nothing named like the scratch records survives", async () => {
    for (const model of ["res.partner", "crm.lead"]) {
      const left = (await client.execute(
        model,
        "search",
        [[["name", "=like", PREFIX]]] as never[],
        { context: { active_test: false } }
      )) as number[];
      console.log("[cleanup] survivors in " + model + ": " + JSON.stringify(left));
      expect(left).toHaveLength(0);
    }
  });
});
