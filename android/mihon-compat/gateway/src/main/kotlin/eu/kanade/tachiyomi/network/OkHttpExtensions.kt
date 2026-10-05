@file:Suppress("Unused")

package eu.kanade.tachiyomi.network

import kotlinx.coroutines.suspendCancellableCoroutine
import okhttp3.Call
import okhttp3.Callback
import okhttp3.Response
import rx.Observable
import rx.Producer
import rx.Subscription
import java.io.IOException
import java.util.concurrent.atomic.AtomicBoolean
import kotlin.coroutines.resume
import kotlin.coroutines.resumeWithException

@Deprecated("Use suspend APIs instead")
fun Call.asObservable(): Observable<Response> = Observable.unsafeCreate { subscriber ->
    // Call is one-shot: clone per subscriber.
    val call = clone()
    val arbiter = object : Producer, Subscription {
        private val started = AtomicBoolean(false)

        override fun request(n: Long) {
            if (n == 0L || !started.compareAndSet(false, true)) return
            try {
                val response = call.execute()
                if (!subscriber.isUnsubscribed) {
                    subscriber.onNext(response)
                    subscriber.onCompleted()
                } else {
                    response.close()
                }
            } catch (e: Exception) {
                if (!subscriber.isUnsubscribed) subscriber.onError(e)
            }
        }

        override fun unsubscribe() = call.cancel()

        override fun isUnsubscribed(): Boolean = call.isCanceled()
    }
    subscriber.add(arbiter)
    subscriber.setProducer(arbiter)
}

@Deprecated("Use suspend APIs instead")
fun Call.asObservableSuccess(): Observable<Response> {
    @Suppress("DEPRECATION")
    return asObservable().doOnNext { response ->
        if (!response.isSuccessful) {
            response.close()
            throw HttpException(response.code)
        }
    }
}

/** Enqueues the call; coroutine cancellation cancels the OkHttp Call (which cancels the brokered request's scope). */
suspend fun Call.await(): Response {
    val callStack = Exception().stackTrace.run { copyOfRange(1, size) }
    return awaitInternal(callStack)
}

suspend fun Call.awaitSuccess(): Response {
    val callStack = Exception().stackTrace.run { copyOfRange(1, size) }
    val response = awaitInternal(callStack)
    if (!response.isSuccessful) {
        response.close()
        throw HttpException(response.code).apply { stackTrace = callStack }
    }
    return response
}

private suspend fun Call.awaitInternal(callStack: Array<StackTraceElement>): Response =
    suspendCancellableCoroutine { continuation ->
        continuation.invokeOnCancellation {
            try {
                cancel()
            } catch (_: Throwable) {
            }
        }
        enqueue(
            object : Callback {
                override fun onFailure(call: Call, e: IOException) {
                    if (continuation.isCancelled) return
                    continuation.resumeWithException(IOException(e.message, e).apply { stackTrace = callStack })
                }

                override fun onResponse(call: Call, response: Response) {
                    continuation.resume(response) { _, value, _ -> value.close() }
                }
            },
        )
    }
