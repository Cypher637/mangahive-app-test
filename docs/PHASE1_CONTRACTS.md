# Phase 1 Contracts (index)

This document indexes Phase 1 domain contracts. Detailed Stage 3 contracts live in `PHASE1_MANGA_DETAILS.md`.

## Stage 1 — Domain foundation

| Module | Path | Responsibility |
|--------|------|----------------|
| Identity | `src/domain/identity.js` | Local / canonical / source identity for series and chapters |
| Chapter order | `src/domain/chapterOrder.js` | Deterministic chapter ordering and navigation helpers |
| Progress | `src/domain/progress.js` | Progress record shape, completion, resume page |
| Reader session | `src/domain/readerSession.js` | Reader session boundaries (later stages) |

## Stage 2 — Discovery & Search

| Module | Path | Responsibility |
|--------|------|----------------|
| Search result | `src/domain/searchResult.js` | Remote result identity (`resultId` / source binding) |
| Discovery search | `src/services/discoverySearch.js` | Search orchestration, preview cache, no library writes |

## Stage 3 — Manga Details

| Module | Path | Responsibility |
|--------|------|----------------|
| Manga details | `src/domain/mangaDetails.js` | Normalized Details view model, metadata normalize/merge, chapter rows, continue-reading, chapter merge |

See **`docs/PHASE1_MANGA_DETAILS.md`** for:

- Details identity resolution
- Metadata model and precedence
- Library integration (add from Preview, remove from Details)
- Chapter list / identity / order / merge
- Progress and Continue Reading
- Refresh and race safety
- No-redirect rule
- Testing strategy


## Stage 4 — Chapter System

| Module | Path | Responsibility |
|--------|------|----------------|
| Chapter system | `src/domain/chapterSystem.js` | Normalize, dedupe, merge, order, progress attach, open contract |
| Chapter service | `src/services/chapterService.js` | `getChapters` with injected fetchers, partial success, stale-token guard |

See **`docs/PHASE1_CHAPTER_SYSTEM.md`** for the full Stage 4 contract.


## Stage 5 — Reader Core

| Module | Path | Responsibility |
|--------|------|----------------|
| Reader pages | `src/domain/readerPages.js` | Page normalize, URL safety, order, resume clamp |
| Reader page service | `src/services/readerPageService.js` | Page load boundary + stale tokens |
| Reader session | `src/domain/readerSession.js` | Session + progress events |

See **`docs/PHASE1_READER_CORE.md`**.

## Persistence services

| Module | Path | Responsibility |
|--------|------|----------------|
| Library store | `src/services/libraryStore.js` | Library mutations only |
| Progress store | `src/services/progressStore.js` | Progress persistence and cleanup lifecycle |
| Startup coordinator | `src/services/startupCoordinator.js` | Startup / migration / recovery |

## Rules carried forward

- No third-party redirects from Details or Preview.
- Progress cleanup only through established APIs (never raw `delete state.progress[id]` from UI).
- Canonical identity over title / cover / array index.
- Pure domain modules: no DOM, network, or storage side effects.

## Stage 6 — Reading Continuity

| Module | Path |
|--------|------|
| Continuity | `src/domain/readingContinuity.js` |

See `docs/PHASE1_READING_CONTINUITY.md`.
