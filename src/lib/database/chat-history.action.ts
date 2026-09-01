import { getDatabase } from "./config";
import { ChatConversation } from "@/types";
import { safeLocalStorage } from "@/lib";

// Legacy localStorage key for migration purposes
const LEGACY_CHAT_HISTORY_KEY = "chat_history";

/**
 * Database conversation type (flattened for SQL)
 */
interface DbConversation {
  id: string;
  title: string;
  created_at: number;
  updated_at: number;
}

/**
 * Database message type (flattened for SQL)
 */
interface DbMessage {
  id: string;
  conversation_id: string;
  role: "user" | "assistant" | "system";
  content: string;
  timestamp: number;
  attached_files: string | null; // JSON string
  speaker: string | null; // JSON string, null before migration 8
  audio_source: string | null;
}

/**
 * The columns recording who spoke, in the order every message INSERT lists
 * them. Meeting segments carry a speaker; typed chat messages do not, so both
 * are nullable — as are all rows written before migration 8.
 */
function speakerParams(
  message: ChatConversation["messages"][number]
): [string | null, string | null] {
  return [
    message.speaker ? JSON.stringify(message.speaker) : null,
    message.audioSource ?? null,
  ];
}

/**
 * SQLite holds audio_source as free text, so a row can carry anything — an
 * older build, a hand-edited database, a future value. Only the two the app
 * understands are honoured; anything else reads back as absent rather than
 * being asserted into the union.
 */
function parseAudioSource(
  value: string | null
): ChatConversation["messages"][number]["audioSource"] {
  return value === "microphone" || value === "system" ? value : undefined;
}

/**
 * Safely parse JSON with error handling
 */
function safeJsonParse<T>(jsonString: string | null, fallback: T): T {
  if (!jsonString) return fallback;
  try {
    return JSON.parse(jsonString) as T;
  } catch (error) {
    console.error("Failed to parse JSON:", error);
    return fallback;
  }
}

/**
 * Validate conversation data
 */
function validateConversation(conversation: ChatConversation): boolean {
  if (!conversation.id || typeof conversation.id !== "string") {
    console.error("Invalid conversation: missing or invalid id");
    return false;
  }
  if (!conversation.title || typeof conversation.title !== "string") {
    console.error("Invalid conversation: missing or invalid title");
    return false;
  }
  if (!Array.isArray(conversation.messages)) {
    console.error("Invalid conversation: messages is not an array");
    return false;
  }
  return true;
}

/**
 * Validate message data
 */
function validateMessage(message: any): boolean {
  if (!message.id || typeof message.id !== "string") {
    console.error("Invalid message: missing or invalid id");
    return false;
  }
  if (
    !message.role ||
    !["user", "assistant", "system"].includes(message.role)
  ) {
    console.error("Invalid message: missing or invalid role");
    return false;
  }
  if (typeof message.content !== "string") {
    console.error("Invalid message: content must be a string");
    return false;
  }
  if (typeof message.timestamp !== "number" || message.timestamp < 0) {
    console.error("Invalid message: invalid timestamp");
    return false;
  }
  return true;
}

/**
 * Create a new conversation with transaction safety
 */
export async function createConversation(
  conversation: ChatConversation
): Promise<ChatConversation> {
  if (!validateConversation(conversation)) {
    throw new Error("Invalid conversation data");
  }

  const db = await getDatabase();

  // Whether *this call* inserted the conversation row. The rollback below is a
  // compensating delete for a partial write, so it must only ever remove a row
  // this call created. If the INSERT itself failed — most likely because the id
  // already exists — the row is somebody else's real conversation, and deleting
  // it cascades to every message it holds.
  let insertedConversationRow = false;

  try {
    // Insert conversation
    await db.execute(
      "INSERT INTO conversations (id, title, created_at, updated_at) VALUES (?, ?, ?, ?)",
      [
        conversation.id,
        conversation.title,
        conversation.createdAt || Date.now(),
        conversation.updatedAt || Date.now(),
      ]
    );
    insertedConversationRow = true;

    // Deduplicate messages by ID before inserting. A duplicate ID would violate
    // the messages primary key and abort the whole insert (rolling back the
    // conversation), so guard here the same way updateConversation does.
    const seenIds = new Set<string>();

    // Insert all messages
    for (const message of conversation.messages) {
      if (!validateMessage(message)) {
        console.warn("Skipping invalid message in conversation creation");
        continue;
      }

      if (seenIds.has(message.id)) {
        console.warn(
          `[ChatHistory] Skipping duplicate message ID during create: ${message.id}`
        );
        continue;
      }
      seenIds.add(message.id);

      const attachedFilesJson = message.attachedFiles
        ? JSON.stringify(message.attachedFiles)
        : null;

      await db.execute(
        "INSERT INTO messages (id, conversation_id, role, content, timestamp, attached_files, speaker, audio_source) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
        [
          message.id,
          conversation.id,
          message.role,
          message.content,
          message.timestamp,
          attachedFilesJson,
          ...speakerParams(message),
        ]
      );
    }

    return conversation;
  } catch (error) {
    console.error("Failed to create conversation:", error);
    // Rollback: delete conversation if message insertion failed
    if (insertedConversationRow) {
      await db
        .execute("DELETE FROM conversations WHERE id = ?", [conversation.id])
        .catch(() => {});
    }
    throw error;
  }
}

/**
 * Hydrates a set of conversation rows with their messages in a single query.
 */
async function attachMessages(
  conversations: DbConversation[]
): Promise<ChatConversation[]> {
  if (conversations.length === 0) {
    return [];
  }

  const db = await getDatabase();

  // Get all messages for these conversations in one query
  const conversationIds = conversations.map((c) => c.id);
  const placeholders = conversationIds.map(() => "?").join(",");
  const allMessages = await db.select<DbMessage[]>(
    `SELECT * FROM messages WHERE conversation_id IN (${placeholders}) ORDER BY conversation_id, timestamp ASC`,
    conversationIds
  );

  // Group messages by conversation_id
  const messagesByConversation = new Map<string, DbMessage[]>();
  for (const msg of allMessages) {
    if (!messagesByConversation.has(msg.conversation_id)) {
      messagesByConversation.set(msg.conversation_id, []);
    }
    messagesByConversation.get(msg.conversation_id)!.push(msg);
  }

  // Build result
  return conversations.map((conv) => ({
    id: conv.id,
    title: conv.title,
    createdAt: conv.created_at,
    updatedAt: conv.updated_at,
    messages:
      messagesByConversation.get(conv.id)?.map((msg) => ({
        id: msg.id,
        role: msg.role,
        content: msg.content,
        timestamp: msg.timestamp,
        attachedFiles: safeJsonParse(msg.attached_files, undefined),
        speaker: safeJsonParse(msg.speaker, undefined),
        audioSource: parseAudioSource(msg.audio_source),
      })) || [],
  }));
}

/**
 * Get all conversations with messages in a single optimized query
 */
export async function getAllConversations(): Promise<ChatConversation[]> {
  const db = await getDatabase();

  try {
    // Get all conversations
    const conversations = await db.select<DbConversation[]>(
      "SELECT * FROM conversations ORDER BY updated_at DESC"
    );

    return attachMessages(conversations);
  } catch (error) {
    console.error("Failed to get all conversations:", error);
    throw error;
  }
}

/**
 * Get only conversations that have no meeting summary yet, with their messages
 * hydrated. The knowledge backfill uses this so it loads message bodies only for
 * conversations it might actually summarize, instead of every conversation on
 * every "Update Knowledge" click.
 */
export async function getUnsummarizedConversations(): Promise<
  ChatConversation[]
> {
  const db = await getDatabase();

  try {
    const conversations = await db.select<DbConversation[]>(
      `SELECT c.* FROM conversations c
       LEFT JOIN meeting_summaries ms ON ms.conversation_id = c.id
       WHERE ms.id IS NULL
       ORDER BY c.updated_at DESC`
    );

    return attachMessages(conversations);
  } catch (error) {
    console.error("Failed to get unsummarized conversations:", error);
    throw error;
  }
}

/**
 * Get a single conversation by ID
 */
export async function getConversationById(
  id: string
): Promise<ChatConversation | null> {
  if (!id || typeof id !== "string") {
    console.error("Invalid conversation id");
    return null;
  }

  const db = await getDatabase();

  try {
    // Get conversation
    const conversations = await db.select<DbConversation[]>(
      "SELECT * FROM conversations WHERE id = ?",
      [id]
    );

    if (conversations.length === 0) {
      return null;
    }

    const conv = conversations[0];

    // Get messages
    const messages = await db.select<DbMessage[]>(
      "SELECT * FROM messages WHERE conversation_id = ? ORDER BY timestamp ASC",
      [id]
    );

    return {
      id: conv.id,
      title: conv.title,
      createdAt: conv.created_at,
      updatedAt: conv.updated_at,
      messages: messages.map((msg) => ({
        id: msg.id,
        role: msg.role,
        content: msg.content,
        timestamp: msg.timestamp,
        attachedFiles: safeJsonParse(msg.attached_files, undefined),
        speaker: safeJsonParse(msg.speaker, undefined),
        audioSource: parseAudioSource(msg.audio_source),
      })),
    };
  } catch (error) {
    console.error(`Failed to get conversation ${id}:`, error);
    return null;
  }
}

/**
 * Whether a conversation row exists, letting query failures propagate.
 *
 * getConversationById returns null on a failed read, which makes a transient
 * error indistinguishable from "no such row" — fine for read-only callers that
 * just render "not found", wrong for anything that routes a write on the answer.
 */
async function conversationExists(id: string): Promise<boolean> {
  const db = await getDatabase();

  const rows = await db.select<{ id: string }[]>(
    "SELECT id FROM conversations WHERE id = ? LIMIT 1",
    [id]
  );

  return rows.length > 0;
}

/**
 * Update a conversation with transaction safety
 */
export async function updateConversation(
  conversation: ChatConversation
): Promise<ChatConversation> {
  if (!validateConversation(conversation)) {
    throw new Error("Invalid conversation data");
  }

  const db = await getDatabase();

  try {
    // Update conversation. Split the same way as appendMessagesToConversation
    // (below): the title write is guarded by title_source so a manual rename
    // survives, while updated_at stays unconditional and keeps the
    // rowsAffected check.
    const updateResult = await db.execute(
      "UPDATE conversations SET updated_at = ? WHERE id = ?",
      [conversation.updatedAt, conversation.id]
    );

    if (updateResult.rowsAffected === 0) {
      throw new Error("Conversation not found");
    }

    await db.execute(
      "UPDATE conversations SET title = ? WHERE id = ? AND title_source = 'auto'",
      [conversation.title, conversation.id]
    );

    // Get existing messages for backup
    const existingMessages = await db.select<DbMessage[]>(
      "SELECT * FROM messages WHERE conversation_id = ?",
      [conversation.id]
    );

    // Delete existing messages
    await db.execute("DELETE FROM messages WHERE conversation_id = ?", [
      conversation.id,
    ]);

    // Deduplicate messages by ID (keep first occurrence to preserve order)
    const seenIds = new Set<string>();
    const uniqueMessages = conversation.messages.filter((msg) => {
      if (seenIds.has(msg.id)) {
        console.warn(`[ChatHistory] Skipping duplicate message ID: ${msg.id}`);
        return false;
      }
      seenIds.add(msg.id);
      return true;
    });

    // Insert updated messages
    try {
      for (const message of uniqueMessages) {
        if (!validateMessage(message)) {
          console.warn("Skipping invalid message in conversation update");
          continue;
        }

        const attachedFilesJson = message.attachedFiles
          ? JSON.stringify(message.attachedFiles)
          : null;

        await db.execute(
          "INSERT INTO messages (id, conversation_id, role, content, timestamp, attached_files, speaker, audio_source) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
          [
            message.id,
            conversation.id,
            message.role,
            message.content,
            message.timestamp,
            attachedFilesJson,
            ...speakerParams(message),
          ]
        );
      }
    } catch (messageError) {
      // Rollback: restore original messages
      console.error(
        "Failed to insert new messages, restoring backup:",
        messageError
      );
      for (const msg of existingMessages) {
        await db
          .execute(
            "INSERT INTO messages (id, conversation_id, role, content, timestamp, attached_files, speaker, audio_source) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
            [
              msg.id,
              msg.conversation_id,
              msg.role,
              msg.content,
              msg.timestamp,
              msg.attached_files,
              msg.speaker,
              msg.audio_source,
            ]
          )
          .catch(() => {});
      }
      throw messageError;
    }

    return conversation;
  } catch (error) {
    console.error("Failed to update conversation:", error);
    throw error;
  }
}

/**
 * Append new messages to an existing conversation without touching rows that
 * are already persisted. Unlike updateConversation, this does not delete and
 * re-insert every message, so its cost is proportional to what's new, not to
 * the conversation's total size — used by the periodic meeting-transcript
 * autosave, which would otherwise redo a full delete+reinsert of the whole
 * conversation on every trigger. INSERT OR IGNORE makes retries with an
 * already-inserted id a no-op instead of a primary-key error, so callers
 * don't need failure/rollback bookkeeping to stay safe.
 */
export async function appendMessagesToConversation(
  conversationId: string,
  title: string,
  updatedAt: number,
  newMessages: ChatConversation["messages"]
): Promise<void> {
  const db = await getDatabase();

  try {
    // Split deliberately. The title write is guarded by title_source so a manual
    // rename survives - this path runs on EVERY autosave tick with the title
    // cached in conversationMetaCacheRef, so an unguarded write reverts a rename
    // seconds after it is made. The updated_at stamp must stay unconditional,
    // and it keeps the rowsAffected check: a guarded single statement would skip
    // the stamp and raise a spurious "not found" on every autosave after a rename.
    const updateResult = await db.execute(
      "UPDATE conversations SET updated_at = ? WHERE id = ?",
      [updatedAt, conversationId]
    );

    if (updateResult.rowsAffected === 0) {
      throw new Error("Conversation not found");
    }

    await db.execute(
      "UPDATE conversations SET title = ? WHERE id = ? AND title_source = 'auto'",
      [title, conversationId]
    );

    let inserted = 0;

    const seenIds = new Set<string>();
    for (const message of newMessages) {
      if (!validateMessage(message)) {
        console.warn("Skipping invalid message in conversation append");
        continue;
      }
      if (seenIds.has(message.id)) {
        console.warn(`[ChatHistory] Skipping duplicate message ID during append: ${message.id}`);
        continue;
      }
      seenIds.add(message.id);

      const attachedFilesJson = message.attachedFiles
        ? JSON.stringify(message.attachedFiles)
        : null;

      const insertResult = await db.execute(
        "INSERT OR IGNORE INTO messages (id, conversation_id, role, content, timestamp, attached_files, speaker, audio_source) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
        [
          message.id,
          conversationId,
          message.role,
          message.content,
          message.timestamp,
          attachedFilesJson,
          ...speakerParams(message),
        ]
      );
      if (insertResult.rowsAffected > 0) {
        inserted += 1;
      }
    }

    // INSERT OR IGNORE swallows primary-key conflicts by design, so a caller
    // that hands over only already-written rows gets a successful-looking save
    // that stored nothing. That silence hid a bug where the meeting autosave
    // re-offered the same messages for an entire meeting while reporting
    // success, and every later segment was lost. Say so.
    if (newMessages.length > 0 && inserted === 0) {
      console.warn(
        `[ChatHistory] append to ${conversationId} wrote none of its ${newMessages.length} message(s) — every id was already present`
      );
    }
  } catch (error) {
    console.error("Failed to append messages to conversation:", error);
    throw error;
  }
}

/**
 * Rename a conversation without touching its messages or its position in the
 * chats list. Deliberately leaves updated_at alone: a rename is not new
 * activity, and the list sorts and groups conversations by that column, so
 * bumping it would jump the conversation to "now" just because a background
 * title generation landed.
 *
 * Returns false when no row matched — the conversation was deleted while the
 * title was being generated, OR the user has renamed it by hand
 * (title_source = 'manual'). Both mean "do not report a rename".
 */
export async function updateConversationTitle(
  id: string,
  title: string
): Promise<boolean> {
  if (!id || typeof id !== "string") {
    console.error("Invalid conversation id");
    return false;
  }
  if (!title || typeof title !== "string") {
    console.error("Invalid conversation title");
    return false;
  }

  const db = await getDatabase();

  try {
    const result = await db.execute(
      "UPDATE conversations SET title = ? WHERE id = ? AND title_source = 'auto'",
      [title, id]
    );

    return result.rowsAffected > 0;
  } catch (error) {
    console.error(`Failed to rename conversation ${id}:`, error);
    throw error;
  }
}

/**
 * Renames a conversation on the user's instruction, and records that a human
 * chose the name so no automatic titler can take it back.
 *
 * Deliberately does NOT touch updated_at. The conversation list sorts on it, so
 * bumping it would make the row jump date groups mid-edit and unmount the input
 * under a new heading, losing the caret.
 */
export async function renameConversationManually(
  id: string,
  title: string
): Promise<boolean> {
  if (!id || typeof id !== "string") {
    console.error("Invalid conversation id");
    return false;
  }
  if (!title || typeof title !== "string") {
    console.error("Invalid conversation title");
    return false;
  }

  const db = await getDatabase();

  try {
    const result = await db.execute(
      "UPDATE conversations SET title = ?, title_source = 'manual' WHERE id = ?",
      [title, id]
    );
    return result.rowsAffected > 0;
  } catch (error) {
    console.error(`Failed to rename conversation ${id}:`, error);
    throw error;
  }
}

/**
 * Gives a conversation the name its summary was given.
 *
 * Until this runs, the same meeting carries two unrelated names. A conversation
 * is titled at creation by `generateConversationTitle` from whatever text
 * started it — for a quick action that's the action's own label, which is why
 * 26 conversations in a real profile are all called "What should I say?" — and
 * the AI titler may later replace that using only the opening few messages, so
 * a ten-hour call becomes "Casual Greeting and Check-In". The summary title is
 * derived from the whole conversation and is simply the better name.
 *
 * It therefore wins outright rather than only filling in placeholders. That is
 * safe even though a manual rename now exists: the provenance check lives in
 * `updateConversationTitle`'s `AND title_source = 'auto'` clause, which this
 * function inherits by delegating to it, so a summary title can still replace
 * an auto-generated one but can never overwrite a rename the user made by hand.
 *
 * Returns whether a row was renamed. Never throws — a summary that was written
 * successfully must not be reported as failed because its cosmetic rename was.
 */
export async function applySummaryTitleToConversation(
  conversationId: string,
  title: string
): Promise<boolean> {
  if (!conversationId || !title?.trim()) {
    return false;
  }

  try {
    return await updateConversationTitle(conversationId, title.trim());
  } catch (error) {
    console.error(
      `Failed to adopt summary title for conversation ${conversationId}:`,
      error
    );
    return false;
  }
}

/**
 * Save or update a conversation (upsert operation)
 */
export async function saveConversation(
  conversation: ChatConversation
): Promise<ChatConversation> {
  if (!validateConversation(conversation)) {
    throw new Error("Invalid conversation data");
  }

  try {
    // Deliberately not getConversationById: a read failure there returns null,
    // which would route an existing conversation into createConversation.
    if (await conversationExists(conversation.id)) {
      return await updateConversation(conversation);
    } else {
      return await createConversation(conversation);
    }
  } catch (error) {
    console.error("Failed to save conversation:", error);
    throw error;
  }
}

/**
 * Delete a conversation and all its messages
 */
export async function deleteConversation(id: string): Promise<boolean> {
  if (!id || typeof id !== "string") {
    console.error("Invalid conversation id");
    return false;
  }

  const db = await getDatabase();

  try {
    const result = await db.execute("DELETE FROM conversations WHERE id = ?", [
      id,
    ]);

    return result.rowsAffected > 0;
  } catch (error) {
    console.error(`Failed to delete conversation ${id}:`, error);
    throw error;
  }
}

/**
 * Delete all conversations and messages
 */
export async function deleteAllConversations(): Promise<void> {
  const db = await getDatabase();

  try {
    // Delete in correct order (messages first due to foreign key)
    await db.execute("DELETE FROM messages");
    await db.execute("DELETE FROM conversations");
  } catch (error) {
    console.error("Failed to delete all conversations:", error);
    throw error;
  }
}

/**
 * Return the user message as the conversation title
 */
export function generateConversationTitle(userMessage: string): string {
  return userMessage.trim();
}

/**
 * Migrate chat history from localStorage to SQLite
 * This function safely moves all existing localStorage chat history to the database
 */
export async function migrateLocalStorageToSQLite(): Promise<{
  success: boolean;
  migratedCount: number;
  error?: string;
}> {
  const migrationKey = "chat_history_migrated_to_sqlite";

  try {
    // Check if migration has already been done
    if (safeLocalStorage.getItem(migrationKey) === "true") {
      return { success: true, migratedCount: 0 };
    }

    // Get existing localStorage data
    const existingData = safeLocalStorage.getItem(LEGACY_CHAT_HISTORY_KEY);
    if (!existingData) {
      // No data to migrate
      safeLocalStorage.setItem(migrationKey, "true");
      return { success: true, migratedCount: 0 };
    }

    // Parse localStorage conversations
    let conversations: ChatConversation[] = [];
    try {
      const parsed = JSON.parse(existingData);
      conversations = Array.isArray(parsed) ? parsed : [];
    } catch (parseError) {
      console.error("Failed to parse localStorage chat history:", parseError);
      // Mark as migrated anyway to prevent repeated failures
      safeLocalStorage.setItem(migrationKey, "true");
      return {
        success: false,
        migratedCount: 0,
        error: "Failed to parse localStorage data",
      };
    }

    if (conversations.length === 0) {
      // No valid data to migrate
      safeLocalStorage.setItem(migrationKey, "true");
      return { success: true, migratedCount: 0 };
    }

    // Get database instance
    const db = await getDatabase();

    // Migrate each conversation
    let migratedCount = 0;
    let errorCount = 0;

    for (const conversation of conversations) {
      // Same rule as createConversation: the cleanup below may only delete a
      // row this iteration inserted, never a conversation already in the DB.
      let insertedConversationRow = false;

      try {
        // Validate conversation data
        if (!conversation?.id || !conversation?.title) {
          console.warn("Skipping invalid conversation:", conversation);
          errorCount++;
          continue;
        }

        // Check if conversation already exists in database
        const existing = await getConversationById(conversation.id);
        if (existing) {
          console.log(
            `Conversation ${conversation.id} already exists, skipping`
          );
          continue;
        }

        // Insert conversation
        await db.execute(
          "INSERT INTO conversations (id, title, created_at, updated_at) VALUES (?, ?, ?, ?)",
          [
            conversation.id,
            conversation.title,
            conversation.createdAt || Date.now(),
            conversation.updatedAt || Date.now(),
          ]
        );
        insertedConversationRow = true;

        // Insert messages
        if (
          Array.isArray(conversation.messages) &&
          conversation.messages.length > 0
        ) {
          for (const message of conversation.messages) {
            // Validate message
            if (
              !message?.id ||
              !message?.role ||
              typeof message?.content !== "string"
            ) {
              console.warn(
                `Skipping invalid message in conversation ${conversation.id}:`,
                message
              );
              continue;
            }

            const attachedFilesJson = message.attachedFiles
              ? JSON.stringify(message.attachedFiles)
              : null;

            await db.execute(
              "INSERT INTO messages (id, conversation_id, role, content, timestamp, attached_files, speaker, audio_source) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
              [
                message.id,
                conversation.id,
                message.role,
                message.content,
                message.timestamp || Date.now(),
                attachedFilesJson,
                ...speakerParams(message),
              ]
            );
          }
        }

        migratedCount++;
      } catch (convError) {
        console.error(
          `Failed to migrate conversation ${conversation?.id}:`,
          convError
        );
        errorCount++;
        // Clean up partially migrated conversation
        if (insertedConversationRow) {
          await db
            .execute("DELETE FROM conversations WHERE id = ?", [
              conversation?.id,
            ])
            .catch(() => {});
        }
      }
    }

    // Mark migration as complete even if some failed
    safeLocalStorage.setItem(migrationKey, "true");

    // Clear localStorage chat history after migration attempt
    safeLocalStorage.removeItem(LEGACY_CHAT_HISTORY_KEY);

    const message =
      errorCount > 0
        ? `Migrated ${migratedCount}/${conversations.length} conversations (${errorCount} failed)`
        : `Successfully migrated ${migratedCount} conversations`;

    console.log(message);

    return {
      success: migratedCount > 0 || errorCount === 0,
      migratedCount,
      error:
        errorCount > 0
          ? `${errorCount} conversations failed to migrate`
          : undefined,
    };
  } catch (error) {
    console.error("Migration failed:", error);
    // Mark as attempted to prevent infinite retry loops
    safeLocalStorage.setItem(migrationKey, "true");
    return {
      success: false,
      migratedCount: 0,
      error: error instanceof Error ? error.message : String(error),
    };
  }
}
