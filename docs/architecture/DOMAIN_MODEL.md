# Canonical Domain Model — Phase 0

**Status:** Phase 0 Foundation  
**Baseline:** Stage 10.1 (canonical manga/chapter already exist)

## Core Principle

MangaHive entities have **internal canonical identities**.  
External source identifiers live only in **bindings**.

Never use an external source ID as the primary identity of a MangaHive entity.

## Entities

### User / Profile

```
Authentication identity (Supabase Auth)
        ↓
User (application account)
        ↓
Profile (display data)
```

| Entity  | Key fields                          | Notes                                      |
|---------|-------------------------------------|--------------------------------------------|
| User    | id, auth_identity_ref, status, timestamps | Canonical account. Future social features reference User.id |
| Profile | user_id, username, display_name, avatar, bio, privacy | Display only. Username is not canonical identity |

### Manga

| Field              | Meaning                                      |
|--------------------|----------------------------------------------|
| id                 | Canonical internal ID (stable across sources)|
| title, aliases     | Display / search metadata                    |
| authors, artists   | Metadata                                     |
| genres             | Metadata                                     |
| created_at / updated_at | Lifecycle                               |

A Manga can have many `MangaSourceBinding`s.  
Deleting a binding or a source **must not** destroy the canonical Manga.

### MangaSourceBinding

```
manga_id + source_id + external_manga_id
(+ extension_id when applicable)
```

This is the only place external manga IDs live.

### Chapter

| Field              | Meaning                                      |
|--------------------|----------------------------------------------|
| id                 | Canonical internal ID                        |
| manga_id           | Parent canonical manga                       |
| number / title     | Display                                      |
| created_at         | Lifecycle                                    |

### ChapterSourceBinding

```
chapter_id + source_id + external_chapter_id
(+ extension_id)
```

### Source

First-class concept representing an external provider (MangaDex, ComicK, Mihon extension source, etc.).

| Field     | Meaning                    |
|-----------|----------------------------|
| id        | Internal source ID         |
| name      | Display                    |
| type      | builtin / extension / …    |
| status    | healthy / degraded / …     |
| metadata  | Configuration              |

### Extension

Independent of Source. An Extension may provide one or more Sources.

| Field              | Meaning                              |
|--------------------|--------------------------------------|
| id                 | Namespaced package ID                |
| version            | SemVer                               |
| trust_state        | trusted / community / quarantined    |
| signature metadata | Future verification                  |
| capabilities       | Declared permissions                 |
| installation state | installed / enabled / disabled       |

### LibraryEntry

```
user_id + manga_id   (canonical)
```

Source-independent. Status, favourite, category, timestamps live here.

### ReadingProgress

```
user_id + manga_id + chapter_id   (all canonical)
+ page / position / percentage / last_read_at
```

Source IDs are metadata only, never part of the uniqueness key.

### Download / DownloadItem

Already implemented in Stage 10:

- Identity is canonical chapter **plus** source binding
- Manifest records extensionId, sourceId, remote IDs, SHA-256, sizes
- Staging → validation → atomic finalization

### Social (already partially present)

- Comment, Reaction, Follow, Friendship, Block, Notification, Group, GroupMembership, Report

These reference **User.id**, never usernames.

## Ownership & Lifecycle Rules

| Entity            | Owner          | Delete behaviour                                      |
|-------------------|----------------|-------------------------------------------------------|
| Manga             | System         | Soft-delete preferred. Never cascade-destroy library or progress |
| MangaSourceBinding| System         | Safe to remove. Does not destroy Manga or Chapters    |
| LibraryEntry      | User           | User-controlled                                       |
| ReadingProgress   | User           | User-controlled                                       |
| Download          | User           | User-controlled. Extension removal does not delete completed downloads |
| Profile           | User           | Soft-delete with account                              |
| Block / Report    | User / System  | Retention for moderation                              |

## Identifier Strategy (Phase 0 decision)

- Prefer **UUID** (or UUIDv7 when available) for new canonical entities.
- Existing Stage 9/10 series IDs are retained for backward compatibility.
- External source IDs are **never** promoted to canonical IDs.
- Generation location: server-side preferred for social/user data; client-side acceptable for pure local download manifests as long as they are treated as local-only.

## Invariants

1. A LibraryEntry always points at a canonical Manga, never a source-specific remote ID.
2. ReadingProgress is unique per (user, manga, chapter) canonical tuple.
3. A source binding cannot be substituted for another merely because the remote ID string matches.
4. Automatic cross-source linking requires exact existing binding or strong metadata match (title + year/author). Exact-title-only is a candidate, never an automatic merge.
