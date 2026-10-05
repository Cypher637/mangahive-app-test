package app.mangahive.mihon

import app.mangahive.mihon.net.Stage6SelfTest
import org.junit.Assert.assertEquals
import org.junit.Test

/**
 * Stage 6: streaming size limits (declared and chunked), cancellation of a blocked read, call/job timeouts, concurrency and
 * rate limits, stale-job cleanup. Real TLS sockets and a server that stalls, drips and streams forever.
 */
class NetworkStage6Test {
    @Test fun resourceControlHarnessHasNoFailures() {
        assertEquals("failed checks in Stage6SelfTest", 0, Stage6SelfTest.runAll())
    }
}
