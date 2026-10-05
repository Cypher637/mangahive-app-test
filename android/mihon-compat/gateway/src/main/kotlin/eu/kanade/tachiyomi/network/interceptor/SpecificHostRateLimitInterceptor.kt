package eu.kanade.tachiyomi.network.interceptor

import okhttp3.HttpUrl
import okhttp3.OkHttpClient
import java.util.concurrent.TimeUnit

@Suppress("UnusedReceiverParameter")
@Deprecated(
    message = "Default rate limiting implementation is no longer provided. Source developers are now " +
        "responsible for implementing their own rate limiting logic if desired",
    replaceWith = ReplaceWith("this"),
)
fun OkHttpClient.Builder.rateLimitHost(
    httpUrl: HttpUrl,
    permits: Int,
    period: Long = 1,
    unit: TimeUnit = TimeUnit.SECONDS,
): OkHttpClient.Builder = addInterceptor(RateLimitInterceptor(httpUrl.host, permits, unit.toMillis(period)))
