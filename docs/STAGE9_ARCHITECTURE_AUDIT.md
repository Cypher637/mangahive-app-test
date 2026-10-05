# MangaHive Phase 9 Architecture Audit

Baseline: audited Stage 8.1.

Phase 9 extends the existing `series.id` identity rather than replacing it. `series.id` remains the stable MangaHive-local canonical manga identity so existing library, history, follows, comments, notifications, bookmarks, and share references remain valid.

## Identity

- Canonical manga: `series.canonicalId` (stable alias of existing `series.id`).
- Remote source binding: `extensionId + sourceId + remoteId`.
- Canonical chapter: `chapter.canonicalChapterId`, derived from canonical manga + structured chapter identity.
- Remote chapter binding: `extensionId + sourceId + remoteId`.
- Titles and chapter numbers are metadata, never immutable remote identity.

## Matching

Matching states are `EXACT`, `VERIFIED_EXTERNAL_ID`, `STRONG_MATCH`, `POSSIBLE_MATCH`, and `UNMATCHED`. The client only automatically merges an exact existing source binding or a single strong metadata match; title-only candidates remain unmerged.

## Reader

The reader continues to resolve pages through the existing source adapter/broker. A user-selected source is stored as an explicit source-binding key. Automatic fallback is disabled by default and is opt-in.

## Migration

Existing series IDs are preserved. Startup normalization adds canonical metadata, source-binding keys, extension ownership, and canonical chapter IDs. The migration is idempotent and does not delete existing user records.

## Environment limitation

Gradle/device verification is intentionally deferred. JVM/JS/static tests remain the authoritative verification available in this environment.
