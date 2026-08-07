import { describe, expect, it, vi } from "vitest";
import { fetchOpportunities } from "@/lib/odoo/opportunities";

function clientReturning(rows: unknown) {
  const execute = vi.fn(async () => rows);
  return { client: { authenticate: vi.fn(), execute, serverDate: null }, execute };
}

const lead = (over: Record<string, unknown> = {}) => ({
  id: 5,
  name: "Heat pump retrofit",
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
      { id: 5, name: "Heat pump retrofit", stageName: "Proposition", partnerId: 1, partnerName: "Ada Lovelace" },
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
    expect(domain).toContainEqual(["type", "=", "opportunity"]);
    expect(domain).toContainEqual(["active", "=", true]);
    expect(domain).toContainEqual(["probability", "<", 100]);
    expect(kwargs.limit).toBe(20);
    expect(kwargs.order).toBe("write_date desc");
  });

  it("survives a lead with a false stage_id or partner_id", async () => {
    const { client } = clientReturning([lead({ stage_id: false, partner_id: false })]);
    await expect(fetchOpportunities(client, 1, null)).resolves.toEqual([
      { id: 5, name: "Heat pump retrofit", stageName: null, partnerId: null, partnerName: null },
    ]);
  });

  it("throws ODOO_UNEXPECTED_ROW for a lead with no usable id", async () => {
    const { client } = clientReturning([{ name: "no id" }]);
    await expect(fetchOpportunities(client, 1, null)).rejects.toMatchObject({
      code: "ODOO_UNEXPECTED_ROW",
    });
  });
});
