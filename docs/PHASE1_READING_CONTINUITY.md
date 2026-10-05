# Phase 1 / Stage 6 — Reading Continuity & Resume

## Objective

Deterministic Continue Reading and resume so users return to the correct chapter and page after leaving the Reader, restarting the app, or refreshing chapter lists.

## Architecture

```
Library / Details / Home
  → resolveSeriesContinue(series)
  → ReadingContinuity.resolveSeriesContinuity
       ← Progress (legacy state.progress + readChapters)
       ← ChapterOrder
  → chapterId + pageIndex
  → openChapterInApp / bestOpenTarget
  → ReaderSession (validated resume)
```

Authoritative module: `src/domain/readingContinuity.js`

## Resolution rules

| Case | Result |
|------|--------|
| No progress | First unread / first chapter (`start`) |
| Incomplete chapter | Saved chapter + clamped page (`continue`) |
| Completed chapter | Next unread via ChapterOrder (`next`) |
| All completed | `finished` / All caught up |
| Multiple records | Latest by `updatedAt` (then chapterId) |
| Missing chapter | Identity match or next unread / `missing` |
| Invalid page | Clamped / recovered |
| Explicit chapter open | Does **not** skip completed (separate from Continue) |

## UI integration

- `bestOpenTarget` → continuity
- `continueReadingItems` / Home rail → continuity
- Details primary CTA label → continuity `label`
- `openChapterInApp` resume page → continuity when chapter matches

## Non-goals

- Downloads, social, Stage 7 UX sweep
- New progress database (uses existing Progress Store / legacy map)


## Final integration hardening

- `continueEntries()` is a thin adapter over `continueReadingItems` → `resolveSeriesContinue` (no independent algorithm).
- `progressChapterCache` + `rememberChapterProgress` prefer ProgressStore-backed writes; refuse older async timestamps.
- `seriesProgressMap` merges cache (authoritative) then legacy gaps then `readChapters` completed flags.
- Startup: `hydrateProgressCacheFromStore` after `finalizeLoadedState`.
- `visibilitychange` (hidden) → `flushProgress(true)` while on Reader route.
- Library Home rail and Details CTA share the same resolver path.

## P1 identity & Reader resume

- `resolveExplicitChapterOpen` matches progress by local id → canonicalChapterId → remoteId.
- `renderReader` resumes via `resolveExplicitChapterOpen(series, chapter, seriesProgressMap)` (not `state.progress.chapterId === c.id` alone).
- `rememberChapterProgress` stores `canonicalChapterId` / `remoteId` from the live chapter when available.
- `progressHydrationReady` / `whenProgressHydrated` track ProgressStore cache hydration after startup.
