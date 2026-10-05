package app.mangahive.mihon.bridge

import android.content.Context
import android.webkit.JavascriptInterface
import android.webkit.WebView
import app.mangahive.mihon.ipc.MihonServiceClient
import app.mangahive.mihon.ipc.contract.ErrorCode
import app.mangahive.mihon.ipc.contract.IpcLimits
import app.mangahive.mihon.ipc.contract.Op
import app.mangahive.mihon.ipc.contract.RuntimeRequest
import org.json.JSONObject
import java.util.UUID
import java.util.concurrent.ArrayBlockingQueue
import java.util.concurrent.ThreadPoolExecutor
import java.util.concurrent.TimeUnit

/**
 * The WebView-facing bridge (registered as `MangaHiveNative`). Main process only.
 *
 * Stage 6: cancellation has to be able to OVERTAKE the call it cancels, so the call path is split in two:
 *  - [mihonStart] validates, starts the request on a bridge thread and returns immediately with the request id; the result is
 *    pushed to `window.__mihonResult(requestId, json)` when it is ready;
 *  - [mihonCancel] sends the runtime a `cancel` for that SAME id right away (it never waits behind the call it cancels).
 * The id is the web layer's; nothing here mints a second one (see [WebRequestParser]).
 * [mihonInvoke] (blocking) stays for callers that do not need cancellation.
 */
class MihonJsBridge(context: Context, private val web: WebView? = null) {
    private val client = MihonServiceClient(context.applicationContext)

    // bounded: a page that spams requests gets BUSY, not unbounded threads
    private val pool = ThreadPoolExecutor(4, 8, 30, TimeUnit.SECONDS, ArrayBlockingQueue(32)) { r -> Thread(r, "mihon-bridge").apply { isDaemon = true } }

    @JavascriptInterface
    fun mihonInvoke(op: String, payloadJson: String): String = execute(op.take(32), payloadJson)

    /** @return `{"accepted":true,"requestId":...}` or the usual failure envelope; the result arrives via __mihonResult. */
    @JavascriptInterface
    fun mihonStart(op: String, payloadJson: String): String {
        val opText = op.take(32)
        val parsed = WebRequestParser.parse(opText, payloadJson)
        if (parsed is WebRequestParser.Parsed.Rejected) {
            return WebResponseMapper.failure(parsed.webRequestId, opText, if (parsed.op == null) ErrorCode.UNKNOWN_OP else parsed.code)
        }
        val ok = parsed as WebRequestParser.Parsed.Ok
        val id = ok.webRequestId
        try {
            pool.execute {
                val json = execute(opText, payloadJson)
                deliver(id, json)
            }
        } catch (_: java.util.concurrent.RejectedExecutionException) {
            return WebResponseMapper.failure(id, opText, ErrorCode.BUSY)
        }
        return JSONObject().put("accepted", true).put("requestId", id).toString()
    }

    /** Immediate. Does not queue behind [mihonStart]'s worker threads. */
    @JavascriptInterface
    fun mihonCancel(requestId: String): String {
        if (!IpcLimits.REQUEST_ID.matches(requestId)) return JSONObject().put("cancelled", false).toString()
        Thread({ client.call(RuntimeRequest.Cancel("c-" + UUID.randomUUID(), requestId), 10_000L) }, "mihon-cancel").apply { isDaemon = true }.start()
        return JSONObject().put("cancelled", true).put("requestId", requestId).toString()
    }

    private fun execute(opText: String, payloadJson: String): String =
        when (val parsed = WebRequestParser.parse(opText, payloadJson)) {
            is WebRequestParser.Parsed.Rejected ->
                WebResponseMapper.failure(parsed.webRequestId, opText, if (parsed.op == null) ErrorCode.UNKNOWN_OP else parsed.code)
            is WebRequestParser.Parsed.Ok -> {
                val response = client.call(parsed.request, timeoutFor(parsed.request))
                val host = if (parsed.request is RuntimeRequest.Health) {
                    WebResponseMapper.hostJson(client.status(), client.health.snapshot())
                } else null
                WebResponseMapper.toJson(parsed.webRequestId, parsed.request.op.wire, response, host)
            }
        }

    private fun deliver(requestId: String, json: String) {
        val w = web ?: return
        // id matches [A-Za-z0-9_.-] and json is the bridge's own JSON: quote it as a JS string literal anyway
        val js = "window.__mihonResult&&window.__mihonResult(" + JSONObject.quote(requestId) + "," + JSONObject.quote(json) + ")"
        w.post { w.evaluateJavascript(js, null) }
    }

    private fun timeoutFor(r: RuntimeRequest): Long = when (r.op) {
        Op.INSTALL -> 120_000L
        Op.DOWNLOAD -> 20L * 60L * 1000L
        Op.HEALTH, Op.CANCEL, Op.INSPECT, Op.DISABLE, Op.UNINSTALL, Op.DELETE_DOWNLOAD -> 15_000L
        else -> MihonServiceClient.DEFAULT_TIMEOUT_MS
    }
}
