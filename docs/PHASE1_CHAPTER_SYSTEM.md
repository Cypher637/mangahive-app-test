# Phase 1 / Stage 4 — Chapter System

## Overview

The Chapter System is the **authoritative layer** for chapter data between source adapters and Details / Reader.

```
Source Adapter
      ↓
Chapter Normalization   (chapterSystem.normalizeChapter)
      ↓
Chapter Identity          (identity module)
      ↓
Dedupe / Merge            (dedupeChapters / mergeChapters)
      ↓
Order + Progress          (orderChapters / attachProgress)
      ↓
Details UI / openChapter  (validateOpenChapter → Reader route)
```

Journey:

```
Discover → Search → Details → Chapters → Open Chapter → Reader (Stage 5)
```

## Module layout

| Module | Path | Role |
|--------|------|------|
| Chapter domain | `src/domain/chapterSystem.js` | Normalize, identity, dedupe, merge, order, progress, open contract |
| Chapter service | `src/services/chapterService.js` | `getChapters` orchestration with injected fetchers + stale-token guard |
| Chapter order | `src/domain/chapterOrder.js` | Deterministic sort / next / previous (Stage 1) |
| Identity | `src/domain/identity.js` | Canonical chapter / series identity (Stage 1) |

UI must not maintain a second chapter model. Source-specific parsing stays out of Details/Reader.

## Chapter model

Normalized shape (compatible with existing library chapter records):

| Field | Notes |
|-------|--------|
| `id` | **Stable local id** — never mass-migrated |
| `canonicalChapterId` | Deterministic canonical id when derivable |
| `canonicalSeriesId` / `seriesId` | Series linkage |
| `number` / `numberText` | Parsed number + original source text |
| `volume`, `title`, `publishedAt`, `language` | Metadata |
| `pages` / `pageCount` | Page payload when present |
| `sourceBindings` | `{ sourceId, remoteId, language, available, chapter }` — **no URLs** |
| `primarySourceId`, `remoteId` | Convenience |
| `available` | Explicit availability for open validation |
| `readState` / `progress` | Attached via progress map, not stored as separate system |

## Identity

- Does **not** depend on array index, title alone, or random generation.
- Uses Stage 1 `getChapterIdentity` (series + structure + source bindings).
- Same source + remote id → same logical chapter across refresh.
- Existing `chapter.id` references keep working.

## Source bindings

- Multiple sources per chapter are first-class.
- Adding a source **adds a binding**; it does not replace primary identity.
- Bindings never include navigational external URLs.

## Normalization

`normalizeChapter(raw, series, options)` accepts source or local records and emits the normalized model.

- Chapter numbers preserve `numberText` (e.g. `"0.5"`, `"10"`).
- Dates: invalid strings → `null` (never fabricated).
- Untrusted HTML is not executed (titles clipped as plain text).

## Ordering

`orderChapters(chapters, direction)` uses `chapterOrder.sortChapters`.

- Correct numeric order: 1, 2, 2.5, 10
- `direction: 'desc'` is **presentation only** — does not mutate stored data

## Deduplication

Conservative matching order:

1. `canonicalChapterId`
2. Local `id`
3. `sourceId` + `remoteId`

Does **not** merge solely because titles or numbers match.

## Merge / refresh

`mergeChapters(existing, incoming, series)`:

- Preserves local id, progress linkage, good metadata
- Fills gaps only; empty incoming does not wipe titles/volumes
- Adds source bindings when the same chapter appears on another source
- **Does not delete** local chapters missing from a source feed

`refreshChapters` + `chapterIdentitySnapshot` support idempotence checks.

## Fetch service

```js
MangaHiveServices.chapterService.getChapters(series, {
  fetchers: [{ sourceId, fetch(series, ctx) }],
  seriesProgress,
  direction,
  requestToken,
  signal
})
```

- Source failures are isolated (`status: 'partial' | 'ok' | 'error' | 'stale'`)
- Stale `requestToken` results are discarded (`stale: true`)
- Pagination fields `hasMore` / `nextCursor` pass through per source result

## Availability

- `available: false` → open rejected with in-app “Chapter unavailable”
- **No third-party redirects** under any failure mode

## Progress / Continue Reading

Uses existing progress map shapes (`state.progress[seriesId]` keyed by chapter id, and legacy forms).

`resolveContinueChapter`:

1. Latest **started** incomplete chapter  
2. Else first **unread** in ascending order  
3. All completed → `finished`  
4. No chapters → `empty`

Completed chapters are never resume targets while unread remain.

## Reader handoff (Stage 4 boundary)

```js
validateOpenChapter(series, chapterRef)
createOpenChapterRequest(series, chapter, { pageIndex })
// → { ok, seriesId, chapterId, canonicalChapterId, pageIndex }
```

App helper: `openChapterInApp(seriesId, chapterId)` validates then `navigate("reader", { seriesId, chapterId })`.

Route carries **ids only**, not full chapter objects.

## No redirects

Opening a chapter must never send the user to MangaDex, Comick, or any external reader.

## Performance

- Map/Set keyed dedupe and merge (not O(N²) title scans)
- Sort once via chapterOrder; direction reverse is cheap
- Service does not persist chapter/page blobs to the Library

## Testing

`tests/phase1/chapterSystem.test.js` covers identity, order, dedupe, merge, refresh idempotence, progress/continue, availability, open contract, partial assemble, service fetch + stale token.

## Out of scope

- Full Reader UI / page engine (Stage 5)
- Downloads / offline chapter storage
- Extension marketplace
- Social / messaging / recommendations
- Final adversarial verification


## Live Details integration (Stage 4 integration fix)

The live Manga Details experience uses the authoritative pipeline:

```
Details
  → getDetailsChapterView() / refreshDetailsChapters()
  → ChapterService.getChapters()
  → Source Registry (getSource / getSourceAdapter)
  → Source adapters (loadSeries)
  → ChapterSystem (normalize, identity, dedupe, merge, order, progress)
  → Details chapter list
  → openChapterInApp() → Reader handoff
```

- Chapter list rendering uses `getDetailsChapterView` (ChapterSystem.assembleChapterList).
- Refresh uses `refreshDetailsChapters` → ChapterService with registry-built fetchers.
- `open-reader` / jump-unread route through `openChapterInApp` (validate + createOpenChapterRequest).
- No external redirects. Partial source failures surface as non-blocking status in Details.
