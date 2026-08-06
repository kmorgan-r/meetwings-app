use tauri_plugin_sql::{Migration, MigrationKind};

/// Returns all database migrations
pub fn migrations() -> Vec<Migration> {
    vec![
        // Migration 1: Create system_prompts table with indexes and triggers
        Migration {
            version: 1,
            description: "create_system_prompts_table",
            sql: include_str!("migrations/system-prompts.sql"),
            kind: MigrationKind::Up,
        },
        // Migration 2: Create chat history tables (conversations and messages)
        Migration {
            version: 2,
            description: "create_chat_history_tables",
            sql: include_str!("migrations/chat-history.sql"),
            kind: MigrationKind::Up,
        },
        // Migration 3: Create API usage tracking table
        Migration {
            version: 3,
            description: "create_api_usage_table",
            sql: include_str!("migrations/api-usage.sql"),
            kind: MigrationKind::Up,
        },
        // Migration 4: Add audio_seconds column for STT cost tracking
        Migration {
            version: 4,
            description: "add_audio_seconds_to_api_usage",
            sql: include_str!("migrations/api-usage-v2.sql"),
            kind: MigrationKind::Up,
        },
        // Migration 5: Remove foreign key constraint (conversation may not exist yet when usage is recorded)
        Migration {
            version: 5,
            description: "remove_fk_from_api_usage",
            sql: include_str!("migrations/api-usage-v3.sql"),
            kind: MigrationKind::Up,
        },
        // Migration 6: Meeting context memory tables (summaries, entities, knowledge profile)
        Migration {
            version: 6,
            description: "create_meeting_context_tables",
            sql: include_str!("migrations/meeting-context.sql"),
            kind: MigrationKind::Up,
        },
        // Migration 7: Add enhanced fields to meeting context tables
        Migration {
            version: 7,
            description: "add_enhanced_meeting_context_fields",
            sql: include_str!("migrations/meeting-context-v7.sql"),
            kind: MigrationKind::Up,
        },
        // Migration 8: Record which speaker each message came from
        Migration {
            version: 8,
            description: "add_speaker_to_messages",
            sql: include_str!("migrations/chat-history-v8.sql"),
            kind: MigrationKind::Up,
        },
        // Migration 9: Record when each summarized meeting actually happened
        Migration {
            version: 9,
            description: "add_meeting_window_to_summaries",
            sql: include_str!("migrations/meeting-context-v9.sql"),
            kind: MigrationKind::Up,
        },
        // Migration 10: Name each summarized conversation after its summary
        Migration {
            version: 10,
            description: "adopt_summary_titles_for_conversations",
            sql: include_str!("migrations/meeting-context-v10.sql"),
            kind: MigrationKind::Up,
        },
    ]
}
