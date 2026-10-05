package app.mangahive.compat.gateway

import kotlinx.coroutines.suspendCancellableCoroutine
import rx.Observable
import rx.Subscriber
import kotlin.coroutines.resume
import kotlin.coroutines.resumeWithException

/**
 * Awaits the single value of a 1.x Observable (CatalogueSource/HttpSource suspend defaults over the deprecated Rx API).
 * Subscribes on the calling coroutine's thread, so the host identity installed by RequestScope is current while the
 * Observable runs its (synchronous) OkHttp call; coroutine cancellation unsubscribes, which cancels that call.
 */
internal suspend fun <T> Observable<T>.awaitSingle(): T = suspendCancellableCoroutine { cont ->
    val subscriber = object : Subscriber<T>() {
        private var value: Any? = NONE

        override fun onStart() = request(1)

        override fun onNext(t: T) {
            if (value !== NONE) {
                unsubscribe()
                if (cont.isActive) cont.resumeWithException(IllegalArgumentException("Observable emitted more than one value"))
                return
            }
            value = t
        }

        override fun onCompleted() {
            if (!cont.isActive) return
            val v = value
            if (v === NONE) {
                cont.resumeWithException(NoSuchElementException("Observable completed without a value"))
            } else {
                @Suppress("UNCHECKED_CAST")
                cont.resume(v as T)
            }
        }

        override fun onError(e: Throwable) {
            if (cont.isActive) cont.resumeWithException(e)
        }
    }
    cont.invokeOnCancellation { subscriber.unsubscribe() }
    subscribe(subscriber)
}

private object NONE
