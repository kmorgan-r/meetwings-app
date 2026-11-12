export type OdooSetup = "absent" | "incomplete" | "complete";

export type Decision =
  | { queue: false; toastIncomplete: boolean }
  | {
      queue: true;
      odooStatus: "held" | "unassigned" | "none";
      notionStatus: "held" | "offered" | "waiting" | null;
      toastIncomplete: boolean;
    };

export interface DestinationInput {
  source: "live" | "recovery";
  odoo: OdooSetup;
  notion: boolean;
  autoSend: boolean;
  odooTargets: number;
  notionPicked: boolean;
}

/**
 * Where an ended meeting goes (spec section 6). Pure, so the whole table is
 * testable without a database.
 *
 * Odoo absent means Odoo status 'none', never held/unassigned: a row written
 * that way would show "Finish setting Odoo up" to a Notion-only user.
 * `toastIncomplete` is never true for recovery: it runs at startup with no
 * just-ended meeting to explain the toast.
 */
export function decideDestinations(i: DestinationInput): Decision {
  const live = i.source === "live";
  const toast = live && i.odoo === "incomplete";

  if (!i.notion) {
    if (i.odoo !== "complete") return { queue: false, toastIncomplete: toast };
    return {
      queue: true,
      odooStatus: live && i.odooTargets > 0 ? "held" : "unassigned",
      notionStatus: null,
      toastIncomplete: false,
    };
  }

  if (i.odoo === "absent") {
    return {
      queue: true,
      odooStatus: "none",
      notionStatus: !i.autoSend ? "offered" : live ? "held" : "waiting",
      toastIncomplete: false,
    };
  }

  if (i.odoo === "complete") {
    if (!live || !i.notionPicked) {
      return {
        queue: true,
        odooStatus: live && i.odooTargets > 0 ? "held" : "unassigned",
        notionStatus: null,
        toastIncomplete: false,
      };
    }
    return {
      queue: true,
      odooStatus: i.odooTargets > 0 ? "held" : "none",
      notionStatus: "held",
      toastIncomplete: false,
    };
  }

  // incomplete
  if (!live) {
    return { queue: true, odooStatus: "none", notionStatus: "offered", toastIncomplete: false };
  }
  // Not picked is offered, as recovery does: never dropped, never auto-sent.
  return { queue: true, odooStatus: "none", notionStatus: i.notionPicked ? "held" : "offered", toastIncomplete: true };
}
