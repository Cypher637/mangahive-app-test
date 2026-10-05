# Identity & Canonical IDs — Phase 0

## Absolute Rule

**External source identifiers must never become the primary identity of a MangaHive entity.**

## Two ID Spaces

| Space                    | Example                              | Lifetime          | Used for                          |
|--------------------------|--------------------------------------|-------------------|-----------------------------------|
| Canonical (internal)     | `manga.id`, `chapter.id`, `user.id`  | Long-lived        | Library, progress, social, downloads identity |
| External (source)        | MangaDex UUID, ComicK id, Mihon remoteId | Source-dependent | Bindings only                     |

## Binding Pattern (already partially implemented in Stage 9)

```
Manga (canonical)
  └── MangaSourceBinding
        ├── manga_id          (canonical)
        ├── source_id         (or extensionId + sourceId)
        └── external_manga_id

Chapter (canonical)
  └── ChapterSourceBinding
        ├── chapter_id        (canonical)
        ├── source_id
        └── external_chapter_id
```

## Library & Progress

```
LibraryEntry   →  (user_id, manga_id)          // both canonical
ReadingProgress → (user_id, manga_id, chapter_id) // all canonical
```

Source information is metadata, never part of the uniqueness key.

## Download Identity (Stage 10 — already correct)

A download is keyed by:

```
canonical chapter + extensionId + sourceId + remoteChapterId
```

This is the correct Phase 0 pattern and must be preserved.

## User Identity

```
Supabase Auth UID  →  User.id  →  Profile.user_id
```

- Social features (follows, blocks, comments, messages) must reference `User.id`.
- Usernames are display identifiers only and may change.

## Generation Rules (Phase 0 decision)

- New canonical entities: UUID (prefer UUIDv7 when the stack supports it).
- Existing Stage 9 series IDs are retained for backward compatibility; they are treated as canonical.
- Client-generated IDs are acceptable only for pure local artifacts (e.g. download job IDs) that never leave the device or are treated as untrusted until server-validated.
- Server-generated IDs are required for any entity that participates in social graph, ownership, or cross-device sync.

## Migration Rule

When an external ID is discovered:

1. Look for an existing binding.
2. If none, create a new canonical entity + binding.
3. Never overwrite or replace an existing canonical ID with an external ID.
