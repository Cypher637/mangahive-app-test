# Stage 8.1 Audit — 2026-10-03

## Scope
Audit of `MangaHive-stage8_1-fixed.zip` after the Stage 8.1 stabilization pass. Gradle 8.5, Android compilation, emulator/device execution, and real third-party APK execution were intentionally not used.

## Findings and resolutions

### Fixed during this audit
1. **Typed Mihon web/native bridge field mismatch**
   - The PWA bridge was sending `packageId`, `remoteId`, `seriesRemoteId`, and omitted `page` for typed runtime operations.
   - The native IPC contract requires `extensionId`, `mangaRemoteId`, `chapterRemoteId`, and `page`.
   - Install/update also sent obsolete `expectedCertSha256` instead of `expectedSignerSha256` and `packageId` instead of `expectedPackage`.
   - All Mihon search/details/chapters/pages/install/update calls now match the typed IPC contract.

2. **Page routing identity**
   - Page calls use the discovered native numeric source identity, never the web namespace ID.

3. **Web source identity**
   - The web namespace encodes the complete extension/source identity rather than a 32-bit hash.

4. **Persistent source cache**
   - Search, details, chapters, and page manifests have bounded, expiring normalized-data persistence.
   - Executable code, APKs, cookies, and credentials are excluded.
   - Reader image bytes remain in the explicit chapter-download/offline cache rather than the source-data cache.

5. **Persistent native source health**
   - Health is persisted and returned through typed IPC.

6. **Mihon update discovery/action**
   - Repository refresh detects newer version codes and Source Hub exposes the native install/update action through the existing verification pipeline.

## Verification

Passed:
- Stage 8 source-runtime regression suite, including new IPC bridge contract assertions
- Mihon compatibility regression suite
- Mihon runtime-boundary suite
- source registry regression suite
- extension hardening suite
- open-platform extension suite
- production security suite
- Mihon Stage 4/5/6 structural suites
- Mihon Yuzono repository fixture suite
- UX audit suite
- extracted `index.html` JavaScript syntax parse

Not verified by design:
- Gradle 8.5 Android compilation
- Android emulator/device instrumentation
- real third-party Mihon APK install/load/search/details/chapters/pages E2E

Those remain environment verification tasks, not code claims.
