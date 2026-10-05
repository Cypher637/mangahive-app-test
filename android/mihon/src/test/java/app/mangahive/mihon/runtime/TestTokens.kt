package app.mangahive.mihon.runtime

import app.mangahive.mihon.spi.CancelScope
import app.mangahive.mihon.spi.RequestContext
import java.util.concurrent.atomic.AtomicInteger

private val seq = AtomicInteger()

/** Tests only: production code never invents a request id (the web layer's id is the id). */
fun CancelToken(): CancelToken = CancelToken(RequestContext("test-" + seq.incrementAndGet(), CancelScope.root()))
