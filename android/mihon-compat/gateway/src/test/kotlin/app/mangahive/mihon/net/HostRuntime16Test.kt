package app.mangahive.mihon.net

import app.mangahive.mihon.loader.BoundaryClassLoader
import app.mangahive.mihon.loader.ExtensionBoundaries
import app.mangahive.mihon.spi.BrokerException
import app.mangahive.mihon.spi.CancelScope
import app.mangahive.mihon.spi.CompatGateway
import app.mangahive.mihon.spi.GatewayException
import app.mangahive.mihon.spi.HostIdentityScope
import app.mangahive.mihon.spi.HttpBrokerHost
import app.mangahive.mihon.spi.RequestContext
import app.mangahive.mihon.spi.SourceGateway
import com.sun.net.httpserver.HttpExchange
import com.sun.net.httpserver.HttpsConfigurator
import com.sun.net.httpserver.HttpsExchange
import com.sun.net.httpserver.HttpsServer
import org.json.JSONArray
import org.json.JSONObject
import org.junit.AfterClass
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotEquals
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertSame
import org.junit.Assert.assertTrue
import org.junit.Assert.fail
import org.junit.Assume.assumeTrue
import org.junit.BeforeClass
import org.junit.FixMethodOrder
import org.junit.Test
import org.junit.runners.MethodSorters
import java.io.File
import java.io.FileInputStream
import java.lang.reflect.InvocationTargetException
import java.net.InetAddress
import java.net.InetSocketAddress
import java.net.URLClassLoader
import java.net.URLDecoder
import java.nio.file.Files
import java.security.KeyStore
import java.util.UUID
import java.util.concurrent.Callable
import java.util.concurrent.ConcurrentLinkedQueue
import java.util.concurrent.Executors
import java.util.concurrent.Semaphore
import java.util.concurrent.TimeUnit
import java.util.concurrent.atomic.AtomicInteger
import java.util.concurrent.atomic.AtomicReference
import java.util.zip.ZipFile
import javax.net.ssl.KeyManagerFactory
import javax.net.ssl.SSLContext

/**
 * Stage 6.6A host-runtime tests. Real topology, real code, real TLS:
 *  - the compat bundle (gateway + MangaHive's eu.kanade.tachiyomi.* host implementation + pinned libs) is loaded in its OWN
 *    URLClassLoader whose parent is the production BoundaryClassLoader(FRAMEWORK, hostSpi) — as AndroidLoaderPorts does;
 *  - the fixture extension (:fixture-ext16, compiled ONLY against the upstream tachiyomix 1.6.0 stubs) is loaded in a child
 *    loader under BoundaryClassLoader(FRAMEWORK, compatApi(bundle)) — as ExtensionLoader does;
 *  - networking is the real Stage 5/6 BrokerEngine (DestinationPolicy, HeaderPolicy, CookieStore, ResourceGovernor) over real
 *    sockets + TLS (PinnedSocketTransport) to a local HTTPS server with a throwaway self-signed certificate.
 * Off-device differences: FRAMEWORK is served by the JDK + AGP's mockable android.jar + org.json instead of the Android boot
 * class path; the bundle is class files/jars instead of a dex. Nothing here is device evidence.
 */
@FixMethodOrder(MethodSorters.NAME_ASCENDING)
class HostRuntime16Test {
    class Seen(val path: String, val query: String, val headers: Map<String, String>, val tls: Boolean)
    class Bundle(val loader: ClassLoader, val gateway: CompatGateway)

    companion object {
        private const val FACTORY = "eu.kanade.tachiyomi.extension.all.mhfixture.MhFixtureFactory"
        private const val JSON = "MH Fixture JSON"
        private const val HTML = "MH Fixture HTML"

        lateinit var server: HttpsServer
        var port = 0
        lateinit var clientCtx: SSLContext
        val seen = ConcurrentLinkedQueue<Seen>()
        val hangArrivals = Semaphore(0)

        lateinit var frameworkRoute: BoundaryClassLoader.Route
        lateinit var bundleUrls: Array<java.net.URL>
        lateinit var gatewayLocation: File
        lateinit var fixtureJar: File
        lateinit var upstreamStubJar: File

        lateinit var bundle: Bundle
        lateinit var engine: BrokerEngine
        lateinit var extA: List<SourceGateway>
        lateinit var extB: List<SourceGateway>
        private val ids = AtomicInteger()

        @BeforeClass @JvmStatic
        fun setUp() {
            startServer()
            System.setProperty("mh.fixture.baseUrl", "https://localhost:$port")
            buildTopology()
            bundle = newBundle()
            engine = engine()
            extA = instantiate(bundle, "mh.ext.a", engine)
            extB = instantiate(bundle, "mh.ext.b", engine)
        }

        @AfterClass @JvmStatic
        fun tearDown() { server.stop(0) }

        // ───────────── topology ─────────────

        private fun buildTopology() {
            val cp = System.getProperty("java.class.path").split(File.pathSeparator).map(::File)
            fun loc(c: Class<*>) = File(c.protectionDomain.codeSource.location.toURI())
            gatewayLocation = loc(Class.forName("app.mangahive.compat.gateway.RealCompatGateway", false, javaClass.classLoader))
            val spi = loc(HostIdentityScope::class.java)
            val tests = loc(HostRuntime16Test::class.java)
            val isAndroidJar = { f: File -> f.name == "android.jar" || f.path.contains("mockable") }
            val isOrgJson = { f: File -> f.name.startsWith("json-") && f.path.contains("org.json") }
            val frameworkJars = cp.filter { isAndroidJar(it) || isOrgJson(it) }
            assertTrue("mockable android.jar + org.json on the test class path: $frameworkJars", frameworkJars.size >= 2)
            val framework = URLClassLoader(frameworkJars.map { it.toURI().toURL() }.toTypedArray(), ClassLoader.getSystemClassLoader().parent /* JDK platform loader */)
            val prod = ExtensionBoundaries.FRAMEWORK
            frameworkRoute = BoundaryClassLoader.Route(prod.label, prod.allow, prod.deny, framework)
            val skip = { f: File ->
                isAndroidJar(f) || isOrgJson(f) || f == tests || (f == spi && f != gatewayLocation) || f.isDirectory ||
                    Regex("junit|hamcrest").containsMatchIn(f.name)
            }
            bundleUrls = (listOf(gatewayLocation) + cp.filterNot(skip)).distinct().map { it.toURI().toURL() }.toTypedArray()
            fixtureJar = classesJarOf(File(System.getProperty("mh.fixture.aar")))
            upstreamStubJar = classesJarOf(File(System.getProperty("mh.upstream.aar")))
        }

        private fun classesJarOf(aar: File): File {
            val out = Files.createTempFile("classes", ".jar").toFile()
            ZipFile(aar).use { z -> z.getInputStream(z.getEntry("classes.jar")).use { i -> out.outputStream().use { i.copyTo(it) } } }
            return out
        }

        fun newBundle(): Bundle {
            val parent = BoundaryClassLoader(listOf(frameworkRoute, ExtensionBoundaries.hostSpi(HostRuntime16Test::class.java.classLoader!!)))
            val l = URLClassLoader(bundleUrls, parent)
            val gw = l.loadClass("app.mangahive.compat.gateway.RealCompatGateway").getDeclaredConstructor().newInstance() as CompatGateway
            return Bundle(l, gw)
        }

        fun extLoader(b: Bundle, vararg jars: File): ClassLoader =
            URLClassLoader(jars.map { it.toURI().toURL() }.toTypedArray(), BoundaryClassLoader(listOf(frameworkRoute, ExtensionBoundaries.compatApi(b.loader))))

        fun instantiate(b: Bundle, extensionId: String, host: HttpBrokerHost, vararg jars: File = arrayOf(fixtureJar)): List<SourceGateway> =
            b.gateway.instantiate(extLoader(b, *jars), extensionId, listOf(FACTORY), host)

        fun engine(governor: ResourceGovernor = ResourceGovernor(), maxResponse: Long = 1L shl 20): BrokerEngine {
            val pol = DestinationPolicy.builder().requireHttps(true).allowPort(443).protect(DestinationPolicy.DEFAULT_PROTECTED_HOST_SUFFIXES)
                .allowLoopbackHostForTestingOnly("localhost", port).build()
            val lim = BrokerEngine.Limits().apply { maxResponseBytes = maxResponse }
            return BrokerEngine(pol, PinnedSocketTransport(clientCtx), CookieStore(null, CookieStore.Clock { System.currentTimeMillis() }), lim, governor, Deadlines.shared())
        }

        // ───────────── local HTTPS server ─────────────

        private fun startServer() {
            val dir = Files.createTempDirectory("mh66").toFile()
            val p12 = File(dir, "ks.p12")
            val crt = File(dir, "s.crt")
            val keytool = File(System.getProperty("java.home"), "bin/keytool").path
            run(keytool, "-genkeypair", "-alias", "s", "-keyalg", "RSA", "-keysize", "2048", "-validity", "3", "-dname", "CN=localhost",
                "-ext", "san=dns:localhost,ip:127.0.0.1", "-keystore", p12.path, "-storetype", "PKCS12", "-storepass", "changeit", "-keypass", "changeit")
            run(keytool, "-exportcert", "-alias", "s", "-keystore", p12.path, "-storepass", "changeit", "-file", crt.path)
            val ks = KeyStore.getInstance("PKCS12").apply { FileInputStream(p12).use { load(it, "changeit".toCharArray()) } }
            val kmf = KeyManagerFactory.getInstance("SunX509").apply { init(ks, "changeit".toCharArray()) }
            val serverCtx = SSLContext.getInstance("TLS").apply { init(kmf.keyManagers, null, null) }
            clientCtx = trusting(crt)
            server = HttpsServer.create(InetSocketAddress(InetAddress.getByName("127.0.0.1"), 0), 0)
            server.httpsConfigurator = HttpsConfigurator(serverCtx)
            server.executor = Executors.newCachedThreadPool()
            port = server.address.port
            server.createContext("/") { x -> route(x) }
            server.start()
        }

        private fun trusting(crt: File): SSLContext {
            val cert = FileInputStream(crt).use { java.security.cert.CertificateFactory.getInstance("X.509").generateCertificate(it) }
            val ts = KeyStore.getInstance(KeyStore.getDefaultType()).apply { load(null, null); setCertificateEntry("ca", cert) }
            val tmf = javax.net.ssl.TrustManagerFactory.getInstance(javax.net.ssl.TrustManagerFactory.getDefaultAlgorithm()).apply { init(ts) }
            return SSLContext.getInstance("TLS").apply { init(null, tmf.trustManagers, null) }
        }

        private fun run(vararg cmd: String) {
            val p = ProcessBuilder(*cmd).redirectErrorStream(true).start()
            val out = p.inputStream.readBytes()
            check(p.waitFor() == 0) { String(out) }
        }

        private fun route(x: HttpExchange) {
            val path = x.requestURI.path
            val query = x.requestURI.rawQuery ?: ""
            seen.add(Seen(path, query, x.requestHeaders.entries.associate { it.key.lowercase() to it.value.joinToString(",") }, x is HttpsExchange))
            val q = query.split('&').filter { it.contains('=') }.associate { it.substringBefore('=') to URLDecoder.decode(it.substringAfter('='), "UTF-8") }
            val base = "https://localhost:$port"
            try {
                when {
                    path == "/api/search" -> {
                        val sid = sid(x)
                        json(x, """{"mangas":[{"url":"/m/1","title":"Result ${q["q"]}","thumb":"$base/t/1.jpg"},{"url":"/m/c","title":"cookie:${sid ?: "-"}"}],"hasNext":true}""")
                    }
                    path == "/api/manga" -> json(x, """{"title":"Manga ${q["url"]}","author":"Au","artist":"Ar","description":"Desc","genre":"Action, Comedy","status":2,"thumb":"$base/t/1.jpg"}""")
                    path == "/api/chapters" -> json(x, """[{"url":"/c/2","name":"Ch 2","number":2,"date":1700000100000,"scanlator":"S"},{"url":"/c/1","name":"Ch 1","number":1,"date":1700000000000}]""")
                    path == "/api/pages" -> json(x, """[{"url":"/p/0","imageUrl":"$base/i/0.jpg"},{"url":"/p/1","imageUrl":"$base/i/1.jpg"}]""")
                    path == "/slow" -> { Thread.sleep(5_000); send(x, 200, "late", "text/plain") }
                    path == "/hang" -> { hangArrivals.release(); try { Thread.sleep(30_000) } catch (_: InterruptedException) {}; send(x, 200, "late", "text/plain") }
                    path == "/big" -> send(x, 200, "x".repeat(2 shl 20), "text/plain")
                    path.startsWith("/status/") -> send(x, path.removePrefix("/status/").toInt(), "error", "text/plain")
                    path == "/html/search" -> {
                        val sid = sid(x)
                        send(x, 200, """<html><body><div class="m"><a href="/h/1">HTML ${q["q"]}</a></div><div class="m"><a href="/h/c">cookie:${sid ?: "-"}</a></div><a class="next" href="#">n</a></body></html>""", "text/html")
                    }
                    path == "/h/1" -> send(x, 200, """<html><body><h1>HTML Manga</h1><span class="author">HA</span><a class="genre">Drama</a><a class="genre">Mystery</a><p class="desc">HD</p><ul><li class="ch"><a href="$base/hc/1" data-n="1">Chapter 1</a></li></ul></body></html>""", "text/html")
                    path == "/hc/1" -> send(x, 200, """<html><body><img class="page" src="/i/a.jpg"><img class="page" src="/i/b.jpg"><img class="page" src="/i/c.jpg"></body></html>""", "text/html")
                    else -> send(x, 404, "not found", "text/plain")
                }
            } catch (_: Exception) {
            } finally {
                x.close()
            }
        }

        /** The sid cookie the client sent; a new one is set when absent. */
        private fun sid(x: HttpExchange): String? {
            val sid = (x.requestHeaders["Cookie"] ?: emptyList()).flatMap { it.split(';') }.map { it.trim() }
                .firstOrNull { it.startsWith("sid=") }?.removePrefix("sid=")
            if (sid == null) x.responseHeaders.add("Set-Cookie", "sid=${UUID.randomUUID()}; Path=/; Secure; HttpOnly")
            return sid
        }

        private fun json(x: HttpExchange, body: String) = send(x, 200, body, "application/json")

        private fun send(x: HttpExchange, code: Int, body: String, type: String) {
            val b = body.toByteArray()
            x.responseHeaders.add("Content-Type", type)
            x.sendResponseHeaders(code, b.size.toLong())
            x.responseBody.use { it.write(b) }
        }

        // ───────────── helpers ─────────────

        fun ctx() = RequestContext("rt-" + ids.incrementAndGet(), CancelScope.root())
        fun SourceGateway.search(q: String, c: RequestContext = ctx()) = JSONObject(searchJson(c, 1, q))
        fun List<SourceGateway>.src(name: String) = first { it.name() == name }
        fun titles(o: JSONObject) = (0 until o.getJSONArray("mangas").length()).map { o.getJSONArray("mangas").getJSONObject(it).getString("title") }
        fun firstTitle(o: JSONObject) = titles(o).first()
        fun cookieOf(o: JSONObject) = titles(o).first { it.startsWith("cookie:") }

        fun gatewayCode(block: () -> Unit): String = try { block(); "none" } catch (e: GatewayException) { e.code }

        fun brokerCode(t: Throwable?): String? {
            var c = t
            while (c != null) {
                if (c is BrokerException) return c.code
                c = if (c is InvocationTargetException) c.targetException else c.cause
            }
            return null
        }

        fun seenCount(pred: (Seen) -> Boolean) = seen.count(pred)

        /** The Source object behind a SourceGateway (test-only reflection; the host itself never touches it). */
        fun sourceOf(g: SourceGateway): Any = g.javaClass.getDeclaredField("source").apply { isAccessible = true }.get(g)

        fun waitUntil(ms: Long, cond: () -> Boolean): Boolean {
            val end = System.currentTimeMillis() + ms
            while (System.currentTimeMillis() < end) { if (cond()) return true; Thread.sleep(20) }
            return cond()
        }
    }

    // ═══════════════ 1. host API class resolution ═══════════════

    @Test fun t01_apiClassesResolveFromTheHostBundle() {
        val ext = extLoader(bundle, fixtureJar)
        val api = listOf(
            "eu.kanade.tachiyomi.AppInfo",
            "eu.kanade.tachiyomi.source.Source", "eu.kanade.tachiyomi.source.CatalogueSource", "eu.kanade.tachiyomi.source.SourceFactory",
            "eu.kanade.tachiyomi.source.ConfigurableSource", "eu.kanade.tachiyomi.source.UnmeteredSource",
            "eu.kanade.tachiyomi.source.online.HttpSource", "eu.kanade.tachiyomi.source.online.ParsedHttpSource",
            "eu.kanade.tachiyomi.source.model.SManga", "eu.kanade.tachiyomi.source.model.SChapter", "eu.kanade.tachiyomi.source.model.SMangaUpdate",
            "eu.kanade.tachiyomi.source.model.Page", "eu.kanade.tachiyomi.source.model.MangasPage", "eu.kanade.tachiyomi.source.model.Filter",
            "eu.kanade.tachiyomi.source.model.Filter\$TriState", "eu.kanade.tachiyomi.source.model.Filter\$Sort\$Selection",
            "eu.kanade.tachiyomi.source.model.FilterList", "eu.kanade.tachiyomi.source.model.UpdateStrategy",
            "eu.kanade.tachiyomi.network.NetworkHelper", "eu.kanade.tachiyomi.network.HttpException", "eu.kanade.tachiyomi.network.RequestsKt",
            "eu.kanade.tachiyomi.network.OkHttpExtensionsKt", "eu.kanade.tachiyomi.network.interceptor.RateLimitInterceptorKt",
            "eu.kanade.tachiyomi.network.interceptor.SpecificHostRateLimitInterceptorKt", "eu.kanade.tachiyomi.util.JsoupExtensionsKt",
        )
        for (n in api) {
            val c = ext.loadClass(n)
            assertSame("$n comes from the compat bundle", bundle.loader, c.classLoader)
            assertEquals("$n is MangaHive's host implementation (bundle classes), not an upstream stub", gatewayLocation, File(c.protectionDomain.codeSource.location.toURI()))
        }
        for (n in listOf("uy.kohesive.injekt.api.InjektScope", "uy.kohesive.injekt.InjektKt", "rx.Observable", "okhttp3.OkHttpClient",
            "kotlinx.serialization.json.JsonObject", "kotlinx.coroutines.CoroutineScope", "org.jsoup.Jsoup", "kotlin.Unit")) {
            assertSame("$n comes from the compat bundle", bundle.loader, ext.loadClass(n).classLoader)
        }
        assertSame("the fixture itself is the extension's own class", ext, ext.loadClass(FACTORY).classLoader)
    }

    @Test fun t02_exact16SurfaceAndNoObsoleteStubShapes() {
        val ext = extLoader(bundle, fixtureJar)
        fun cnfe(n: String) = try { ext.loadClass(n); false } catch (_: ClassNotFoundException) { true }
        assertTrue("wrong package eu.kanade.tachiyomi.source.HttpSource does not exist", cnfe("eu.kanade.tachiyomi.source.HttpSource"))
        val http = ext.loadClass("eu.kanade.tachiyomi.source.online.HttpSource")
        val names = http.methods.map { it.name }.toSet()
        assertFalse("old stub getMangaDetails is gone", "getMangaDetails" in names)
        assertFalse("old stub getChapterList is gone", "getChapterList" in names)
        assertTrue(listOf("getMangaUpdate", "getPageList", "getSearchManga", "getClient", "getHeaders", "getBaseUrl", "fetchMangaDetails", "getImageUrl").all { it in names })
        val upd = ext.loadClass("eu.kanade.tachiyomi.source.model.SMangaUpdate")
        assertEquals(listOf(2), upd.constructors.map { it.parameterCount })
        assertFalse(upd.methods.any { it.name == "getRelated" })
        val manga = ext.loadClass("eu.kanade.tachiyomi.source.model.SManga")
        assertEquals(String::class.java, manga.getMethod("getGenre").returnType)
        assertFalse(manga.methods.any { it.name == "getGenres" })
        val chapter = ext.loadClass("eu.kanade.tachiyomi.source.model.SChapter")
        assertFalse(chapter.methods.any { it.name == "getLocked" || it.name == "getLanguage" })
        val page = ext.loadClass("eu.kanade.tachiyomi.source.model.Page")
        assertNotNull(page.getConstructor(Int::class.javaPrimitiveType, String::class.java, String::class.java, ext.loadClass("android.net.Uri")))
        val ex = ext.loadClass("eu.kanade.tachiyomi.network.HttpException")
        assertSame(IllegalStateException::class.java, ex.superclass)
        assertEquals("HTTP error 503", (ex.getConstructor(Int::class.javaPrimitiveType).newInstance(503) as Throwable).message)
    }

    @Test fun t03_privateHostClassesAreNotVisibleToExtensions() {
        val ext = extLoader(bundle, fixtureJar)
        for (n in listOf(
            "app.mangahive.compat.gateway.HostNetwork", "app.mangahive.compat.gateway.BrokerInterceptor", "app.mangahive.compat.gateway.BrokerClients",
            "app.mangahive.compat.gateway.HostInjekt", "app.mangahive.compat.gateway.RealCompatGateway", "app.mangahive.compat.gateway.RequestScope",
            "app.mangahive.mihon.spi.HostIdentityScope", "app.mangahive.mihon.spi.HttpBroker", "app.mangahive.mihon.net.BrokerEngine",
            "app.mangahive.mihon.loader.BoundaryClassLoader", "dev.mihon.injekt.PatchedDefaultRegister", "android.webkit.WebView",
        )) {
            try { ext.loadClass(n); fail("$n must not be loadable by an extension") } catch (_: ClassNotFoundException) {}
        }
    }

    @Test fun t04_apiClassesBundledByTheExtensionAreNeverSelected() {
        assertNotNull("upstream stub jar really contains NetworkHelper", URLClassLoader(arrayOf(upstreamStubJar.toURI().toURL()), null).getResource("eu/kanade/tachiyomi/network/NetworkHelper.class"))
        val ext = extLoader(bundle, fixtureJar, upstreamStubJar)
        for (n in listOf("eu.kanade.tachiyomi.network.NetworkHelper", "eu.kanade.tachiyomi.source.online.HttpSource", "eu.kanade.tachiyomi.source.model.SManga")) {
            assertSame("$n: host definition wins over the extension's copy", bundle.loader, ext.loadClass(n).classLoader)
        }
        val dup = bundle.gateway.instantiate(ext, "mh.ext.dup", listOf(FACTORY), engine)
        assertEquals("Result dup", firstTitle(dup.src(JSON).search("dup")))   // an upstream stub would throw "Stub!"
    }

    // ═══════════════ 2-3. NetworkHelper + Injekt ═══════════════

    @Test fun t05_injektServesTheHostNetworkHelperAndJson() {
        assertEquals("injekt:true:true", firstTitle(extA.src(JSON).search("injekt")))
    }

    @Test fun t05b_injektRegistrationsAreRestoredBeforeTheNextConstruction() {
        assertEquals("injekt-hijacked", firstTitle(extA.src(JSON).search("injekt-hijack")))
        val c = instantiate(bundle, "mh.ext.c", engine)
        assertEquals("injekt:true:true", firstTitle(c.src(JSON).search("injekt")))
        assertEquals("Result after-hijack", firstTitle(c.src(JSON).search("after-hijack")))
    }

    // ═══════════════ 4-5. client resolution + identity ═══════════════

    @Test fun t06_identityIsHostBoundAndFailsClosed() {
        val a = sourceOf(extA.src(JSON))
        val sid = extA.src(JSON).sourceId()
        val currentClient = a.javaClass.getMethod("currentNetworkClient")
        val request = a.javaClass.getMethod("requestFromCurrentThread", String::class.java)
        fun outcome(block: () -> Any?): String = try { block(); "ok" } catch (t: Throwable) { brokerCode(t) ?: t.toString() }

        assertEquals("NO_IDENTITY", outcome { currentClient.invoke(a) })
        assertEquals("NO_REQUEST_CONTEXT", outcome { request.invoke(a, "/api/search?q=noscope") })
        assertEquals("IDENTITY_MISMATCH", outcome {
            HostIdentityScope.call(HostIdentityScope.Call("mh.ext.b", sid, ctx()), Callable { request.invoke(a, "/api/search?q=foreign") })
        })
        assertEquals(0, seenCount { it.query.contains("q=noscope") || it.query.contains("q=foreign") })
        assertEquals(200, HostIdentityScope.call(HostIdentityScope.Call("mh.ext.a", sid, ctx()), Callable { request.invoke(a, "/api/search?q=owner") }))
        assertEquals(1, seenCount { it.query.contains("q=owner") })
        assertEquals("both extensions' fixture sources have the same upstream id", sid, extB.src(JSON).sourceId())
    }

    // ═══════════════ 6-7. newBuilder() keeps the broker; real HTTPS ═══════════════

    @Test fun t07_constructionTimeClientKeepsBrokerAndExtensionInterceptorsRun() {
        assertEquals("Result hello", firstTitle(extA.src(JSON).search("hello")))
        val s = seen.last { it.query.contains("q=hello") }
        assertTrue("real TLS", s.tls)
        assertEquals("extension interceptor added via newBuilder() ran", "1", s.headers["x-fixture-interceptor"])
        assertEquals("https://localhost:$port/", s.headers["referer"])
        assertTrue(s.headers["user-agent"]!!.startsWith("Mozilla/5.0"))
    }

    @Test fun t08_clientWithBrokerStrippedFailsClosed() {
        val t = firstTitle(extA.src(JSON).search("detach"))
        assertTrue(t, t.startsWith("detach-blocked:"))
        assertEquals(0, seenCount { it.path == "/detach" })
    }

    // ═══════════════ 8. cookies ═══════════════

    @Test fun t09_cookiesAreScopedToExtensionAndSource() {
        val aJson = extA.src(JSON)
        aJson.search("c1")
        val a = cookieOf(aJson.search("c2"))
        assertNotEquals("A/json keeps its cookie", "cookie:-", a)
        assertEquals("A/html (other source, same host) does not see A/json's cookie", "cookie:-", cookieOf(extA.src(HTML).search("h1")))
        val bJson = extB.src(JSON)
        assertEquals("B/json (same source id, other extension) does not see A's cookie", "cookie:-", cookieOf(bJson.search("b1")))
        val b = cookieOf(bJson.search("b2"))
        assertNotEquals("cookie:-", b)
        assertNotEquals(a, b)
    }

    // ═══════════════ 9. privileged headers ═══════════════

    @Test fun t10_privilegedHeadersAreRejectedBeforeTheWire() {
        assertEquals("PRIVILEGED_HEADER", gatewayCode { extA.src(JSON).search("privileged") })
        assertEquals(0, seenCount { it.headers.containsKey("x-mangahive-token") })
    }

    // ═══════════════ 10-12. details / chapters / pages ═══════════════

    @Test fun t11_details() {
        val d = JSONObject(extA.src(JSON).detailsJson(ctx(), "/m/1", """{"k":"v"}"""))
        assertEquals("Manga /m/1", d.getString("title"))
        assertEquals("Au", d.getString("author"))
        assertEquals(JSONArray(listOf("Action", "Comedy")).toString(), d.getJSONArray("genres").toString())
        assertEquals(2, d.getInt("status"))
        assertEquals("v", d.getJSONObject("memo").getString("k"))
        assertEquals(JSON, d.getJSONObject("memo").getString("fetchedBy"))
        val h = JSONObject(extA.src(HTML).detailsJson(ctx(), "/h/1"))
        assertEquals("HTML Manga", h.getString("title"))
        assertEquals(JSONArray(listOf("Drama", "Mystery")).toString(), h.getJSONArray("genres").toString())
    }

    @Test fun t12_chapters() {
        val c = JSONObject(extA.src(JSON).chaptersJson(ctx(), "/m/1")).getJSONArray("chapters")
        assertEquals(2, c.length())
        assertEquals("/c/2", c.getJSONObject(0).getString("url"))
        assertEquals(2.0, c.getJSONObject(0).getDouble("number"), 0.0)
        assertEquals(1700000100000L, c.getJSONObject(0).getLong("dateUpload"))
        val h = JSONObject(extA.src(HTML).chaptersJson(ctx(), "/h/1")).getJSONArray("chapters")
        assertEquals("/hc/1", h.getJSONObject(0).getString("url"))
        assertEquals("Chapter 1", h.getJSONObject(0).getString("name"))
    }

    @Test fun t13_pages() {
        val p = JSONObject(extA.src(JSON).pagesJson(ctx(), "/c/1")).getJSONArray("pages")
        assertEquals(2, p.length())
        assertEquals("https://localhost:$port/i/1.jpg", p.getJSONObject(1).getString("imageUrl"))
        val h = JSONObject(extA.src(HTML).pagesJson(ctx(), "/hc/1")).getJSONArray("pages")
        assertEquals(3, h.length())
        assertEquals("https://localhost:$port/i/c.jpg", h.getJSONObject(2).getString("imageUrl"))
    }

    @Test fun t14_awaitSuccessMapsHttpErrors() {
        assertEquals("http-error:500:HTTP error 500", firstTitle(extA.src(JSON).search("httperror")))
    }

    // ═══════════════ 13-14. timeout / cancellation / size ═══════════════

    @Test fun t15_readTimeoutIsTimeout() {
        val t0 = System.nanoTime()
        assertEquals("TIMEOUT", gatewayCode { extA.src(JSON).search("slow") })
        assertTrue("bounded by the 1 s read timeout, not the 5 s server delay", TimeUnit.NANOSECONDS.toMillis(System.nanoTime() - t0) < 4_500)
    }

    @Test fun t16_userCancellationIsCancelledAndReleasesTheSlot() {
        hangArrivals.drainPermits()
        val c = ctx()
        val result = AtomicReference<String>()
        val th = Thread { result.set(gatewayCode { extA.src(JSON).search("hang", c) }) }.apply { start() }
        assertTrue(hangArrivals.tryAcquire(10, TimeUnit.SECONDS))
        val t0 = System.nanoTime()
        c.cancel.cancel(CancelScope.Reason.CANCELLED)
        th.join(5_000)
        assertEquals("CANCELLED", result.get())
        assertTrue(TimeUnit.NANOSECONDS.toMillis(System.nanoTime() - t0) < 3_000)
        assertTrue("no in-flight call left", waitUntil(2_000) { engine.governor().activeCalls("mh.ext.a") == 0 })
    }

    @Test fun t17_sourceSideCoroutineCancellationCancelsTheBrokeredCall() {
        assertEquals("self-cancelled", firstTitle(extA.src(JSON).search("selfcancel")))
        assertTrue(waitUntil(2_000) { engine.governor().activeCalls("mh.ext.a") == 0 })
    }

    @Test fun t18_oversizedResponse() {
        assertEquals("RESPONSE_TOO_LARGE", gatewayCode { extA.src(JSON).search("big") })
    }

    @Test fun t19_rateLimit() {
        val src = ResourceGovernor.Limits(8, 8, 0.001, 1, 0, 60_000, 120_000, 16L shl 20)
        val gov = ResourceGovernor(ResourceGovernor.Limits.EXTENSION_DEFAULT, src, ResourceGovernor.Limits.DOWNLOAD_DEFAULT) { System.nanoTime() }
        val g = instantiate(newBundle(), "mh.ext.rate", engine(gov)).src(JSON)
        assertEquals("Result r1", firstTitle(g.search("r1")))
        assertEquals("RATE_LIMITED", gatewayCode { g.search("r2") })
    }

    @Test fun t20_concurrencyLimit() {
        val src = ResourceGovernor.Limits(1, 8, 1_000.0, 1_000, 0, 60_000, 120_000, 16L shl 20)
        val gov = ResourceGovernor(ResourceGovernor.Limits.EXTENSION_DEFAULT, src, ResourceGovernor.Limits.DOWNLOAD_DEFAULT) { System.nanoTime() }
        val g = instantiate(newBundle(), "mh.ext.conc", engine(gov)).src(JSON)
        hangArrivals.drainPermits()
        val c = ctx()
        val th = Thread { gatewayCode { g.search("hang", c) } }.apply { start() }
        assertTrue(hangArrivals.tryAcquire(10, TimeUnit.SECONDS))
        assertEquals("CONCURRENCY_LIMIT", gatewayCode { g.search("second") })
        c.cancel.cancel(CancelScope.Reason.CANCELLED)
        th.join(5_000)
    }

    // ═══════════════ 15. cross-extension isolation (also t06, t09) ═══════════════

    @Test fun t21_extensionsShareNoClientOrState() {
        val a = sourceOf(extA.src(JSON))
        val b = sourceOf(extB.src(JSON))
        val clientA = a.javaClass.getMethod("getClient").invoke(a)
        val clientB = b.javaClass.getMethod("getClient").invoke(b)
        assertNotEquals("each extension's construction-time client is its own", clientA, clientB)
        assertSame("same class definition source (one bundle), different loaders", a.javaClass.superclass, b.javaClass.superclass)
        assertNotEquals(a.javaClass.classLoader, b.javaClass.classLoader)
    }

    // ═══════════════ optional: public internet (MH_LIVE_HTTPS=1) ═══════════════

    @Test fun t22_liveHttpsThroughProductionPolicy() {
        assumeTrue("set MH_LIVE_HTTPS=1 to run", System.getProperty("mh.live", "").isNotEmpty())
        val live = BrokerEngine(DestinationPolicy.production(), PinnedSocketTransport(SSLContext.getDefault()),
            CookieStore(null, CookieStore.Clock { System.currentTimeMillis() }), BrokerEngine.Limits())
        val g = instantiate(newBundle(), "mh.ext.live", live).src(JSON)
        assertEquals("live:200", firstTitle(g.search("live:https://example.com/")))
        assertNotEquals("loopback stays blocked by the production policy", "none", gatewayCode { g.search("live:https://localhost:$port/") })
    }
}
