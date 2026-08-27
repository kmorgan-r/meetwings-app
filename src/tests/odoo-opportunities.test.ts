import { describe, expect, it, vi } from "vitest";
import { fetchOpportunities } from "@/lib/odoo/opportunities";

function clientReturning(rows: unknown) {
  const execute = vi.fn(async () => rows);
  return { client: { authenticate: vi.fn(), execute, serverDate: null }, execute };
}

const lead = (over: Record<string, unknown> = {}) => ({
  id: 5,
  name: "Heat pump retrofit",
  type: "opportunity",
  stage_id: [3, "Proposition"],
  partner_id: [1, "Ada Lovelace"],
  probability: 40,
  ...over,
});

describe("fetchOpportunities", () => {
  it("returns [] when there are none", async () => {
    const { client } = clientReturning([]);
    await expect(fetchOpportunities(client, 1, null)).resolves.toEqual([]);
  });

  it("maps a single result", async () => {
    const { client } = clientReturning([lead()]);
    await expect(fetchOpportunities(client, 1, null)).resolves.toEqual([
      {
        id: 5,
        name: "Heat pump retrofit",
        type: "opportunity",
        stageName: "Proposition",
        partnerId: 1,
        partnerName: "Ada Lovelace",
      },
    ]);
  });

  it("returns several", async () => {
    const { client } = clientReturning([lead(), lead({ id: 6, name: "Solar" })]);
    await expect(fetchOpportunities(client, 1, null)).resolves.toHaveLength(2);
  });

  // In Odoo an opportunity for a person at a company is very commonly held on
  // the COMPANY partner. Searching only partner_id = contactId returns zero
  // rows for exactly the human you are meeting, the "None" branch fires
  // silently, and slice 2 posts to the contact record while open deals sit on
  // the parent.
  it("searches the parent company as well as the contact", async () => {
    const { client, execute } = clientReturning([]);
    await fetchOpportunities(client, 1, 9);
    const domain = execute.mock.calls[0][2][0] as unknown[][];
    expect(domain).toContainEqual(["partner_id", "in", [1, 9]]);
  });

  it("omits a null parent from the domain", async () => {
    const { client, execute } = clientReturning([]);
    await fetchOpportunities(client, 1, null);
    const domain = execute.mock.calls[0][2][0] as unknown[][];
    expect(domain).toContainEqual(["partner_id", "in", [1]]);
  });

  // active = false means LOST in Odoo; WON opportunities stay active = true
  // forever, so without this the list grows with every deal ever closed.
  it("excludes won leads and caps the result set", async () => {
    const { client, execute } = clientReturning([]);
    await fetchOpportunities(client, 1, null);
    const [model, method, args, kwargs] = execute.mock.calls[0];
    expect(model).toBe("crm.lead");
    expect(method).toBe("search_read");
    const domain = args[0] as unknown[][];
    expect(domain).toContainEqual(["type", "in", ["lead", "opportunity"]]);
    expect(domain).toContainEqual(["active", "=", true]);
    expect(domain).toContainEqual(["probability", "<", 100]);
    expect(kwargs.limit).toBe(20);
    expect(kwargs.order).toBe("write_date desc");
  });

  it("survives a lead with a false stage_id or partner_id", async () => {
    const { client } = clientReturning([lead({ stage_id: false, partner_id: false })]);
    await expect(fetchOpportunities(client, 1, null)).resolves.toEqual([
      {
        id: 5,
        name: "Heat pump retrofit",
        type: "opportunity",
        stageName: null,
        partnerId: null,
        partnerName: null,
      },
    ]);
  });

  // A many2one is `[id, name]` or `false` - nothing else. A parser that
  // assumes a tuple without checking Array.isArray + element types still
  // "works" on a plain string, because strings have numeric indices too:
  // "ab"[0] and "ab"[1] read as "a" and "b" instead of throwing, so a
  // guardless parser quietly returns { id: "a", name: "b" } - a string
  // leaking into a field typed number | null - instead of null.
  it("treats a many2one string as unreadable, not a tuple", async () => {
    const { client } = clientReturning([lead({ partner_id: "ab" })]);
    const [result] = await fetchOpportunities(client, 1, null);
    expect(result.partnerId).toBeNull();
    expect(result.partnerName).toBeNull();
  });

  // A single-element array has a real value at index 0 and `undefined` at
  // index 1. Deliberately asserted on partnerId, not stageName: a truncated
  // array's missing index 1 collapses to `undefined` whether or not the
  // guard runs, and `?? null` masks that identically either way, so a
  // stageName-only assertion cannot tell a guarded parser from a guardless
  // one. The id at index 0 is real, though, so it leaks into `partnerId`
  // (typed number | null) for a value that was never a valid [id, name] pair.
  it("treats a truncated many2one array as unreadable, not a tuple", async () => {
    const { client } = clientReturning([lead({ partner_id: [5] })]);
    const [result] = await fetchOpportunities(client, 1, null);
    expect(result.partnerId).toBeNull();
    expect(result.partnerName).toBeNull();
  });

  // Leads and opportunities are one Odoo table; the picker offers both, and the
  // row label and the destination sentence have to name the right one, so the
  // kind has to survive the mapping.
  it("carries a lead's type through", async () => {
    const { client } = clientReturning([lead({ id: 7, name: "Website form", type: "lead" })]);
    const [result] = await fetchOpportunities(client, 1, null);
    expect(result.type).toBe("lead");
  });

  it("asks the CRM for both kinds, not opportunities alone", async () => {
    const { client, execute } = clientReturning([]);
    await fetchOpportunities(client, 1, null);
    const [, , args, kwargs] = execute.mock.calls[0];
    const domain = args[0] as unknown[][];
    expect(domain).toContainEqual(["type", "in", ["lead", "opportunity"]]);
    expect(kwargs.fields).toContain("type");
  });

  // A missing or unreadable `type` must read as an opportunity - the kind every
  // row this function returned before leads existed. Defaulting the other way
  // would print "Lead" beside a deal, and the label is what the user picks by.
  it("reads an unusable type as an opportunity, never as a lead", async () => {
    const { client } = clientReturning([lead({ type: false }), lead({ id: 8, type: undefined })]);
    const rows = await fetchOpportunities(client, 1, null);
    expect(rows.map((r) => r.type)).toEqual(["opportunity", "opportunity"]);
  });

  it("throws ODOO_UNEXPECTED_ROW for a lead with no usable id", async () => {
    const { client } = clientReturning([{ name: "no id" }]);
    await expect(fetchOpportunities(client, 1, null)).rejects.toMatchObject({
      code: "ODOO_UNEXPECTED_ROW",
    });
  });
});
