import {
  KnowledgeProfile,
  MeetingSummary,
  KeyPerson,
  KeyProject,
  Terminology,
  UpdateKnowledgeProfileInput,
} from "@/types";
import {
  getKnowledgeProfile,
  updateKnowledgeProfile,
  getOldestUncompactedSummaries,
  getUncompactedSummaryCount,
  getUnsummarizedConversations,
} from "@/lib/database";
import { fetchAIResponse } from "./ai-response.function";
import {
  extractJsonObject,
  summarizeConversation,
  shouldSummarize,
} from "./meeting-summarizer";
import { shouldUseMeetwingsAPI } from "./meetwings.api";
import {
  getUserIdentity,
  hasUserIdentity,
  getActiveConversationId,
} from "@/lib/storage";

type ProviderConfig = {
  provider: any;
  selectedProvider: {
    provider: string;
    variables: Record<string, string>;
  };
};

// Max serial AI calls per "Update Knowledge" click. Each conversation we try to
// summarize is a streaming AI call, so an unbounded first-run backfill on a
// large history could fire dozens of calls. Cap the number of AI *attempts*
// (not successes); the remainder is picked up on the next click. Skips
// (already-summarized / too short) are cheap no-AI checks and don't count.
// Counting attempts rather than successes matters: if the AI call keeps failing
// (rate limit, network, unparseable response), those failures must still count,
// or the loop would fire one call per remaining conversation — the exact
// unbounded backfill this cap exists to prevent.
export const MAX_BACKFILL_PER_CLICK = 10;

export type BackfillResult = {
  /** Conversations newly summarized this click. */
  summarized: number;
  /**
   * AI summarization calls made this click (successes + failures). Lets the
   * caller distinguish "nothing to summarize" (attempts === 0) from "every
   * attempt failed" (attempts > 0 && summarized === 0), which would otherwise
   * both look like a no-op.
   */
  attempts: number;
  /** True if the cap was hit and more unsummarized conversations may remain. */
  cappedAtLimit: boolean;
};

/**
 * Summarizes stored conversations that don't yet have a summary, up to
 * MAX_BACKFILL_PER_CLICK new summaries per call.
 *
 * Normally summaries are only generated when the user leaves a conversation
 * (start new / switch). This backfills any conversation that was never
 * summarized so "Update Knowledge" has fresh material to compact. Already-
 * summarized conversations are excluded at the DB layer by
 * getUnsummarizedConversations; too-short ones are skipped in the loop below
 * (no AI call). The conversation currently open in the chat view is skipped too,
 * so it isn't summarized before it's finished.
 */
export async function summarizePendingConversations(
  providerConfig?: ProviderConfig
): Promise<BackfillResult> {
  const conversations = await getUnsummarizedConversations();
  // The conversation currently open in the chat view may still receive more
  // messages. Summarizing it now would freeze its summary early (there is no
  // update path), permanently dropping anything said afterwards, so skip it.
  const activeConversationId = getActiveConversationId();
  let attempts = 0;
  let summarized = 0;
  let cappedAtLimit = false;

  for (const conv of conversations) {
    if (conv.id === activeConversationId) {
      continue;
    }

    const messages = conv.messages.map((m) => ({
      role: m.role,
      content: m.content,
    }));

    // Too short to summarize — a cheap no-AI skip, so it must not count against
    // the cap. (Already-summarized conversations are excluded at the DB layer by
    // getUnsummarizedConversations.)
    if (!shouldSummarize(messages)) {
      continue;
    }

    // From here summarizeConversation makes a streaming AI call whether it
    // succeeds or fails, so count the attempt (not just successes) against the
    // cap before making it.
    if (attempts >= MAX_BACKFILL_PER_CLICK) {
      cappedAtLimit = true;
      break;
    }
    attempts += 1;

    const ok = await summarizeConversation(conv.id, messages, providerConfig);
    if (ok) {
      summarized += 1;
    }
  }

  if (summarized > 0) {
    console.log(`Backfilled ${summarized} pending conversation summaries`);
  }

  return { summarized, attempts, cappedAtLimit };
}

// Compaction thresholds
const COMPACTION_DAYS_THRESHOLD = 30; // Compact if last compaction was > 30 days ago
const COMPACTION_SUMMARY_THRESHOLD = 50; // Compact if > 50 uncompacted summaries
// Max summaries folded into the profile per compaction run. Bounds the prompt
// size / cost of a single AI call. If more uncompacted summaries exist, the
// watermark advances only to the newest one included so the rest are compacted
// on the next run (never skipped).
const COMPACTION_BATCH_SIZE = 100;

// Compaction prompt template
const COMPACTION_PROMPT = `You are creating a knowledge profile about a user based on their meeting/conversation summaries.
Your goal is to distill the most important, recurring, and actionable information into a concise profile.

Respond ONLY with a valid JSON object in this exact format (no markdown, no code blocks, just raw JSON):
{
  "summary": "Comprehensive 2-4 sentence summary of the user's work context, main responsibilities, and current focus areas",
  "key_people": [
    {"name": "Person Name", "role": "Their role/title", "relationship": "How they relate to the user"}
  ],
  "key_projects": [
    {"name": "Project Name", "status": "active/completed/planning", "description": "Brief description"}
  ],
  "terminology": [
    {"term": "Technical Term", "meaning": "What it means in this context"}
  ],
  "recent_goals": ["goal1", "goal2"],
  "recent_decisions": ["decision1", "decision2"],
  "recent_team_updates": ["update1", "update2"]
}

Rules:
- "summary": Focus on recurring themes, main work areas, and current priorities
- "key_people": Include only people mentioned multiple times or who seem important. Max 10 people.
- "key_projects": Include active and recent projects. Max 8 projects.
- "terminology": Include domain-specific terms, acronyms, or jargon used. Max 10 terms.
- "recent_goals": Important goals or objectives mentioned across recent meetings (max 10)
- "recent_decisions": Key decisions made in recent meetings (max 10)
- "recent_team_updates": Status updates about team members or projects from recent meetings (max 10)
- Prioritize information that would help an AI assistant provide more relevant responses
- Keep the entire profile concise (aim for ~500 tokens total)
- Merge similar entries and remove outdated information
- If existing profile has good information, preserve and update it rather than replacing`;

/**
 * Filters the user's name from key_people (case-insensitive).
 */
function filterUserFromKeyPeople(keyPeople: KeyPerson[]): KeyPerson[] {
  if (!hasUserIdentity()) {
    return keyPeople;
  }

  const identity = getUserIdentity();
  if (!identity?.name) {
    return keyPeople;
  }

  const userNameLower = identity.name.toLowerCase();
  return keyPeople.filter((p) => p.name.toLowerCase() !== userNameLower);
}

/**
 * Gets the user identity instruction for compaction prompts.
 */
function getUserIdentityCompactionInstruction(): string {
  if (!hasUserIdentity()) {
    return "";
  }

  const identity = getUserIdentity();
  if (!identity?.name) {
    return "";
  }

  return `\n- IMPORTANT: The user's name is "${identity.name}". Do NOT include "${identity.name}" in key_people - they are the user, not a contact.`;
}

/**
 * Formats summaries for compaction
 */
function formatSummariesForCompaction(summaries: MeetingSummary[]): string {
  return summaries
    .map((s, i) => {
      const date = new Date(s.createdAt).toLocaleDateString();
      let text = `[${i + 1}] ${date}\n`;
      if (s.title) {
        text += `Title: ${s.title}\n`;
      }
      text += `Summary: ${s.summary}\n`;
      if (s.topics.length > 0) {
        text += `Topics: ${s.topics.join(", ")}\n`;
      }
      if (s.goals.length > 0) {
        text += `Goals: ${s.goals.join("; ")}\n`;
      }
      if (s.actionItems.length > 0) {
        text += `Action Items: ${s.actionItems.join("; ")}\n`;
      }
      if (s.nextSteps.length > 0) {
        text += `Next Steps: ${s.nextSteps.join("; ")}\n`;
      }
      if (s.decisions.length > 0) {
        text += `Decisions: ${s.decisions.join("; ")}\n`;
      }
      if (s.teamUpdates.length > 0) {
        text += `Team Updates: ${s.teamUpdates.join("; ")}\n`;
      }
      if (s.participants.length > 0) {
        text += `Participants: ${s.participants.join(", ")}\n`;
      }
      return text;
    })
    .join("\n");
}

/**
 * Formats existing profile for compaction
 */
function formatExistingProfile(profile: KnowledgeProfile | null): string {
  if (!profile || !profile.summary) {
    return "No existing profile.";
  }

  let text = `Summary: ${profile.summary}\n\n`;

  if (profile.keyPeople.length > 0) {
    text += "Key People:\n";
    profile.keyPeople.forEach((p) => {
      text += `- ${p.name} (${p.role}): ${p.relationship}\n`;
    });
    text += "\n";
  }

  if (profile.keyProjects.length > 0) {
    text += "Key Projects:\n";
    profile.keyProjects.forEach((p) => {
      text += `- ${p.name} [${p.status}]: ${p.description}\n`;
    });
    text += "\n";
  }

  if (profile.terminology.length > 0) {
    text += "Terminology:\n";
    profile.terminology.forEach((t) => {
      text += `- ${t.term}: ${t.meaning}\n`;
    });
  }

  return text;
}

/**
 * Parses the compaction AI response
 */
function parseCompactionResponse(response: string): UpdateKnowledgeProfileInput | null {
  try {
    const parsed = JSON.parse(extractJsonObject(response));

    const result: UpdateKnowledgeProfileInput = {
      summary: typeof parsed.summary === "string" ? parsed.summary : undefined,
      keyPeople: [],
      keyProjects: [],
      terminology: [],
      recentGoals: [],
      recentDecisions: [],
      recentTeamUpdates: [],
    };

    // Parse key_people
    if (Array.isArray(parsed.key_people)) {
      result.keyPeople = parsed.key_people
        .filter(
          (p: any) =>
            p &&
            typeof p === "object" &&
            typeof p.name === "string" &&
            p.name.trim()
        )
        .slice(0, 10)
        .map(
          (p: any): KeyPerson => ({
            name: p.name,
            role: typeof p.role === "string" ? p.role : "",
            relationship: typeof p.relationship === "string" ? p.relationship : "",
          })
        );
    }

    // Parse key_projects
    if (Array.isArray(parsed.key_projects)) {
      result.keyProjects = parsed.key_projects
        .filter(
          (p: any) =>
            p &&
            typeof p === "object" &&
            typeof p.name === "string" &&
            p.name.trim()
        )
        .slice(0, 8)
        .map(
          (p: any): KeyProject => ({
            name: p.name,
            status: typeof p.status === "string" ? p.status : "active",
            description: typeof p.description === "string" ? p.description : "",
          })
        );
    }

    // Parse terminology
    if (Array.isArray(parsed.terminology)) {
      result.terminology = parsed.terminology
        .filter(
          (t: any) =>
            t &&
            typeof t === "object" &&
            typeof t.term === "string" &&
            t.term.trim()
        )
        .slice(0, 10)
        .map(
          (t: any): Terminology => ({
            term: t.term,
            meaning: typeof t.meaning === "string" ? t.meaning : "",
          })
        );
    }

    // Parse recent_goals
    if (Array.isArray(parsed.recent_goals)) {
      result.recentGoals = parsed.recent_goals
        .filter((g: any) => typeof g === "string" && g.trim())
        .slice(0, 10);
    }

    // Parse recent_decisions
    if (Array.isArray(parsed.recent_decisions)) {
      result.recentDecisions = parsed.recent_decisions
        .filter((d: any) => typeof d === "string" && d.trim())
        .slice(0, 10);
    }

    // Parse recent_team_updates
    if (Array.isArray(parsed.recent_team_updates)) {
      result.recentTeamUpdates = parsed.recent_team_updates
        .filter((u: any) => typeof u === "string" && u.trim())
        .slice(0, 10);
    }

    return result;
  } catch (error) {
    console.error("Failed to parse compaction response:", error);
    console.error("Raw response:", response);
    return null;
  }
}

/**
 * Checks if compaction should run based on time and summary count
 */
export async function shouldCompact(): Promise<{
  shouldRun: boolean;
  reason: string;
}> {
  const profile = await getKnowledgeProfile();
  const uncompactedCount = await getUncompactedSummaryCount();

  // Check summary count threshold
  if (uncompactedCount >= COMPACTION_SUMMARY_THRESHOLD) {
    return {
      shouldRun: true,
      reason: `${uncompactedCount} uncompacted summaries (threshold: ${COMPACTION_SUMMARY_THRESHOLD})`,
    };
  }

  // Check time threshold
  if (profile?.lastCompacted) {
    const daysSinceCompaction =
      (Date.now() - profile.lastCompacted) / (1000 * 60 * 60 * 24);
    if (daysSinceCompaction >= COMPACTION_DAYS_THRESHOLD && uncompactedCount > 0) {
      return {
        shouldRun: true,
        reason: `${Math.floor(daysSinceCompaction)} days since last compaction`,
      };
    }
  } else if (uncompactedCount > 0) {
    // No previous compaction and we have summaries
    return {
      shouldRun: true,
      reason: "No previous compaction and summaries exist",
    };
  }

  return {
    shouldRun: false,
    reason: `${uncompactedCount} uncompacted summaries, not enough to trigger compaction`,
  };
}

/**
 * Compacts summaries into the knowledge profile
 */
export async function compactKnowledge(
  providerConfig?: {
    provider: any;
    selectedProvider: {
      provider: string;
      variables: Record<string, string>;
    };
  }
): Promise<KnowledgeProfile | null> {
  try {
    // Get existing profile
    const existingProfile = await getKnowledgeProfile();

    // Get uncompacted summaries (oldest-first, strictly after the last
    // watermark). Bounded to COMPACTION_BATCH_SIZE; we advance the watermark
    // below only to the newest summary actually included, so a larger backlog
    // is drained over subsequent runs rather than being skipped.
    const sinceTimestamp = existingProfile?.lastCompacted || 0;
    const summaries = await getOldestUncompactedSummaries(
      COMPACTION_BATCH_SIZE,
      sinceTimestamp
    );

    if (summaries.length === 0) {
      console.log("No summaries to compact");
      return existingProfile;
    }

    // Format data for AI
    const existingProfileText = formatExistingProfile(existingProfile);
    const summariesText = formatSummariesForCompaction(summaries);

    const userMessage = `EXISTING PROFILE:
${existingProfileText}

NEW SUMMARIES TO INCORPORATE (${summaries.length} total):
${summariesText}

Create the updated knowledge profile JSON:`;

    // Use AI to generate compacted profile
    const useMeetwingsAPI = await shouldUseMeetwingsAPI();

    if (!useMeetwingsAPI && !providerConfig) {
      console.log("No AI provider configured for compaction");
      return null;
    }

    let fullResponse = "";

    for await (const chunk of fetchAIResponse({
      provider: useMeetwingsAPI ? undefined : providerConfig?.provider,
      selectedProvider: providerConfig?.selectedProvider || {
        provider: "",
        variables: {},
      },
      systemPrompt: COMPACTION_PROMPT + getUserIdentityCompactionInstruction(),
      history: [],
      userMessage,
      imagesBase64: [],
    })) {
      fullResponse += chunk;
    }

    // Parse the response
    const updates = parseCompactionResponse(fullResponse);

    if (!updates || !updates.summary) {
      console.error("Failed to generate valid compacted profile");
      return null;
    }

    // Filter user from key_people (in case AI included them despite instruction)
    if (updates.keyPeople) {
      updates.keyPeople = filterUserFromKeyPeople(updates.keyPeople);
    }

    // Update source count
    updates.sourceCount = (existingProfile?.sourceCount || 0) + summaries.length;

    // Advance the watermark only to the newest summary we actually incorporated
    // (summaries are oldest-first). Anything created after this stays uncompacted
    // and is picked up next run, instead of being skipped by a blanket "now".
    //
    // The next run re-queries with strict `created_at > watermark`. This assumes
    // no two summaries share the exact same ms createdAt across a batch boundary:
    // if the batch ended on one of a same-ms pair, the other would be excluded
    // permanently. Safe in practice — every summary creation is gated behind its
    // own multi-second streaming AI call, so consecutive summaries never collide
    // on Date.now(). Closing it fully would need a composite (created_at, id)
    // watermark (an extra stored last_compacted_id).
    updates.lastCompacted = summaries[summaries.length - 1].createdAt;

    // Save the updated profile
    const updatedProfile = await updateKnowledgeProfile(updates);

    console.log(
      `Compacted ${summaries.length} summaries into knowledge profile (total sources: ${updates.sourceCount})`
    );

    return updatedProfile;
  } catch (error) {
    console.error("Error during knowledge compaction:", error);
    return null;
  }
}

/**
 * Runs compaction if needed (call on app startup or periodically)
 */
export async function runCompactionIfNeeded(
  providerConfig?: {
    provider: any;
    selectedProvider: {
      provider: string;
      variables: Record<string, string>;
    };
  }
): Promise<boolean> {
  const { shouldRun, reason } = await shouldCompact();

  if (!shouldRun) {
    console.log(`Skipping compaction: ${reason}`);
    return false;
  }

  console.log(`Running compaction: ${reason}`);
  const result = await compactKnowledge(providerConfig);
  return result !== null;
}
