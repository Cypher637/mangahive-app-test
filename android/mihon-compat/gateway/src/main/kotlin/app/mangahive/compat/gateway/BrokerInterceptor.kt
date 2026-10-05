@file:OptIn(okhttp3.internal.OkHttpInternalApi::class) // RealCall.client: which client (and so which interceptors) made the call

package app.mangahive.compat.gateway

import app.mangahive.mihon.spi.BrokerRequest
import app.mangahive.mihon.spi.BrokerResponse
import app.mangahive.mihon.spi.BrokerException
import app.mangahive.mihon.spi.CancelScope
import app.mangahive.mihon.spi.RequestContext
import app.mangahive.mihon.spi.HttpBroker
import okhttp3.Authenticator
import okhttp3.Cache
import okhttp3.Call
import okhttp3.CertificatePinner
import okhttp3.Connection
import okhttp3.ConnectionPool
import okhttp3.CookieJar
import okhttp3.Dns
import okhttp3.Dispatcher
import okhttp3.EventListener
import okhttp3.Headers
import okhttp3.Interceptor
import okhttp3.MediaType.Companion.toMediaTypeOrNull
import okhttp3.OkHttpClient
import okhttp3.Protocol
import okhttp3.Request
import okhttp3.Response
import okhttp3.ResponseBody.Companion.asResponseBody
import okhttp3.internal.connection.RealCall
import okio.Buffer
import okio.buffer
import okio.source
import java.net.Proxy
import java.net.ProxySelector
import java.util.concurrent.ConcurrentHashMap
import javax.net.SocketFactory
import javax.net.ssl.HostnameVerifier
import javax.net.ssl.SSLSocketFactory
import javax.net.ssl.X509TrustManager
import java.util.concurrent.TimeUnit

/**
 * TERMINAL OkHttp interceptor. It never hands the request to OkHttp's own network stages (retry/bridge/cache/connect): the
 * request is translated to the JDK-typed [BrokerRequest] and handed to the identity-bound [HttpBroker]. Nothing the Source
 * configures on its client (sockets, proxies, DNS, SSL factories, cookie jar, cache, network interceptors) reaches the network.
 *
 * Application interceptors the extension appends with `client.newBuilder().addInterceptor(..)` (header injection, the 1.6
 * `rateLimit`, response rewriting) sit AFTER this interceptor in OkHttp's list; OkHttp would never reach them. This interceptor
 * therefore runs them itself, in order, in a [BrokerChain] whose end is the broker, so upstream interceptor semantics hold
 * and every request they produce still terminates here. Network interceptors never run (there is no network stage).
 *
 * Preserved HTTP semantics: method, URL, header order and repeats, request body + content type, status, reason phrase,
 * protocol, response headers (repeats), content type/length, streaming body, redirect chain as priorResponse, final URL,
 * timeouts (chain timeouts), cancellation (Call.cancel() and the request's scope both abort the socket), failures as IOException (BrokerException is one).
 */
internal class BrokerInterceptor(
    private val broker: HttpBroker,
    private val followRedirects: Boolean,
    private val calls: CallScopes,
) : Interceptor {

    override fun intercept(chain: Interceptor.Chain): Response {
        // The incoming OkHttp chain is never advanced: OkHttp's retry/bridge/cache/connect stages are unreachable from here.
        val after = extensionInterceptorsAfterBroker(chain.call())
        return BrokerChain(chain, after, 0, chain.request(), chain.connectTimeoutMillis(), chain.readTimeoutMillis(), chain.writeTimeoutMillis())
            .dispatch(chain.request())
    }

    /** The application interceptors listed after the (first) broker interceptor of the client that made [call]. */
    private fun extensionInterceptorsAfterBroker(call: Call): List<Interceptor> {
        val client = (call as? RealCall)?.client ?: return emptyList()
        val list = client.interceptors
        val i = list.indexOfFirst { it is BrokerInterceptor }
        if (i < 0) return emptyList()
        return list.subList(i + 1, list.size).filter { it !is BrokerInterceptor }
    }

    private inner class BrokerChain(
        private val outer: Interceptor.Chain,
        private val interceptors: List<Interceptor>,
        private val index: Int,
        private val request: Request,
        private val connectMs: Int,
        private val readMs: Int,
        private val writeMs: Int,
    ) : Interceptor.Chain by outer {
        private var proceeded = false

        override fun request(): Request = request
        override fun connection(): Connection? = null
        override fun connectTimeoutMillis(): Int = connectMs
        override fun readTimeoutMillis(): Int = readMs
        override fun writeTimeoutMillis(): Int = writeMs
        override fun withConnectTimeout(timeout: Int, unit: TimeUnit): Interceptor.Chain = copy(connect = ms(timeout, unit))
        override fun withReadTimeout(timeout: Int, unit: TimeUnit): Interceptor.Chain = copy(read = ms(timeout, unit))
        override fun withWriteTimeout(timeout: Int, unit: TimeUnit): Interceptor.Chain = copy(write = ms(timeout, unit))

        // Transport settings are host-owned: per-call overrides of DNS, sockets, proxies, TLS, cookies, cache or pooling
        // are accepted for API compatibility and have no effect on the brokered request.
        override fun withDns(dns: Dns): Interceptor.Chain = this
        override fun withSocketFactory(socketFactory: SocketFactory): Interceptor.Chain = this
        override fun withRetryOnConnectionFailure(retryOnConnectionFailure: Boolean): Interceptor.Chain = this
        override fun withAuthenticator(authenticator: Authenticator): Interceptor.Chain = this
        override fun withCookieJar(cookieJar: CookieJar): Interceptor.Chain = this
        override fun withCache(cache: Cache?): Interceptor.Chain = this
        override fun withProxy(proxy: Proxy?): Interceptor.Chain = this
        override fun withProxySelector(proxySelector: ProxySelector): Interceptor.Chain = this
        override fun withProxyAuthenticator(proxyAuthenticator: Authenticator): Interceptor.Chain = this
        override fun withSslSocketFactory(sslSocketFactory: SSLSocketFactory?, x509TrustManager: X509TrustManager?): Interceptor.Chain = this
        override fun withHostnameVerifier(hostnameVerifier: HostnameVerifier): Interceptor.Chain = this
        override fun withCertificatePinner(certificatePinner: CertificatePinner): Interceptor.Chain = this
        override fun withConnectionPool(connectionPool: ConnectionPool): Interceptor.Chain = this

        private fun copy(connect: Int = connectMs, read: Int = readMs, write: Int = writeMs) =
            BrokerChain(outer, interceptors, index, request, connect, read, write)

        /** Called by the extension's interceptors. Ends at [toBroker], never at the outer OkHttp chain. */
        override fun proceed(request: Request): Response {
            check(!proceeded) { "interceptor ${interceptors.getOrNull(index - 1)} must call proceed() exactly once" }
            proceeded = true
            return dispatch(request)
        }

        fun dispatch(request: Request): Response {
            if (index < interceptors.size) {
                val next = BrokerChain(outer, interceptors, index + 1, request, connectMs, readMs, writeMs)
                return interceptors[index].intercept(next)
            }
            return toBroker(request, outer.call(), connectMs, readMs)
        }
    }

    private fun toBroker(request: Request, call: Call, connectMs: Int, readMs: Int): Response {
        // The request this HTTP call belongs to (id + cancel scope), set by the gateway for the Source call being served.
        // Not current => refuse: an unattributed request could not be cancelled.
        val hostCall = RequestScope.current() ?: throw BrokerException("NO_REQUEST_CONTEXT", "HTTP call outside a request")
        val parent = hostCall.request
        if (parent.cancel.isCancelled) throw parent.cancel.asException()
        // One scope per OkHttp call: Call.cancel() (the Source's own) cancels it. The listener is attached to the CALL, so an
        // extension replacing the client's EventListener cannot detach cancellation.
        val scope = parent.cancel.child()
        calls.bind(call, scope)
        call.addEventListener(calls)
        val ctx = RequestContext(parent.requestId, scope)

        var bodyBytes: ByteArray? = null
        var bodyType: String? = null
        val body = request.body
        if (body != null) {
            val buf = Buffer()
            body.writeTo(buf)
            bodyBytes = buf.readByteArray()
            bodyType = body.contentType()?.toString()
        } else if (request.method == "POST" || request.method == "PUT" || request.method == "PATCH") {
            bodyBytes = ByteArray(0)
        }

        val h = ArrayList<Array<String>>(request.headers.size)
        for (i in 0 until request.headers.size) {
            val name = request.headers.name(i)
            if (name.equals("Content-Type", true) && bodyType != null) continue // carried separately
            h.add(arrayOf(name, request.headers.value(i)))
        }

        val callMs = call.timeout().timeoutNanos().let { if (it == 0L) 0 else TimeUnit.NANOSECONDS.toMillis(it).toInt() }
        val br = BrokerRequest(request.method, request.url.toString(), h, bodyBytes, bodyType, followRedirects, connectMs, readMs, callMs)
        val resp = try { broker.execute(br, ctx) } catch (t: Throwable) { calls.unbind(call); scope.close(); throw t }
        if (call.isCanceled()) scope.cancel(CancelScope.Reason.CANCELLED)
        return toOkHttp(request, resp)
    }

    private fun ms(timeout: Int, unit: TimeUnit): Int = unit.toMillis(timeout.toLong()).coerceIn(0, Int.MAX_VALUE.toLong()).toInt()

    private fun toOkHttp(original: Request, r: BrokerResponse): Response {
        val protocol = when (r.protocol) { "h2" -> Protocol.HTTP_2; "http/1.0" -> Protocol.HTTP_1_0; else -> Protocol.HTTP_1_1 }

        fun headersOf(list: List<Array<String>>): Headers {
            val b = Headers.Builder()
            for (e in list) b.addUnsafeNonAscii(e[0], e[1])
            return b.build()
        }

        // Earlier redirect hops become priorResponse links (bodies already discarded by the broker).
        var prior: Response? = null
        for (hop in r.priorHops) {
            // Hop requests are descriptive only (their bodies were already sent); a bodyless GET/HEAD carrier is enough.
            val hopReq = Request.Builder().url(hop.url).method(if (hop.method == "HEAD") "HEAD" else "GET", null).build()
            prior = Response.Builder().request(hopReq).protocol(protocol).code(hop.status).message(hop.message)
                .headers(headersOf(hop.headers)).priorResponse(prior).sentRequestAtMillis(r.sentAtMillis).receivedResponseAtMillis(r.receivedAtMillis)
                .body(Buffer().asResponseBody(null, 0)).build()
        }

        val finalRequest = if (r.finalUrl == original.url.toString() && r.finalMethod == original.method) original
        else Request.Builder().url(r.finalUrl).method(r.finalMethod, null).build()

        val src = r.body().source().buffer()
        return Response.Builder()
            .request(finalRequest).protocol(protocol).code(r.status).message(r.message)
            .headers(headersOf(r.headers)).priorResponse(prior)
            .sentRequestAtMillis(r.sentAtMillis).receivedResponseAtMillis(r.receivedAtMillis)
            .body(src.asResponseBody(r.contentType?.toMediaTypeOrNull(), r.contentLength))
            .build()
    }
}

/** OkHttp Call -> its CancelScope, so a Source's own Call.cancel() aborts the brokered connection. Entries leave on call end/failure. */
internal class CallScopes : EventListener() {
    private val map = ConcurrentHashMap<Call, CancelScope>()
    fun bind(call: Call, scope: CancelScope) { map[call] = scope; if (call.isCanceled()) scope.cancel(CancelScope.Reason.CANCELLED) }
    override fun canceled(call: Call) { map[call]?.cancel(CancelScope.Reason.CANCELLED) }
    override fun callEnd(call: Call) { map.remove(call) }
    override fun callFailed(call: Call, ioe: java.io.IOException) { map.remove(call)?.close() }
    fun unbind(call: Call) { map.remove(call) }
    fun size(): Int = map.size
}

/**
 * Builds the ONLY client a Source of this bundle is given: terminal broker interceptor, no cookie jar, no cache, no proxy.
 * One client per EXTENSION (extensionId fixed by the host when it hands the client out); the source id and request id come
 * from the host's per-call scope at request time, via [HostIdentityScope.ScopedBroker]. Extensions' `newBuilder()` copies keep
 * the terminal interceptor. A copy whose interceptors were CLEARED would fall through to OkHttp's own stack: DNS and socket
 * creation are denied on this client so that copy fails closed instead of opening a direct connection.
 */
internal object BrokerClients {
    fun forExtension(extensionId: String, host: app.mangahive.mihon.spi.HttpBrokerHost): OkHttpClient =
        forBroker(app.mangahive.mihon.spi.HostIdentityScope.ScopedBroker(extensionId, host))

    fun forBroker(broker: HttpBroker): OkHttpClient {
        val calls = CallScopes()
        return OkHttpClient.Builder()
            .followRedirects(true)
            .followSslRedirects(true)
            .dispatcher(Dispatcher(RequestScope.wrap(RequestScope.newPool())))   // async calls keep the submitter's request
            .proxy(Proxy.NO_PROXY)
            .dns(DenyDirectNetwork)
            .socketFactory(DenyDirectNetwork.sockets)
            .addInterceptor(BrokerInterceptor(broker, followRedirects = true, calls = calls))
            .build()
    }
}

/** Direct DNS/sockets for a brokered client: always refused (only reachable if an extension strips the broker interceptor). */
internal object DenyDirectNetwork : Dns {
    private fun refuse(): Nothing = throw java.net.UnknownHostException("MangaHive: direct network access is disabled; requests must go through the broker")
    override fun lookup(hostname: String): List<java.net.InetAddress> = refuse()

    val sockets: SocketFactory = object : SocketFactory() {
        override fun createSocket(): java.net.Socket = throw java.net.SocketException("MangaHive: direct sockets are disabled")
        override fun createSocket(host: String?, port: Int): java.net.Socket = createSocket()
        override fun createSocket(host: String?, port: Int, localHost: java.net.InetAddress?, localPort: Int): java.net.Socket = createSocket()
        override fun createSocket(host: java.net.InetAddress?, port: Int): java.net.Socket = createSocket()
        override fun createSocket(address: java.net.InetAddress?, port: Int, localAddress: java.net.InetAddress?, localPort: Int): java.net.Socket = createSocket()
    }
}
