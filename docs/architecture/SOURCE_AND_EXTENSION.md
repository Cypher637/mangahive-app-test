# Source & Extension Architecture — Phase 0

## Source

A **Source** is a first-class domain concept representing an external manga provider.

Examples already present:
- MangaDex, ComicK (built-in reader-capable)
- Mangpi, MangaHook (self-hosted)
- AniList, Jikan, Kitsu (metadata-only)
- Mihon extension sources

Core MangaHive domain code must not call MangaDex- or ComicK-specific APIs directly.  
It must go through a SourceAdapter (or the existing equivalent runtime).

### Target contract (conceptual)

```
SourceAdapter
  search(query) → MangaSummary[]
  getManga(externalId) → MangaDetails
  getChapters(externalId) → ChapterSummary[]
  getChapterPages(externalChapterId) → Page[]
  healthCheck() → Health
```

The existing Stage 8/9/10 source runtime already moves in this direction; Phase 0 freezes the boundary.

## Extension

An **Extension** is independent of Source.

```
Extension
   └── provides one or more Sources
```

### Rules already enforced (must be preserved)

- Manifest version + apiVersion required
- Namespaced lowercase IDs only
- Explicit permissions list
- Controlled engines only — **no arbitrary JavaScript execution**
- Reserved namespaces: `mangahive.*`, `community.*`, `vendor.*`

### Trust & Lifecycle (architectural)

| State        | Meaning                                      |
|--------------|----------------------------------------------|
| trusted      | First-party or explicitly verified           |
| community    | User-installed, limited trust                |
| quarantined  | Temporarily disabled after policy violation |
| disabled     | User or system turned off                    |
| uninstalled  | Removed; completed downloads remain          |

### Isolation requirements

Extensions must not be able to:

- Access private backend APIs or auth tokens
- Read unrelated application storage
- Modify application databases
- Access arbitrary filesystem paths
- Execute downloaded content as code

Android `mihon-net` BrokerEngine already provides strong network isolation. This boundary must not be weakened.

## Binding Identity (Stage 9 — correct)

```
extensionId + sourceId + remoteId
```

A binding from one extension/source cannot be substituted for another merely because the remote ID string is equal.
