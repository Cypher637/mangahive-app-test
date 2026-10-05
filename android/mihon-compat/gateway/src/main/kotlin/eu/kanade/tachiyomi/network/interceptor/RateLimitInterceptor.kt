package eu.kanade.tachiyomi.network.interceptor

import okhttp3.Interceptor
import okhttp3.OkHttpClient
import okhttp3.Response
import java.io.IOException
import java.util.ArrayDeque
import java.util.concurrent.Semaphore
import java.util.concurrent.TimeUnit

/**
 * Client-side politeness limiter an extension may add. It runs IN FRONT of the terminal broker interceptor (see
 * BrokerInterceptor) and can only delay requests; the broker's own rate/concurrency limits still apply afterwards.
 */
@Suppress("UnusedReceiverParameter")
@Deprecated(
    message = "Default rate limiting implementation is no longer provided. Source developers are now " +
        "responsible for implementing their own rate limiting logic if desired",
    replaceWith = ReplaceWith("this"),
)
fun OkHttpClient.Builder.rateLimit(
    permits: Int,
    period: Long = 1,
    unit: TimeUnit = TimeUnit.SECONDS,
): OkHttpClient.Builder = addInterceptor(RateLimitInterceptor(null, permits, unit.toMillis(period)))

internal class RateLimitInterceptor(
    private val host: String?,
    private val permits: Int,
    private val periodMillis: Long,
) : Interceptor {
    init {
        require(permits > 0) { "permits must be positive" }
        require(periodMillis > 0) { "period must be positive" }
    }

    private val queue = ArrayDeque<Long>(permits)
    private val fairLock = Semaphore(1, true)

    override fun intercept(chain: Interceptor.Chain): Response {
        val call = chain.call()
        if (call.isCanceled()) throw IOException("Canceled")
        val request = chain.request()
        if (host != null && host != request.url.host) return chain.proceed(request)
        try {
            fairLock.acquire()
        } catch (e: InterruptedException) {
            throw IOException(e)
        }
        try {
            synchronized(queue) {
                while (queue.size >= permits) {
                    val periodStart = now() - periodMillis
                    var removed = false
                    while (queue.isNotEmpty() && queue.first() <= periodStart) {
                        queue.removeFirst()
                        removed = true
                    }
                    if (call.isCanceled()) throw IOException("Canceled")
                    if (removed) break
                    try {
                        (queue as Object).wait((queue.first() - periodStart).coerceAtLeast(1))
                    } catch (_: InterruptedException) {
                        throw IOException("Canceled")
                    }
                }
                queue.addLast(now())
            }
        } finally {
            fairLock.release()
        }
        return chain.proceed(request)
    }

    private fun now(): Long = System.nanoTime() / 1_000_000
}
