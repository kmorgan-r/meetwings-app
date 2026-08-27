import { describe, expect, it, vi } from "vitest";
import {
  fetchOpportunities,
  leadSearchDomain,
  searchDomain,
  searchLeads,
} from "@/lib/odoo/opportunities";

function clientReturning(rows: unknown) {
  const execute = vi.fn(async () => rows);
  return { client: { authenticate: vi.fn(), execute, serverDate: null }, execute };
}

/** Only the four fields the lookup reads. */
const ada = (over: Record<string, unknown> = {}) => ({
  id: 1,
  parentId: null as number | null,
  name: "Ada Lovelace",
  email: "ada@analytical.example" as string | null,
  ...over,
});

const lead = (over: Record<string, unknown> = {}) => ({
  id: 5,
  name: "Heat pump retrofit",
  type: "opportunity",
  stage_id: [3, "Proposition"],
  partner_id: [1, "Ada Lovelace"],
  probability: 40,
  contact_name: false,
  email_from: false,
  ...over,
});

const mapped = (over: Record<string, unknown> = {}) => ({
  id: 5,
  name: "Heat pump retrofit",
  type: "opportunity",
  stageName: "Proposition",
  partnerId: 1,
  partnerName: "Ada Lovelace",
  contactName: null,
  email: null,
  ...over,
});

describe("fetchOpportunities", () => {
  it("returns [] when there are none", async () => {
    const { client } = clientReturning([]);
    await expect(fetchOpportunities(client, ada())).resolves.toEqual([]);
  });

  it("maps a single result", async () => {
    const { client } = clientReturning([lead()]);
    await expect(fetchOpportunities(client, ada())).resolves.toEqual([mapped()]);
  });

  it("returns several", async () => {
    const { client } = clientReturning([lead(), lead({ id: 6, name: "Solar" })]);
    await expect(fetchOpportunities(client, ada())).resolves.toHaveLength(2);
  });

  it("asks crm.lead, bounded and newest first", async () => {
    const { client, execute } = clientReturning([]);
    await fetchOpportunities(client, ada());
    const [model, method, , kwargs] = execute.mock.calls[0];
    expect(model).toBe("crm.lead");
    expect(method).toBe("search_read");
    expect(kwargs.limit).toBe(20);
    expect(kwargs.order).toBe("write_date desc");
    // Without these two an UNLINKED lead renders as a bare subject line with
    // nothing on it tying it to the contact on screen.
    expect(kwargs.fields).toContain("contact_name");
    expect(kwargs.fields).toContain("email_from");
    expect(kwargs.fields).toContain("type");
  });

  it("survives a lead with a false stage_id or partner_id", async () => {
    const { client } = clientReturning([lead({ stage_id: false, partner_id: false })]);
    await expect(fetchOpportunities(client, ada())).resolves.toEqual([
      mapped({ stageName: null, partnerId: null, partnerName: null }),
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
    const [result] = await fetchOpportunities(client, ada());
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
    const [result] = await fetchOpportunities(client, ada());
    expect(result.partnerId).toBeNull();
    expect(result.partnerName).toBeNull();
  });

  // Leads and opportunities are one Odoo table; the picker offers both, and the
  // row label and the destination sentence have to name the right one, so the
  // kind has to survive the mapping.
  it("carries a lead's type through", async () => {
    const { client } = clientReturning([lead({ id: 7, name: "Website form", type: "lead" })]);
    const [result] = await fetchOpportunities(client, ada());
    expect(result.type).toBe("lead");
  });

  // A missing or unreadable `type` must read as an opportunity - the kind every
  // row this function returned before leads existed. Defaulting the other way
  // would print "Lead" beside a deal, and the label is what the user picks by.
  it("reads an unusable type as an opportunity, never as a lead", async () => {
    const { client } = clientReturning([lead({ type: false }), lead({ id: 8, type: undefined })]);
    const rows = await fetchOpportunities(client, ada());
    expect(rows.map((r) => r.type)).toEqual(["opportunity", "opportunity"]);
  });

  // The free text an unlinked lead carries INSTEAD of a partner. Odoo returns
  // `false` for an empty char field, never "".
  it("carries an unlinked lead's own contact details, and nulls empty ones", async () => {
    const { client } = clientReturning([
      lead({ id: 9, type: "lead", partner_id: false, contact_name: "Christian Carron", email_from: "cc@ecs.example" }),
      lead({ id: 10, type: "lead", partner_id: false }),
    ]);
    const rows = await fetchOpportunities(client, ada());
    expect(rows[0]).toMatchObject({
      contactName: "Christian Carron",
      email: "cc@ecs.example",
    });
    expect(rows[1]).toMatchObject({ contactName: null, email: null });
  });

  it("throws ODOO_UNEXPECTED_ROW for a lead with no usable id", async () => {
    const { client } = clientReturning([{ name: "no id" }]);
    await expect(fetchOpportunities(client, ada())).rejects.toMatchObject({
      code: "ODOO_UNEXPECTED_ROW",
    });
  });
});

/**
 * The domain is asserted WHOLE, not clause by clause.
 *
 * Odoo domains are prefix notation, so the operators and their operand counts
 * are as load-bearing as the leaves themselves - a `toContainEqual` per clause
 * passes happily against a domain whose "&"/"|" nesting means something else
 * entirely.
 */
describe("searchDomain", () => {
  it("builds the whole thing: linked records, or an unlinked lead by identity", () => {
    expect(searchDomain(ada({ parentId: 9 }))).toEqual([
      ["active", "=", true],
      ["type", "in", ["lead", "opportunity"]],
      // The won filter, scoped to opportunities: a lead is never won.
      "|",
      ["type", "=", "lead"],
      ["probability", "<", 100],
      // Reachability: Odoo's own link, OR an unlinked lead that names this
      // contact itself.
      "|",
      ["partner_id", "in", [1, 9]],
      "&",
      "&",
      ["type", "=", "lead"],
      ["partner_id", "=", false],
      "|",
      ["email_from", "=ilike", "ada@analytical.example"],
      ["contact_name", "=ilike", "Ada Lovelace"],
    ]);
  });

  // In Odoo an opportunity for a person at a company is very commonly held on
  // the COMPANY partner. Searching only partner_id = contactId returns zero
  // rows for exactly the human you are meeting, the "None" branch fires
  // silently, and slice 2 posts to the contact record while open deals sit on
  // the parent.
  it("searches the parent company as well as the contact", () => {
    expect(searchDomain(ada({ parentId: 9 }))).toContainEqual(["partner_id", "in", [1, 9]]);
  });

  it("omits a null parent", () => {
    expect(searchDomain(ada())).toContainEqual(["partner_id", "in", [1]]);
  });

  // active = false means LOST in Odoo; WON opportunities stay active = true
  // forever, so without this the list grows with every deal ever closed.
  it("keeps lost records out", () => {
    expect(searchDomain(ada())).toContainEqual(["active", "=", true]);
  });

  // THE BUG THIS CLAUSE EXISTS FOR. Odoo's default for an unconverted lead is
  // free-text contact details and NO partner, so a partner_id-only search finds
  // none of them - a real Leads list looked empty here.
  it("finds an unlinked lead by the contact's own name and email", () => {
    const domain = searchDomain(ada());
    expect(domain).toContainEqual(["contact_name", "=ilike", "Ada Lovelace"]);
    expect(domain).toContainEqual(["email_from", "=ilike", "ada@analytical.example"]);
    // A lead already pointed at a DIFFERENT partner belongs to that partner,
    // whatever name it carries.
    expect(domain).toContainEqual(["partner_id", "=", false]);
  });

  // `ilike` wraps its value in %...%, so "ada@x.com" would also match
  // "notada@x.com" - a meeting posted to a stranger's lead.
  it("never uses a substring operator for the identity match", () => {
    const flat = JSON.stringify(searchDomain(ada()));
    expect(flat).toContain('"=ilike"');
    expect(flat).not.toContain('"ilike"');
    expect(flat).not.toContain('"like"');
  });

  it("drops the email clause for a contact that has none", () => {
    const domain = searchDomain(ada({ email: null }));
    expect(JSON.stringify(domain)).not.toContain("email_from");
    expect(domain).toContainEqual(["contact_name", "=ilike", "Ada Lovelace"]);
  });

  // Nothing to recognise an unlinked lead BY. Widening the search on a blank
  // value would match every unlinked lead in the database.
  it("asks only for linked records when the contact has no identity at all", () => {
    expect(searchDomain(ada({ name: "   ", email: null }))).toEqual([
      ["active", "=", true],
      ["type", "in", ["lead", "opportunity"]],
      "|",
      ["type", "=", "lead"],
      ["probability", "<", 100],
      ["partner_id", "in", [1]],
    ]);
  });

  // `probability` is nullable in Postgres and NULL < 100 is NULL, i.e.
  // excluded - so a probability filter applied to leads can silently drop every
  // one of them. It buys nothing either way: a lead is converted (which flips
  // `type`) or lost (which clears `active`), never won.
  it("scopes the won filter to opportunities so no lead is caught by it", () => {
    const domain = searchDomain(ada());
    const wonAt = domain.findIndex(
      (t) => JSON.stringify(t) === JSON.stringify(["probability", "<", 100])
    );
    expect(wonAt).toBeGreaterThan(0);
    expect(domain[wonAt - 1]).toEqual(["type", "=", "lead"]);
    expect(domain[wonAt - 2]).toBe("|");
  });
});

/**
 * The only way to reach a record the contact-first flow cannot.
 *
 * `fetchOpportunities` starts from a res.partner. An unconverted lead has none
 * - not one that is hard to find, one that does not exist - so there is no
 * contact to select first and no lookup to hang off it.
 */
describe("searchLeads", () => {
  it("builds the whole domain: unwon, active, and any of four text fields", () => {
    expect(leadSearchDomain("carron")).toEqual([
      ["active", "=", true],
      "|",
      ["type", "=", "lead"],
      ["probability", "<", 100],
      "|",
      "|",
      "|",
      ["name", "ilike", "carron"],
      ["contact_name", "ilike", "carron"],
      ["partner_name", "ilike", "carron"],
      ["email_from", "ilike", "carron"],
    ]);
  });

  // Deliberately the OPPOSITE operator to searchDomain's identity match. That
  // one asks "is this the same person" and must be exact; this is a user
  // typing a fragment, where the wrapping %...% is the entire point.
  it("uses substring matching, unlike the identity match", () => {
    const flat = JSON.stringify(leadSearchDomain("carron"));
    expect(flat).toContain('"ilike"');
    expect(flat).not.toContain('"=ilike"');
  });

  it("asks crm.lead, bounded and newest first", async () => {
    const { client, execute } = clientReturning([]);
    await searchLeads(client, "carron");
    const [model, method, args, kwargs] = execute.mock.calls[0];
    expect(model).toBe("crm.lead");
    expect(method).toBe("search_read");
    expect(args[0]).toEqual(leadSearchDomain("carron"));
    expect(kwargs.limit).toBe(10);
    expect(kwargs.order).toBe("write_date desc");
  });

  it("maps rows exactly as the contact lookup does", async () => {
    const { client } = clientReturning([
      lead({ id: 90, name: "Partnership with ECS", type: "lead", partner_id: false, contact_name: "Christian Carron" }),
    ]);
    await expect(searchLeads(client, "carron")).resolves.toEqual([
      {
        id: 90,
        name: "Partnership with ECS",
        type: "lead",
        stageName: "Proposition",
        partnerId: null,
        partnerName: null,
        contactName: "Christian Carron",
        email: null,
      },
    ]);
  });

  // A one-character `ilike` matches a large fraction of any real CRM and an
  // empty one matches ALL of it - and this fires from a debounce timer on the
  // way to a real query, not only when the user has stopped typing.
  it("does not go to the wire for a query too short to mean anything", async () => {
    const { client, execute } = clientReturning([]);
    await expect(searchLeads(client, "c")).resolves.toEqual([]);
    await expect(searchLeads(client, "   ")).resolves.toEqual([]);
    await expect(searchLeads(client, "")).resolves.toEqual([]);
    expect(execute).not.toHaveBeenCalled();
  });

  it("searches on the trimmed value, not the raw one", async () => {
    const { client, execute } = clientReturning([]);
    await searchLeads(client, "  carron  ");
    expect(execute.mock.calls[0][2][0]).toEqual(leadSearchDomain("carron"));
  });

  it("throws ODOO_UNEXPECTED_ROW for a row with no usable id", async () => {
    const { client } = clientReturning([{ name: "no id" }]);
    await expect(searchLeads(client, "carron")).rejects.toMatchObject({
      code: "ODOO_UNEXPECTED_ROW",
    });
  });
});
