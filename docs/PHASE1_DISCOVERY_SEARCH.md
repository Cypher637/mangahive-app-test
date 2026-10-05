# Phase 1 / Stage 2 — Discovery & Search

Journey owned by this stage: **Discover → Search → Find → Preview → Add to Library.**
Later stages own Details / Chapters / Read.

## Rules (enforced by tests)
1. Searching and previewing **never** change the Library or write storage.
2. Only the explicit **Add to Library** action imports, and it is idempotent.
3. Search resolves sources through the **source registry**; the UI never fans out to adapters.
4. Search results are **remote works**, not Library entities (no local `series.id` is invented).
5. **No source redirects.** A source URL is inert metadata (`sourceMetadata.reference`); nothing navigates to it.

## Modules
| File | Role |
|---|---|
| `src/domain/searchResult.js` | `normalizeSearchResult`, canonical identity, conservative `strongSameWork` |
| `src/services/discoverySearch.js` | `createDiscoverySearch({registry,…})`: orchestration, state model, pagination, stale/abort, `addToLibrary`; helpers `buildLibraryIndex`, `matchLibrary`, `debounce` |
| `index.html` (Stage 2 glue) | `discoveryRegistry` (adapts `THIRD_PARTY_SOURCES` + `getSourceAdapter` + health), `discovery` instance, UI states, `searchPreview` route |

## Search contract
`discovery.search(query, { signal, sources })` → resolves a state snapshot
`{ query, status, reason, results, sourceStatuses, partial, page, hasMore, capped, loadingMore, loadMoreError, stale }`.

* Query is control-char-stripped, whitespace-collapsed, trimmed. Empty/whitespace → `status:"idle"`, **zero source calls**. Longer than `maxQueryLength` (120) → `invalid`.
* `status`: `idle | loading | ok | empty | error | offline | invalid`. `reason` distinguishes `no-sources`, `all-failed`, `offline`, `empty-query`, `invalid-query`.
* Per-source state: `ok | empty | timeout | error | offline | unavailable | aborted`. `unavailable` (not configured / cooling down / no adapter) is reported but is **not** counted as a failed request.
* `partial: true` = at least one queried source timed out/errored while others succeeded; successful results are kept.
* Adapters implement `search(query, {page, limit, signal})` returning an array or `{results, hasMore}`; the adapter owns parsing, the service owns orchestration.
* Registry contract: `listSearchSources()` (enabled, priority, reader, available, unavailableReason, paginates), `getAdapter(id)`, optional `resolveExtensionId(id)`. Disabled sources are excluded entirely.

## Stale / abort
Monotonic request token. A new search, `clear()`, or an external abort invalidates the in-flight request: its `AbortController` is aborted and any late response resolves with `stale:true` and **never** touches state. `loadMore` from an old query is rejected the same way. Per-source timeout (12 s) → `timeout`.

## Result model
`resultId == canonicalSeriesId`, `sourceId`, `remoteId`, `extensionId`, `sourceBindingKey`, `title`, `alternateTitles`, `description`, `coverUrl`, `author(s)`, `artist(s)`, `status`, `year`, `genres`, `tags`, `sourceMetadata{sourceName,kind,readable,reference}`, `fetchedAt`, optional `alsoFrom[]` (merged cross-source bindings). Rows without source+remote id or title are dropped.

## Canonical identity
Reuses the Stage 1 identity module: `sourceBindingKey = identity.normalizeBinding(...).bindingKey` (`extensionId␟sourceId␟remoteId`, same key the app uses for Library `sourceMappings`). `canonicalSeriesId = "mhseries:" + bindingKey` with `␟` rendered as `|`. Never derived from title, cover, index or position. Library recognition = binding-key lookup in a read-only `Map` built from `sourceMappings`, `altSources` and the legacy `source` field.

## Deduplication
1. Same `canonicalSeriesId` → collapsed.
2. Cross-source merge only via `strongSameWork`: equal normalized title (≥4 chars) **and** matching author or matching year, with no contradicting year/author. Title alone never merges. Merged rows keep every binding in `alsoFrom` and Library lookup checks them.
3. Otherwise kept separate (duplicates are preferred over false merges). O(N) using Maps.

Ranking (deterministic): readable sources first → title relevance (exact, prefix, contains) → source priority → title → id. Pages append; earlier rows never reorder.

## Pagination
Per-source cursors. Only sources that really paginate (`paginates:true`; currently MangaDex via offset, `hasMore` from the API `total`) are asked for page 2+. Other sources are single-page and report `hasMore:false`. Bounds: `perSourceLimit` 20, `maxPages` 5, `maxResults` 200 (`capped:true` is surfaced in the UI, never silent), `maxSources` 8. Duplicate `loadMore()` calls share one promise. A failed page keeps results and the cursor; Retry requests the same page.

## Failure / offline
Offline → `status:"offline"` without source calls, Retry available. All sources failing → `error` ("Couldn't reach any source" + per-source cause). No enabled source → distinct `no-sources` message. "No manga found" is shown only for genuine empty results. Failed searches never create Library data.

## Preview and Add
Result click → `navigate("searchPreview",{id: resultId})` (identifier only; the result is resolved from an in-memory LRU cache / current search, never stored in history). If it is gone, a "no longer available" screen offers Back to Discover. States: **Add to Library** → *Adding…* → **Added to Library**; already present → **Already in Library** (+ Open). `addToLibrary` checks for an existing match first (no fetch, no write, progress untouched), de-duplicates concurrent adds, and imports through the existing `importHubResult` → `persistCanonicalSeries` path (merges into an existing series by binding, preserving progress). Metadata-only sources (AniList/Jikan/Kitsu) keep the existing "find a readable source" resolution, now behind the explicit Add.

## Persistence
Search/preview state is in-memory only. The Library is touched only by the explicit import (existing store); Stage 1 targeted progress writes are unchanged.

## Tests
* `tests/phase1/discoverySearch.test.js` — behavioral (fake registry + real identity + real `libraryStore` over in-memory storage): query contract, registry, normalization, partial/total failure, offline, stale, abort, dedupe, pagination, retry, state transitions, Library round-trip, idempotent add, progress survival.
* `tests/phase1/discoveryWiring.test.js` — **static** wiring checks on `index.html` (no auto-import paths, registry use, no redirects, route, script order).
* `source_registry_regression_test.js` — two assertions that encoded the old auto-import / direct adapter loop were updated to assert the new preview-first and registry-glue behaviour.

## Known limitations
No browser or device verification was run. Typing does not search per keystroke (Enter / Search button only; `debounce` is exported but not wired to input). Sources other than MangaDex are single-page. Legacy `import*Result` helpers (MangaDex/ComicK/Mangpi/MangaHook) remain as unused code. A Library series added from a metadata source is recognised via `altSources`; older entries lacking that record show "Add to Library" (re-adding merges, it does not duplicate).
