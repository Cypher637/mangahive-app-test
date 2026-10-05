# MangaHive Phase 9

Phase 9 introduces canonical manga/chapter identity and explicit multi-source bindings on top of Stage 8.1.

## Implemented

- stable canonical manga alias while preserving existing IDs
- extension-aware source bindings
- canonical chapter IDs and structured chapter identity
- safe exact/strong matching
- idempotent startup migration
- canonical import persistence across reader sources
- source selection on manga detail
- explicit automatic fallback setting (off by default)
- source-isolated page resolution
- durable cache cleanup by extension namespace

## Deferred

Android Gradle compilation and real-device instrumentation remain unverified by design for this phase.
