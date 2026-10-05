# Stage 3 — real Mihon source loader

**Status: code written, NOT compiled, NOT run. The real Stage 2 APK has never been built, so the gate is open.**

## Pipeline (`app.mangahive.mihon.loader.ExtensionLoader`)
APK → `PackageManagerManifestReader` (no code runs) → `ExtensionDetector` (feature, exact `tachiyomix.extensionLib`
match, entry-class list in the APK's own package tree) → signer-ownership check → `BoundaryClassLoader` + per-extension
`PathClassLoader` → `CompatGateway.instantiate` (Source / SourceFactory enumeration, N sources per APK) →
metadata validation → `MihonSourceRegistry` (`mihon:<extension-id>:<source-id>`, atomic per extension) → `MangaHiveSourceAdapter`.

## ClassLoader layers
- **extension loader** (PathClassLoader, one per extension) → parent **BoundaryClassLoader**: framework (`java`, `javax`,
  `android` minus `android.webkit`, `org.json`, `org.xml.sax`, `org.w3c.dom`) + compat API packages served ONLY from the compat loader.
- **compat loader** (shared): real upstream API + pinned deps + `RealCompatGateway`; sees framework + `app.mangahive.mihon.spi` only.
- The app's own ClassLoader is never a parent of either. `eu.kanade.*` stubs inside `:mihon` are therefore invisible to extensions.
- Matching is by package segment (`PackageBoundary`), never `startsWith`. Unknown packages fail closed.

## Hard blockers (need a decision/artifact, not more code)
1. **No Stage 2 APK exists.** Build it (see `mihon-test-extension/README.md`).
2. **No compat bundle exists.** The host must supply a *runnable* upstream API (HttpSource etc.) plus the Stage 1 pinned
   dependency versions (Kotlin 2.4 stdlib, OkHttp 5.5, coroutines 1.11…). `:mihon` itself ships Kotlin 1.9 / OkHttp 4.12, which
   is why the bundle is a separate ClassLoader. If `tachiyomix:1.6` is stubs only (as MIHON_API_PROFILES.md states), the
   implementation must come from elsewhere (e.g. Mihon's own source-api); that choice is open.
3. Kotlin 2.4 build of `mihon-compat/gateway` + dexing it into a bundle with a recorded SHA-256 — not scripted yet.

## Not done / known gaps
- `getMangaUpdate` (details/chapters) unimplemented: signature unread. Adapter returns failure for them.
- Host network security config must trust the Stage 2 fixture CA (extensions run under the host's config).
- Extension APKs that *bundle* classes in denied packages are not scanned; they only reach their own copy.
- (Stage 4) The legacy `SourceClassLoaderRuntime` / `MihonSourceRuntime` / `MihonHostImpl` paths are deleted; `ExtensionLoader` is now the only way extension code is loaded, and only inside `:mihon`. See `MIHON_STAGE4_ISOLATION.md`.
- `MihonRuntimeStatus` flags stay false.

## Tests
JVM (`./gradlew :mihon:testDebugUnitTest`): boundary, ClassLoader, key, detector, registry, loader pipeline with fakes of the SPI only.
Gate (`:mihon:connectedAndroidTest`, `RealStage2ApkLoadTest`): skipped unless `stage2Apk`, `compatBundle`, `compatBundleSha256` are passed.
