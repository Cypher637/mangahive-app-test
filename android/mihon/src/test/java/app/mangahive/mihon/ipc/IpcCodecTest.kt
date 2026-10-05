package app.mangahive.mihon.ipc

import app.mangahive.mihon.ipc.contract.*
import app.mangahive.mihon.ipc.contract.IpcCodec.Decoded
import org.json.JSONObject
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

class IpcCodecTest {
    private val ext = "eu.kanade.tachiyomi.extension.all.mhfixture"

    private fun rejected(raw: String): ErrorCode = (IpcCodec.decodeRequest(raw) as Decoded.Rejected).code
    private fun req(op: String, args: String, v: Int = 1, extra: String = "") =
        """{"v":$v,"id":"r1","op":"$op","args":$args$extra}"""

    @Test fun everyRequestTypeRoundTrips() {
        val all: List<RuntimeRequest> = listOf(
            RuntimeRequest.Install("a", "https://x.example/e.apk", "a".repeat(64), ext, null),
            RuntimeRequest.Inspect("a", ext), RuntimeRequest.Enable("a", ext), RuntimeRequest.Disable("a", ext),
            RuntimeRequest.Uninstall("a", ext), RuntimeRequest.ListSources("a", null), RuntimeRequest.ListSources("a", ext),
            RuntimeRequest.Search("a", ext, 42L, "hive", 1), RuntimeRequest.Details("a", ext, 42L, "/m/1"),
            RuntimeRequest.Chapters("a", ext, -7L, "/m/1"), RuntimeRequest.Pages("a", ext, 42L, "/c/1"),
            RuntimeRequest.Cancel("a", "b"), RuntimeRequest.Health("a"),
        )
        assertEquals(Op.values().toSet(), all.map { it.op }.toSet())
        for (r in all) assertEquals(r, (IpcCodec.decodeRequest(IpcCodec.encodeRequest(r)) as Decoded.Ok).value)
    }

    @Test fun rejectsAnythingOutsideTheAllowlist() {
        assertEquals(ErrorCode.UNKNOWN_OP, rejected(req("execute", "{}")))
        assertEquals(ErrorCode.UNKNOWN_OP, rejected(req("invoke", """{"className":"a.B","methodName":"c"}""")))
        assertEquals(ErrorCode.BAD_REQUEST, rejected(req("inspect", """{"extensionId":"$ext","className":"a.B"}""")))   // unknown arg key
        assertEquals(ErrorCode.BAD_REQUEST, rejected(req("health", "{}", extra = ""","debug":true""")))                   // unknown top-level key
        assertEquals(ErrorCode.UNSUPPORTED_VERSION, rejected(req("health", "{}", v = 2)))
    }

    @Test fun rejectsWrongTypesAndBounds() {
        assertEquals(ErrorCode.BAD_REQUEST, rejected(req("search", """{"extensionId":"$ext","sourceId":"42","query":"q","page":1}""")))   // sourceId must be a number
        assertEquals(ErrorCode.BAD_REQUEST, rejected(req("search", """{"extensionId":"$ext","sourceId":42,"query":"q","page":0}""")))
        assertEquals(ErrorCode.BAD_REQUEST, rejected(req("search", """{"extensionId":"$ext","sourceId":42,"query":"${"q".repeat(513)}","page":1}""")))
        assertEquals(ErrorCode.BAD_REQUEST, rejected(req("inspect", """{"extensionId":"../../etc/passwd"}""")))
        assertEquals(ErrorCode.BAD_REQUEST, rejected(req("install", """{"apkUrl":"https://x/e.apk","expectedSha256":"nothex"}""")))
        assertEquals(ErrorCode.BAD_REQUEST, rejected("not json"))
        assertEquals(ErrorCode.BAD_REQUEST, rejected("x".repeat(IpcLimits.MAX_REQUEST_CHARS + 1)))
    }

    @Test fun failureNeverCarriesFreeText() {
        val wire = IpcCodec.encodeResponse(RuntimeResponse.Failure("r1", Op.SEARCH, IpcError(ErrorCode.SOURCE_ERROR, "java.lang.NullPointerException at x.Y")))
        val err = JSONObject(wire).getJSONObject("error")
        assertEquals("SOURCE_ERROR", err.getString("code"))
        assertFalse("a non-token detail must be dropped", err.has("detail"))
        assertFalse(wire.contains("NullPointer"))
    }

    @Test fun responsesRoundTripAndAreBounded() {
        val sr = RuntimeResponse.Success("r1", Op.SEARCH, Payload.SearchPage(listOf(MangaDto("/m/1", "Hive", null)), true))
        assertEquals(sr, (IpcCodec.decodeResponse(IpcCodec.encodeResponse(sr)) as Decoded.Ok).value)
        val h = RuntimeResponse.Success("r2", Op.HEALTH, Payload.Health(RuntimeHealth(1, 99, "app:mihon", 5L, false, 0, listOf(ExtensionHealthDto(ext, ExtensionState.LOADED)))))
        assertEquals(h, (IpcCodec.decodeResponse(IpcCodec.encodeResponse(h)) as Decoded.Ok).value)
        // a hostile runtime sending an unknown field or an oversized list is rejected, not truncated silently
        val hostile = """{"v":1,"id":"r1","op":"search","ok":true,"data":{"type":"search","hasNextPage":false,"items":[],"stack":"boom"}}"""
        assertTrue(IpcCodec.decodeResponse(hostile) is Decoded.Rejected)
        val many = (1..101).joinToString(",") { """{"remoteId":"/m/$it","title":"t","coverUrl":null}""" }
        assertTrue(IpcCodec.decodeResponse("""{"v":1,"id":"r1","op":"search","ok":true,"data":{"type":"search","hasNextPage":false,"items":[$many]}}""") is Decoded.Rejected)
    }

    @Test fun encoderCapsListsSoItsOwnOutputAlwaysDecodes() {
        val big = RuntimeResponse.Success("r1", Op.PAGES, Payload.Pages((1..900).map { PageDto(it, "https://x/$it", null) }))
        val back = (IpcCodec.decodeResponse(IpcCodec.encodeResponse(big)) as Decoded.Ok).value as RuntimeResponse.Success
        assertEquals(IpcLimits.MAX_PAGES, (back.payload as Payload.Pages).pages.size)
    }
}
