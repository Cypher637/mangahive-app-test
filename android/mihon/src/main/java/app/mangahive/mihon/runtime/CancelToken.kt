package app.mangahive.mihon.runtime

import app.mangahive.mihon.spi.CancelScope
import app.mangahive.mihon.spi.RequestContext

class CancelledException : RuntimeException()

/**
 * The runtime's view of one request: the web layer's request id plus its [CancelScope]. Not a flag: cancelling the scope
 * runs the abort hooks of every HTTP call, connection and body stream opened for this request. [ctx] is what gets passed
 * down to the Source and to the APK downloader.
 */
class CancelToken(val ctx: RequestContext) {
    fun cancel() { ctx.cancel.cancel(CancelScope.Reason.CANCELLED) }
    val isCancelled: Boolean get() = ctx.cancel.isCancelled
    fun throwIfCancelled() { if (ctx.cancel.isCancelled || Thread.currentThread().isInterrupted) throw CancelledException() }
}
