# MangaHive Stage 8 — Real Mihon Source Runtime

Stage 8 turns the Stage 7 extension installation/security boundary into an executable Mihon source runtime.

## Runtime flow

`repository metadata → verified APK → PackageInstaller → persistent extension record → ExtensionLoader → MihonSourceRegistry → source adapter → brokered network → normalized MangaHive DTOs`

### Guarantees
- A source is identified by `extensionId + sourceId`, serialized as `mihon:<extension-id>:<source-id>`.
- Only an enabled, non-quarantined extension can expose sources.
- Third-party bytecode executes only in `:mihon` through the dedicated ClassLoader path.
- Source HTTP is brokered; extensions never receive MangaHive/Supabase credentials.
- One broken source/extension is isolated from unrelated sources.
- Startup reconciles installed APKs and reloads valid enabled extensions.
- Source calls have bounded response models, cancellation, timeouts and health cooldowns.
- Mihon `SManga.memo`/`SChapter.memo` is preserved across the normal details → chapters → pages sequence.
- Chapters are numerically ordered when chapter numbers exist; pages are ordered by page index.
- PWA source IDs are web-safe namespaces; the actual Mihon source key remains separate and is what the native bridge sends.

## Real APK execution

The Android Source Hub can request `install` with HTTPS APK metadata. The runtime verifies the APK, installs it through Android `PackageInstaller`, re-reads the installed package, checks version/package/signers, loads it, discovers its actual source IDs, and persists the result.

The browser never downloads and executes extension bytecode itself.

## Multi-source behavior

The web layer can fan out searches over enabled sources. Each source has independent health/cooldown state. Results retain their source identity so the same title can have multiple source bindings without duplicating MangaHive library identity.

## Offline behavior

Extension-backed network operations require the native runtime and broker. Existing MangaHive library/read state remains intact if an extension is disabled or removed. Cached application data is not treated as proof that a removed extension may execute.

## Stage 8 verification status

This archive includes source-runtime and PWA regression checks. Android Gradle/device instrumentation remains environment-dependent: if Gradle 8.5 and an API-34 emulator/device are unavailable, the archive must not claim a device-level E2E result.

## Stage 8.1 stabilization notes
- Mihon page requests always use the native numeric `extensionId + sourceId` identity. The web namespace ID is never sent to the Android runtime.
- Web-facing Mihon source IDs encode the complete extension/source identity instead of using a 32-bit hash, eliminating practical namespace collision ambiguity.
- Source health is persisted in `mihon_source_health.json`, bounded to 512 source records, and returned through the typed Source IPC contract so Source Hub can display authoritative native health.
- Search, details, chapter lists, and page manifests are stored in a bounded, expiring persistent source-data cache. Reader image bytes remain in the existing explicit chapter-download/offline cache; the source-data cache never stores executable code or unbounded image payloads. Cache entries contain normalized data only—never APKs, executable code, cookies, or credentials. Cached data can be read after extension disable/uninstall; uninstall still removes the executable extension state and broker cookies.
- Mihon repository refresh detects newer `versionCode` values and Source Hub exposes a native update action. Updates go back through the same APK hash/package/signer/downgrade/PackageInstaller/runtime-load verification pipeline; a failed activation remains `RECOVERY_REQUIRED` rather than claiming rollback.
- Android/Gradle/device verification remains intentionally pending until a machine with the Android build environment and emulator/device is available.
