// Stage 5 static gate. Source-level assertions that cannot be expressed in the JDK harness. Run: node mihon_stage5_network_broker_test.js
const fs = require("fs"), path = require("path");
let pass = 0;
const ok = (c, m) => { if (!c) { console.error("FAIL: " + m); process.exit(1); } pass++; console.log("PASS: " + m); };
const walk = d => fs.readdirSync(d, { withFileTypes: true }).flatMap(e => e.isDirectory() ? (["build", "node_modules", ".git"].includes(e.name) ? [] : walk(path.join(d, e.name))) : [path.join(d, e.name)]);
const all = walk("android").filter(f => /\.(kt|java)$/.test(f));
const main = all.filter(f => !/\/(test|androidTest)\//.test(f));
const read = f => fs.readFileSync(f, "utf8");

// one policy: nothing else decides destinations
ok(all.every(f => !/\b(object|class) (ExtensionNetworkPolicy|SecureHttpClient|MangaHiveOkHttpBridge|ExtensionCookieJar)\b/.test(read(f))), "legacy parallel network classes are gone");
ok(!main.some(f => /\bactiveExtensionId\b/.test(read(f))), "no mutable global activeExtensionId in main code");
ok(main.filter(f => /allowLoopbackHostForTestingOnly/.test(read(f))).every(f => f.endsWith("DestinationPolicy.java")), "test-only loopback relaxation is mentioned only in DestinationPolicy itself");
const svc = read("android/mihon/src/main/java/app/mangahive/mihon/runtime/MihonExtensionService.kt");
ok(/DestinationPolicy\.production\(\)/.test(svc) && !/allowLoopback/.test(svc), "service builds the PRODUCTION policy with no relaxation");
ok(svc.includes("urlPolicy = policy::screen") && svc.includes('"mihon_apks"), broker)') && svc.includes("PathClassLoaderFactory(), registry, broker)"), "repository check, APK download and extension HTTP share one policy/broker instance");
ok(/broker\.cookies\(\)\.clearExtension\(id\)/.test(svc) && /onUninstall = \{ id, byRequest ->/.test(svc), "uninstall wipes the extension's cookies");

// sockets: only the transport may open them in main code
const noComments = t => t.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
// Stage 6.6A: the extension fixture (android/mihon-compat/fixture-ext16) is extension code, checked separately below.
const hostMain = main.filter(f => !/\/fixture-ext16\//.test(f));
const netUsers = hostMain.filter(f => /\bOkHttpClient\b|java\.net\.Socket\b|new Socket\(|URLConnection|SocketFactory/.test(noComments(read(f))));
// Stage 6.6A: the 1.6.0 API itself names OkHttpClient (HttpSource.client, rateLimit builders); those files may reference the
// type but never construct a client. Construction is checked below.
const allowed = ["OkHttpTransport.kt", "BrokerInterceptor.kt", "NetworkHelper.kt", "HostNetwork.kt", "HttpSource.kt", "RateLimitInterceptor.kt", "SpecificHostRateLimitInterceptor.kt"];
ok(netUsers.every(f => allowed.some(a => f.endsWith(a))), "only OkHttpTransport, the compat interceptor/HostNetwork and the 1.6.0 API types touch OkHttpClient or sockets: " + netUsers.map(f => path.basename(f)).join(","));
const builders = hostMain.filter(f => /OkHttpClient\(\)|OkHttpClient\.Builder\(\)/.test(noComments(read(f))));
ok(builders.every(f => f.endsWith("OkHttpTransport.kt") || f.endsWith("BrokerInterceptor.kt")), "a fresh OkHttpClient is built only by the production transport and BrokerClients: " + builders.map(f => path.basename(f)).join(","));
ok(hostMain.every(f => !/java\.net\.Socket\b|new Socket\(|URLConnection|openConnection\(/.test(noComments(read(f))) || f.endsWith("OkHttpTransport.kt") || f.endsWith("BrokerInterceptor.kt")), "no raw socket / URLConnection in host code outside the transport (BrokerInterceptor only installs a deny-all SocketFactory)");
ok(!/dns\(|Dns\b/.test(read("android/mihon-net/src/main/java/app/mangahive/mihon/net/BrokerEngine.java")), "engine itself never resolves; DestinationPolicy is the sole resolver");
const dp = read("android/mihon-net/src/main/java/app/mangahive/mihon/net/DestinationPolicy.java");
ok((noComments(dp).match(/getAllByName/g) || []).length === 1, "exactly one DNS call site in the whole network core");
const tr = read("android/mihon/src/main/java/app/mangahive/mihon/network/OkHttpTransport.kt");
ok(/Proxy\.NO_PROXY/.test(tr) && /followRedirects\(false\)/.test(tr) && /followSslRedirects\(false\)/.test(tr) && /retryOnConnectionFailure\(false\)/.test(tr) && /NO_COOKIES/.test(tr) && /override fun lookup\(hostname: String\): List<InetAddress> = pinned/.test(tr), "production transport: pinned DNS, no proxy, no redirects, no retries, no jar");

// compat side: terminal interceptor, identity bound by host
const bi = read("android/mihon-compat/gateway/src/main/kotlin/app/mangahive/compat/gateway/BrokerInterceptor.kt");
ok(!/chain\.proceed/.test(noComments(bi)), "compat interceptor is terminal (never proceeds to a real socket)");
// Stage 6.6A: extension interceptors added via newBuilder() run inside BrokerChain, whose end is toBroker(); the incoming OkHttp
// chain (retry/bridge/cache/connect) is never advanced.
ok(!/outer\.proceed|chain\.proceed/.test(noComments(bi)) && /return toBroker\(request, outer\.call\(\)/.test(bi) && /\.dispatch\(chain\.request\(\)\)/.test(bi), "BrokerChain ends at the broker, never at OkHttp's network chain");
ok(/\.dns\(DenyDirectNetwork\)/.test(bi) && /\.socketFactory\(DenyDirectNetwork\.sockets\)/.test(bi) && /\.proxy\(Proxy\.NO_PROXY\)/.test(bi), "brokered clients fail closed if an extension strips the broker interceptor (deny DNS + sockets, no proxy)");
const spi = read("android/mihon-spi/src/main/java/app/mangahive/mihon/spi/BrokerRequest.java") + read("android/mihon-spi/src/main/java/app/mangahive/mihon/spi/HttpBroker.java");
ok(!/extensionId|sourceId/.test(noComments(spi)), "a request carries no identity field the Source could set");
ok(/HttpBrokerHost brokers/.test(read("android/mihon-spi/src/main/java/app/mangahive/mihon/spi/CompatGateway.java")), "gateway receives brokers as its only network capability");

// secrets never wired into the broker
const netCore = noComments(walk("android/mihon-net/src/main").map(read).join("\n") + tr);
ok(!/supabase_key|anon_key|refresh_token|access_token|CookieManager|SharedPreferences|apikey/i.test(netCore.replace(/"sb-[^"]*"|supabase/gi, "")), "network core has no path to Supabase keys, session tokens, WebView CookieManager or prefs");

// honest status
const st = read("android/mihon/src/main/java/app/mangahive/mihon/runtime/MihonRuntimeStatus.kt");
ok(/SOURCE_EXECUTION_DEVICE_VERIFIED\s*=\s*false/.test(st), "device-verified source execution is still not claimed");

// ---- Stage 6.5: host-bound identity + single client source ----
{
  const G = "android/mihon-compat/gateway/src/main/kotlin/app/mangahive/compat/gateway/";
  const nc = t => t.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
  const rsg2 = nc(read(G + "RealSourceGateway.kt")), rcg = nc(read(G + "RealCompatGateway.kt")), hn = nc(read(G + "HostNetwork.kt")), bi2 = nc(read(G + "BrokerInterceptor.kt"));
  const scope = nc(read("android/mihon-spi/src/main/java/app/mangahive/mihon/spi/HostIdentityScope.java"));
  ok(!/OkHttpClient|okhttp3/.test(rsg2) && !/OkHttpClient|okhttp3/.test(rcg), "gateway classes hold and build NO OkHttp client (open seam F1 removed)");
  ok(/BrokerClients\.forExtension\(extensionId, h\)/.test(hn) && /HostIdentityScope\.extensionIdForNewClient\(\)/.test(hn) && !/fun clientFor\w*\([^)]*extensionId/.test(hn), "HostNetwork derives the extension id from the host scope, not from a caller argument");
  ok((nc(rcg).match(/BrokerClients\./g) || []).length === 0 && /HostIdentityScope\.construction\(extensionId/.test(rcg), "entry classes are constructed inside the host's construction scope");
  ok(/HostIdentityScope\.Call\(extensionId, source\.id, ctx\)/.test(rsg2), "every Source call's identity is (host extensionId, the Source's own id, the host's RequestContext)");
  ok(/class ScopedBroker/.test(scope) && /IDENTITY_MISMATCH/.test(scope) && /NO_REQUEST_CONTEXT/.test(scope), "ScopedBroker refuses a missing call scope and a foreign extension (fail closed)");
  ok(!/getHeader|header\(|\.headers|name\(/.test(scope), "identity code never reads request headers");
  ok(!/\bstatic\s+(?!final\s+ThreadLocal)[A-Za-z<>\[\], ]+\s+(current|active)\w*\s*[;=]/.test(scope) && !/activeExtensionId|currentSource/.test(scope + rsg2 + hn), "no mutable global current/active source or extension (thread-local scopes only)");
  ok(/fun forExtension\(extensionId: String/.test(bi2) && /ScopedBroker\(extensionId, host\)/.test(bi2) && !/chain\.proceed/.test(bi2), "extension clients are built on ScopedBroker and the interceptor remains terminal");
  ok(/getMangaUpdate\(mangaOf\(mangaUrl, mangaMemoJson\), emptyList\(\), fetchDetails = true, fetchChapters = false\)/.test(rsg2) && /fetchDetails = false, fetchChapters = true/.test(rsg2), "details/chapters use the 1.6.0 getMangaUpdate(manga, chapters, fetchDetails, fetchChapters) with at most one flag set");
  ok(!/getDetails\(|getChapters\(|getMangaDetails\(|getChapterList\(/.test(rsg2) && !/NOT_IMPLEMENTED/.test(rsg2), "no invented getDetails/getChapters; no NOT_IMPLEMENTED left in the real gateway");
  ok(!/\.genres\b|chapter\.language|\.locked\b/.test(rsg2), "no fields the 1.6.0 models do not have");
}
// ---- Stage 6.6A: real host implementation of the tachiyomix 1.6.0 API ----
{
  const A = "android/mihon-compat/gateway/src/main/kotlin/eu/kanade/tachiyomi/";
  const nc = t => t.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
  const nh = nc(read(A + "network/NetworkHelper.kt")), hs = nc(read(A + "source/online/HttpSource.kt")), js = nc(read(A + "network/JavaScriptEngine.kt"));
  ok((nh.match(/HostNetwork\.clientForCurrentExtension\(\)/g) || []).length === 2 && !/OkHttpClient\.Builder|OkHttpClient\(\)/.test(nh), "NetworkHelper.client and cloudflareClient are both the host's brokered client");
  ok(/network\.client/.test(hs) && !/OkHttpClient\.Builder|OkHttpClient\(\)/.test(hs), "HttpSource.client defaults to network.client (no own client)");
  ok(/throw UnsupportedOperationException/.test(js) && !/\beval\(|javax\.script|\bScriptEngine\b|QuickJs|WebView|Function\(/.test(js), "JavaScriptEngine links but never executes JavaScript");
  const api = walk("android/mihon-compat/gateway/src/main/kotlin/eu").map(read).map(nc).join("\n");
  ok(!/WebView|HttpURLConnection|openConnection\(|new Socket\(|Socket\(|InetAddress\.getByName|ProcessBuilder|Runtime\.getRuntime/.test(api), "host API code has no WebView, URLConnection, raw socket, DNS or process access");
  const hi = nc(read("android/mihon-compat/gateway/src/main/kotlin/app/mangahive/compat/gateway/HostInjekt.kt"));
  const rcg = nc(read("android/mihon-compat/gateway/src/main/kotlin/app/mangahive/compat/gateway/RealCompatGateway.kt"));
  ok(/patchInjekt\(\)/.test(hi) && /addSingleton|addSingletonFactory|registrar/.test(hi) && /HostInjekt\.ensureInstalled\(\)/.test(rcg) && rcg.indexOf("HostInjekt.ensureInstalled()") < rcg.indexOf("HostIdentityScope.construction(extensionId"), "Injekt NetworkHelper/Json registered before any entry class is constructed");
  const eb = nc(read("android/mihon/src/main/java/app/mangahive/mihon/loader/ExtensionBoundaries.kt"));
  ok(!/"dev\.mihon\.injekt"/.test(eb.slice(eb.indexOf("fun compatApi"))), "patched-Injekt internals (dev.mihon.injekt) are not extension-visible");
  ok(fs.existsSync("android/mihon-compat/verify-abi.sh") && fs.existsSync("android/mihon-compat/abi-allowlist.txt"), "ABI diff against the 1.6.0 AAR is scripted");
}
console.log(pass + " passed");
