import { createNotionClient, type NotionClient } from "./client";
import { NotionError, notionErrorText } from "./errors";
import { optionNames } from "./knowledge";
import { armNotionRedactor } from "./redact";
import { buildMapping, describeMapping, describeSubTable, type SubTable } from "./routing";
import { requeueAuthFailures } from "@/lib/database/notion-queue.action";
import {
  parseNotionDatabaseId,
  type NotionConfig,
  type Weekday,
} from "@/lib/storage/notion-config.storage";

export type CheckResult =
  | { ok: true; mapping: string; recorder: string; warnings: string[]; weekdays: Weekday[] }
  | { ok: false; message: string };

const MEETINGS_UNSEEN =
  "Can't see the Weekly Team Meetings database: open it in Notion and check you have edit access.";
const KNOWLEDGE_UNSEEN =
  "Can't see the Team Knowledge database: open it in Notion and check you have edit access.";
const WEEKDAY_ORDER: Weekday[] = [
  "monday",
  "tuesday",
  "wednesday",
  "thursday",
  "friday",
  "saturday",
  "sunday",
];
// Checked in this order; the first missing one is reported.
const KNOWLEDGE_COLUMNS: [string, string][] = [
  ["Rule", "title"],
  ["Status", "status"],
  ["Topic", "select"],
  ["Meeting link", "url"],
];

/** A failed check, carrying the sentence to show. Never leaves this file. */
class CheckFailure extends Error {}

/**
 * NOT_FOUND / NO_ACCESS on a database read is "you can't see it"; every other
 * NotionError is its fixed copy; anything else is NOTION_INTERNAL. Never raw
 * error text.
 */
function messageFor(thrown: unknown, unseen: string | null): string {
  if (thrown instanceof CheckFailure) return thrown.message;
  if (
    unseen !== null &&
    thrown instanceof NotionError &&
    (thrown.code === "NOTION_NOT_FOUND" || thrown.code === "NOTION_NO_ACCESS")
  ) {
    return unseen;
  }
  return notionErrorText(thrown).text;
}

async function readSubTables(client: NotionClient, dbId: string): Promise<SubTable[]> {
  const { dataSources } = await client.database(dbId);
  if (dataSources.length === 0) throw new CheckFailure(MEETINGS_UNSEEN);
  const subTables: SubTable[] = [];
  for (const ds of dataSources) {
    const source = await client.dataSource(ds.id);
    const subTable = describeSubTable({ id: ds.id, name: ds.name, properties: source.properties });
    if (subTable === null) throw new CheckFailure(`${ds.name} has no date column.`);
    subTables.push(subTable);
  }
  return subTables;
}

async function checkKnowledge(client: NotionClient, dbId: string): Promise<void> {
  const { dataSources } = await client.database(dbId);
  if (dataSources.length === 0) throw new CheckFailure(KNOWLEDGE_UNSEEN);
  const { properties } = await client.dataSource(dataSources[0].id);
  for (const [name, type] of KNOWLEDGE_COLUMNS) {
    if (properties[name]?.type !== type) {
      throw new CheckFailure(`Team Knowledge is missing the ${name} column.`);
    }
  }
  if (!optionNames(properties.Status.status).includes("Proposed")) {
    throw new CheckFailure("Team Knowledge's Status column has no Proposed option.");
  }
}

/**
 * Runs on the card's CURRENT form values with the STORED token. Stops at the
 * first failure and returns a fixed sentence for it.
 */
export async function checkNotionSetup(token: string, cfg: NotionConfig): Promise<CheckResult> {
  armNotionRedactor([token]);
  const client = createNotionClient({ token });

  let ownerUserId: string | null;
  let mapping: ReturnType<typeof buildMapping>;
  let subTables: SubTable[];
  try {
    ownerUserId = (await client.me()).ownerUserId;
  } catch (thrown) {
    return { ok: false, message: messageFor(thrown, null) };
  }

  const meetingsDbId = parseNotionDatabaseId(cfg.meetingsDbUrl);
  if (meetingsDbId === null) return { ok: false, message: MEETINGS_UNSEEN };
  try {
    subTables = await readSubTables(client, meetingsDbId);
    mapping = buildMapping(subTables);
  } catch (thrown) {
    return { ok: false, message: messageFor(thrown, MEETINGS_UNSEEN) };
  }
  if (mapping === null) return { ok: false, message: MEETINGS_UNSEEN };

  const warnings: string[] = [];
  for (const st of subTables) {
    if (st.calendarEventIssue === "missing") {
      warnings.push(
        `"${st.name}" has no "Calendar event" text column, so duplicate recordings there are matched by time and AI only.`,
      );
    } else if (st.calendarEventIssue === "wrong-type") {
      warnings.push(
        `"${st.name}" has a "Calendar event" column that isn't a text column, so it is ignored.`,
      );
    }
  }
  if (cfg.knowledgeDbUrl.trim() === "") {
    warnings.push("No Team Knowledge link: practices will only appear on the meeting page.");
  } else {
    const knowledgeDbId = parseNotionDatabaseId(cfg.knowledgeDbUrl);
    if (knowledgeDbId === null) return { ok: false, message: KNOWLEDGE_UNSEEN };
    try {
      await checkKnowledge(client, knowledgeDbId);
    } catch (thrown) {
      return { ok: false, message: messageFor(thrown, KNOWLEDGE_UNSEEN) };
    }
  }

  // Same rule as the sender's step 2.
  let recorder = cfg.yourName.trim();
  if (recorder === "" && ownerUserId !== null) {
    try {
      recorder = (await client.userName(ownerUserId)) ?? "";
    } catch (thrown) {
      return { ok: false, message: messageFor(thrown, null) };
    }
  }
  if (recorder === "") recorder = "You";

  // Housekeeping: the Notion check already passed.
  try {
    await requeueAuthFailures();
  } catch (thrown) {
    notionErrorText(thrown);
  }

  return {
    ok: true,
    mapping: describeMapping(mapping),
    recorder,
    warnings,
    weekdays: WEEKDAY_ORDER.filter((day) => mapping.byWeekday[day] !== undefined),
  };
}
