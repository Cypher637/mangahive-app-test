package app.mangahive.mihon

import app.mangahive.mihon.net.NetSelfTest
import org.junit.Assert.assertEquals
import org.junit.Test

/** Runs the Stage 5 network-core harness (policy, SSRF, DNS pinning, redirects, cookies, headers, real TLS). */
class NetworkBrokerTest {
    @Test fun networkBrokerHarnessHasNoFailures() {
        assertEquals("failed checks in NetSelfTest", 0, NetSelfTest.runAll())
    }
}
