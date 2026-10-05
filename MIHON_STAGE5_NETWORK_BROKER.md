# Stage 5 - Real Mihon HTTP + cookie + security broker

Scope: network only. UI, existing MangaHive adapters, process model (Stage 4) untouched.

## Path
Source -> OkHttp (compat bundle) -> `BrokerInterceptor` (terminal, never `proceed()`) -> `HttpBroker` (identity bound by the host)
-> `BrokerEngine` -> `DestinationPolicy` (every hop) -> `HeaderPolicy` -> `CookieStore` -> `Transport` (`OkHttpTransport`) -> Internet.
Repository checks, APK downloads and every redirect of each go through the same `DestinationPolicy` / `BrokerEngine`.

## Where things live
- `android/mihon-spi` JDK-only: `HttpBroker`, `HttpBrokerHost`, `BrokerRequest/Response` (status, reason, protocol, repeated headers, final URL/method, redirect chain, content type/length, streaming body, timing), `BrokerException`, `CancelSignal`.
- `android/mihon-net` pure JDK, shared into `:mihon` at source level: `SafeUrl` (strict parser), `AddressClassifier`, `DestinationPolicy`, `HeaderPolicy`, `CookieScope/CookieStore/FileCookieStorage`, `BrokerEngine`, `Transport`.
- `:mihon` `OkHttpTransport` (pinned DNS, no proxy/redirect/retry/jar), `DefaultBrokerEngine`, brokered `ApkDownloader`.
- `mihon-compat/gateway` `BrokerInterceptor`, `BrokerClients`, gateway receives `HttpBrokerHost`.
- Deleted: `SecureHttpClient`, `MangaHiveOkHttpBridge`, `ExtensionNetworkPolicy`, `ExtensionCookieJar`, `activeExtensionId`.

## Behaviour
- Policy order: strict parse -> https (production) -> port 443 -> hostname rules -> protected hosts (supabase.*) -> resolve ONCE -> classify every address -> pin. One bad record refuses the whole answer. The transport dials only the validated list (no second lookup = no rebinding window); TLS is verified against the host name.
- Rejected URL spellings: userinfo, backslash, `2130706433`, `0x7f.1`, `0177.0.0.1`, `127.1`, zone ids, percent-escapes in host, non-ASCII, bad ports.
- Redirects: followed by the broker, each hop re-parsed and re-checked (fresh DNS); relative / `../` / `//host` supported; loops (3rd visit), >20 hops, unsafe scheme/host/private address refused (`REDIRECT_BLOCKED`); 302/303 POST->GET, 307/308 on non-GET returned to the Source (OkHttp behaviour); Authorization and an explicit Cookie header dropped on cross-origin hop.
- Cookies: keyed by `(extensionId, sourceId)` fixed when the host opens the broker; RFC 6265 parsing, Set-Cookie honoured on redirect hops; own jar, never the WebView CookieManager; only cookies with an expiry are written to disk (hash-named files); `clearExtension` on uninstall wipes memory and disk.
- Headers: `x-mangahive-*`, `x-mh-*`, `x-supabase-*`, `sb-*`, `x-client-info` -> request FAILS (`PRIVILEGED_HEADER`); Host/Content-Length/Transfer-Encoding/Connection/Upgrade/Proxy-* dropped; CR/LF injection fails. The broker adds no credentials; there is no code path from Supabase keys, session/refresh tokens or browser cookies into it.
- Compression: gzip handled transparently only if the Source set no Accept-Encoding (headers fixed up like OkHttp); size caps apply to the decoded stream.

## Verification actually run
- `android/mihon-net/run-jvm-harness.sh <mihon-test-extension dir>`: 331 checks, 0 failed (JDK 21; real TLS servers; real Stage 2 `fixture_server.py` incl. its User-Agent gate and request log; scripted wire for public-address / rebinding cases).
- `node mihon_stage5_network_broker_test.js` (15 static gates) plus the Stage 1/4, boundary and production-security suites pass.
- NOT run: any Kotlin compile, Gradle, instrumented test, device. `mihon_yuzono_repo_test.js` now reads the repository fixture `tests/fixtures/yuzono/yuzono-index.min.json` (Stage 6.5; SYNTHETIC, see its README) and no longer fetches live data.

## Open findings
- F1 (blocks the "real Source is brokered" gate). UPDATE: the Stage 2 `FixtureSource` source is now fixed (no private `OkHttpClient`; it inherits the host `network.client`; `verify-apk.sh` checks this) but is unbuilt, and the host side still does not hand a Source its brokered client. Original finding: the Stage 2 `FixtureSource` built its own `OkHttpClient` and bypassed the broker. In a same-UID `:mihon` process nothing here can stop that; real enforcement is the isolated, INTERNET-less process from Stage 4 (not built). Also unread: how 1.6 hands a Source its client (`NetworkHelper` via Injekt is global, so per-source identity needs a per-source seam). `SOURCE_NETWORK_FORCED_THROUGH_BROKER=false`.
- F2: the Kotlin pieces (`OkHttpTransport`, `BrokerInterceptor`, gateway/service wiring) are unverified code.
- F3: cookie public-suffix check is a heuristic list, not the PSL.
- F4: the test relaxation `allowLoopbackHostForTestingOnly` exists in main code (guarded: production factory never sets it; static test pins its single mention). Moving it to the test source set needs a policy subclass hook.


## Stage 6.5 status of F1 (the open seam) - UPDATED 2026-10-03, still OPEN
Read from the real tachiyomix 1.6.0 sources (MIHON_API_PROFILES.md, "VERIFIED 1.6.0 contract"):
- tachiyomix is a **stub** artifact; `HttpSource.client`, `HttpSource.network`, `NetworkHelper.client` all throw `Stub!`. A Source can only run against
  host-provided classes with the same binary names. **Those host-provided classes (`HttpSource`, `NetworkHelper`, `SManga/SChapter` impls, `GET/POST`, `await*`,
  ...) are NOT written yet.** Until they exist no real extension can be instantiated at all, so no Source network call can be proven to reach the broker.
- Done (JVM-tested core + uncompiled Kotlin adapters): the identity design and its single client source.
  `HostIdentityScope` (JDK-only, 18 JVM checks): host-set `construction(extensionId)` and `call(extensionId, sourceId, RequestContext)` scopes, thread-local with
  restore, no global; `ScopedBroker` (client per extension; source id + request id from the call scope; foreign extension -> IDENTITY_MISMATCH; no scope ->
  NO_REQUEST_CONTEXT). `HostNetwork.clientForCurrentExtension()` is the only place a Source-visible `OkHttpClient` is made; the gateway classes hold none
  (static gate in `mihon_stage5_network_broker_test.js`). The host `NetworkHelper.client`/`cloudflareClient`/`HttpSource.client` MUST return it (not yet wired).
- `SOURCE_NETWORK_FORCED_THROUGH_BROKER` stays `false`: it flips only after a real extension's search/details/chapters/pages are shown reaching the broker.
- Fixed `Yuzono` test reproducibility (`tests/fixtures/yuzono/`, synthetic fixture, no live fetch).

## Stage 6.6A status of F1 - UPDATED 2026-10-03, still OPEN (narrowed)
- The host classes now exist (`MIHON_STAGE6_6_HOST_RUNTIME.md`). `NetworkHelper.client`, `cloudflareClient`, `HttpSource.client`
  and `Injekt.get<NetworkHelper>()` all resolve to `HostNetwork.clientForCurrentExtension()`. A Source compiled only against
  upstream 1.6.0 was shown, on the JVM, to send search/details/chapters/pages through the broker over real TLS
  (`HostRuntime16Test`).
- `client.newBuilder()`: extension application interceptors now run inside `BrokerInterceptor`'s own `BrokerChain`, which ends at
  the broker. Before 6.6A they were silently skipped. Clearing the interceptor list now fails closed (deny-all DNS and
  SocketFactory, no proxy) instead of reaching OkHttp's real sockets.
- Still open: in the same-UID process an extension can construct its own `OkHttpClient()` or socket (`okhttp3` is part of the
  1.6 API surface). `SOURCE_NETWORK_FORCED_THROUGH_BROKER=false` until the isolated INTERNET-less process exists.
- F2 is partly closed: `BrokerInterceptor`, `HostNetwork`, `RequestScope` and `RealSourceGateway` compile and run in the JVM
  tests. `OkHttpTransport`/service wiring in `:mihon` is covered only by the main-build attempt recorded in the 6.6A doc.
- Static gate `mihon_stage5_network_broker_test.js`: 37 checks. It now separates "references the OkHttpClient type" (1.6 API
  files) from "constructs a client" (only `OkHttpTransport` and `BrokerClients`), and adds 6.6A host-API checks.
