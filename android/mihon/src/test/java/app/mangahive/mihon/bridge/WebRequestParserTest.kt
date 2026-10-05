package app.mangahive.mihon.bridge

import app.mangahive.mihon.ipc.contract.ErrorCode
import app.mangahive.mihon.ipc.contract.RuntimeRequest
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test

class WebRequestParserTest {
    private val ext = "eu.kanade.tachiyomi.extension.all.mhfixture"

    @Test fun onlyTheTwelveContractOperationsParse() {
        for (op in listOf("execute", "invoke", "discover", "listInstalled", "eval", "loadClass", "")) {
            val r = WebRequestParser.parse(op, "{}") as WebRequestParser.Parsed.Rejected
            assertEquals(op, ErrorCode.UNKNOWN_OP, r.code)
        }
    }

    @Test fun payloadFieldsNamingClassesOrMethodsAreIgnoredNotForwarded() {
        val p = WebRequestParser.parse("search", """{"requestId":"web-1-abc","packageId":"$ext","sourceId":"42","query":"hive","className":"java.lang.Runtime","methodName":"exec","page":2}""")
        val ok = p as WebRequestParser.Parsed.Ok
        assertEquals(RuntimeRequest.Search("web-1-abc", ext, 42L, "hive", 2), ok.request)
    }

    @Test fun acceptsFullSourceKeyAndRejectsGarbage() {
        val ok = WebRequestParser.parse("details", """{"packageId":"$ext","sourceId":"mihon:$ext:77","remoteId":"/m/1"}""") as WebRequestParser.Parsed.Ok
        assertEquals(77L, (ok.request as RuntimeRequest.Details).sourceId)
        assertTrue(WebRequestParser.parse("details", """{"packageId":"$ext","sourceId":"../x","remoteId":"/m/1"}""") is WebRequestParser.Parsed.Rejected)
        assertTrue(WebRequestParser.parse("search", "[not an object") is WebRequestParser.Parsed.Rejected)
        assertTrue(WebRequestParser.parse("pages", """{"packageId":$ext}""") is WebRequestParser.Parsed.Rejected)
    }

    @Test fun theWebRequestIdIsTheWireIdAndMalformedIdsAreRefusedNotReplaced() {
        val ok = WebRequestParser.parse("search", """{"requestId":"web-1767-k3j9","packageId":"$ext","sourceId":"1","query":"q"}""") as WebRequestParser.Parsed.Ok
        assertEquals("web-1767-k3j9", ok.request.requestId)
        assertEquals("web-1767-k3j9", ok.webRequestId)
        val bad = WebRequestParser.parse("search", """{"requestId":"has space","packageId":"$ext","sourceId":"1","query":"q"}""")
        assertTrue(bad is WebRequestParser.Parsed.Rejected)
        val none = WebRequestParser.parse("search", """{"packageId":"$ext","sourceId":"1","query":"q"}""") as WebRequestParser.Parsed.Ok
        assertEquals(none.request.requestId, none.webRequestId) // minted once, at the top, and reported back unchanged
    }
}
