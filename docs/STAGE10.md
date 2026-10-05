# MangaHive Stage 10 — Production Reader, Downloads & Offline

Stage 10 builds on the canonical manga/chapter/source model from Stage 9.

## Download identity

A download is keyed by the canonical chapter plus its source binding. The manifest records:

- canonical manga ID
- canonical chapter ID
- extension ID
- source ID
- remote manga/chapter IDs
- page count
- per-page byte size and SHA-256

A chapter number or title is never used as the download identity.

## Lifecycle

Jobs persist in IndexedDB and use the states:

`queued → resolving → downloading → completed`

with `paused`, `failed`, `cancelled`, and recovery transitions.

The download manager uses bounded concurrency and supports pause/resume/cancel/retry.

## Atomicity

Pages are first written to a staging store. The completed page set is validated and a manifest is written before the download is considered complete. A failed manifest/finalization path removes the newly-created canonical download rather than exposing a partial chapter as complete.

## Integrity

Each page is checked for:

- non-empty data
- maximum 25 MiB size
- supported image content types when reported
- decodable image dimensions where `createImageBitmap` is available

The manifest records SHA-256 values. Android's native offline store performs the same manifest/hash validation.

## Offline behavior

Offline reading uses downloaded page blobs before attempting persistent cache/network resolution. Downloaded data is user-owned data and is not executable extension code.

A disabled, quarantined, or removed extension does not remove completed downloaded pages.

Current visibility/content policy is still evaluated before opening content.

## Storage

The PWA uses browser storage estimates and a configurable download limit. The Android native layer uses a hashed, root-confined filesystem path and atomic directory replacement.

Cache and explicit downloads remain separate concepts.

## Service worker boundary

The service worker caches only the application shell/static assets. Dynamic API/source responses and chapter images are not globally inserted into the service-worker cache. Explicit offline page data remains in the download store.

## Android

`OfflineDownloadStore` and `OfflineDownloadPathPolicy` provide the native filesystem boundary, atomic replacement, manifest validation, and SHA-256 verification. These classes intentionally do not execute or load downloaded content as code.

Android compilation/device execution remains an environment-dependent verification item when Gradle 8.5/device tooling is unavailable.
