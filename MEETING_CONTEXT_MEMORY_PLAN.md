# Meeting Context Memory Feature

## Summary
A system that automatically summarizes meeting/conversation sessions, extracts key entities, and injects relevant historical context into AI prompts for more personalized assistance.

## Key Features
1. **Auto-Summarization** - Summarize every session with 2+ exchanges when it ends
2. **Entity Extraction** - Extract people, projects, terms, companies from conversations
3. **Knowledge Compaction** - Consolidate older summaries into a "knowledge profile" (30 days or threshold)
4. **Context Injection** - Automatically prepend relevant context to AI prompts
5. **Dashboard UI** - View/edit summaries, entities, and toggle settings

---

## Database Schema (Migration v6)

### Table 1: `meeting_summaries`
Stores AI-generated summaries per conversation.

| Column | Type | Description |
|--------|------|-------------|
| id | TEXT PK | UUID |
| conversation_id | TEXT UNIQUE | Links to conversations table |
| summary | TEXT | Markdown summary of the session |
| topics | TEXT | JSON array: `["topic1", "topic2"]` |
| action_items | TEXT | JSON array of action items |
| decisions | TEXT | JSON array of decisions made |
| participants | TEXT | JSON array of mentioned people |
| exchange_count | INTEGER | Number of user/assistant exchanges |
| created_at | INTEGER | Timestamp |
| updated_at | INTEGER | Timestamp |

### Table 2: `knowledge_entities`
Extracted entities (people, projects, terms, companies).

| Column | Type | Description |
|--------|------|-------------|
| id | TEXT PK | UUID |
| entity_type | TEXT | 'person', 'project', 'term', 'company' |
| name | TEXT | Entity name |
| description | TEXT | AI-generated description |
| first_seen | INTEGER | First mention timestamp |
| last_seen | INTEGER | Most recent mention timestamp |
| mention_count | INTEGER | Total mentions across all sessions |

**Unique constraint**: `(entity_type, name)`

### Table 3: `entity_mentions`
Many-to-many link between entities and summaries.

| Column | Type | Description |
|--------|------|-------------|
| entity_id | TEXT | FK to knowledge_entities |
| summary_id | TEXT | FK to meeting_summaries |

**Primary key**: `(entity_id, summary_id)`

### Table 4: `knowledge_profile`
Compacted long-term memory (single row).

| Column | Type | Description |
|--------|------|-------------|
| id | TEXT PK | Always 'profile' |
| summary | TEXT | Compacted profile summary |
| key_people | TEXT | JSON: Most important people |
| key_projects | TEXT | JSON: Active projects |
| terminology | TEXT | JSON: Domain-specific terms |
| last_compacted | INTEGER | Timestamp of last compaction |
| source_count | INTEGER | Number of summaries compacted |

---

## Implementation Steps

### Step 1: Database Foundation
**Files to create:**
- `src-tauri/src/db/migrations/meeting-context.sql` - SQL migration
- `src/types/meeting-context.ts` - TypeScript interfaces
- `src/lib/database/meeting-context.action.ts` - CRUD operations

**Files to modify:**
- `src-tauri/src/db/main.rs` - Add migration v6

### Step 2: Summarization Backend
**Files to create:**
- `src/lib/functions/meeting-summarizer.ts` - AI-powered summarization

**Summarization triggers (files to modify):**
- `src/hooks/useSystemAudio.ts` - Trigger on `stopCapture()` when 2+ exchanges
- `src/hooks/useCompletion.ts` - Trigger on conversation switch or explicit end

**Summarization prompt template:**
```
Analyze this conversation and provide a structured summary:

CONVERSATION:
{conversation_history}

Respond in this exact JSON format:
{
  "summary": "2-3 sentence summary of what was discussed",
  "topics": ["topic1", "topic2"],
  "action_items": ["action1", "action2"],
  "decisions": ["decision1"],
  "participants": ["person1", "person2"],
  "entities": [
    {"type": "person", "name": "John", "description": "Project manager"},
    {"type": "project", "name": "Alpha", "description": "Q1 initiative"}
  ]
}
```

### Step 3: Knowledge Compaction
**Files to create:**
- `src/lib/functions/knowledge-compactor.ts` - Profile compaction logic

**Compaction triggers:**
- On app startup if >30 days since last compaction
- When uncompacted summary count exceeds threshold (e.g., 50)

**Compaction prompt template:**
```
You are creating a knowledge profile about a user based on their meeting summaries.

EXISTING PROFILE:
{existing_profile}

NEW SUMMARIES TO INCORPORATE:
{new_summaries}

Create an updated profile in JSON format:
{
  "summary": "Comprehensive summary of the user's work context",
  "key_people": [{"name": "...", "role": "...", "relationship": "..."}],
  "key_projects": [{"name": "...", "status": "...", "description": "..."}],
  "terminology": [{"term": "...", "meaning": "..."}]
}

Keep the profile concise (~500 tokens max).
```

### Step 4: Context Injection
**Files to modify:**
- `src/lib/functions/ai-response.function.ts` - Modify `buildEnhancedSystemPrompt()`

**Files to create:**
- `src/lib/functions/context-builder.ts` - Build context string from DB

**Context injection template:**
```
## Your Context About the User

### Long-term Knowledge Profile
{knowledge_profile_summary}

### Key People
{key_people_list}

### Active Projects
{key_projects_list}

### Recent Context (Last 30 Days)
{recent_summaries_condensed}

### Domain Terminology
{terminology_glossary}

---

{original_system_prompt}
```

**Token budget:** ~1500 tokens total
- Profile summary: ~500 tokens
- Recent summaries: ~800 tokens
- People/Projects/Terms: ~200 tokens

### Step 5: Settings (localStorage)
**Storage keys:**
- `context_memory_enabled` - boolean (default: true)
- `context_memory_max_tokens` - number (default: 1500)
- `context_memory_days` - number (default: 30)

**Files to modify:**
- `src/config/constants.ts` - Add STORAGE_KEYS

### Step 6: UI Dashboard
**Files to create:**
```
src/pages/context-memory/
├── index.tsx                    # Main page layout
└── components/
    ├── index.ts                 # Barrel export
    ├── SummaryList.tsx          # List of meeting summaries
    ├── SummaryDetail.tsx        # View/edit single summary
    ├── KnowledgeProfile.tsx     # View/edit profile
    ├── EntityBrowser.tsx        # Browse extracted entities
    └── ContextSettings.tsx      # Toggle and configure
```

**Files to modify:**
- `src/routes/index.tsx` - Add route
- `src/hooks/useMenuItems.tsx` - Add menu item
- `src/pages/index.ts` - Export page

---

## Files Summary

### Files to Create (12)
```
src-tauri/src/db/migrations/meeting-context.sql
src/types/meeting-context.ts
src/lib/database/meeting-context.action.ts
src/lib/functions/meeting-summarizer.ts
src/lib/functions/knowledge-compactor.ts
src/lib/functions/context-builder.ts
src/pages/context-memory/index.tsx
src/pages/context-memory/components/index.ts
src/pages/context-memory/components/SummaryList.tsx
src/pages/context-memory/components/SummaryDetail.tsx
src/pages/context-memory/components/KnowledgeProfile.tsx
src/pages/context-memory/components/EntityBrowser.tsx
src/pages/context-memory/components/ContextSettings.tsx
```

### Files to Modify (8)
```
src-tauri/src/db/main.rs              # Add migration v6
src/lib/functions/ai-response.function.ts  # Context injection
src/hooks/useSystemAudio.ts           # Trigger summarization
src/hooks/useCompletion.ts            # Trigger summarization
src/config/constants.ts               # Add storage keys
src/routes/index.tsx                  # Add route
src/hooks/useMenuItems.tsx            # Add menu item
src/pages/index.ts                    # Export page
```

---

## Technical Notes

### Token Management
- Context limited to ~1500 tokens total
- Use tiktoken or simple word count estimation (1 token ≈ 4 chars)
- Truncate oldest summaries first if over budget

### Performance
- Summarization runs async after session ends (non-blocking)
- Compaction runs on startup in background
- Context building cached for 5 minutes

### Data Privacy
- All data stored locally in SQLite
- No data sent to external servers (uses existing AI provider)
- User can delete all context data from settings

### Edge Cases
- Empty conversations (< 2 exchanges): Skip summarization
- AI provider not configured: Queue for later or skip
- Very long conversations: Summarize in chunks if needed

---

## Implementation Order

1. **Phase 1: Core Infrastructure** (Steps 1-2)
   - Database schema
   - Types
   - Summarization function
   - Trigger in useSystemAudio

2. **Phase 2: Context Features** (Steps 3-4)
   - Knowledge compaction
   - Context builder
   - Injection into AI prompts

3. **Phase 3: UI & Polish** (Steps 5-6)
   - Settings
   - Dashboard UI
   - Testing & edge cases

---

## Testing Checklist

- [ ] Summarization triggers after System Audio session ends
- [ ] Summarization triggers after Conversation Mode session switch
- [ ] Entities extracted and deduplicated correctly
- [ ] Knowledge profile compacts after 30 days
- [ ] Context injected into AI prompts
- [ ] Context respects token budget
- [ ] UI displays summaries correctly
- [ ] UI allows editing/deleting summaries
- [ ] Settings toggle works
- [ ] Performance: No noticeable lag during summarization
