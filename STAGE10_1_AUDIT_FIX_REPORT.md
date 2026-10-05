# MangaHive Stage 10.1 — Audit Fix Report

Baseline: MangaHive Stage 10

## Fixed

1. **Source-specific download identity**
   - Job IDs and manifests now include canonical manga/chapter + extensionId + sourceId + remoteChapterId.
   - Completed storage is source-qualified.

2. **Fallback identity correctness**
   - A fallback changes the persisted download identity to the actual source that supplied the pages.
   - Stale primary-source job identity is removed after fallback.

3. **Fallback is truly opt-in**
   - `autoSourceFallback` defaults to false.
   - Alternate source mappings are not attempted unless explicitly enabled.

4. **Mihon native download boundary**
   - Mihon-backed downloads use the native IPC `download` operation.
   - Native runtime obtains page data and downloads bytes through the existing broker.
   - Web/PWA code receives only validated offline manifest metadata and opaque local URLs.

5. **Offline content policy**
   - Downloads are re-checked against age band, content rating, NSFW mode, and mature confirmation immediately before execution.
   - Restricted content is not silently downloaded for an ineligible profile.

6. **Android persistent download recovery**
   - Native offline jobs use a durable atomic JSON journal.
   - Job identity is source-qualified.
   - Interrupted/in-progress state can be reconciled on runtime restart.

7. **Manifest-authoritative reader**
   - Reader selection/validation is driven by the Stage 10 manifest and its source identity.
   - Native and browser-backed copies are validated before being exposed to the reader.

8. **Storage and page integrity**
   - Streaming page limits, image validation, SHA-256 metadata, chapter limits, bounded staging, and atomic finalization remain enforced.
   - Native downloads validate returned identity, page count, page indexes, byte sizes, hashes, and local URL shape.

9. **Retry/recovery behavior**
   - Persistent retry count and next-attempt timestamps are stored.
   - Retryable network/source failures use bounded exponential backoff.
   - Cancellation and policy/storage failures are not retried as network failures.

10. **Cleanup**
    - Automatic cleanup respects active jobs and native deletion.
    - Native manifests are removed only after native storage deletion succeeds.

## Verification

- `phase10_download_regression_test.js`: PASS
- `stage10_1_stabilization_regression_test.js`: PASS
- extension hardening regression: PASS
- extension open-platform regression: PASS
- extension platform regression: PASS
- extension registry regression: PASS
- Mihon compatibility regression: PASS
- Mihon runtime-boundary regression: PASS (structural)
- Mihon API foundation regression: PASS (repository-level; Kotlin compile gate not run)
- Mihon network broker regression: PASS

## Known verification limits

- Android Gradle/device execution remains **UNVERIFIED** because the requested Gradle 8.5 distribution/device environment is not available in this run.
- Real third-party Mihon APK → native download → process death → recovery → offline reader remains **UNVERIFIED** at device level.
- One older Stage 4 regression test still expects the historical 12-operation IPC contract. Stage 10 intentionally adds typed `download` and `deleteDownload` operations, so that old test reports a contract-count mismatch; the Stage 10 runtime-boundary and stabilization tests pass.
- The existing Stage 6 resource-control regression also contains a stale request-ID ownership assertion against the newer bridge/runtime arrangement; no Stage 10 download failure is indicated by it.

No Android/device claim is marked verified unless actually exercised.
