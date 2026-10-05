# MangaHive Mihon Android module

> **Not an upstream-compatible runtime.** The `eu.kanade.tachiyomi.*` classes here are hand-written MangaHive
> stubs, not the Mihon/Tachiyomi API. Stage 4: one runtime path (JS bridge -> typed AIDL IPC -> `:mihon` service -> `ExtensionLoader`). See `MIHON_STAGE4_ISOLATION.md` at the repo root.
> Upstream profiles and pins: `../../MIHON_API_PROFILES.md`. Real-API compile checks: `../mihon-compat`.

## Implemented (real code)

- Streaming APK download with SHA-256 (`ApkDownloader`)
- Static APK inspection via PackageManager (`ApkInspector`)
- SSRF-aware URL policy (`ExtensionNetworkPolicy`)
- Allowlisted JS bridge (`MihonJsBridge`) — no arbitrary invoke
- Compatibility state model
- Upstream API profile data (`compat/MihonApiProfile.kt`): descriptions only, `runtimeImplemented = false`

## Not implemented (explicit)

- Loading real Tachiyomi/Mihon `Source` classes (tachiyomix API) from APK. The existing loader only targets the internal stubs.
- Running `fetchSearchManga` / chapter / page list against real extension bytecode

That requires an isolated process + ClassLoader + HTTP client shim matching the Mihon API surface. Do not claim SOURCE_EXECUTION_READY until that ships.

## Integration

1. Add this module to the Capacitor/Android app Gradle project.
2. Register `MihonJsBridge` on the WebView as `MangaHiveNative`.
3. Implement `MihonBridgeApi.Host` with app storage paths and request cancellation map.
