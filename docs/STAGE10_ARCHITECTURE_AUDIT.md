# Stage 10 Architecture Audit

## Baseline

`MangaHive-stage9.zip` was inspected before implementation.

## Findings addressed

1. The PWA already had an IndexedDB chapter download store, but download jobs were process-memory-only.
2. Completed chapter rows had no durable download manifest or per-page integrity metadata.
3. The reader could consume page blobs, but there was no explicit distinction between a completed download and partial staging data.
4. The existing queue was concurrency-one and had no persistent pause/resume state.
5. Startup did not reconstruct active download jobs from persistent state.
6. Storage limits were advisory rather than a bounded download policy.
7. The service worker correctly avoided globally caching dynamic chapter/API responses; that boundary was preserved.
8. Android had durable source-data caching but no explicit offline chapter filesystem model.

## Stage 10 design

### PWA

- `downloadJobs`: durable job state.
- `downloadManifests`: completed chapter integrity metadata.
- `downloadStaging`: crash-safe page staging.
- existing `chapters`: backward-compatible completed page data.
- source-aware manifest identity.
- bounded download concurrency.
- startup job recovery.
- pause/resume/cancel/retry states.

### Android

- `OfflineDownloadModels`: stable identity and state/failure enums.
- `OfflineDownloadPathPolicy`: hashed root-confined paths.
- `OfflineDownloadStore`: atomic replacement and SHA-256 manifest validation.

## Compatibility

Existing Stage 9 chapter rows remain readable. The new stores are additive. No completed chapter is automatically converted into a new manifest unless it is downloaded through the Stage 10 path.

## Security boundary

Downloaded pages are data. No download path constructs a path from title or URL, and no downloaded page/APK is executed by the reader.

## Verification limitation

Gradle 8.5 and real Android device/emulator execution were not used. Kotlin model/path classes were compiled with standalone `kotlinc`; the Android-dependent store/service remain marked for Gradle/device verification.
