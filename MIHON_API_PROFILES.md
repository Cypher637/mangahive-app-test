# Mihon / Tachiyomi API compatibility profiles (Stage 1)

**Status: API foundation only. No Mihon/Tachiyomi runtime compatibility is claimed.**
Nothing in MangaHive loads or executes real upstream extension bytecode yet.

Research date: 2026-10-01. Every row below says where it came from. "Unresolved" means it was
**not** verified and must be filled by `android/mihon-compat/verify-pins.sh` on a machine with network access.

## What was wrong before

- `android/mihon/src/main/java/eu/kanade/tachiyomi/**` is **hand-written by MangaHive**. It is not an upstream artifact.
  Concrete evidence it differs: upstream `HttpSource` is `eu.kanade.tachiyomi.source.online.HttpSource`
  (path `source/online/HttpSource.kt` in Mihon's source-api); the local one sits in `...source`. Upstream 1.6
  also moved `getPopularManga`/`getSearchManga`/`getLatestUpdates`/`getFilterList` up into `Source` and added
  `getMangaUpdate`, `memo` fields and `HttpException`; the local stubs have none of that.
- `ControlledSource`, `MHProbeSource` and the old `MihonCompatibilityProfile` therefore proved nothing about Mihon.
  They are now labelled **MangaHive internal** (see "Relabelled" below).

## Terminology: KeiSource is not a Mihon API

The Stage 1 brief grouped "Mihon/Tachiyomix 1.6 / KeiSource". Upstream sources show these are different layers:

| Layer | What it is | Source |
|---|---|---|
| `tachiyomix` 1.6 | The Mihon extension API (stubs). Defines `Source`, `HttpSource`, models, manifest contract. | github.com/mihonapp/tachiyomix |
| `keiyoushi.source.KeiSource` | A base class **inside the Keiyoushi/Yuzono extension build system** (`libVersion = "1.6"`, extends the `HttpSource` contract, KSP-generated entry class `keiyoushi.source.Generated`). | yuzono/tachiyomi-extensions CONTRIBUTING.md |

KeiSource is **not part of** any Mihon artifact and is not in the `MIHON_1_6` contract. Extensions built with it are
still `HttpSource` subclasses compiled against tachiyomix 1.6. **Unresolved:** whether KeiSource's bytecode ships
inside each extension APK or is expected from the host. That must be read from a real APK's dex in a later stage.

## Profile MIHON_1_6  (selected primary boundary)

| Field | Value | Evidence |
|---|---|---|
| API generation | tachiyomix (Mihon 0.x), suspend-first | tachiyomix CHANGELOG |
| API version | 1.6 | README, `tachiyomix.extensionLib = "1.6"` |
| Artifact | `com.github.mihonapp:tachiyomix:1.6`, `compileOnly`, repo `https://www.jitpack.io` | tachiyomix README |
| Release tag | `1.6.0`, released 2026-06-28 | CHANGELOG `## [1.6.0] - Jun 28, 2026` |
| Release commit | **Unresolved** | GitHub tags page is robots-blocked; use `verify-pins.sh` step 1 |
| Coordinate vs tag | README says `1.6`, CHANGELOG says `1.6.0`. **Unresolved** which JitPack serves | `verify-pins.sh` step 2 |
| Host adoption | Mihon v0.20.0 (2026-06-27, commit `19f1d00`): "Added support for tachiyomix 1.6 extensions and index format" | Mihon release notes |
| Build JDK | 17 | tachiyomix `.jitpack.yml` (`openjdk17`) |
| compileSdk | 37 | CHANGELOG 1.6.0 "Other" |

**Source contract.** `eu.kanade.tachiyomi.source.online.HttpSource`. 1.6.0 adds suspend `Source.getPopularManga`,
`getLatestUpdates`, `getSearchManga`, `getMangaUpdate`, `getPageList`, `getFilterList`, plus `HttpSource.getHomeUrl`
and `getImageUrl`. The old `xxxRequest/xxxParse` pairs, `fetch*` methods, `ParsedHttpSource`, `rateLimit*` are
**deprecated but present**.

**Model contract.** `SManga`, `SChapter`, `Page`, `MangasPage`, `Filter`/`FilterList`; 1.6.0 adds `SManga.memo`,
`SChapter.memo`. The richer fields (`SManga.genres`, `SChapter.number`, `Source.language`, ...) are listed under
*Unreleased* on `main` and are **not** in 1.6.0. The exact `SMangaUpdate` shape returned by `getMangaUpdate` was
**not read** (unresolved; an open upstream PR #37 is still changing it).

**Network contract.** OkHttp types in signatures; `NetworkHelper.client`; `HttpException`; `Call.awaitSuccess`; Injekt for lookups.

**Entry point (manifest).**
```xml
<uses-feature android:name="tachiyomi.extension" />
<meta-data android:name="tachiyomix.name" android:value="..." />
<meta-data android:name="tachiyomix.contentWarning" android:value="0" />   <!-- 0 safe, 1 mixed, 2 NSFW -->
<meta-data android:name="tachiyomix.extensionLib" android:value="1.6" />
<meta-data android:name="tachiyomi.extension.class" android:value=".Mihon" /> <!-- FQCN or package-relative -->
```
The old MangaHive guess `tachiyomi.extension.class.factory` is **not** documented upstream and was removed from the profile.

**Pinned host dependencies** (tachiyomix README "App Requirements", read from `main` on 2026-10-01; an earlier
snapshot of the same README listed older versions, so re-verify at tag 1.6.0):

| Dependency | Version | Why it is needed |
|---|---|---|
| `org.jetbrains.kotlin:kotlin-stdlib` | 2.4.0 | stub class metadata is Kotlin 2.4; Kotlin 1.9 cannot read it |
| `org.jetbrains.kotlinx:kotlinx-coroutines-core` | 1.11.0 | suspend source API |
| `org.jetbrains.kotlinx:kotlinx-serialization-json` (+`-json-okio`, `-protobuf`) | 1.11.0 | `memo` JSON, extension DTOs |
| `com.squareup.okhttp3:okhttp` (+`okhttp-brotli`, `okhttp-zstd`) | 5.5.0 | `Request`/`Response`/`Headers` appear in `HttpSource` signatures |
| `org.jsoup:jsoup` | 1.23.1 | HTML parsing done by extensions |
| `com.github.mihonapp:injekt` | `91edab2317` | dependency lookup. Note: Mihon's own app moved to `uy.kohesive.injekt:injekt-core:1.16.1` (Mihon d435dd9217); the tachiyomix README still lists the mihonapp coordinate |

**Supported capabilities:** *targets only, none implemented* — browse (popular/latest), text search with filters,
manga update (details + chapters), page list, lazy image-URL resolution through an `HttpSource`.

**Unsupported / not claimed:** `ConfigurableSource` preference screens; WebView-dependent sources and
Cloudflare/WebView challenge solving; login/account sources; Komikku-only hooks (related manga, full-chapter
download), URL deeplinks; anything marked *Unreleased*; compatibility with every published extension.

## Profile MIHON_1_4  (legacy boundary, placeholder)

| Field | Value | Evidence |
|---|---|---|
| API generation | legacy request/parse + Observable `fetch*` | inferred from 1.6.0 deprecations; Keiyoushi calls 1.4 "legacy" |
| Artifact | **Unresolved** | only third-party fork READMEs show `com.github.mihonapp:tachiyomix:1.4.4` and `com.github.mihonapp:extensions-lib:1.4.4` — names conflict, not upstream-authoritative |
| Tag / commit | **Unresolved** | — |
| Entry point | library version conveyed via `versionName` prefix (`1.4.<code>`) per Keiyoushi; Mihon's reader for 1.4 manifests **not inspected** | Keiyoushi CONTRIBUTING |

`MIHON_1_4` exists so the boundary is explicit. Its compile module (`shapes-1_4`) is disabled until the artifact is
pinned. No dependency list is recorded for it.

## Dependency structure

- `android/mihon-compat/` — **separate Gradle build** (AGP 9.1.1, Kotlin 2.4.0, JDK 17, compileSdk 37). Compiles
  shapes against the real `tachiyomix:1.6`. Never depends on `:mihon`. JitPack is allowed for group
  `com.github.mihonapp` only. Why separate: the main build (AGP 8.2.2, Kotlin 1.9.22) cannot read Kotlin 2.4 metadata
  and forcing the upgrade would put `:app` at risk in a stage that must leave it intact.
- `android/mihon` (`:mihon`) — Stage 6.6A: its inert `eu.kanade.*` stubs are **deleted** (nothing imported them).
- `android/internal-probe` — **deleted** in Stage 6.6A (it existed only to compile against those stubs).
- `android/mihon-compat/gateway/src/main/kotlin/eu/kanade/tachiyomi/**` — Stage 6.6A: the one authoritative host implementation
  of the 1.6.0 API. `verify-abi.sh` diffs it against the AAR. `fixture-ext16` is a test Source compiled only against the AAR.

## Relabelled

| Item | Now |
|---|---|
| `ControlledSource` | (deleted in Stage 4) was a MangaHive internal normalized Source abstraction; not a Mihon compatibility test |
| `MihonCompatibilityProfile` | internal stub profile only (`mangahive-internal-stub-v1`); points to the real profiles |
| `MihonRuntimeStatus` | `CLASSLOADER_RUNTIME_READY`, `HTTP_SOURCE_API`, `SOURCE_EXECUTION_CODE_READY` are now `false`; `UPSTREAM_API_RUNTIME_COMPATIBLE = false` |
| `MHProbeSource` | internal probe, not a Mihon extension |

## Compile gate (not run in the authoring environment)

`cd android/mihon-compat && ./verify-pins.sh` — resolves tags/commits, checks the JitPack coordinate, runs
`:shapes-1_6:assembleDebug`, prints SHA-256 of the resolved artifacts. **The combination AGP 9.1.1 + KGP 2.4.0 +
compileSdk 37 has not been built.** If the 1.6 call-surface shape fails to compile, that is a finding about the 1.6
signatures, to be corrected from the 1.6.0 sources.

## Unresolved

1. MIHON_1_6 release commit SHA. (RESOLVED in 6.6A: JitPack serves `1.6.0`; `1.6` is HTTP 404. The catalog now pins `1.6.0`.)
2. Whether the host-dependency table at tag `1.6.0` matches `main`.
3. MIHON_1_4 artifact, tag, commit, dependency list, and manifest contract.
4. Exact 1.6.0 signature of `Source.getMangaUpdate` / `SMangaUpdate` (not shape-tested).
5. Where KeiSource bytecode lives (APK vs host).
6. Whether AGP 9.1.1 + KGP 2.4.0 builds the shapes module as configured.

## Stage 6.5: VERIFIED 1.6.0 contract (read from the tachiyomix `1.6.0` source zip, 2026-10-03)

Source: `tachiyomix-1.6.0.zip` (library/src/main/java/eu/kanade/tachiyomi/...) and `injekt-91edab2317...zip`, supplied by the project owner.
Everything below was read from those files, not inferred. CHANGELOG `[Unreleased]` is EMPTY at 1.6.0, so PR #37 material
(suspend-lambda `SMangaUpdate` constructors, `SMangaUpdate.related`, `SChapter.locked/language`) is NOT in 1.6.0.

```kotlin
// eu.kanade.tachiyomi.source.Source (interface)
val id: Long;  val name: String;  val supportsLatest: Boolean
fun getFilterList(): FilterList
suspend fun getPopularManga(page: Int): MangasPage
suspend fun getLatestUpdates(page: Int): MangasPage
suspend fun getSearchManga(page: Int, query: String, filters: FilterList): MangasPage
suspend fun getMangaUpdate(manga: SManga, chapters: List<SChapter>, fetchDetails: Boolean, fetchChapters: Boolean): SMangaUpdate
suspend fun getPageList(chapter: SChapter): List<Page>
// kdoc: unrequested parts may be returned as-is; the host MAY apply whatever is returned regardless of the flags.

class SMangaUpdate(val manga: SManga, val chapters: List<SChapter>)            // plain class, 2-arg constructor ONLY

interface SManga { var url; var title; var thumbnail_url: String?; var artist: String?; var author: String?; var status: Int;
                   var description: String?; var genre: String?  /* comma-separated, NOT a list */; var update_strategy: UpdateStrategy;
                   var memo: JsonObject; var initialized: Boolean;  companion { UNKNOWN=0 ONGOING=1 COMPLETED=2 LICENSED=3
                   PUBLISHING_FINISHED=4 CANCELLED=5 ON_HIATUS=6; fun create(): SManga } }
interface SChapter { var url; var name; var chapter_number: Float; var scanlator: String?; var date_upload: Long; var memo: JsonObject; companion { create() } }
class Page(val index: Int, val url: String = "", var imageUrl: String? = null, var uri: Uri? = null)
class MangasPage(val mangas: List<SManga>, val hasNextPage: Boolean)
interface SourceFactory { fun createSources(): List<Source> }                 // eu.kanade.tachiyomi.source.SourceFactory
interface CatalogueSource : Source { val lang: String }

// eu.kanade.tachiyomi.source.online.HttpSource (abstract class : CatalogueSource)
protected val network: NetworkHelper;  abstract val baseUrl: String;  open fun getHomeUrl(): String;  open val versionId: Int
override val id: Long;  val headers: Headers;  open val client: OkHttpClient;  protected open fun headersBuilder(): Headers.Builder
open suspend fun getImageUrl(page: Page): String;  protected open fun imageRequest(page: Page): Request
fun SChapter.setUrlWithoutDomain(url); fun SManga.setUrlWithoutDomain(url); open fun getMangaUrl(manga); open fun getChapterUrl(chapter)

// eu.kanade.tachiyomi.network
class NetworkHelper(context: android.content.Context) { val client: OkHttpClient; val cloudflareClient: OkHttpClient /*deprecated*/ }
class HttpException(val code: Int) : IllegalStateException("HTTP error $code")
fun GET(url: String|HttpUrl, headers = DEFAULT_HEADERS, cache = DEFAULT_CACHE_CONTROL): Request;  fun POST(url, headers, body, cache): Request
suspend fun Call.await(): Response;  suspend fun Call.awaitSuccess(): Response
```

**Injekt.** The pinned `com.github.mihonapp:injekt:91edab2317` is only `dev.mihon.injekt.patchInjekt()` + `PatchedDefaultRegister`
(a registrar). The `Injekt` object/`get()` API is `uy.kohesive.injekt:injekt-core:1.16.1`, which is a dependency of that library
and was not in the zip (its API shape is NOT verified here). `patchInjekt()` assigns the top-level `Injekt` var: Injekt is one
process-global registry, so `Injekt.get<NetworkHelper>()` cannot by itself know which extension is asking.

**Entry point.** Manifest `tachiyomi.extension.class` (FQCN or `.Relative`); instance is a `Source` or a `SourceFactory`.

### Consequences (these drive the Stage 6.5 design)

1. **tachiyomix is a stub artifact. Every real class throws `Exception("Stub!")` in its initialisers** (e.g. `HttpSource.network`,
   `HttpSource.client`, `NetworkHelper.client`, `SManga.create()`). Nothing compiled against it can run until the HOST provides
   real classes with the same binary names and members. Earlier stages called the bundle "the real upstream API"; that was wrong:
   the compat bundle must carry a MangaHive implementation of these classes (as Mihon's app does), never the stub jar at runtime.
2. That makes the network seam closable by construction: the host-written `HttpSource` decides what `network` and `client` return.
3. Extensions commonly build `override val client = network.client.newBuilder()...build()` in a property initialiser, i.e. BEFORE any
   request exists, and many call `Injekt.get<NetworkHelper>()` directly. So the client handed out must carry identity that does
   not depend on a request being current (extensionId, fixed by the host during instantiate), while sourceId/requestId come from
   the host-established per-call scope. `newBuilder()` copies interceptors, so the broker interceptor survives extension tweaks.
4. `getMangaUpdate` returns BOTH details and chapters; `detailsJson`/`chaptersJson` are views over one call with different flags.
5. `SManga.genre` is a comma-separated string: the MangaHive `genres` list is derived by splitting it, never invented.
6. 1.6.0 `SChapter` has no language/locked; `SManga` has no `genres` list. Do not fabricate them.

### Stage 6.6A update
Resolved since 6.5: the gateway, the host API and the fixture compile (AGP 9.1.1 / KGP 2.4.0 / compileSdk 37). The kohesive Injekt
API (`InjektScope`, `addSingleton`, `get`, `injectLazy`) is used from `injekt-core 1.16.1` and exercised by tests. The full
ABI of the AAR (38 classes, including `ParsedHttpSource`, `Filter`, `UpdateStrategy`, `RateLimitInterceptorKt`,
`JavaScriptEngine`, `AppInfo`) is matched member-for-member (`verify-abi.sh`). `JavaScriptEngine.evaluate` deliberately always
throws (MangaHive runs no extension JS). See `MIHON_STAGE6_6_HOST_RUNTIME.md`.

### Still unverified (as of 6.5; see the 6.6A update above for what is now resolved)
Kotlin/Gradle compile of anything here; the kohesive `Injekt` API surface; `Filter`/`FilterList`/`UpdateStrategy` details beyond use;
how real extensions' bytecode links against host-provided classes (dex/classloader parent order); `ParsedHttpSource`,
`RateLimitInterceptor`, `JavaScriptEngine`, `AppInfo` runtime behaviour.
