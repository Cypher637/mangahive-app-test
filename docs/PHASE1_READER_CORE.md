# Phase 1 / Stage 5 — Reader Core

## Product rule

```
User taps chapter → MangaHive Reader opens → pages load → user reads in-app
```

Never redirect to a source website, AniList, or external browser for reading.

## Architecture

```
Details
  → openChapterInApp() / ChapterSystem handoff
  → navigate("reader", { seriesId, chapterId })
  → renderReader()
  → ensureRemoteChapterPages() / adapters (via registry)
  → readerPages.normalizePageList()
  → vertical page strip (lazy images)
  → progress store (existing)
  → prev/next via chapterOrder
  → Back → Details
```

| Layer | Module | Role |
|-------|--------|------|
| Page model | `src/domain/readerPages.js` | Normalize/order pages, sanitize URLs, clamp resume index |
| Page service | `src/services/readerPageService.js` | Load pages via injected fetcher; stale-token guard |
| Session | `src/domain/readerSession.js` | Ephemeral session + progress events (Stage 1) |
| UI | `index.html` `renderReader` | Vertical reader, chrome, gestures, lazy load |

## Page model

```
{ id, chapterId, canonicalChapterId, pageIndex, pageNumber,
  imageUrl, width, height, alt, availability }
```

- URLs: only `http(s)`, `blob:`, `data:image/`, relative paths
- Rejects `javascript:` and other unsafe schemes
- Order: preserve source order unless explicit `pageIndex` / `pageNumber` provided  
  (never sort image URLs alphabetically)

## Page loading

- Reader does not hard-code providers
- Live path uses existing `getSourceAdapter` / `ensureRemoteChapterPages`
- `normalizeChapterPagesForReader` applied when pages are cached or assigned
- Empty chapter → in-app empty/error UI (existing), not completed
- Partial image failure: existing per-image retry / lazy load remains

## Progress

- Existing `state.progress` + `flushProgress` on leave / visibility
- Resume clamps with `readerPages.clampPageIndex`
- Completion uses existing end-of-chapter semantics (not merely opening)

## Navigation

- Previous / next: `chapterOrder.getPreviousChapter` / `getNextChapter`
- Supports decimal / special chapter ordering
- Chapter switch: `readerSessionId` token prevents stale page/DOM updates

## Controls

- Back, chapter title, prev/next, progress scrubber (existing UI)
- Tap to toggle chrome; vertical continuous (webtoon) default
- Keyboard: existing reader handlers where present

## Security

- No `window.open` / external location navigation from `openChapterInApp`
- No source HTML rendering as UI
- Image URLs sanitized before use as `img` sources

## Out of scope

- Downloads / offline packages
- Social features
- Final adversarial / device verification
'''
path = '/home/workdir/artifacts/stage10fix/docs/PHASE1_READER_CORE.md'
# already writing via tool


## Live integration (hardening)

The live Reader uses a **single** page pipeline:

```
resolvePagesForChapter(series, chapter)
  → offline-first fetchRawPagesForChapter (local blobs / ensureRemoteChapterPages via registry adapters)
  → ReaderPageService.loadChapterPages({ fetchPages })
  → ReaderPages.normalizePageList
  → chapter._normalizedPages (+ legacy chapter.pages URL list for downloads)
  → chapterImagesHtml(normalized pages)
```

- `chapterImagesHtml` accepts normalized page objects (`imageUrl`, `availability`, `alt`) or legacy URL strings.
- `renderReader` prefers `c._normalizedPages` and creates a domain `ReaderSession`.
- Chapter switch calls `ReaderPageService.invalidate` + bumps `readerSessionId`.
- Seamless next-chapter append uses the same `resolvePagesForChapter` path.
- `ensureRemoteChapterPages` remains the **source adapter** implementation behind the injected fetcher — not a parallel UI pipeline.


## Final hardening — ReaderSession authority & keyboard

- `activeDomainReaderSession` is the authoritative live session.
- `applyDomainPage` / `domainNextPage` / `domainPreviousPage` wrap ReaderSession APIs.
- `applyPageIndex` (scroll/observer) and jump-to-page go through `applyDomainPage`.
- `applyDomainComplete` → `ReaderSession.complete` → Progress Store + `markChapterRead` (idempotent).
- `readerContext.pageIndex` is a derived mirror of the domain session.
- Keyboard: `src/domain/readerKeyboard.js` + `attachReaderKeyboardController` (Escape, arrows, PageUp/Down, Space; RTL-aware; skips inputs).
- Session cleared on chapter switch and Reader back navigation.
