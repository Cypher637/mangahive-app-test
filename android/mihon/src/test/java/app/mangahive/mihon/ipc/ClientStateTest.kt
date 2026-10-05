package app.mangahive.mihon.ipc

import app.mangahive.mihon.ipc.contract.ErrorCode
import app.mangahive.mihon.ipc.contract.Op
import app.mangahive.mihon.ipc.contract.RuntimeRequest
import app.mangahive.mihon.ipc.contract.RuntimeResponse
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test
import app.mangahive.mihon.ipc.ExtensionHealthTracker.Health

class ClientStateTest {
    private val ext = "eu.kanade.tachiyomi.extension.all.mhfixture"

    @Test fun runtimeDeathFailsEveryInFlightRequestCleanly() {
        val p = PendingRequests()
        val a = p.register(RuntimeRequest.Search("a", ext, 1L, "q", 1))
        val b = p.register(RuntimeRequest.Health("b"))
        val failed = p.failAll(ErrorCode.RUNTIME_DIED)
        assertEquals(2, failed.size)
        assertEquals(0, p.size())
        val ra = a.future.get() as RuntimeResponse.Failure
        assertEquals(ErrorCode.RUNTIME_DIED, ra.error.code); assertTrue(ra.error.retryable)
        assertEquals(Op.HEALTH, (b.future.get() as RuntimeResponse.Failure).op)
    }

    @Test fun staleAndMismatchedAnswersAreDropped() {
        val p = PendingRequests()
        assertNull(p.complete(RuntimeResponse.Failure("ghost", null, app.mangahive.mihon.ipc.contract.IpcError(ErrorCode.INTERNAL))))
        val e = p.register(RuntimeRequest.Search("a", ext, 1L, "q", 1))
        p.complete(RuntimeResponse.Success("a", Op.HEALTH, app.mangahive.mihon.ipc.contract.Payload.Ack))
        assertEquals("OP_MISMATCH", (e.future.get() as RuntimeResponse.Failure).error.detail)
    }

    @Test fun duplicateRequestIdIsRefused() {
        val p = PendingRequests()
        p.register(RuntimeRequest.Health("x"))
        try { p.register(RuntimeRequest.Health("x")); throw AssertionError("expected IllegalStateException") } catch (_: IllegalStateException) {}
    }

    @Test fun repeatedCrashesQuarantineOnlyTheCulprit() {
        val t = ExtensionHealthTracker(crashThreshold = 3)
        val bad = "a.bad.ext"; val good = "a.good.ext"
        t.noteExtension(good); t.onSuccess(good)
        repeat(2) { t.onRuntimeDied(setOf(bad)); t.onRuntimeUp() }
        assertTrue(t.mayDispatch(bad))
        assertEquals(Health.UNKNOWN, t.healthOf(good))   // back to unknown after restart, not failed
        t.onRuntimeDied(setOf(bad))
        assertFalse(t.mayDispatch(bad)); assertEquals(Health.QUARANTINED, t.healthOf(bad))
        assertTrue(t.mayDispatch(good))
        t.release(bad)
        assertTrue(t.mayDispatch(bad))
    }

    @Test fun deathMarksKnownExtensionsUnavailableUntilRuntimeIsBack() {
        val t = ExtensionHealthTracker()
        t.noteExtension("a.b.c"); t.onSuccess("a.b.c"); assertEquals(Health.HEALTHY, t.healthOf("a.b.c"))
        t.onRuntimeDied(emptySet()); assertEquals(Health.RUNTIME_UNAVAILABLE, t.healthOf("a.b.c"))
        t.onRuntimeUp(); assertEquals(Health.UNKNOWN, t.healthOf("a.b.c"))
    }

    @Test fun restartPolicyBacksOffACrashLoop() {
        val r = RestartPolicy(maxDeaths = 3, windowMs = 1000, cooldownMs = 5000)
        r.recordDeath(0); r.recordDeath(100); assertTrue(r.mayStart(200))
        r.recordDeath(300); assertFalse(r.mayStart(400)); assertTrue(r.mayStart(5400))
    }
}
