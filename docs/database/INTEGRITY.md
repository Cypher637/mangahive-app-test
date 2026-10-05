# Database Integrity & RLS Expectations — Phase 0

## Constraints That Must Exist

For every core table:

- Primary keys
- Foreign keys where relationships are required
- Unique constraints that prevent:
  - Duplicate library entries for the same (user, manga)
  - Duplicate progress for the same (user, manga, chapter)
  - Duplicate friendships / follows / blocks
  - Duplicate source bindings for the same (manga, source, external_id)
- NOT NULL on required columns
- Sensible defaults for timestamps and status fields

## Cascades

**Critical rule already stated in Stage 9/10 docs and reinforced here:**

Deleting a Source or a SourceBinding must **not** cascade-destroy:

- Canonical Manga
- Canonical Chapters
- LibraryEntry
- ReadingProgress
- Completed Downloads

Those are user or system data that outlive any particular provider.

## RLS Expectations (must be audited on the live project)

| Table category          | SELECT                          | INSERT / UPDATE / DELETE              |
|-------------------------|---------------------------------|---------------------------------------|
| Public metadata         | Authenticated or public         | System / admin only                   |
| profiles                | According to privacy settings   | Owner only                            |
| library / progress      | Owner only                      | Owner only                            |
| posts / comments        | Public or friends (policy)      | Author only (mods later)              |
| blocks / reports        | Involved parties / mods         | Reporter / blocker only               |
| conversations / messages| Participants only               | Participants only                     |
| downloads (if synced)   | Owner only                      | Owner only                            |

**Forbidden pattern:** `USING (true)` or equivalent unrestricted policies on private user data.

## Migrations

All schema changes must go through ordered, reviewable migrations.  
No manual production schema edits.

## Current State Note

The Stage 10.1 repository does not contain the Supabase migration files themselves (they live in the remote project). Phase 0 requires that any future schema work is migration-based and that RLS is audited against the rules above.
