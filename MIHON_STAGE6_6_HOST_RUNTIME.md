# Stage 6.6A: MangaHive host runtime for the tachiyomix 1.6.0 extension API

Date: 2026-10-03. **Stage 6.6A is partly done. Stage 6.6 is NOT complete.** The status flags have not changed:
`UPSTREAM_API_RUNTIME_COMPATIBLE=false`, `SOURCE_NETWORK_FORCED_THROUGH_BROKER=false`, `SOURCE_EXECUTION_DEVICE_VERIFIED=false`.
This is not Mihon application compatibility. No third-party APK has been built or run (that is Stage 6.6C/D).

## What changed

| Before | Now |
|---|---|
| 8 hand-written, inert `eu.kanade.*` stubs in `android/mihon` (wrong `HttpSource` package, no 1.6 surface), plus `android/internal-probe` that compiled against them | Both are deleted. Nothing imported the stubs. |
| Compat bundle got the API from the stub-only tachiyomix AAR, where every body throws `Stub!` | `android/mihon-compat/gateway/src/main/kotlin/eu/kanade/tachiyomi/**` is the one authoritative host implementation. It has the same binary names and signatures as the AAR. |
| Catalog pinned `tachiyomix16 = "1.6"`, which is HTTP 404 on JitPack | `1.6.0`, which resolves (POM and AAR return HTTP 200). The AAR's `classes.jar` is the ABI reference. |
| Nothing registered `NetworkHelper` in Injekt | `HostInjekt` calls `patchInjekt()` and registers the host `NetworkHelper` and `Json`. This runs before any entry class is loaded or constructed. |
| Interceptors an extension added with `client.newBuilder().addInterceptor(..)` (including 1.6 `rateLimit`) never ran: the broker interceptor came first and was terminal | `BrokerInterceptor` runs them in order inside its own `BrokerChain`, which ends at the broker. The incoming OkHttp chain is still never advanced. |
| A client with its interceptor list cleared would fall through to OkHttp's real sockets | Brokered clients use `Proxy.NO_PROXY`, a `Dns` that always fails and a `SocketFactory` that always fails. Stripping the broker gives a failure, not direct traffic. |

## Exact API (verified against the AAR)

`android/mihon-compat/verify-abi.sh` extracts the AAR named in the catalog. For each of its 38 `eu/kanade/**` classes it runs
`javap -protected -s` on both the upstream class and the host class. It fails if any upstream public/protected member is missing
or has a different JVM descriptor. Host-only extras must be listed, with a reason, in `abi-allowlist.txt`. Today the only extras
are compiler-generated lambdas and accessors, `SMangaImpl`/`SChapterImpl`, the internal `RateLimitInterceptor`, and an internal
`NetworkHelper()` constructor.

Result (run): `ABI OK: 38 upstream classes, every public/protected member present with identical JVM signature`.

Packages: `eu.kanade.tachiyomi` (`AppInfo`), `.source` (`Source`, `CatalogueSource`, `ConfigurableSource`, `SourceFactory`,
`UnmeteredSource`), `.source.online` (`HttpSource`, `ParsedHttpSource`), `.source.model` (`SManga`, `SChapter`, `SMangaUpdate`
(2-arg, no `related`), `Page`, `MangasPage`, `Filter` and its subclasses, `FilterList`, `UpdateStrategy`), `.network`
(`NetworkHelper`, `HttpException`, `GET`/`POST`, `Call.await`/`awaitSuccess`, deprecated Rx `asObservable*`, `JavaScriptEngine`),
`.network.interceptor` (`rateLimit`, `rateLimitHost`), `.util` (`asJsoup`, ...). Later Mihon additions are **not** added:
no `genres` list, no `SChapter.locked`/`language`, no `SMangaUpdate.related`.

Semantics worth knowing:
- `NetworkHelper.client` and the deprecated `cloudflareClient` both return `HostNetwork.clientForCurrentExtension()`. There is no
  second client, and no Cloudflare/WebView path.
- `HttpSource.client` defaults to `network.client`. `network` is `injectLazy()`, as upstream.
- `Call.await()` cancels the OkHttp `Call` when the coroutine is cancelled. `awaitSuccess()` closes the response and throws
  `HttpException(code)` ("HTTP error $code").
- `CatalogueSource`/`HttpSource` bridge the suspend API to the deprecated Rx `fetch*` methods (and back), as upstream does.
- `JavaScriptEngine` exists so extensions that reference it still link, but `evaluate` always throws
  `UnsupportedOperationException`. MangaHive runs no extension JavaScript: no eval, no JS engine, no WebView.
- `ConfigurableSource.setupPreferenceScreen(PreferenceScreen)` has the upstream signature (AndroidX Preference is compile-only).
  The host never calls it yet, because preference UI is not wired.
- `AppInfo` reports MangaHive's own runtime version (`HostRuntimeInfo`), not a Mihon version.

## ClassLoader topology

```
platform/boot ── FRAMEWORK route (android.*, java.*, org.json ...; android.webkit denied)
compat bundle loader  (gateway + host eu.kanade.tachiyomi.* + pinned kotlin/coroutines/serialization/okhttp/okio/jsoup/rx/injekt)
   parent = BoundaryClassLoader(FRAMEWORK, hostSpi(app))                      # AndroidLoaderPorts
extension loader (APK/jar)
   parent = BoundaryClassLoader(FRAMEWORK, compatApi(bundle))                 # ExtensionLoader
```

`compatApi` (ExtensionBoundaries.kt) admits only these package trees: `kotlin`, `kotlinx.coroutines`, `kotlinx.serialization`,
`okhttp3`, `okio`, `org.jsoup`, `rx`, `uy.kohesive.injekt`, `eu.kanade.tachiyomi.source`, `eu.kanade.tachiyomi.network`,
`eu.kanade.tachiyomi.util`, plus exactly the package `eu.kanade.tachiyomi` (for `AppInfo`). Everything else in the bundle cannot be
resolved by an extension, including `app.mangahive.*`, `dev.mihon.injekt` and the SPI. The loaders are parent-first and allow-list
only, so a host API class always wins over a copy that an extension ships. Test t04 loads the upstream stub `classes.jar` inside
the extension and checks this.

## Identity and networking path

```
extension Source ─ HttpSource.client / NetworkHelper.client / Injekt.get<NetworkHelper>().client  (incl. newBuilder() copies)
   → BrokerInterceptor (terminal; runs the extension's own application interceptors first, inside BrokerChain)
   → ScopedBroker(extensionId from HostIdentityScope)  → BrokerEngine → DestinationPolicy / HeaderPolicy / CookieStore
   → ResourceGovernor (rate, concurrency, active jobs) → Transport → internet
```

- `RealCompatGateway.instantiate` installs the broker host (`HostNetwork.install`), then runs `HostInjekt.ensureInstalled()`, then
  loads and constructs the entry classes inside `HostIdentityScope.construction(extensionId)`. So property initialisers such as
  `override val client = network.client.newBuilder()...` get a client bound to that extension.
- Every Source call runs inside `HostIdentityScope.Call(extensionId, source.id, requestContext)`. `RequestScope` re-installs it
  across coroutine and OkHttp dispatcher hops.
- Outside any host scope a client cannot be obtained (`NO_IDENTITY`). An HTTP call outside a request fails with
  `NO_REQUEST_CONTEXT`. Using one extension's client under another extension's call fails with `IDENTITY_MISMATCH`. Nothing
  reaches the wire in any of these cases (tests t06).
- Extension-added network interceptors never run, because there is no network stage. Per-call transport overrides on the chain
  (DNS, sockets, proxy, TLS, cookie jar, cache) are accepted and ignored.
- `HostInjekt` re-asserts the host registrations before every construction. An extension that replaces the global `Injekt`
  registry cannot change what the next extension receives (test t05b). Injekt stays process-global, as upstream. Identity never
  comes from Injekt.

Known implementation dependency: to find the interceptors that follow it, `BrokerInterceptor` reads `RealCall.client`, an OkHttp
API marked `@OkHttpInternalApi` (opt-in). OkHttp is pinned (5.5.0) and ships inside the bundle. If a call is ever not a
`RealCall`, the extension's interceptors are skipped and the request still terminates at the broker (fail-safe). Re-check this
on any OkHttp upgrade.

## Tests actually run (JVM, off-device)

`cd android/mihon-compat && ./gradlew :gateway:testDebugUnitTest` → `HostRuntime16Test`: **23 tests, 22 passed, 0 failed,
1 skipped** (t22, public-internet HTTPS, runs only with `-Dmh.live=1`).

Test setup:
- The fixture extension `:fixture-ext16` is compiled **only** against the published tachiyomix 1.6.0 AAR (compileOnly) plus
  upstream libraries. It never imports MangaHive classes.
- The compat bundle and the fixture each get their own loader, arranged in the production BoundaryClassLoader topology.
- Networking uses the real BrokerEngine, DestinationPolicy, HeaderPolicy, CookieStore and ResourceGovernor, over real sockets
  and TLS (`PinnedSocketTransport`), to a local HTTPS server with a throwaway certificate.

| # | Requirement | Test |
|---|---|---|
| 1 | host API classes resolve from the bundle (and from the host class files, not a stub) | t01, t02 (exact surface, wrong package absent, no old-stub shapes, `Page(int,String,String,Uri)`, `HttpException`) |
| 2 | NetworkHelper | t05 |
| 3 | Injekt (`Injekt.get<NetworkHelper>() === network`, `Json`) + restore after hijack | t05, t05b |
| 4 | HttpSource client resolution | t07, t21 |
| 5 | construction-time identity / fail-closed outside scope / cross-extension | t06 |
| 6 | `client.newBuilder()` keeps the broker, extension interceptor runs, stripped broker fails closed | t07, t08 |
| 7 | real HTTPS (TLS) through the broker | t07 (local TLS); t22 (public internet, opt-in, not run here) |
| 8 | cookies scoped to (extension, source) | t09 |
| 9 | privileged header rejected before the wire | t10 (`PRIVILEGED_HEADER`, never seen by the server) |
| 10-12 | details / chapters / pages via `getMangaUpdate` / `getPageList` (suspend JSON source and Rx/Jsoup `ParsedHttpSource`) | t11, t12, t13 |
| 13 | read timeout → `TIMEOUT` (bounded by the 1 s timeout), oversize → `RESPONSE_TOO_LARGE`, rate → `RATE_LIMITED`, concurrency → `CONCURRENCY_LIMIT`, `awaitSuccess` → `HttpException` | t15, t18, t19, t20, t14 |
| 14 | user cancel → `CANCELLED`, slot released; Source-side `withTimeout` cancels the brokered call | t16, t17 |
| 15 | cross-extension isolation | t06, t09, t21 |

Defect found by these tests and fixed: `detailsJson` read `url`/`title` from the SManga that `mangaDetailsParse` returned. Upstream
parsers leave those fields unset, so a real ParsedHttpSource failed with `UninitializedPropertyAccessException`. Unset fields now
fall back to the requested manga, as Mihon does.

Other checks run: `verify-abi.sh` (above), all 14 JS suites, `android/mihon-net/run-jvm-harness.sh` (328 + 99 + 18 checks, 0 failed).

## Not verified / remaining (Stage 6.6B+)

- **No device or emulator run.** The bundle has not been dexed and loaded with `DexClassLoader`. On the JVM, FRAMEWORK is the JDK
  plus AGP's mockable `android.jar` plus org.json.
- **No independently built third-party APK** has been loaded (6.6C/D). The fixture was written in this repository, but it
  compiles against upstream artifacts only.
- `SOURCE_NETWORK_FORCED_THROUGH_BROKER` stays false. `okhttp3` is extension-visible (it is the 1.6 API), so in the same-UID
  process an extension can still call `OkHttpClient()` itself or open sockets. Real enforcement needs the isolated, INTERNET-less
  process (Stage 4 design, not built).
- Main Android build (`android/`, AGP 8.2.2): see "Android build" below.
- Preference screens (`ConfigurableSource`), `UnmeteredSource` semantics, `update_strategy` handling, and Filter UI mapping are
  implemented as API but not consumed by MangaHive.
- `JavaScriptEngine`-dependent sources are unsupported by design.
- `BrokerInterceptor` relies on the OkHttp-internal `RealCall.client` (see above).

## Android build (run 2026-10-03, JDK 17/21, local Android SDK)

Main build (`android/`, AGP 8.2.2, Kotlin 1.9.22):
- `./gradlew :app:assembleDebug` → **BUILD SUCCESSFUL** and produces `app-debug.apk`. This is the first time `:mihon`'s Kotlin
  compiles (`:mihon:compileDebugKotlin`). Before 6.6A it did not compile: 5 errors in files that 6.6A did not otherwise touch,
  left by the Stage 6.5 SPI change. Each fix below is the minimum needed:
  - `AndroidLoaderPorts`: the class path is built from `it.file.absolutePath` (it was `it.absolutePath` on a non-File).
  - `ExtensionLoader.DenyAllBrokers`: `execute(request, ctx: RequestContext)` now matches `HttpBroker` (it was the pre-6.5
    `CancelSignal` form).
  - `RuntimeDispatcher` Health path: `CancelToken(RequestContext(requestId, CancelScope.root()))` (it passed a String).
- `./gradlew :mihon:testDebugUnitTest` → **FAILS at test compilation, a pre-existing problem 6.6A did not change**.
  `:mihon` adds `mihon-net/src/test/java` to its unit-test sources. `NetSelfTest.java` there uses `com.sun.net.httpserver`, which
  is not on the Android unit-test compile classpath. So `RuntimeDispatcherTest`, `NetworkStage6Test` and the other `:mihon` unit
  tests were **not run**. The same JVM suites do run through `mihon-net/run-jvm-harness.sh` (328 + 99 + 18 checks, 0 failed).

Compat build (`android/mihon-compat/`, AGP 9.1.1, Kotlin 2.4.0, compileSdk 37):
- `./gradlew :gateway:assembleDebug :fixture-ext16:assembleDebug :shapes-1_6:assembleDebug` → **BUILD SUCCESSFUL** (AARs
  produced). `./gradlew :gateway:testDebugUnitTest` → `HostRuntime16Test`, 23 tests, 0 failures, 1 skipped (see above).
- Not done: packaging the bundle as the dexed, hashed runtime file that `AndroidLoaderPorts` loads, and any on-device load of it.

A successful compile is not a device run. Nothing here sets `SOURCE_EXECUTION_DEVICE_VERIFIED`.
