import { describe, expect, it } from "vitest";
import { decideDestinations } from "@/lib/notion/destinations";

type Input = Parameters<typeof decideDestinations>[0];
type Decision = ReturnType<typeof decideDestinations>;

// A literal table: every expectation is written out, never computed with the
// code under test. Dimensions the rule ignores are fanned out with flatMap so
// the table proves they are ignored rather than assuming it.
const BOOLS = [true, false];

const I = (
  source: Input["source"],
  odoo: Input["odoo"],
  notion: boolean,
  autoSend: boolean,
  notionPicked: boolean,
  odooTargets = 0
): Input => ({ source, odoo, notion, autoSend, notionPicked, odooTargets });

const Q = (
  odooStatus: "held" | "unassigned" | "none",
  notionStatus: "held" | "offered" | "waiting" | null,
  toastIncomplete = false
): Decision => ({ queue: true, odooStatus, notionStatus, toastIncomplete });

const NO = (toastIncomplete = false): Decision => ({ queue: false, toastIncomplete });

/** Every autoSend x picked combination, for cells that ignore both. */
const anyFlags = (
  source: Input["source"],
  odoo: Input["odoo"],
  notion: boolean,
  odooTargets: number,
  expected: Decision
): [Input, Decision][] =>
  BOOLS.flatMap((autoSend) =>
    BOOLS.map((picked): [Input, Decision] => [
      I(source, odoo, notion, autoSend, picked, odooTargets),
      expected,
    ])
  );

const MATRIX: [Input, Decision][] = [
  // Notion off: today's behaviour.
  ...anyFlags("live", "absent", false, 0, NO()),
  ...anyFlags("recovery", "absent", false, 0, NO()),
  ...anyFlags("live", "incomplete", false, 0, NO(true)),
  ...anyFlags("recovery", "incomplete", false, 0, NO(false)),
  ...anyFlags("live", "complete", false, 0, Q("unassigned", null)),
  ...anyFlags("live", "complete", false, 2, Q("held", null)),
  ...anyFlags("recovery", "complete", false, 0, Q("unassigned", null)),

  // Notion only (Odoo absent): Odoo is always 'none'; picked is ignored.
  [I("live", "absent", true, true, false), Q("none", "held")],
  [I("live", "absent", true, true, true), Q("none", "held")],
  [I("live", "absent", true, false, false), Q("none", "offered")],
  [I("live", "absent", true, false, true), Q("none", "offered")],
  [I("recovery", "absent", true, true, false), Q("none", "waiting")],
  [I("recovery", "absent", true, true, true), Q("none", "waiting")],
  [I("recovery", "absent", true, false, false), Q("none", "offered")],
  [I("recovery", "absent", true, false, true), Q("none", "offered")],

  // Both set up: picked decides, autoSend is ignored.
  ...BOOLS.flatMap((a): [Input, Decision][] => [
    [I("live", "complete", true, a, true, 0), Q("none", "held")],
    [I("live", "complete", true, a, true, 2), Q("held", "held")],
    [I("live", "complete", true, a, false, 0), Q("unassigned", null)],
    [I("live", "complete", true, a, false, 2), Q("held", null)],
    [I("recovery", "complete", true, a, true, 0), Q("unassigned", null)],
    [I("recovery", "complete", true, a, false, 0), Q("unassigned", null)],
  ]),

  // Odoo half-filled, Notion on.
  ...BOOLS.flatMap((a): [Input, Decision][] => [
    [I("live", "incomplete", true, a, true), Q("none", "held", true)],
    [I("live", "incomplete", true, a, false), Q("none", "offered", true)],
    [I("recovery", "incomplete", true, a, true), Q("none", "offered", false)],
    [I("recovery", "incomplete", true, a, false), Q("none", "offered", false)],
  ]),
];

describe("decideDestinations", () => {
  it.each(MATRIX)("%o -> %o", (input, expected) => {
    expect(decideDestinations(input)).toEqual(expected);
  });

  it("never returns held/pending/unassigned for Odoo when Odoo is absent", () => {
    const absent = MATRIX.filter(([i]) => i.odoo === "absent");
    expect(absent.length).toBeGreaterThan(0);
    for (const [input] of absent) {
      for (const odooTargets of [0, 3]) {
        const d = decideDestinations({ ...input, odooTargets });
        if (d.queue) expect(d.odooStatus).toBe("none");
      }
    }
  });

  it("never asks to toast an incomplete Odoo setup from recovery", () => {
    for (const [input] of MATRIX.filter(([i]) => i.source === "recovery")) {
      expect(decideDestinations(input).toastIncomplete).toBe(false);
    }
  });
});
