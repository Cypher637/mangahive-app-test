# Phase 9 Migration

Migration is an in-place normalization of the existing local state. It preserves existing series IDs and all collection/history references. New canonical fields are added lazily and persisted on the next state write. Running the migration repeatedly is safe.
