package app.mangahive.mihon.runtime

import app.mangahive.mihon.ipc.contract.ErrorCode
import app.mangahive.mihon.net.ActiveJobs
import app.mangahive.mihon.net.Deadlines
import app.mangahive.mihon.net.ResourceGovernor
import app.mangahive.mihon.ipc.contract.IpcError
import app.mangahive.mihon.ipc.contract.Payload
import app.mangahive.mihon.ipc.contract.RuntimeRequest
import app.mangahive.mihon.ipc.contract.RuntimeResponse
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test
import java.util.concurrent.ArrayBlockingQueue
import java.util.concurrent.CountDownLatch
import java.util.concurrent.LinkedBlockingQueue
import java.util.concurrent.ThreadPoolExecutor
import java.util.concurrent.TimeUnit

class RuntimeDispatcherTest {
    private val ext = "eu.kanade.tachiyomi.extension.all.mhfixture"
    private val pool = ThreadPoolExecutor(1, 1, 1, TimeUnit.SECONDS, ArrayBlockingQueue(1), ThreadPoolExecutor.AbortPolicy())
    private val jobs = ActiveJobs(ResourceGovernor(), Deadlines.shared())
    private val replies = LinkedBlockingQueue<RuntimeResponse>()
    private val sink = Replier { replies.add(it) }
    @After fun tearDown() { pool.shutdownNow() }

    private fun search(id: String) = RuntimeRequest.Search(id, ext, 1L, "q", 1)

    @Test fun cancelIsNotQueuedBehindTheCallItCancels() {
        val started = CountDownLatch(1)
        val d = RuntimeDispatcher({ r, token ->
            started.countDown()
            try { Thread.sleep(30_000) } catch (_: InterruptedException) {}
            RuntimeResponse.Success(r.requestId, r.op, Payload.Ack)
        }, pool, jobs)
        d.submit(search("slow"), sink)
        assertTrue(started.await(2, TimeUnit.SECONDS))
        d.submit(RuntimeRequest.Cancel("c1", "slow"), sink)
        val first = replies.poll(2, TimeUnit.SECONDS)!!; val second = replies.poll(2, TimeUnit.SECONDS)!!
        val byId = listOf(first, second).associateBy { it.requestId }
        assertEquals(ErrorCode.CANCELLED, (byId.getValue("slow") as RuntimeResponse.Failure).error.code)
        assertTrue(byId.getValue("c1") is RuntimeResponse.Success)
        assertEquals(0, d.inFlightCount())
    }

    @Test fun exactlyOneReplyPerRequestEvenIfAbortedAndFinished() {
        val d = RuntimeDispatcher({ r, _ -> RuntimeResponse.Success(r.requestId, r.op, Payload.Ack) }, pool, jobs)
        d.submit(search("a"), sink)
        assertEquals("a", replies.poll(2, TimeUnit.SECONDS)!!.requestId)
        d.submit(RuntimeRequest.Cancel("c", "a"), sink)       // already finished: Ack only
        assertEquals("c", replies.poll(2, TimeUnit.SECONDS)!!.requestId)
        assertTrue(replies.poll(200, TimeUnit.MILLISECONDS) == null)
    }

    @Test fun saturatedPoolAnswersBusyAndDuplicateIdsAreRefused() {
        val gate = CountDownLatch(1)
        val d = RuntimeDispatcher({ r, _ -> gate.await(5, TimeUnit.SECONDS); RuntimeResponse.Success(r.requestId, r.op, Payload.Ack) }, pool, jobs)
        d.submit(search("1"), sink); d.submit(search("2"), sink)   // 1 running, 2 queued
        d.submit(search("3"), sink)
        val busy = replies.poll(2, TimeUnit.SECONDS) as RuntimeResponse.Failure
        assertEquals(ErrorCode.BUSY, busy.error.code)
        d.submit(search("1"), sink)
        assertEquals("DUPLICATE_ID", (replies.poll(2, TimeUnit.SECONDS) as RuntimeResponse.Failure).error.detail)
        gate.countDown()
    }

    @Test fun aThrowingHandlerBecomesInternalWithoutDetail() {
        val d = RuntimeDispatcher({ _, _ -> throw IllegalStateException("secret stack info") }, pool, jobs)
        d.submit(search("x"), sink)
        val f = replies.poll(2, TimeUnit.SECONDS) as RuntimeResponse.Failure
        assertEquals(IpcError(ErrorCode.INTERNAL), f.error)
    }

    @Test fun cancelInterruptsTheScopeAndLeavesNoStaleJob() {
        val started = CountDownLatch(1); val sawCancel = CountDownLatch(1)
        val d = RuntimeDispatcher({ r, token ->
            // like a blocked socket read: the scope's abort hook fires from the cancelling thread, not by polling
            token.ctx.cancel.onCancel { sawCancel.countDown() }
            started.countDown()
            try { Thread.sleep(30_000) } catch (_: InterruptedException) {}
            RuntimeResponse.Success(r.requestId, r.op, Payload.Ack)
        }, pool, jobs)
        d.submit(search("w-1"), sink)
        assertTrue(started.await(2, TimeUnit.SECONDS))
        assertEquals(1, d.inFlightCount())
        d.submit(RuntimeRequest.Cancel("c9", "w-1"), sink)
        assertTrue(sawCancel.await(2, TimeUnit.SECONDS))
        replies.poll(2, TimeUnit.SECONDS); replies.poll(2, TimeUnit.SECONDS)
        assertEquals(0, d.inFlightCount())
        assertTrue(awaitIdle())
        assertEquals(0, jobs.rootHooks())
    }

    @Test fun deadlineCancelsTheWorkAndRepliesTimeout() {
        val interrupted = CountDownLatch(1)
        val d = RuntimeDispatcher({ r, _ ->
            try { Thread.sleep(30_000) } catch (_: InterruptedException) { interrupted.countDown() }
            RuntimeResponse.Success(r.requestId, r.op, Payload.Ack)
        }, pool, jobs, deadlineMs = 200)
        d.submit(search("t-1"), sink)
        val f = replies.poll(3, TimeUnit.SECONDS) as RuntimeResponse.Failure
        assertEquals(ErrorCode.TIMEOUT, f.error.code)
        assertTrue(interrupted.await(2, TimeUnit.SECONDS))   // the worker really was interrupted
        assertTrue(awaitIdle())
        assertTrue(replies.poll(200, TimeUnit.MILLISECONDS) == null) // and no second reply
    }

    @Test fun perExtensionJobCapAnswersBusy() {
        val gate = CountDownLatch(1)
        val gov = ResourceGovernor(
            ResourceGovernor.Limits(8, 1, 100.0, 100, 0, 60_000, 120_000, 1L shl 20),
            ResourceGovernor.Limits.SOURCE_DEFAULT, ResourceGovernor.Limits.DOWNLOAD_DEFAULT, ResourceGovernor.Clock { System.nanoTime() })
        val local = ActiveJobs(gov, Deadlines.shared())
        val big = ThreadPoolExecutor(4, 4, 1, TimeUnit.SECONDS, ArrayBlockingQueue(4), ThreadPoolExecutor.AbortPolicy())
        val d = RuntimeDispatcher({ r, _ -> gate.await(5, TimeUnit.SECONDS); RuntimeResponse.Success(r.requestId, r.op, Payload.Ack) }, big, local)
        d.submit(search("j1"), sink); d.submit(search("j2"), sink)
        assertEquals(ErrorCode.BUSY, (replies.poll(2, TimeUnit.SECONDS) as RuntimeResponse.Failure).error.code)
        gate.countDown(); replies.poll(2, TimeUnit.SECONDS)
        big.shutdownNow()
    }

    private fun awaitIdle(): Boolean {
        val end = System.nanoTime() + 3_000_000_000L
        while (System.nanoTime() < end) { if (jobs.size() == 0 && jobs.liveWorkers() == 0) return true; Thread.sleep(10) }
        return false
    }
}
