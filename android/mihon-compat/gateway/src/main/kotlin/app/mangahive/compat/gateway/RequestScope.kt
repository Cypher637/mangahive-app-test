package app.mangahive.compat.gateway

import app.mangahive.mihon.spi.HostIdentityScope
import app.mangahive.mihon.spi.RequestContext
import kotlinx.coroutines.ThreadContextElement
import java.util.concurrent.Callable
import java.util.concurrent.ExecutorService
import java.util.concurrent.Future
import java.util.concurrent.ThreadFactory
import java.util.concurrent.ThreadPoolExecutor
import java.util.concurrent.TimeUnit
import java.util.concurrent.SynchronousQueue
import kotlin.coroutines.CoroutineContext

/**
 * Which (extension, source, request) a Source's HTTP call belongs to. Since Stage 6.5 this is a thin Kotlin adapter over
 * [HostIdentityScope] (JDK-only, JVM-tested in IdentityScopeSelfTest): the HOST sets extensionId + sourceId + RequestContext
 * for the Source call being served; they follow the Source into coroutines ([element]) and onto OkHttp dispatcher threads
 * ([wrap]). Nothing an extension can set or send contributes to the identity. An HTTP call with no current call is refused.
 *
 * UNCOMPILED (authoring sandbox has no Kotlin toolchain).
 */
internal object RequestScope {
    fun current(): HostIdentityScope.Call? = HostIdentityScope.currentCall()

    inline fun <T> with(call: HostIdentityScope.Call, crossinline block: () -> T): T =
        HostIdentityScope.call(call, Callable { block() })

    /** Coroutine context element: re-installs the call on whichever thread a coroutine resumes on. */
    fun element(call: HostIdentityScope.Call): CoroutineContext = object : ThreadContextElement<HostIdentityScope.Call?> {
        override val key: CoroutineContext.Key<*> = Key
        override fun updateThreadContext(context: CoroutineContext): HostIdentityScope.Call? = HostIdentityScope.enter(call)
        override fun restoreThreadContext(context: CoroutineContext, oldState: HostIdentityScope.Call?) { HostIdentityScope.leave(oldState) }
    }
    private object Key : CoroutineContext.Key<ThreadContextElement<HostIdentityScope.Call?>>

    /** Wraps tasks so they run with the call of the thread that SUBMITTED them (OkHttp Dispatcher.enqueue). */
    fun wrap(delegate: ExecutorService): ExecutorService = object : ExecutorService by delegate {
        private fun <T> bound(f: () -> T): () -> T {
            val c = HostIdentityScope.currentCall()
            return { val p = HostIdentityScope.enter(c); try { f() } finally { HostIdentityScope.leave(p) } }
        }
        override fun execute(command: Runnable) { val b = bound { command.run() }; delegate.execute { b() } }
        override fun <T> submit(task: Callable<T>): Future<T> { val b = bound { task.call() }; return delegate.submit(Callable { b() }) }
        override fun submit(task: Runnable): Future<*> { val b = bound { task.run() }; return delegate.submit { b() } }
    }

    /** OkHttp's default dispatcher pool, daemon threads, bounded idle time. */
    fun newPool(): ExecutorService = ThreadPoolExecutor(0, Int.MAX_VALUE, 60, TimeUnit.SECONDS, SynchronousQueue(),
        ThreadFactory { r -> Thread(r, "mihon-okhttp").apply { isDaemon = true } })
}
