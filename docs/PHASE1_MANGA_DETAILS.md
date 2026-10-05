# Phase 1 / Stage 3 — Manga Details

## Overview

Stage 3 establishes the **canonical Manga Details** experience as the authoritative presentation layer for a series.

Journey:

```
Discover → Search → Preview → (optional Add to Library) → Details → Chapters
Library → Series → Details
```

Details is distinct from Search Preview:

| Concern | Search Preview | Manga Details |
|--------|----------------|---------------|
| Route | `searchPreview` | `seriesDetail` |
| Entity | Remote `SearchResult` | Library series (local id) |
| Chapters | No | Yes (foundation list) |
| Progress / Continue | No | Yes |
| Library controls | Add | Remove / status |
| Identity | `resultId` / source binding | `series.id` + canonical series id |

## Identity

- Details routes carry the **local series id** (`navigate("seriesDetail", { id })`).
- The screen resolves the entity via `findSeries(id)` and the Stage 1 identity module.
- Canonical series / chapter ids come from `MangaHiveDomain.identity`.
- Details never treats title, cover URL, or array position as identity.
- Invalid / missing id → safe redirect to Library (not a blank screen).

Domain entry point:

```js
MangaHiveDomain.mangaDetails.buildDetailsViewModel(series, {
  seriesProgress: state.progress[seriesId],
  adding: false,
  metadataState: 'ready',
  chapterState: 'ready'
})
```

## Metadata model

Normalized fields (view model):

- `title`, `alternateTitles`
- `cover`
- `description` (sanitized plain text)
- `authors`, `artists` (deduped arrays)
- `status` / `statusLabel` (`ongoing` | `completed` | `hiatus` | `cancelled` | `unknown`)
- `year`
- `genres`, `tags`
- `language`
- `sourceBindings` (attribution only — **no external URLs or navigation**)

Normalization lives in `src/domain/mangaDetails.js`. UI must not parse source-specific shapes.

### Metadata precedence (merge)

On refresh / multi-source merge:

1. Existing non-empty local / canonical fields win.
2. Incoming fills gaps only.
3. Empty incoming never overwrites good local title, description, cover, authors, etc.

API: `mergeMetadata(existingSeries, incomingMeta)`.

### Missing metadata

Safe fallbacks via `displayFallback` / empty arrays — never render `undefined`, `null`, or `[object Object]`.

### Description

- HTML is stripped; `<script>` / style blocks removed.
- Line breaks preserved as plain text newlines.
- Callers must still HTML-escape when inserting into the DOM.
- Long text supports expand/collapse via `descriptionPreview`.

### Cover

- Dangerous schemes (`javascript:`, `data:text…`) rejected.
- Missing cover uses existing app cover fallback UI.
- Cover URL is **not** identity.

## Library integration

- Details for a library series reports `libraryState.inLibrary === true`.
- Add is performed from **Search Preview** (`preview-add`) using the existing Library store / import path — not a second Details implementation.
- Remove uses the existing remove lifecycle (armed confirm, undo window, Stage 1 progress cleanup APIs). UI must not call `delete state.progress[id]` directly.
- Re-add after remove follows Stage 1: progress does not resurrect unless Undo restores it.

Opening Details does **not** write the Library. Expanding description does **not** write the Library.

## Chapter list

Foundation only (Reader is Stage 4+):

Each row exposes:

- local `id`, `canonicalChapterId`
- `number`, `volume`, `title`, `releaseDate`
- `sourceIds`, `readState` (`unread` | `started` | `completed`)
- `remoteId` when known

Ordering: `MangaHiveDomain.chapterOrder.sortChapters` — never API insertion order or string sort alone.

Duplicates: collapsed by canonical chapter identity (first in ordered list wins). Titles alone do not merge chapters.

### Chapter merge (refresh)

`mergeChapterLists(existing, incoming, series)`:

- Matches on canonical id, then local id, then source binding / remote id.
- Preserves local `chapter.id` and existing read/progress linkage.
- Fills missing metadata from incoming.
- Does **not** delete local chapters that vanished from a source response (avoids orphaning progress).

## Progress / Continue Reading

Consumed from `state.progress[seriesId]` (and legacy `readChapters` when present).

Continue rules:

1. Most recently updated **started** (incomplete) chapter.
2. Else first **unread** in deterministic order.
3. If all completed → `kind: 'finished'`.
4. If no chapters → `kind: 'empty'`.

Completed chapters are never chosen as resume targets while unread chapters remain.

## Refresh

- Controlled refresh must preserve progress, completed state, and stable chapter identity.
- Race safety: use existing request tokens / AbortController patterns so older responses cannot overwrite newer state.
- Partial success: show metadata even if chapter fetch fails, and vice versa.

## No redirects

Details must never navigate to third-party sites:

- No `window.open` / `window.location` to source sites
- No “Read on MangaDex” / “Open source” external links
- Source info is attribution and internal resolution only

## Routing

- Existing app router: `seriesDetail` with `{ id }`.
- Survives back/forward; does not put full manga objects into history state.
- Search path: Preview → Add → Open Details (or Open when already in library).
- Library path: Library → series → Details.

## Loading / errors

- Avoid blank screens; use existing busy / toast patterns.
- Not found → return to Library.
- Network / source failures: retry where already supported; partial UI remains usable.

## Performance

- View model built once per render of Details (not re-sorted per chapter row).
- Chapter ordering and metadata normalization are pure and suitable for memoization by callers.
- Opening Details does not serialize or rewrite the whole library.

## Testing

`tests/phase1/mangaDetails.test.js` covers:

- Identity resolution and invalid id
- Metadata normalization, sanitization, status, year, tags, people
- Library state
- Chapter order, identity, duplicates, read states
- Continue Reading / finished / start
- Chapter and metadata merge
- View model shape and no-URL source bindings

Regression: all existing Phase 1 tests must continue to pass.

## Files

| File | Role |
|------|------|
| `src/domain/mangaDetails.js` | Stage 3 domain (view model, normalize, merge, continue) |
| `tests/phase1/mangaDetails.test.js` | Behavioral tests |
| `index.html` | Loads domain module; Details render consumes view model |
| `docs/PHASE1_MANGA_DETAILS.md` | This document |

## Out of scope (Stage 3)

- Reader
- Downloads / offline chapters
- Multi-source overhaul / extensions product work
- Social, messaging, recommendations
- Server-side manga sync
- Final adversarial verification
