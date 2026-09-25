import { beforeEach, describe, expect, it, vi } from "vitest";

const action = vi.hoisted(() => ({
  listContactIds: vi.fn(async () => [] as number[]),
  deleteContact: vi.fn(async () => {}),
  loadTargets: vi.fn(async () => [] as unknown[]),
  removeSelectedTarget: vi.fn(async () => {}),
}));
vi.mock("@/lib/database/odoo-contacts.action", () => action);

import { ID_PAGE_LIMIT, reconcileDeletedContacts } from "@/lib/odoo/contacts-reconcile";
import { OdooError } from "@/lib/odoo/errors";

const INSTANCE = "http://h:8069|odoo";

/** A client whose execute() returns each queued id page in turn. */
function clientReturning(pages: unknown[]) {
  const execute = vi.fn(async () => pages.shift() ?? []);
  return { client: { authenticate: vi.fn(), execute, serverDate: null } as never, execute };
}

beforeEach(() => {
  Object.values(action).forEach((fn) => fn.mockReset());
  action.listContactIds.mockResolvedValue([]);
  action.deleteContact.mockResolvedValue(undefined);
  action.loadTargets.mockResolvedValue([]);
  action.removeSelectedTarget.mockResolvedValue(undefined);
  vi.spyOn(console, "warn").mockImplementation(() => {});
});

describe("reconcileDeletedContacts", () => {
  it("deletes a cached id Odoo no longer returns", async () => {
    action.listContactIds.mockResolvedValue([55, 56, 57]);
    const { client } = clientReturning([[55, 57]]);

    const removed = await reconcileDeletedContacts({ client, instance: INSTANCE });

    expect(removed).toBe(1);
    expect(action.deleteContact).toHaveBeenCalledTimes(1);
    expect(action.deleteContact).toHaveBeenCalledWith(INSTANCE, 56);
  });

  it("asks for archived partners too, with the cache's own type filter", async () => {
    action.listContactIds.mockResolvedValue([1]);
    const { client, execute } = clientReturning([[1]]);

    await reconcileDeletedContacts({ client, instance: INSTANCE });

    const [model, method, args, kwargs] = execute.mock.calls[0] as unknown as [
      string, string, unknown[][][], Record<string, unknown>
    ];
    expect(model).toBe("res.partner");
    expect(method).toBe("search");
    // Without active_test:false every archived contact reads as "deleted".
    expect(kwargs.context).toEqual({ active_test: false });
    expect(args[0]).toContainEqual(["type", "!=", "invoice"]);
  });

  it("drops a stale id from the overlay's pinned selection, only for res.partner", async () => {
    action.listContactIds.mockResolvedValue([56, 57]);
    action.loadTargets.mockResolvedValue([
      { model: "res.partner", resId: 56, name: "Andres Vergara" },
      { model: "crm.lead", resId: 56, name: "A lead that shares the number" },
    ]);
    const { client } = clientReturning([[57]]);

    await reconcileDeletedContacts({ client, instance: INSTANCE });

    expect(action.removeSelectedTarget).toHaveBeenCalledTimes(1);
    expect(action.removeSelectedTarget).toHaveBeenCalledWith(INSTANCE, "res.partner", 56);
  });

  it("deletes nothing when Odoo returns no ids at all", async () => {
    action.listContactIds.mockResolvedValue([1, 2, 3]);
    const { client } = clientReturning([[]]);

    expect(await reconcileDeletedContacts({ client, instance: INSTANCE })).toBe(0);
    expect(action.deleteContact).not.toHaveBeenCalled();
  });

  it("skips when more than half of a real-sized cache looks deleted", async () => {
    // A permissions change hides partners from the API user; they still exist,
    // and the write_date watermark would never bring them back.
    action.listContactIds.mockResolvedValue(Array.from({ length: 20 }, (_, i) => i + 1));
    const { client } = clientReturning([[1, 2, 3, 4, 5]]);

    expect(await reconcileDeletedContacts({ client, instance: INSTANCE })).toBe(0);
    expect(action.deleteContact).not.toHaveBeenCalled();
    expect(console.warn).toHaveBeenCalled();
  });

  it("does not apply that guard to a tiny cache", async () => {
    action.listContactIds.mockResolvedValue([1, 2]);
    const { client } = clientReturning([[2]]);

    expect(await reconcileDeletedContacts({ client, instance: INSTANCE })).toBe(1);
    expect(action.deleteContact).toHaveBeenCalledWith(INSTANCE, 1);
  });

  it("does not call Odoo at all when the cache is empty", async () => {
    const { client, execute } = clientReturning([]);

    expect(await reconcileDeletedContacts({ client, instance: INSTANCE })).toBe(0);
    expect(execute).not.toHaveBeenCalled();
  });

  it("pages by id cursor until a short page", async () => {
    action.listContactIds.mockResolvedValue([1, 2001, 5000]);
    const first = Array.from({ length: ID_PAGE_LIMIT }, (_, i) => i + 1);
    const { client, execute } = clientReturning([first, [2001]]);

    await reconcileDeletedContacts({ client, instance: INSTANCE });

    const secondDomain = (execute.mock.calls[1] as unknown as unknown[][][])[2][0];
    expect(secondDomain).toContainEqual(["id", ">", ID_PAGE_LIMIT]);
    expect(action.deleteContact).toHaveBeenCalledTimes(1);
    expect(action.deleteContact).toHaveBeenCalledWith(INSTANCE, 5000);
  });

  it("throws ODOO_UNEXPECTED_ROW on a non-list answer and deletes nothing", async () => {
    action.listContactIds.mockResolvedValue([1, 2, 3]);
    const { client } = clientReturning(["nope"]);

    await expect(reconcileDeletedContacts({ client, instance: INSTANCE })).rejects.toMatchObject({
      code: "ODOO_UNEXPECTED_ROW",
    });
    expect(action.deleteContact).not.toHaveBeenCalled();
  });

  it("throws on a non-integer id rather than treating it as absent", async () => {
    action.listContactIds.mockResolvedValue([1]);
    const { client } = clientReturning([[1, "2"]]);

    const err = await reconcileDeletedContacts({ client, instance: INSTANCE }).catch((e) => e);
    expect(err).toBeInstanceOf(OdooError);
    expect(action.deleteContact).not.toHaveBeenCalled();
  });

  it("throws when a non-empty page cannot advance the cursor", async () => {
    action.listContactIds.mockResolvedValue([1]);
    const { client } = clientReturning([[0]]);

    await expect(reconcileDeletedContacts({ client, instance: INSTANCE })).rejects.toMatchObject({
      code: "ODOO_UNEXPECTED_ROW",
    });
  });
});
