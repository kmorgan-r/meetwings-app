import { beforeEach, describe, expect, it, vi } from "vitest";
import { createOrAdoptContact } from "@/lib/odoo/create-contact";
import { OdooError } from "@/lib/odoo/errors";
import type { OdooClient } from "@/lib/odoo/client";
import type { XmlRpcValue } from "@/lib/odoo/xmlrpc-codec";
import { PARTNER_FIELDS } from "@/lib/odoo/contacts-sync";

/** A raw Odoo record, as search_read returns it (snake_case, false for unset). */
function row(over: Record<string, unknown> = {}) {
  return {
    id: 7,
    name: "Jane Doe",
    email: "jane@acme.example",
    phone: false,
    parent_id: false,
    is_company: false,
    active: true,
    write_date: "2026-09-05 10:00:00",
    type: "contact",
    ...over,
  };
}

/** Queues one response per execute() call, in order. */
function clientReturning(...responses: XmlRpcValue[]): {
  client: OdooClient;
  execute: ReturnType<typeof vi.fn>;
} {
  const execute = vi.fn();
  for (const r of responses) execute.mockResolvedValueOnce(r);
  return { client: { authenticate: vi.fn(), execute, serverDate: null } as OdooClient, execute };
}

const args = { address: "Jane@Acme.Example", name: "Jane Doe", parentId: null };

beforeEach(() => vi.clearAllMocks());

describe("createOrAdoptContact - the Layer 1 search", () => {
  it("searches on the normalized email with =ilike, active_test false, and NO limit", async () => {
    const { client, execute } = clientReturning([], 7, [row()]);
    await createOrAdoptContact({ client, ...args });
    const [model, method, callArgs, kwargs] = execute.mock.calls[0];
    expect(model).toBe("res.partner");
    expect(method).toBe("search_read");
    expect(callArgs).toEqual([[["email", "=ilike", "jane@acme.example"]]]);
    expect(kwargs.context).toEqual({ active_test: false });
    // Every row() fixture always carries `active`, so dropping it from
    // PARTNER_FIELDS would go undetected by every other test in this file -
    // and against a live server, parsePartnerRow's `row.active !== false`
    // would then read every archived partner as active.
    expect(kwargs.fields).toEqual(PARTNER_FIELDS);
    // A limit makes the active-vs-archived branch arbitrary - see the spec.
    expect(kwargs).not.toHaveProperty("limit");
  });

  it("raises ODOO_UNEXPECTED_ROW when the search returns a non-list", async () => {
    const { client } = clientReturning(false);
    await expect(createOrAdoptContact({ client, ...args })).rejects.toMatchObject({
      code: "ODOO_UNEXPECTED_ROW",
    });
  });
});

describe("createOrAdoptContact - adopting", () => {
  it("adopts an active hit without calling create", async () => {
    const { client, execute } = clientReturning([row({ id: 7 })]);
    const out = await createOrAdoptContact({ client, ...args });
    expect(out).toMatchObject({ kind: "adopted-active" });
    expect(execute).toHaveBeenCalledTimes(1);
    expect(execute.mock.calls.some(([, method]) => method === "create")).toBe(false);
  });

  it("distinguishes an archived hit from an active one", async () => {
    const { client } = clientReturning([row({ id: 7, active: false })]);
    const out = await createOrAdoptContact({ client, ...args });
    expect(out).toMatchObject({ kind: "adopted-archived" });
  });

  // Two partners sharing an email is routine in Odoo. Telling the user to go
  // un-archive somebody while an ACTIVE partner with that email exists is the
  // failure a limit:1 with no order would produce at random.
  it.each([
    ["archived first", [row({ id: 8, active: false }), row({ id: 9, active: true })]],
    ["active first", [row({ id: 9, active: true }), row({ id: 8, active: false })]],
  ])("prefers the active partner over the archived one (%s)", async (_label, rows) => {
    const { client } = clientReturning(rows);
    const out = await createOrAdoptContact({ client, ...args });
    expect(out).toMatchObject({ kind: "adopted-active" });
    expect((out as { contact: { id: number } }).contact.id).toBe(9);
  });

  it("prefers a person over a company when both are active", async () => {
    const { client } = clientReturning([
      row({ id: 3, is_company: true }),
      row({ id: 4, is_company: false }),
    ]);
    const out = await createOrAdoptContact({ client, ...args });
    expect((out as { contact: { id: number } }).contact.id).toBe(4);
  });

  it("prefers the lowest id between two people", async () => {
    const { client } = clientReturning([row({ id: 31 }), row({ id: 30 })]);
    const out = await createOrAdoptContact({ client, ...args });
    expect((out as { contact: { id: number } }).contact.id).toBe(30);
  });

  // A mutant that reads the first element as a bare id (the shape `firstId`
  // expects) returns null for every hit, silently skips the adopt, and creates
  // a duplicate on EVERY hit. This pins the record shape.
  it("adopts from the returned record, not from a bare id", async () => {
    const { client, execute } = clientReturning([row({ id: 7, name: "Jane From Odoo" })]);
    const out = await createOrAdoptContact({ client, ...args });
    expect((out as { contact: { name: string } }).contact.name).toBe("Jane From Odoo");
    expect(execute).toHaveBeenCalledTimes(1);
  });

  // `=ilike` is Odoo's SQL ILIKE with no escaping: an underscore in the
  // searched address matches any single character server-side. A row whose
  // email is merely a wildcard hit - not an exact match - must not be adopted.
  it("does not adopt a =ilike wildcard false positive - falls through to create", async () => {
    const { client } = clientReturning(
      [row({ id: 5, email: "janexdoe@acme.example" })],
      7,
      [row({ id: 7, email: "jane_doe@acme.example" })]
    );
    const out = await createOrAdoptContact({
      client,
      address: "jane_doe@acme.example",
      name: "Jane Doe",
      parentId: null,
    });
    expect(out).toMatchObject({ kind: "created" });
  });

  // The sharp case: a wildcard false positive and the real exact row come
  // back TOGETHER, and the wildcard row is built to WIN preferForAdoption on
  // its own (active, lower id) if it were ever allowed to compete. Without
  // filtering to the exact email first, the wrong partner gets adopted and
  // the user's notes land on somebody else's record.
  it("adopts the exact-email row even when a =ilike wildcard match would outrank it", async () => {
    const wildcard = row({ id: 5, email: "janexdoe@acme.example" });
    const exact = row({ id: 9, email: "jane_doe@acme.example" });
    const { client } = clientReturning([wildcard, exact]);
    const out = await createOrAdoptContact({
      client,
      address: "jane_doe@acme.example",
      name: "Jane Doe",
      parentId: null,
    });
    expect(out).toMatchObject({ kind: "adopted-active" });
    expect((out as { contact: { id: number } }).contact.id).toBe(9);
  });
});

describe("createOrAdoptContact - creating", () => {
  it("creates with type contact and is_company false, then reads back", async () => {
    const { client, execute } = clientReturning([], 7, [row({ name: "Jane From Odoo" })]);
    const out = await createOrAdoptContact({ client, ...args });
    expect(out).toMatchObject({ kind: "created" });

    const [, createMethod, createArgs] = execute.mock.calls[1];
    expect(createMethod).toBe("create");
    // `type` is EXPLICIT: the sync domain excludes delivery/invoice/other, so a
    // partner created with an unlucky default is invisible to this app forever.
    expect(createArgs[0]).toEqual({
      name: "Jane Doe",
      email: "jane@acme.example",
      is_company: false,
      type: "contact",
      parent_id: false,
    });

    const [, readMethod, readArgs, readKwargs] = execute.mock.calls[2];
    expect(readMethod).toBe("search_read");
    expect(readArgs).toEqual([[["id", "=", 7]]]);
    expect(readKwargs.context).toEqual({ active_test: false });
    expect(readKwargs.fields).toEqual(PARTNER_FIELDS);
    // The read-back row's name differs from the draft ("Jane Doe") passed to
    // create. A fabricated contact built from the create id and the draft
    // would carry "Jane Doe" here instead - this pins that the returned
    // contact comes from parsePartnerRow(back[0]), not from the create call.
    expect((out as { contact: { name: string } }).contact.name).toBe("Jane From Odoo");
  });

  it("sends parent_id false, not null and not omitted, when no company is chosen", async () => {
    const { client, execute } = clientReturning([], 7, [row()]);
    await createOrAdoptContact({ client, ...args, parentId: null });
    expect(execute.mock.calls[1][2][0].parent_id).toBe(false);
  });

  it("sends the chosen company id when there is one", async () => {
    const { client, execute } = clientReturning([], 7, [row({ parent_id: [90, "Acme Ltd"] })]);
    await createOrAdoptContact({ client, ...args, parentId: 90 });
    expect(execute.mock.calls[1][2][0].parent_id).toBe(90);
  });

  it("raises ODOO_UNEXPECTED_ROW when create returns a non-integer", async () => {
    const { client } = clientReturning([], false);
    await expect(createOrAdoptContact({ client, ...args })).rejects.toMatchObject({
      code: "ODOO_UNEXPECTED_ROW",
    });
  });

  // `expectRows` wraps BOTH search_read calls. Without this case a mutant that
  // drops it from the read-back only - leaving `back.length` to throw a raw
  // TypeError instead of a typed ODOO_UNEXPECTED_ROW - passes the whole file,
  // because the search's own non-list case is tested and the read-back's is not.
  it("raises ODOO_UNEXPECTED_ROW when the read-back returns a non-list", async () => {
    const { client } = clientReturning([], 7, false);
    await expect(createOrAdoptContact({ client, ...args })).rejects.toMatchObject({
      code: "ODOO_UNEXPECTED_ROW",
    });
  });

  // Record rules can hide a record from the API user that created it. No cache
  // row is fabricated - a synthesised row would produce a proposal row whose
  // target write then fails, or silently succeeds against an unseeable record.
  it("reports created-invisible and no contact when the read-back is empty", async () => {
    const { client } = clientReturning([], 7, []);
    const out = await createOrAdoptContact({ client, ...args });
    expect(out).toEqual({ kind: "created-invisible" });
  });
});

describe("createOrAdoptContact - failures reach the caller with their code", () => {
  it.each(["ODOO_FAULT", "ODOO_UNREACHABLE"] as const)("propagates %s unchanged", async (code) => {
    const execute = vi.fn().mockRejectedValue(new OdooError(code, "boom", {}));
    const client = { authenticate: vi.fn(), execute, serverDate: null } as OdooClient;
    await expect(createOrAdoptContact({ client, ...args })).rejects.toMatchObject({ code });
  });
});
