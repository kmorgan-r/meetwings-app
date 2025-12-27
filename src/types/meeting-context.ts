// Meeting Context Memory Types

// Entity types that can be extracted from conversations
export type EntityType = "person" | "project" | "term" | "company";

// TypeScript interfaces for application use (camelCase)
export interface MeetingSummary {
  id: string;
  conversationId: string;
  summary: string;
  topics: string[];
  actionItems: string[];
  decisions: string[];
  participants: string[];
  exchangeCount: number;
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

export interface KnowledgeProfile {
  id: string;
  summary: string | null;
  keyPeople: KeyPerson[];
  keyProjects: KeyProject[];
  terminology: Terminology[];
  lastCompacted: number | null;
  sourceCount: number;
}

// AI summarization response structure
export interface SummarizationResult {
  summary: string;
  topics: string[];
  actionItems: string[];
  decisions: string[];
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
  topics: string | null;
  action_items: string | null;
  decisions: string | null;
  participants: string | null;
  exchange_count: number | null;
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
  last_compacted: number | null;
  source_count: number | null;
}

// Input types for creating records
export interface CreateMeetingSummaryInput {
  conversationId: string;
  summary: string;
  topics?: string[];
  actionItems?: string[];
  decisions?: string[];
  participants?: string[];
  exchangeCount?: number;
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
  sourceCount?: number;
}
