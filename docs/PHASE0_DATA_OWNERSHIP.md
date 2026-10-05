# Phase 0 Data Ownership Model

| Domain | Authoritative owner | Persistence | Sync strategy | ID strategy | Offline | Deletion |
|--------|---------------------|-------------|---------------|-------------|---------|----------|
| **User / Profile** | Server (Supabase Auth + profiles) | Postgres | Auth is source of truth | `auth.users.id` = `profiles.id` (UUID) | Session cache only | Account delete cascades profile |
| **Manga (canonical)** | Client-local for now; metadata from sources | IndexedDB / in-memory; source APIs | No server manga table in Phase 0 | Stable local canonical id (Stage 9); external ids only in bindings | Full local | Binding removal does not destroy canonical entity |
| **Chapter (canonical)** | Client-local | IndexedDB | Same as manga | Canonical chapter id; bindings hold remote ids | Full local | Same |
| **Source** | Built-in registry + extension manifests | Code + extension storage | Install/enable is local/native | sourceId + extensionId | Offline uses downloads | Disable ≠ delete downloads |
| **Extension** | Device (install state) | Android isolated process + web registry | No central extension store required for Phase 0 | Namespaced extension id | N/A | Uninstall keeps completed downloads |
| **Library** | Client-local (user device) | IndexedDB | Future: server `library_entries (user_id, manga_id)` UNIQUE | Canonical manga id | Yes | User-controlled |
| **Reading progress** | Client-local | IndexedDB | Future: server unique (user, manga, chapter) | Canonical ids only | Yes | User-controlled |
| **Downloads** | Client-local + Android native offline store | IndexedDB blobs + filesystem | Not server-synced in Phase 0 | Canonical chapter **+** source binding | Primary offline path | User-controlled; extension removal does not delete |
| **Social graph** | Server | Postgres + RLS | Realtime optional | UUID | Online-first | Cascades on account delete |
| **Messages** | Server | Postgres + RLS | Online-first | UUID | Not offline-first | Participant leave ≠ message delete |
| **Reports** | Server | Postgres | Moderator workflow later | UUID | N/A | Retention for moderation |

## Explicit Phase 0 decisions

1. **Library / progress / downloads are client-authoritative** until a sync phase adds server tables. Security does not depend on nonexistent server rows for these domains.
2. **Canonical IDs remain valid** when server sync is added later; migrations must not redefine identity.
3. **Social and messaging are server-authoritative** with RLS as the boundary.
4. **No false API** is promised for server manga/library in Phase 0.
