import { getDatabase } from "./config";
import type {
  MeetingSummary,
  DbMeetingSummary,
  KnowledgeEntity,
  DbKnowledgeEntity,
  KnowledgeProfile,
  DbKnowledgeProfile,
  CreateMeetingSummaryInput,
  CreateKnowledgeEntityInput,
  UpdateKnowledgeProfileInput,
  EntityType,
  KeyPerson,
  KeyProject,
  Terminology,
} from "@/types";

// ============================================================================
// Helper Functions
// ============================================================================

function generateId(): string {
  return crypto.randomUUID();
}

function safeJsonParse<T>(json: string | null, fallback: T): T {
  if (!json) return fallback;
  try {
    return JSON.parse(json) as T;
  } catch {
    return fallback;
  }
}

// ============================================================================
// MeetingSummary Converters
// ============================================================================

function dbRowToMeetingSummary(row: DbMeetingSummary): MeetingSummary {
  return {
    id: row.id,
    conversationId: row.conversation_id,
    summary: row.summary,
    topics: safeJsonParse<string[]>(row.topics, []),
    actionItems: safeJsonParse<string[]>(row.action_items, []),
    decisions: safeJsonParse<string[]>(row.decisions, []),
    participants: safeJsonParse<string[]>(row.participants, []),
    exchangeCount: row.exchange_count || 0,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

// ============================================================================
// MeetingSummary CRUD
// ============================================================================

export async function createMeetingSummary(
  input: CreateMeetingSummaryInput
): Promise<MeetingSummary> {
  const db = await getDatabase();
  const now = Date.now();
  const id = generateId();

  const record: MeetingSummary = {
    id,
    conversationId: input.conversationId,
    summary: input.summary,
    topics: input.topics || [],
    actionItems: input.actionItems || [],
    decisions: input.decisions || [],
    participants: input.participants || [],
    exchangeCount: input.exchangeCount || 0,
    createdAt: now,
    updatedAt: now,
  };

  try {
    await db.execute(
      `INSERT INTO meeting_summaries (
        id, conversation_id, summary, topics, action_items,
        decisions, participants, exchange_count, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        record.id,
        record.conversationId,
        record.summary,
        JSON.stringify(record.topics),
        JSON.stringify(record.actionItems),
        JSON.stringify(record.decisions),
        JSON.stringify(record.participants),
        record.exchangeCount,
        record.createdAt,
        record.updatedAt,
      ]
    );
    return record;
  } catch (error) {
    console.error("Failed to create meeting summary:", error);
    throw error;
  }
}

export async function getMeetingSummaryByConversation(
  conversationId: string
): Promise<MeetingSummary | null> {
  const db = await getDatabase();

  try {
    const rows = await db.select<DbMeetingSummary[]>(
      `SELECT * FROM meeting_summaries WHERE conversation_id = ? LIMIT 1`,
      [conversationId]
    );
    return rows.length > 0 ? dbRowToMeetingSummary(rows[0]) : null;
  } catch (error) {
    console.error("Failed to get meeting summary:", error);
    return null;
  }
}

export async function getMeetingSummaryById(
  id: string
): Promise<MeetingSummary | null> {
  const db = await getDatabase();

  try {
    const rows = await db.select<DbMeetingSummary[]>(
      `SELECT * FROM meeting_summaries WHERE id = ? LIMIT 1`,
      [id]
    );
    return rows.length > 0 ? dbRowToMeetingSummary(rows[0]) : null;
  } catch (error) {
    console.error("Failed to get meeting summary:", error);
    return null;
  }
}

export async function getRecentMeetingSummaries(
  limit: number = 30,
  sinceTimestamp?: number
): Promise<MeetingSummary[]> {
  const db = await getDatabase();

  try {
    let query = `SELECT * FROM meeting_summaries`;
    const params: (number | string)[] = [];

    if (sinceTimestamp !== undefined) {
      query += ` WHERE created_at >= ?`;
      params.push(sinceTimestamp);
    }

    query += ` ORDER BY created_at DESC LIMIT ?`;
    params.push(limit);

    const rows = await db.select<DbMeetingSummary[]>(query, params);
    return rows.map(dbRowToMeetingSummary);
  } catch (error) {
    console.error("Failed to get recent meeting summaries:", error);
    return [];
  }
}

export async function getAllMeetingSummaries(): Promise<MeetingSummary[]> {
  const db = await getDatabase();

  try {
    const rows = await db.select<DbMeetingSummary[]>(
      `SELECT * FROM meeting_summaries ORDER BY created_at DESC`
    );
    return rows.map(dbRowToMeetingSummary);
  } catch (error) {
    console.error("Failed to get all meeting summaries:", error);
    return [];
  }
}

export async function updateMeetingSummary(
  id: string,
  updates: Partial<CreateMeetingSummaryInput>
): Promise<MeetingSummary | null> {
  const db = await getDatabase();
  const now = Date.now();

  try {
    const existing = await getMeetingSummaryById(id);
    if (!existing) return null;

    const updated: MeetingSummary = {
      ...existing,
      ...updates,
      topics: updates.topics ?? existing.topics,
      actionItems: updates.actionItems ?? existing.actionItems,
      decisions: updates.decisions ?? existing.decisions,
      participants: updates.participants ?? existing.participants,
      updatedAt: now,
    };

    await db.execute(
      `UPDATE meeting_summaries SET
        summary = ?, topics = ?, action_items = ?, decisions = ?,
        participants = ?, exchange_count = ?, updated_at = ?
      WHERE id = ?`,
      [
        updated.summary,
        JSON.stringify(updated.topics),
        JSON.stringify(updated.actionItems),
        JSON.stringify(updated.decisions),
        JSON.stringify(updated.participants),
        updated.exchangeCount,
        updated.updatedAt,
        id,
      ]
    );

    return updated;
  } catch (error) {
    console.error("Failed to update meeting summary:", error);
    return null;
  }
}

export async function deleteMeetingSummary(id: string): Promise<boolean> {
  const db = await getDatabase();

  try {
    await db.execute(`DELETE FROM meeting_summaries WHERE id = ?`, [id]);
    return true;
  } catch (error) {
    console.error("Failed to delete meeting summary:", error);
    return false;
  }
}

export async function deleteMeetingSummaryByConversation(
  conversationId: string
): Promise<boolean> {
  const db = await getDatabase();

  try {
    await db.execute(
      `DELETE FROM meeting_summaries WHERE conversation_id = ?`,
      [conversationId]
    );
    return true;
  } catch (error) {
    console.error("Failed to delete meeting summary:", error);
    return false;
  }
}

export async function getMeetingSummaryCount(): Promise<number> {
  const db = await getDatabase();

  try {
    const result = await db.select<{ count: number }[]>(
      `SELECT COUNT(*) as count FROM meeting_summaries`
    );
    return result[0]?.count || 0;
  } catch (error) {
    console.error("Failed to get meeting summary count:", error);
    return 0;
  }
}

// ============================================================================
// KnowledgeEntity Converters
// ============================================================================

function dbRowToKnowledgeEntity(row: DbKnowledgeEntity): KnowledgeEntity {
  return {
    id: row.id,
    entityType: row.entity_type as EntityType,
    name: row.name,
    description: row.description,
    firstSeen: row.first_seen,
    lastSeen: row.last_seen,
    mentionCount: row.mention_count || 1,
  };
}

// ============================================================================
// KnowledgeEntity CRUD
// ============================================================================

export async function createOrUpdateKnowledgeEntity(
  input: CreateKnowledgeEntityInput
): Promise<KnowledgeEntity> {
  const db = await getDatabase();
  const now = Date.now();

  try {
    // Check if entity already exists
    const existing = await db.select<DbKnowledgeEntity[]>(
      `SELECT * FROM knowledge_entities WHERE entity_type = ? AND name = ? LIMIT 1`,
      [input.entityType, input.name]
    );

    if (existing.length > 0) {
      // Update existing entity
      const entity = existing[0];
      await db.execute(
        `UPDATE knowledge_entities SET
          description = COALESCE(?, description),
          last_seen = ?,
          mention_count = mention_count + 1
        WHERE id = ?`,
        [input.description || null, now, entity.id]
      );

      return {
        id: entity.id,
        entityType: entity.entity_type as EntityType,
        name: entity.name,
        description: input.description || entity.description,
        firstSeen: entity.first_seen,
        lastSeen: now,
        mentionCount: (entity.mention_count || 1) + 1,
      };
    } else {
      // Create new entity
      const id = generateId();
      await db.execute(
        `INSERT INTO knowledge_entities (
          id, entity_type, name, description, first_seen, last_seen, mention_count
        ) VALUES (?, ?, ?, ?, ?, ?, 1)`,
        [id, input.entityType, input.name, input.description || null, now, now]
      );

      return {
        id,
        entityType: input.entityType,
        name: input.name,
        description: input.description || null,
        firstSeen: now,
        lastSeen: now,
        mentionCount: 1,
      };
    }
  } catch (error) {
    console.error("Failed to create/update knowledge entity:", error);
    throw error;
  }
}

export async function getKnowledgeEntityById(
  id: string
): Promise<KnowledgeEntity | null> {
  const db = await getDatabase();

  try {
    const rows = await db.select<DbKnowledgeEntity[]>(
      `SELECT * FROM knowledge_entities WHERE id = ? LIMIT 1`,
      [id]
    );
    return rows.length > 0 ? dbRowToKnowledgeEntity(rows[0]) : null;
  } catch (error) {
    console.error("Failed to get knowledge entity:", error);
    return null;
  }
}

export async function getKnowledgeEntitiesByType(
  entityType: EntityType
): Promise<KnowledgeEntity[]> {
  const db = await getDatabase();

  try {
    const rows = await db.select<DbKnowledgeEntity[]>(
      `SELECT * FROM knowledge_entities WHERE entity_type = ? ORDER BY mention_count DESC`,
      [entityType]
    );
    return rows.map(dbRowToKnowledgeEntity);
  } catch (error) {
    console.error("Failed to get knowledge entities by type:", error);
    return [];
  }
}

export async function getAllKnowledgeEntities(): Promise<KnowledgeEntity[]> {
  const db = await getDatabase();

  try {
    const rows = await db.select<DbKnowledgeEntity[]>(
      `SELECT * FROM knowledge_entities ORDER BY mention_count DESC, last_seen DESC`
    );
    return rows.map(dbRowToKnowledgeEntity);
  } catch (error) {
    console.error("Failed to get all knowledge entities:", error);
    return [];
  }
}

export async function getTopKnowledgeEntities(
  limit: number = 20
): Promise<KnowledgeEntity[]> {
  const db = await getDatabase();

  try {
    const rows = await db.select<DbKnowledgeEntity[]>(
      `SELECT * FROM knowledge_entities ORDER BY mention_count DESC LIMIT ?`,
      [limit]
    );
    return rows.map(dbRowToKnowledgeEntity);
  } catch (error) {
    console.error("Failed to get top knowledge entities:", error);
    return [];
  }
}

export async function deleteKnowledgeEntity(id: string): Promise<boolean> {
  const db = await getDatabase();

  try {
    await db.execute(`DELETE FROM knowledge_entities WHERE id = ?`, [id]);
    return true;
  } catch (error) {
    console.error("Failed to delete knowledge entity:", error);
    return false;
  }
}

// ============================================================================
// Entity Mentions (Junction Table)
// ============================================================================

export async function createEntityMention(
  entityId: string,
  summaryId: string
): Promise<boolean> {
  const db = await getDatabase();

  try {
    await db.execute(
      `INSERT OR IGNORE INTO entity_mentions (entity_id, summary_id) VALUES (?, ?)`,
      [entityId, summaryId]
    );
    return true;
  } catch (error) {
    console.error("Failed to create entity mention:", error);
    return false;
  }
}

export async function getEntitiesForSummary(
  summaryId: string
): Promise<KnowledgeEntity[]> {
  const db = await getDatabase();

  try {
    const rows = await db.select<DbKnowledgeEntity[]>(
      `SELECT ke.* FROM knowledge_entities ke
       INNER JOIN entity_mentions em ON ke.id = em.entity_id
       WHERE em.summary_id = ?
       ORDER BY ke.mention_count DESC`,
      [summaryId]
    );
    return rows.map(dbRowToKnowledgeEntity);
  } catch (error) {
    console.error("Failed to get entities for summary:", error);
    return [];
  }
}

export async function getSummariesForEntity(
  entityId: string
): Promise<MeetingSummary[]> {
  const db = await getDatabase();

  try {
    const rows = await db.select<DbMeetingSummary[]>(
      `SELECT ms.* FROM meeting_summaries ms
       INNER JOIN entity_mentions em ON ms.id = em.summary_id
       WHERE em.entity_id = ?
       ORDER BY ms.created_at DESC`,
      [entityId]
    );
    return rows.map(dbRowToMeetingSummary);
  } catch (error) {
    console.error("Failed to get summaries for entity:", error);
    return [];
  }
}

// ============================================================================
// KnowledgeProfile Converters
// ============================================================================

function dbRowToKnowledgeProfile(row: DbKnowledgeProfile): KnowledgeProfile {
  return {
    id: row.id,
    summary: row.summary,
    keyPeople: safeJsonParse<KeyPerson[]>(row.key_people, []),
    keyProjects: safeJsonParse<KeyProject[]>(row.key_projects, []),
    terminology: safeJsonParse<Terminology[]>(row.terminology, []),
    lastCompacted: row.last_compacted,
    sourceCount: row.source_count || 0,
  };
}

// ============================================================================
// KnowledgeProfile CRUD
// ============================================================================

export async function getKnowledgeProfile(): Promise<KnowledgeProfile | null> {
  const db = await getDatabase();

  try {
    const rows = await db.select<DbKnowledgeProfile[]>(
      `SELECT * FROM knowledge_profile WHERE id = 'profile' LIMIT 1`
    );
    return rows.length > 0 ? dbRowToKnowledgeProfile(rows[0]) : null;
  } catch (error) {
    console.error("Failed to get knowledge profile:", error);
    return null;
  }
}

export async function updateKnowledgeProfile(
  updates: UpdateKnowledgeProfileInput
): Promise<KnowledgeProfile | null> {
  const db = await getDatabase();
  const now = Date.now();

  try {
    const existing = await getKnowledgeProfile();
    if (!existing) {
      // Profile should always exist due to migration, but create if missing
      await db.execute(
        `INSERT OR IGNORE INTO knowledge_profile (id, source_count) VALUES ('profile', 0)`
      );
    }

    const updated: KnowledgeProfile = {
      id: "profile",
      summary: updates.summary ?? existing?.summary ?? null,
      keyPeople: updates.keyPeople ?? existing?.keyPeople ?? [],
      keyProjects: updates.keyProjects ?? existing?.keyProjects ?? [],
      terminology: updates.terminology ?? existing?.terminology ?? [],
      lastCompacted: now,
      sourceCount: updates.sourceCount ?? existing?.sourceCount ?? 0,
    };

    await db.execute(
      `UPDATE knowledge_profile SET
        summary = ?,
        key_people = ?,
        key_projects = ?,
        terminology = ?,
        last_compacted = ?,
        source_count = ?
      WHERE id = 'profile'`,
      [
        updated.summary,
        JSON.stringify(updated.keyPeople),
        JSON.stringify(updated.keyProjects),
        JSON.stringify(updated.terminology),
        updated.lastCompacted,
        updated.sourceCount,
      ]
    );

    return updated;
  } catch (error) {
    console.error("Failed to update knowledge profile:", error);
    return null;
  }
}

export async function clearKnowledgeProfile(): Promise<boolean> {
  const db = await getDatabase();

  try {
    await db.execute(
      `UPDATE knowledge_profile SET
        summary = NULL,
        key_people = NULL,
        key_projects = NULL,
        terminology = NULL,
        last_compacted = NULL,
        source_count = 0
      WHERE id = 'profile'`
    );
    return true;
  } catch (error) {
    console.error("Failed to clear knowledge profile:", error);
    return false;
  }
}

// ============================================================================
// Bulk Operations
// ============================================================================

export async function deleteAllMeetingContextData(): Promise<boolean> {
  const db = await getDatabase();

  try {
    // Delete in order due to foreign key constraints
    await db.execute(`DELETE FROM entity_mentions`);
    await db.execute(`DELETE FROM meeting_summaries`);
    await db.execute(`DELETE FROM knowledge_entities`);
    await clearKnowledgeProfile();
    return true;
  } catch (error) {
    console.error("Failed to delete all meeting context data:", error);
    return false;
  }
}

export async function getUncompactedSummaryCount(
  sinceTimestamp?: number
): Promise<number> {
  const db = await getDatabase();

  try {
    const profile = await getKnowledgeProfile();
    const lastCompacted = sinceTimestamp ?? profile?.lastCompacted ?? 0;

    const result = await db.select<{ count: number }[]>(
      `SELECT COUNT(*) as count FROM meeting_summaries WHERE created_at > ?`,
      [lastCompacted]
    );
    return result[0]?.count || 0;
  } catch (error) {
    console.error("Failed to get uncompacted summary count:", error);
    return 0;
  }
}
