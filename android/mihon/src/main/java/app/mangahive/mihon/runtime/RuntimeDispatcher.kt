package app.mangahive.mihon.runtime

import app.mangahive.mihon.spi.RequestContext
import app.mangahive.mihon.ipc.contract.ErrorCode
import app.mangahive.mihon.ipc.contract.IpcError
import app.mangahive.mihon.ipc.contract.Payload
import app.mangahive.mihon.ipc.contract.RuntimeRequest
import app.mangahive.mihon.ipc.contract.RuntimeResponse
import app.mangahive.mihon.net.ActiveJobs
import app.mangahive.mihon.spi.BrokerException
import app.mangahive.mihon.spi.CancelScope
import java.util.concurrent.ExecutorService
import java.util.concurrent.Future
import java.util.concurrent.RejectedExecutionException

fun interface Replier { fun send(response: RuntimeResponse) }

/**
 * Runtime-side scheduling on the real job registry ([ActiveJobs]: requestId -> Job). The request id is the one the web
 * layer minted and the IPC carried; nothing here makes another. Health/cancel run at once on the binder thread; everything
 * else runs on a bounded pool.
 *
 * Exactly one reply per request, decided by the job's compare-and-set terminal state: the worker replies if it completes
 * first; otherwise whoever aborted it (a cancel request, the deadline, runtime shutdown) replies CANCELLED / TIMEOUT. Abort is
 * real: it cancels the job's [CancelScope] (sockets and body streams of every HTTP call made for this request are closed on
 * the aborting thread), cancels the pool Future and interrupts the worker. Whatever the end - success, failure, cancel,
 * timeout - the job leaves the registry, its deadline timer is cancelled and its extension job slot is returned.
 */
class RuntimeDispatcher(
    private val handler: (RuntimeRequest, CancelToken) -> RuntimeResponse,
    private val workers: ExecutorService,
    private val jobs: ActiveJobs,
    private val deadlineMs: Long = 90_000,
    private val deadlineFor: (RuntimeRequest) -> Long = { deadlineMs },
) {
    fun inFlightCount(): Int = jobs.size()
    val registry: ActiveJobs get() = jobs

    fun submit(request: RuntimeRequest, replier: Replier) {
        when (request) {
            is RuntimeRequest.Cancel -> {
                // aborts the target (its own abort listener sends the target's CANCELLED reply); then ack this request
                jobs.cancel(request.targetRequestId)
                safeSend(replier, RuntimeResponse.Success(request.requestId, request.op, Payload.Ack))
            }
            is RuntimeRequest.Health -> safeSend(replier, runHandler(request, CancelToken(RequestContext(request.requestId, CancelScope.root()))))
            else -> enqueue(request, replier)
        }
    }

    private fun enqueue(request: RuntimeRequest, replier: Replier) {
        val job = try {
            jobs.open(request.requestId, request.extensionIdOrNull, deadlineFor(request).coerceAtLeast(1_000L)) { j, reason ->
                safeSend(replier, failure(request, if (reason == CancelScope.Reason.TIMEOUT) ErrorCode.TIMEOUT else ErrorCode.CANCELLED, null))
            }
        } catch (e: BrokerException) {
            safeSend(replier, failure(request, if (e.code == "CONCURRENCY_LIMIT") ErrorCode.BUSY else ErrorCode.BAD_REQUEST, if (e.code == "DUPLICATE_ID") "DUPLICATE_ID" else null))
            return
        }
        try {
            val future: Future<*> = workers.submit(Runnable { run(job, request, replier) })
            job.setRunner { future.cancel(true) }
        } catch (_: RejectedExecutionException) {
            if (job.tryComplete()) safeSend(replier, failure(request, ErrorCode.BUSY, null))
            job.workerExited()
        }
    }

    private fun run(job: ActiveJobs.Job, request: RuntimeRequest, replier: Replier) {
        job.bindThread()
        try {
            val response = runHandler(request, CancelToken(job.ctx))
            if (job.tryComplete()) safeSend(replier, response) // lost the race => the aborter already replied
        } finally {
            job.workerExited()
        }
    }

    private fun runHandler(request: RuntimeRequest, token: CancelToken): RuntimeResponse = try {
        handler(request, token)
    } catch (e: VirtualMachineError) {
        throw e
    } catch (_: Throwable) {
        failure(request, ErrorCode.INTERNAL, null)
    }

    private fun safeSend(replier: Replier, response: RuntimeResponse) {
        try { replier.send(response) } catch (_: Exception) { /* peer gone */ }
    }

    private fun failure(r: RuntimeRequest, code: ErrorCode, detail: String?) =
        RuntimeResponse.Failure(r.requestId, r.op, IpcError(code, detail))
}
