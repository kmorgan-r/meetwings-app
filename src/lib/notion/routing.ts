import type { NotionProperty } from "./client";
import type { NotionConfig, Weekday } from "@/lib/storage/notion-config.storage";

/**
 * Which Notion data source a meeting lands in, and what the page is titled.
 *
 * Weekday and time-of-day are LOCAL (`Date.getDay`/`getHours`/`getMinutes`,
 * no UTC): a team time is configured in the user's wall clock, so a meeting
 * started in the same room has to compare against the same wall clock.
 */
export const TEAM_TIME_WINDOW_MS = 30 * 60 * 1000;

export interface SubTable {
  dataSourceId: string;
  name: string;
  titleProp: string;
  dateProp: string;
  recordedByProp: string | null;
  /** The optional "Calendar event" text column, when present and a text column. */
  calendarEventProp: string | null;
  /** Why calendarEventProp is null: no such column, or one of another type. */
  calendarEventIssue: "missing" | "wrong-type" | null;
}

export interface Mapping {
  byWeekday: Partial<Record<Weekday, SubTable>>;
  other: SubTable;
}

/** Sunday-first: JS `getDay()` gives Sunday as 0, so index 1 = Monday. */
const JS_DAY: Weekday[] = [
  "sunday",
  "monday",
  "tuesday",
  "wednesday",
  "thursday",
  "friday",
  "saturday",
];

/** Monday-to-Sunday order for listing mappings to the user. */
const WEEKDAYS: Weekday[] = [
  "monday",
  "tuesday",
  "wednesday",
  "thursday",
  "friday",
  "saturday",
  "sunday",
];

export const CALENDAR_EVENT_COLUMN = "Calendar event";

/** The first property named "calendar event" (any case): usable only as rich_text. */
export function calendarEventColumn(properties: Record<string, NotionProperty>): {
  prop: string | null;
  issue: "missing" | "wrong-type" | null;
} {
  for (const [name, property] of Object.entries(properties)) {
    if (name.toLowerCase() !== CALENDAR_EVENT_COLUMN.toLowerCase()) continue;
    return property.type === "rich_text"
      ? { prop: name, issue: null }
      : { prop: null, issue: "wrong-type" };
  }
  return { prop: null, issue: "missing" };
}

/** Strict "HH:MM": two digits, 00-23 hours, 00-59 minutes. */
const HH_MM = /^([01][0-9]|2[0-3]):[0-5][0-9]$/;

/** "monday" → "Monday", the one capitalisation every user-visible use shares. */
const capitalizeWeekday = (weekday: Weekday): string =>
  `${weekday.charAt(0).toUpperCase()}${weekday.slice(1)}`;

/**
 * Reads one Notion data source into the descriptor page creation needs:
 * - titleProp is the property of type "title" (there is at most one);
 * - dateProp prefers a date property named exactly "Date", then "Meeting
 *   Date", then the first date property; "Recorded by" is matched
 *   case-insensitively, as people columns get re-titled casually;
 * - null when the data source has no title or no date property - a page
 *   without either could not be titled or dated.
 */
export function describeSubTable(ds: {
  id: string;
  name: string;
  properties: Record<string, NotionProperty>;
}): SubTable | null {
  let titleProp: string | null = null;
  let dateNamedDate: string | null = null;
  let dateNamedMeetingDate: string | null = null;
  let firstDate: string | null = null;
  let recordedByProp: string | null = null;

  for (const [name, property] of Object.entries(ds.properties)) {
    if (property.type === "title" && titleProp === null) titleProp = name;
    if (property.type === "date") {
      if (name === "Date" && dateNamedDate === null) dateNamedDate = name;
      if (name === "Meeting Date" && dateNamedMeetingDate === null) {
        dateNamedMeetingDate = name;
      }
      if (firstDate === null) firstDate = name;
    }
    if (
      property.type === "people" &&
      recordedByProp === null &&
      name.toLowerCase() === "recorded by"
    ) {
      recordedByProp = name;
    }
  }

  let dateProp: string | null = dateNamedDate;
  if (dateProp === null) dateProp = dateNamedMeetingDate;
  if (dateProp === null) dateProp = firstDate;
  if (titleProp === null || dateProp === null) return null;

  const calendar = calendarEventColumn(ds.properties);
  return {
    dataSourceId: ds.id,
    name: ds.name,
    titleProp,
    dateProp,
    recordedByProp,
    calendarEventProp: calendar.prop,
    calendarEventIssue: calendar.issue,
  };
}

/**
 * Builds the routing map: a weekday slot goes to the sub-table whose name
 * starts with the weekday's name (case-insensitive), the first sub-table
 * winning when two do. `other` is the sub-table whose name starts with
 * "Other", else the first sub-table - which may therefore also be a weekday
 * slot, that being the fallback case. Returns null for an empty list.
 */
export function buildMapping(subTables: SubTable[]): Mapping | null {
  if (subTables.length === 0) return null;

  const byWeekday: Partial<Record<Weekday, SubTable>> = {};
  let other: SubTable | null = null;
  for (const subTable of subTables) {
    for (const weekday of WEEKDAYS) {
      if (subTable.name.toLowerCase().startsWith(weekday)) {
        if (byWeekday[weekday] === undefined) byWeekday[weekday] = subTable;
        break;
      }
    }
    if (other === null && subTable.name.toLowerCase().startsWith("other")) {
      other = subTable;
    }
  }

  return { byWeekday, other: other ?? subTables[0] };
}

/**
 * Routes a meeting: the weekday sub-table only when the meeting starts within
 * TEAM_TIME_WINDOW_MS of that day's team time, or when the day has no valid
 * team time ("", missing or malformed means any start that day). Anything
 * else goes to `other`, keeping the AI's title.
 */
export function routeMeeting(
  startAt: number,
  m: Mapping,
  teamTimes: NotionConfig["teamTimes"],
  aiTitle: string,
): { subTable: SubTable; title: string } {
  const date = new Date(startAt);
  const weekday = JS_DAY[date.getDay()];
  const weekdayTitle = `${capitalizeWeekday(weekday)} Meeting`;

  const subTable = m.byWeekday[weekday];
  if (subTable !== undefined) {
    const teamTime = teamTimes[weekday];
    // No usable team time ("", missing or malformed): any start that day counts.
    if (typeof teamTime !== "string" || !HH_MM.test(teamTime)) {
      return { subTable, title: weekdayTitle };
    }
    const startMinutes = date.getHours() * 60 + date.getMinutes();
    const [h, mm] = teamTime.split(":").map(Number);
    const teamMinutes = h * 60 + mm;
    if (Math.abs(startMinutes - teamMinutes) * 60_000 <= TEAM_TIME_WINDOW_MS) {
      return { subTable, title: weekdayTitle };
    }
  }

  return { subTable: m.other, title: aiTitle };
}

/**
 * The settings-page sentence: every mapped weekday in Monday-to-Sunday order,
 * then where the rest go. With no weekday mappings it is only the last clause.
 */
export function describeMapping(m: Mapping): string {
  const clauses = WEEKDAYS.filter(
    (weekday) => m.byWeekday[weekday] !== undefined,
  ).map(
    (weekday) => `${capitalizeWeekday(weekday)} → ${m.byWeekday[weekday]?.name}`,
  );
  clauses.push(`other days → ${m.other.name}`);
  return clauses.join(", ");
}
