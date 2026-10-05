package app.mangahive.mihon.ipc

import android.content.ComponentName
import android.content.Context
import android.content.Intent
import android.content.ServiceConnection
import android.os.Binder
import android.os.IBinder
import android.os.Process
import android.os.RemoteException
import app.mangahive.mihon.ipc.contract.ErrorCode
import app.mangahive.mihon.ipc.contract.IpcCodec
import app.mangahive.mihon.ipc.contract.IpcError
import app.mangahive.mihon.ipc.contract.RUNTIME_SERVICE_CLASS
import app.mangahive.mihon.ipc.contract.RuntimeRequest
import app.mangahive.mihon.ipc.contract.RuntimeResponse
import java.util.UUID
import java.util.concurrent.ExecutionException
import java.util.concurrent.Executors
import java.util.concurrent.TimeUnit
import java.util.concurrent.TimeoutException
import java.util.concurrent.locks.ReentrantLock
import kotlin.concurrent.withLock

/**
 * MAIN-PROCESS client of the :mihon runtime.
 *
 * Security/structure rules (enforced by mihon_stage4_isolation_test.js):
 *  - imports nothing from loader / runtime / apk / network packages and no reflection or ClassLoader API;
 *  - the service is addressed by class-name STRING, so no runtime class is linked into this process path;
 *  - the only thing sent is an [IpcCodec]-encoded [RuntimeRequest]; the only thing accepted back is an
 *    [IpcCodec]-decoded [RuntimeResponse] (the runtime hosts third-party code, so replies are untrusted input).
 *
 * Failure model: if the runtime process dies, every waiting call is completed with RUNTIME_DIED, the health tracker is
 * updated, and the next call transparently re-binds (Android re-creates the service process on bind).
 */
class MihonServiceClient(
    context: Context,
    val health: ExtensionHealthTracker = ExtensionHealthTracker(),
    private val restartPolicy: RestartPolicy = RestartPolicy(),
    private val clock: () -> Long = { System.currentTimeMillis() },
) {
    data class HostStatus(val connected: Boolean, val deaths: Int, val lastDeathAtMs: Long, val pending: Int)

    private val appContext = context.applicationContext
    private val pending = PendingRequests()
    private val lock = ReentrantLock()
    private val connectedCond = lock.newCondition()
    private var service: IMihonRuntime? = null
    private var binder: IBinder? = null
    private var bound = false
    private var deaths = 0
    private var lastDeathAt = 0L
    private val housekeeping = Executors.newSingleThreadExecutor { r -> Thread(r, "mihon-client-hk").apply { isDaemon = true } }

    private val deathRecipient = IBinder.DeathRecipient { onRuntimeGone() }

    private val callback = object : IMihonRuntimeCallback.Stub() {
        override fun onResponse(responseJson: String?) {
            if (Binder.getCallingUid() != Process.myUid()) return
            if (responseJson == null) return
            when (val d = IpcCodec.decodeResponse(responseJson)) {
                is IpcCodec.Decoded.Ok -> {
                    val entry = pending.complete(d.value)
                    val ext = entry?.extensionId
                    if (ext != null && d.value is RuntimeResponse.Success) health.onSuccess(ext)
                    if (entry != null && d.value is RuntimeResponse.Success && entry.request is RuntimeRequest.Enable && ext != null) health.release(ext)
                }
                is IpcCodec.Decoded.Rejected -> {
                    // The runtime sent something outside the contract. Fail that one request; never surface its content.
                    val id = d.requestId
                    if (id != null) pending.complete(RuntimeResponse.Failure(id, d.op, IpcError(ErrorCode.INTERNAL, "BAD_RESPONSE")))
                }
            }
        }
    }

    private val conn = object : ServiceConnection {
        override fun onServiceConnected(name: ComponentName?, b: IBinder?) {
            if (b == null) return
            lock.withLock {
                binder = b
                service = IMihonRuntime.Stub.asInterface(b)
                try { b.linkToDeath(deathRecipient, 0) } catch (_: RemoteException) { /* already dead; onRuntimeGone below */ }
                connectedCond.signalAll()
            }
            if (!b.isBinderAlive) { onRuntimeGone(); return }
            housekeeping.execute { pingAfterConnect() }
        }

        override fun onServiceDisconnected(name: ComponentName?) { onRuntimeGone() }

        override fun onBindingDied(name: ComponentName?) {
            onRuntimeGone()
            lock.withLock {
                if (bound) { try { appContext.unbindService(this) } catch (_: Exception) {}; bound = false }
            }
        }

        override fun onNullBinding(name: ComponentName?) {
            onRuntimeGone()
            lock.withLock {
                if (bound) { try { appContext.unbindService(this) } catch (_: Exception) {}; bound = false }
            }
        }
    }

    /** Idempotent: safe to call from the death recipient AND onServiceDisconnected for the same death. */
    private fun onRuntimeGone() {
        var wasUp = false
        lock.withLock {
            wasUp = service != null
            try { binder?.unlinkToDeath(deathRecipient, 0) } catch (_: Exception) {}
            service = null
            binder = null
        }
        val failed = pending.failAll(ErrorCode.RUNTIME_DIED)
        if (wasUp || failed.isNotEmpty()) {
            val now = clock()
            lock.withLock { deaths++; lastDeathAt = now }
            restartPolicy.recordDeath(now)
            health.onRuntimeDied(failed.mapNotNull { it.extensionId }.toSet())
        }
    }

    fun status(): HostStatus = lock.withLock { HostStatus(service != null, deaths, lastDeathAt, pending.size()) }

    fun unbind() {
        lock.withLock {
            if (bound) { try { appContext.unbindService(conn) } catch (_: Exception) {}; bound = false }
            service = null; binder = null
        }
        pending.failAll(ErrorCode.RUNTIME_UNAVAILABLE)
    }

    /** Blocks the calling (non-UI) thread until the runtime answers, the call times out, or the runtime dies. */
    fun call(request: RuntimeRequest, timeoutMs: Long = DEFAULT_TIMEOUT_MS): RuntimeResponse {
        val ext = request.extensionIdOrNull
        if (ext != null) health.noteExtension(ext)
        if (ext != null && request.op.isSourceOp && !health.mayDispatch(ext)) return fail(request, ErrorCode.QUARANTINED)

        // Validate our own output with the same decoder the runtime uses; never send something it would reject.
        val json = IpcCodec.encodeRequest(request)
        if (IpcCodec.decodeRequest(json) !is IpcCodec.Decoded.Ok) return fail(request, ErrorCode.BAD_REQUEST)

        if (request is RuntimeRequest.Cancel) {
            // The waiter disappears immediately; the runtime is told best-effort.
            pending.discard(request.targetRequestId)?.future?.complete(
                RuntimeResponse.Failure(request.targetRequestId, null, IpcError(ErrorCode.CANCELLED)),
            )
        }

        val svc = connect(CONNECT_TIMEOUT_MS) ?: return fail(request, ErrorCode.RUNTIME_UNAVAILABLE)
        val entry = try { pending.register(request) } catch (_: IllegalStateException) { return fail(request, ErrorCode.BAD_REQUEST) }
        try {
            svc.submit(json, callback)
        } catch (_: RemoteException) {
            pending.discard(request.requestId)
            onRuntimeGone()
            return fail(request, ErrorCode.RUNTIME_DIED)
        } catch (_: RuntimeException) { // includes TransactionTooLargeException
            pending.discard(request.requestId)
            return fail(request, ErrorCode.INTERNAL)
        }
        return try {
            entry.future.get(timeoutMs, TimeUnit.MILLISECONDS)
        } catch (_: TimeoutException) {
            pending.discard(request.requestId)
            cancelQuietly(request.requestId)
            fail(request, ErrorCode.TIMEOUT)
        } catch (_: InterruptedException) {
            Thread.currentThread().interrupt()
            pending.discard(request.requestId)
            cancelQuietly(request.requestId)
            fail(request, ErrorCode.CANCELLED)
        } catch (_: ExecutionException) {
            fail(request, ErrorCode.INTERNAL)
        }
    }

    private fun connect(timeoutMs: Long): IMihonRuntime? {
        lock.lock()
        try {
            service?.let { return it }
            if (!restartPolicy.mayStart(clock())) return null
            if (!bound) {
                val i = Intent().setClassName(appContext.packageName, RUNTIME_SERVICE_CLASS)
                bound = appContext.bindService(i, conn, Context.BIND_AUTO_CREATE)
                if (!bound) return null
            }
            var nanos = TimeUnit.MILLISECONDS.toNanos(timeoutMs)
            while (service == null && nanos > 0) nanos = connectedCond.awaitNanos(nanos)
            return service
        } finally {
            lock.unlock()
        }
    }

    private fun cancelQuietly(targetId: String) {
        val svc = lock.withLock { service } ?: return
        try {
            val cancel = RuntimeRequest.Cancel("c-" + UUID.randomUUID().toString(), targetId)
            svc.submit(IpcCodec.encodeRequest(cancel), callback)
        } catch (_: Exception) { /* runtime gone: nothing left to cancel */ }
    }

    private fun pingAfterConnect() {
        val r = call(RuntimeRequest.Health("h-" + UUID.randomUUID().toString()), 5_000)
        if (r is RuntimeResponse.Success) health.onRuntimeUp()
    }

    private fun fail(request: RuntimeRequest, code: ErrorCode): RuntimeResponse =
        RuntimeResponse.Failure(request.requestId, request.op, IpcError(code))

    companion object {
        const val DEFAULT_TIMEOUT_MS = 30_000L
        const val CONNECT_TIMEOUT_MS = 5_000L
    }
}
