// Creates a scratch contact and lead to aim a MANUAL, GUI end-to-end run at,
// so the app-level legs (a local write failure after a successful message_post;
// two running instances) never point at a real customer.
//
// Run:  ODOO_LIVE=1 npx vitest run --config .livecheck/vitest.scratch.config.ts
// Then: pick "ZZ Meetwings smoke ..." in the app's contact picker.
// After: .livecheck/vitest.cleanup.config.ts removes them.
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

let client: OdooClient;
let base = "";

beforeAll(async () => {
  const raw = JSON.parse(fs.readFileSync(STORE, "utf8"))["secure_odoo_config"];
  const cfg = JSON.parse(raw);
  base = String(cfg.url).trim();
  client = createOdooClient({
    url: base,
    db: String(cfg.db).trim(),
    login: String(cfg.login).trim(),
    apiKey: String(cfg.apiKey),
  });
});

// This instance serves the classic /web# hash URLs. menu_id/action are this
// database's own ids for the Contacts and CRM actions - not portable.
const form = (model: string, id: number, menu: number, action: number) =>
  base + "/web#id=" + id + "&cids=1&menu_id=" + menu + "&action=" +
  action + "&model=" + model + "&view_type=form";

describe("scratch records for a manual GUI run", () => {
  it("creates one contact and one lead", async () => {
    const stamp = new Date().toISOString().replace(/[:.]/g, "-");
    // The contact carries an email so the picker's name/email search finds it.
    const partnerId = (await client.execute("res.partner", "create", [
      {
        name: "ZZ Meetwings smoke GUI " + stamp,
        email: "zz-meetwings-smoke@example.invalid",
        comment: "Scratch target for a manual Meetwings end-to-end run. Safe to delete.",
      },
    ])) as number;
    const leadId = (await client.execute("crm.lead", "create", [
      {
        name: "ZZ Meetwings smoke GUI lead " + stamp,
        partner_id: partnerId,
        description: "Scratch target for a manual Meetwings end-to-end run. Safe to delete.",
      },
    ])) as number;

    console.log("\n============ AIM THE APP AT THESE ============");
    console.log("contact " + partnerId + ": " + form("res.partner", partnerId, 117, 154));
    console.log("lead    " + leadId + ": " + form("crm.lead", leadId, 145, 206));
    console.log("picker search term: ZZ Meetwings smoke GUI");
    console.log("==============================================\n");

    expect(partnerId).toBeGreaterThan(0);
    expect(leadId).toBeGreaterThan(0);
  });
});
