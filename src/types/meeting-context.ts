// Meeting Context Memory Types

// Entity types that can be extracted from conversations
export type EntityType = "person" | "project" | "term" | "company";

// TypeScript interfaces for application use (camelCase)
export interface MeetingSummary {
  id: string;
  conversationId: string;
  summary: string;
  title: string | null;
  topics: string[];
  goals: string[];
  actionItems: string[];
  nextSteps: string[];
  decisions: string[];
  teamUpdates: string[];
  participants: string[];
  exchangeCount: number;
  durationSeconds: number | null;
  /**
   * When the meeting itself started/ended, taken from its messages. Distinct
   * from createdAt, which is when the summary row was written: the knowledge
   * backfill summarizes months-old conversations today, so createdAt says
   * nothing about when the conversation happened. Null for summaries of
   * conversations with no messages left to read.
   */
  meetingStartedAt: number | null;
  meetingEndedAt: number | null;
  createdAt: number;
  updatedAt: number;
}

export interface KnowledgeEntity {
  id: string;
  entityType: EntityType;
  name: string;
  description: string | null;
  firstSeen: number;
  lastSeen: number;
  mentionCount: number;
}

export interface EntityMention {
  entityId: string;
  summaryId: string;
}

export interface KeyPerson {
  name: string;
  role: string;
  relationship: string;
}

export interface KeyProject {
  name: string;
  status: string;
  description: string;
}

export interface Terminology {
  term: string;
  meaning: string;
}

export interface ActionItem {
  text: string;
  assignee?: string;
  status: "pending" | "completed";
}

export interface KnowledgeProfile {
  id: string;
  summary: string | null;
  keyPeople: KeyPerson[];
  keyProjects: KeyProject[];
  terminology: Terminology[];
  recentGoals: string[];
  recentDecisions: string[];
  recentTeamUpdates: string[];
  lastCompacted: number | null;
  sourceCount: number;
}

// AI summarization response structure
export interface SummarizationResult {
  title: string | null;
  summary: string;
  topics: string[];
  goals: string[];
  actionItems: string[];
  nextSteps: string[];
  decisions: string[];
  teamUpdates: string[];
  participants: string[];
  entities: ExtractedEntity[];
}

export interface ExtractedEntity {
  type: EntityType;
  name: string;
  description: string;
}

// Database row types (snake_case to match SQLite)
export interface DbMeetingSummary {
  id: string;
  conversation_id: string;
  summary: string;
  title: string | null;
  topics: string | null;
  goals: string | null;
  action_items: string | null;
  next_steps: string | null;
  decisions: string | null;
  team_updates: string | null;
  participants: string | null;
  exchange_count: number | null;
  duration_seconds: number | null;
  meeting_started_at: number | null;
  meeting_ended_at: number | null;
  created_at: number;
  updated_at: number;
}

export interface DbKnowledgeEntity {
  id: string;
  entity_type: string;
  name: string;
  description: string | null;
  first_seen: number;
  last_seen: number;
  mention_count: number | null;
}

export interface DbEntityMention {
  entity_id: string;
  summary_id: string;
}

export interface DbKnowledgeProfile {
  id: string;
  summary: string | null;
  key_people: string | null;
  key_projects: string | null;
  terminology: string | null;
  recent_goals: string | null;
  recent_decisions: string | null;
  recent_team_updates: string | null;
  last_compacted: number | null;
  source_count: number | null;
}

// Input types for creating records
export interface CreateMeetingSummaryInput {
  conversationId: string;
  summary: string;
  title?: string;
  topics?: string[];
  goals?: string[];
  actionItems?: string[];
  nextSteps?: string[];
  decisions?: string[];
  teamUpdates?: string[];
  participants?: string[];
  exchangeCount?: number;
  /** Overrides the duration otherwise derived from the meeting window. */
  durationSeconds?: number;
  /** Override the window otherwise read from the conversation's messages. */
  meetingStartedAt?: number | null;
  meetingEndedAt?: number | null;
}

export interface CreateKnowledgeEntityInput {
  entityType: EntityType;
  name: string;
  description?: string;
}

export interface UpdateKnowledgeProfileInput {
  summary?: string;
  keyPeople?: KeyPerson[];
  keyProjects?: KeyProject[];
  terminology?: Terminology[];
  recentGoals?: string[];
  recentDecisions?: string[];
  recentTeamUpdates?: string[];
  sourceCount?: number;
  /**
   * Explicit compaction watermark (ms). Defaults to now when omitted. Compaction
   * sets this to the newest summary it actually incorporated so summaries beyond
   * a single batch aren't skipped past.
   */
  lastCompacted?: number;
}
