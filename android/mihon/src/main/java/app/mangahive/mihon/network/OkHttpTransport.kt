package app.mangahive.mihon.network

import app.mangahive.mihon.net.Transport
import okhttp3.Dns
import okhttp3.Headers.Companion.headersOf
import okhttp3.MediaType.Companion.toMediaTypeOrNull
import okhttp3.OkHttpClient
import okhttp3.Protocol
import okhttp3.Request
import okhttp3.RequestBody.Companion.toRequestBody
import app.mangahive.mihon.spi.Registration
import java.io.IOException
import java.util.concurrent.atomic.AtomicBoolean
import java.net.InetAddress
import java.net.Proxy
import java.util.concurrent.TimeUnit

/**
 * SecureHttpClient's wire: the production [Transport]. The ONLY OkHttp client in the runtime that touches a socket.
 * It does exactly what the Transport contract demands and nothing else:
 *  - connects only to the addresses DestinationPolicy validated (per-call Dns that returns that list, never the system resolver),
 *  - no redirects (incl. https->http), no cookie jar, no transparent decompression (the engine sets Accept-Encoding itself,
 *    which switches OkHttp's own gzip handling off), no proxy (system/PAC proxies would move the connect target off the pinned IP),
 *  - no automatic retries on another route (a retry could re-dial a different address),
 *  - TLS verified by OkHttp against the URL HOST NAME with the platform trust store.
 * Built on the host's OkHttp 4.12 (the compat bundle's OkHttp 5 never touches a socket).
 */
class OkHttpTransport(
    private val base: OkHttpClient = OkHttpClient.Builder().build(),
) : Transport {

    override fun execute(r: Transport.Request): Transport.Response {
        val pinned = r.addresses
        val client = base.newBuilder()
            .dns(object : Dns { override fun lookup(hostname: String): List<InetAddress> = pinned })
            .proxy(Proxy.NO_PROXY)
            .followRedirects(false)
            .followSslRedirects(false)
            .retryOnConnectionFailure(false)
            .cookieJar(okhttp3.CookieJar.NO_COOKIES)
            .connectTimeout(r.connectTimeoutMs.toLong(), TimeUnit.MILLISECONDS)
            .readTimeout(r.readTimeoutMs.toLong(), TimeUnit.MILLISECONDS)
            .writeTimeout(r.readTimeoutMs.toLong(), TimeUnit.MILLISECONDS)
            .callTimeout(0, TimeUnit.MILLISECONDS) // the engine owns the overall deadline
            .build()

        val b = Request.Builder().url(r.url.toString())
        for (h in r.headers) b.addHeader(h[0], h[1])
        val ct = r.headers.firstOrNull { it[0].equals("Content-Type", true) }?.get(1)
        val body = when {
            r.body != null -> r.body.toRequestBody(ct?.toMediaTypeOrNull())
            r.method == "POST" || r.method == "PUT" || r.method == "PATCH" -> ByteArray(0).toRequestBody(null)
            else -> null
        }
        b.method(r.method, body)

        b.tag(String::class.java, r.requestId)
        val call = client.newCall(b.build())
        // Cancel (and the engine's timeout, which cancels the same scope) must interrupt a thread blocked in connect/read:
        // Call.cancel() closes the socket from the cancelling thread. Registered before the first byte is sent.
        val hook: Registration = r.cancel.onCancel { call.cancel() }
        if (r.cancel.isCancelled) { hook.close(); throw IOException("cancelled") }
        val resp = try { call.execute() } catch (t: Throwable) { hook.close(); throw t }
        val out = ArrayList<Array<String>>(resp.headers.size)
        for (i in 0 until resp.headers.size) out.add(arrayOf(resp.headers.name(i), resp.headers.value(i)))
        val proto = when (resp.protocol) { Protocol.HTTP_2 -> "h2"; Protocol.HTTP_1_0 -> "http/1.0"; else -> "http/1.1" }
        val released = AtomicBoolean(false)
        return Transport.Response(
            resp.code, resp.message, proto, out, resp.body!!.byteStream(),
            /* abort */ { call.cancel() },                      // tears the connection down; the rest of the body is NOT drained
            /* onClosed */ { if (released.compareAndSet(false, true)) { hook.close(); try { resp.close() } catch (_: Exception) {} } },
        )
    }
}
