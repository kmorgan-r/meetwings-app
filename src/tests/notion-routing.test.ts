import { describe, expect, it } from "vitest";
import {
  TEAM_TIME_WINDOW_MS,
  buildMapping,
  describeMapping,
  describeSubTable,
  routeMeeting,
  type Mapping,
  type SubTable,
} from "@/lib/notion/routing";
import type { Weekday } from "@/lib/storage/notion-config.storage";

function subTable(id: string, name: string, overrides: Partial<SubTable> = {}): SubTable {
  return {
    dataSourceId: id,
    name,
    titleProp: "Name",
    dateProp: "Meeting Date",
    recordedByProp: "Recorded by",
    calendarEventProp: null,
    calendarEventIssue: null,
    attendeesProp: null,
    attendeesIssue: "missing",
    ...overrides,
  };
}

const MONDAY = subTable("ds-monday", "Monday Meetings");
const WEDNESDAY = subTable("ds-wednesday", "Wednesday Meetings");
const SUNDAY = subTable("ds-sunday", "Sunday Reviews");
const OTHER = subTable("ds-other", "Other Meetings");

const MAPPING = buildMapping([MONDAY, WEDNESDAY, SUNDAY, OTHER]) as Mapping;

// November 2026: the 9th is the dispatch week's Monday. Local constructors
// only, so the tests hold in any timezone.
const WEEKDAY_DATE: Record<Weekday, number> = {
  monday: 9,
  tuesday: 10,
  wednesday: 11,
  thursday: 12,
  friday: 13,
  saturday: 14,
  sunday: 15,
};

function localStartAt(weekday: Weekday, clock: string): number {
  const [h, m] = clock.split(":").map(Number);
  return new Date(2026, 10, WEEKDAY_DATE[weekday], h, m).getTime();
}

/** [weekday, start clock, team time (null = entry absent), sub-table] */
type RouteCase = [Weekday, string, string | null, string];

const ROUTE_CASES: RouteCase[] = [
  // Monday, team time 09:00: the 30-minute window holds on both edges.
  ["monday", "08:30", "09:00", "Monday Meetings"],
  ["monday", "09:30", "09:00", "Monday Meetings"],
  // The same Monday window misses by one minute on either side.
  ["monday", "08:29", "09:00", "Other Meetings"],
  ["monday", "09:31", "09:00", "Other Meetings"],
  ["monday", "08:30", "", "Monday Meetings"],
  ["monday", "22:47", "", "Monday Meetings"],
  ["monday", "04:03", null, "Monday Meetings"],
  ["monday", "10:15", "25:61", "Monday Meetings"],
  ["monday", "09:00", "9:00", "Monday Meetings"],
  ["tuesday", "09:00", "09:00", "Other Meetings"],
  ["wednesday", "14:29", "14:00", "Wednesday Meetings"],
  ["sunday", "19:58", "", "Sunday Reviews"],
];

describe("routeMeeting", () => {
  it.each(ROUTE_CASES)("%s %s (team %s) routes to %s", (weekday, startClock, teamTime, expectedName) => {
    const teamTimes: Partial<Record<Weekday, string>> =
      teamTime === null ? {} : { [weekday]: teamTime };
    const result = routeMeeting(localStartAt(weekday, startClock), MAPPING, teamTimes);
    expect(result.name).toBe(expectedName);
    expect(result.dataSourceId).toBe(
      [MONDAY, WEDNESDAY, SUNDAY, OTHER].find((ds) => ds.name === expectedName)?.dataSourceId,
    );
  });

  it("without an Other sub-table a Tuesday start goes to the first sub-table", () => {
    const mapping = buildMapping([MONDAY, WEDNESDAY]) as Mapping;
    expect(routeMeeting(localStartAt("tuesday", "08:00"), mapping, {})).toEqual(MONDAY);
  });

  it("TEAM_TIME_WINDOW_MS is 30 minutes", () => {
    expect(TEAM_TIME_WINDOW_MS).toBe(30 * 60 * 1000);
  });
});

describe("buildMapping", () => {
  it("maps no weekdays when no name starts with one, and still keeps other", () => {
    const mapping = buildMapping([OTHER, subTable("ds-lab", "Lab Meetings")]) as Mapping;
    expect(mapping.byWeekday).toEqual({});
    expect(mapping.other).toEqual(OTHER);
  });

  it("null on an empty list", () => {
    expect(buildMapping([])).toBeNull();
  });

  it("the first sub-table wins when two names start with the same weekday", () => {
    const later = subTable("ds-monday-later", "Monday Extra");
    const mapping = buildMapping([MONDAY, later]) as Mapping;
    expect(mapping.byWeekday.monday).toEqual(MONDAY);
  });

  it("an Other-named sub-table is preferred as other, even last in the list", () => {
    const mapping = buildMapping([MONDAY, OTHER]) as Mapping;
    expect(mapping.other).toEqual(OTHER);
    expect(mapping.byWeekday.monday).toEqual(MONDAY);
  });

  it("without an Other-named sub-table other is the FIRST sub-table", () => {
    const mapping = buildMapping([MONDAY, WEDNESDAY]) as Mapping;
    expect(mapping.other).toEqual(MONDAY);
  });
});

describe("describeSubTable", () => {
  it("picks Meeting Date in Other and finds a Recorded by people column", () => {
    const ds = {
      id: "ds-other",
      name: "Other Meetings",
      properties: {
        Name: { type: "title" },
        "Meeting Date": { type: "date" },
        "recorded by": { type: "people" },
        Status: { type: "select" },
      },
    };
    expect(describeSubTable(ds)).toEqual({
      dataSourceId: "ds-other",
      name: "Other Meetings",
      titleProp: "Name",
      dateProp: "Meeting Date",
      recordedByProp: "recorded by",
      calendarEventProp: null,
      calendarEventIssue: "missing",
      attendeesProp: null,
      attendeesIssue: "missing",
    });
  });

  it.each([
    ["multi_select", "attendees", null],
    ["people", null, "wrong-type"],
    ["rich_text", null, "wrong-type"],
  ])("an 'attendees' %s column reads as prop %s, issue %s", (type, prop, issue) => {
    const st = describeSubTable({
      id: "ds-a",
      name: "Monday Meetings",
      properties: { Name: { type: "title" }, Date: { type: "date" }, attendees: { type } },
    });
    expect(st?.attendeesProp).toBe(prop);
    expect(st?.attendeesIssue).toBe(issue);
  });

  it("detects the column case-insensitively", () => {
    const st = describeSubTable({
      id: "ds-a",
      name: "Monday Meetings",
      properties: {
        Name: { type: "title" },
        Date: { type: "date" },
        "calendar EVENT": { type: "rich_text" },
      },
    });
    expect(st?.calendarEventProp).toBe("calendar EVENT");
    expect(st?.calendarEventIssue).toBeNull();
  });

  it("a non-rich_text Calendar event column is ignored and flagged wrong-type", () => {
    const st = describeSubTable({
      id: "ds-a",
      name: "Monday Meetings",
      properties: {
        Name: { type: "title" },
        Date: { type: "date" },
        "Calendar event": { type: "url" },
      },
    });
    expect(st?.calendarEventProp).toBeNull();
    expect(st?.calendarEventIssue).toBe("wrong-type");
  });

  it("a 'Recorded by' column of a type other than people is ignored", () => {
    const ds = {
      id: "ds-monday",
      name: "Monday Meetings",
      properties: {
        Name: { type: "title" },
        Date: { type: "date" },
        "Recorded by": { type: "rich_text" },
      },
    };
    expect(describeSubTable(ds)?.recordedByProp).toBeNull();
  });

  it("a non-date column named Date is not picked as dateProp", () => {
    const ds = {
      id: "ds-monday",
      name: "Monday Meetings",
      properties: {
        Name: { type: "title" },
        Date: { type: "select" },
        Held: { type: "date" },
      },
    };
    expect(describeSubTable(ds)?.dateProp).toBe("Held");
  });

  it("a date property named Date wins over one named Meeting Date", () => {
    const ds = {
      id: "ds-monday",
      name: "Monday Meetings",
      properties: {
        Name: { type: "title" },
        "Meeting Date": { type: "date" },
        Date: { type: "date" },
      },
    };
    expect(describeSubTable(ds)?.dateProp).toBe("Date");
  });

  it("without Date or Meeting Date the first date property is used, in property order", () => {
    const ds = {
      id: "ds-monday",
      name: "Monday Meetings",
      properties: {
        Name: { type: "title" },
        Occurred: { type: "date" },
        Held: { type: "date" },
      },
    };
    expect(describeSubTable(ds)?.dateProp).toBe("Occurred");
  });

  it("null when there is no title property, and null when there is no date property", () => {
    expect(
      describeSubTable({
        id: "ds-no-title",
        name: "No title",
        properties: { "Meeting Date": { type: "date" } },
      }),
    ).toBeNull();
    expect(
      describeSubTable({
        id: "ds-no-date",
        name: "No date",
        properties: { Name: { type: "title" }, Status: { type: "select" } },
      }),
    ).toBeNull();
  });
});

describe("describeMapping", () => {
  it("reads like the settings sentence, weekdays in Monday-to-Sunday order", () => {
    expect(describeMapping(MAPPING)).toBe(
      "Monday → Monday Meetings, Wednesday → Wednesday Meetings, Sunday → Sunday Reviews, other days → Other Meetings",
    );
  });

  it("with no weekday mappings it returns only the other-days clause", () => {
    const mapping = buildMapping([OTHER]) as Mapping;
    expect(describeMapping(mapping)).toBe("other days → Other Meetings");
  });

  it("a partial mapping lists only the mapped weekdays", () => {
    const mapping = buildMapping([SUNDAY, MONDAY, OTHER]) as Mapping;
    expect(describeMapping(mapping)).toBe(
      "Monday → Monday Meetings, Sunday → Sunday Reviews, other days → Other Meetings",
    );
  });
});
