package app.mangahive.mihon.ipc

import app.mangahive.mihon.ipc.contract.ErrorCode
import app.mangahive.mihon.ipc.contract.IpcError
import app.mangahive.mihon.ipc.contract.RuntimeRequest
import app.mangahive.mihon.ipc.contract.RuntimeResponse
import java.util.concurrent.CompletableFuture
import java.util.concurrent.ConcurrentHashMap

/** Main-process table of requests sent to the runtime and not yet answered. Pure JVM; unit-testable. */
class PendingRequests {
    class Entry(val request: RuntimeRequest, val future: CompletableFuture<RuntimeResponse>) {
        val requestId: String get() = request.requestId
        val extensionId: String? get() = request.extensionIdOrNull
    }

    private val map = ConcurrentHashMap<String, Entry>()

    /** @throws IllegalStateException when [request] reuses the id of an in-flight request. */
    fun register(request: RuntimeRequest): Entry {
        val e = Entry(request, CompletableFuture())
        check(map.putIfAbsent(request.requestId, e) == null) { "duplicate request id" }
        return e
    }

    /** Completes the waiter. An answer for an unknown (timed-out, cancelled, pre-crash) id is dropped. */
    fun complete(response: RuntimeResponse): Entry? {
        val e = map.remove(response.requestId) ?: return null
        val safe = if (response.op != null && response.op != e.request.op) {
            RuntimeResponse.Failure(e.requestId, e.request.op, IpcError(ErrorCode.INTERNAL, "OP_MISMATCH"))
        } else response
        e.future.complete(safe)
        return e
    }

    fun discard(requestId: String): Entry? = map.remove(requestId)

    /** Fails every waiter with [code]. Used when the runtime process dies. Returns what was in flight. */
    fun failAll(code: ErrorCode): List<Entry> {
        val out = ArrayList<Entry>()
        for (id in map.keys.toList()) {
            val e = map.remove(id) ?: continue
            e.future.complete(RuntimeResponse.Failure(e.requestId, e.request.op, IpcError(code)))
            out += e
        }
        return out
    }

    fun size(): Int = map.size
}
