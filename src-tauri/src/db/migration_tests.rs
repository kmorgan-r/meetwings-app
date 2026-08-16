#[cfg(test)]
mod tests {
    use crate::db::migrations;
    use std::collections::HashSet;
    use std::fs;

    #[test]
    fn migration_versions_are_unique_and_monotonic() {
        let versions: Vec<i64> = migrations().iter().map(|m| m.version).collect();
        let unique: HashSet<i64> = versions.iter().copied().collect();
        assert_eq!(unique.len(), versions.len(), "duplicate migration version");
        let mut sorted = versions.clone();
        sorted.sort_unstable();
        assert_eq!(sorted, versions, "migrations are not in ascending order");
    }

    /// A migration file written but never `include_str!`'d compiles fine and
    /// leaves the vec perfectly unique and monotonic. This is the only check
    /// that catches it. (The inverse - `include_str!` of a missing file - is
    /// already a compile error.)
    #[test]
    fn every_migration_file_is_registered() {
        let descriptions: Vec<&str> = migrations().iter().map(|m| m.description).collect();
        assert_eq!(
            descriptions.len(),
            fs::read_dir("src/db/migrations")
                .expect("migrations dir")
                .filter(|e| {
                    e.as_ref()
                        .map(|e| e.path().extension().is_some_and(|x| x == "sql"))
                        .unwrap_or(false)
                })
                .count(),
            "a .sql file in src/db/migrations is not registered in migrations()"
        );
    }

    /// The two checks above only bound the shape of the migrations() vec
    /// (unique/ascending versions, count matching files on disk) - neither
    /// one ties the Odoo migration to its specific version or its specific
    /// file. A migration mistakenly registered as version 20, or one that
    /// points at the wrong existing .sql file, would pass both of them
    /// silently. Comparing `sql` against `include_str!` of the real file
    /// binds the registration to that exact file, since include_str!
    /// resolves at compile time - a pointer at the wrong file would embed
    /// different content and fail this comparison.
    #[test]
    fn odoo_migration_is_version_11_and_points_at_its_own_file() {
        let odoo = migrations()
            .into_iter()
            .find(|m| m.description == "create_odoo_contact_tables")
            .expect("odoo migration must be registered");
        assert_eq!(odoo.version, 11, "odoo migration must be version 11");
        assert_eq!(
            odoo.sql,
            include_str!("migrations/odoo-contacts.sql"),
            "odoo migration must embed migrations/odoo-contacts.sql"
        );
    }

    /// Same reasoning as the version-11 test above: the two generic checks
    /// bound only the SHAPE of the vec. A queue migration mistakenly
    /// registered as version 11 would collide with an already-applied
    /// checksum and brick Database.load for every existing user.
    #[test]
    fn meeting_log_queue_migration_is_version_12_and_points_at_its_own_file() {
        let queue = migrations()
            .into_iter()
            .find(|m| m.description == "create_meeting_log_queue")
            .expect("meeting log queue migration must be registered");
        assert_eq!(
            queue.version, 12,
            "meeting log queue migration must be version 12"
        );
        assert_eq!(
            queue.sql,
            include_str!("migrations/meeting-log-queue.sql"),
            "meeting log queue migration must embed migrations/meeting-log-queue.sql"
        );
    }
}
