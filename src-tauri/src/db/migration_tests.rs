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
}
