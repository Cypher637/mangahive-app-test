package app.mangahive.mihon.bridge

import app.mangahive.mihon.ipc.contract.ErrorCode
import app.mangahive.mihon.ipc.contract.IpcLimits
import app.mangahive.mihon.ipc.contract.Op
import app.mangahive.mihon.ipc.contract.RuntimeRequest
import org.json.JSONException
import org.json.JSONObject
import java.util.UUID

/**
 * Turns the WebView's {op, payload-JSON} into a typed [RuntimeRequest]. This is the only place web input is
 * interpreted. It is a closed `when` over [Op]: an operation that is not in [Op] cannot become a request, and no
 * field of the payload is ever used as a class name, method name or file path.
 *
 * The web layer's historical field names are kept (packageId, remoteId, ...) and mapped to contract fields.
 * Fields the contract does not define are ignored, never forwarded.
 */
object WebRequestParser {
    const val MAX_PAYLOAD_CHARS = 64 * 1024

    sealed class Parsed {
        class Ok(val request: RuntimeRequest, val webRequestId: String) : Parsed()
        class Rejected(val webRequestId: String, val op: Op?, val code: ErrorCode) : Parsed()
    }

    private class Bad : RuntimeException()

    fun parse(opName: String, payloadJson: String): Parsed {
        val op = Op.fromWire(opName) ?: return Parsed.Rejected("none", null, ErrorCode.UNKNOWN_OP)
        if (payloadJson.length > MAX_PAYLOAD_CHARS) return Parsed.Rejected("none", op, ErrorCode.BAD_REQUEST)
        val p = try { if (payloadJson.isBlank()) JSONObject() else JSONObject(payloadJson) } catch (_: JSONException) {
            return Parsed.Rejected("none", op, ErrorCode.BAD_REQUEST)
        }
        // ONE request id for the whole path. The web layer's id IS the wire id, the runtime job id, the Source call's id and
        // the id on every HTTP call. This parser is the top of the native side: it mints an id only when the web layer sent
        // none at all. A malformed id is refused, never silently replaced by a different one.
        val rawId = p.opt("requestId")
        if (rawId != null && rawId != JSONObject.NULL && (rawId !is String || !IpcLimits.REQUEST_ID.matches(rawId))) {
            return Parsed.Rejected("none", op, ErrorCode.BAD_REQUEST)
        }
        val webId = rawId as? String
        val id = webId ?: ("m-" + UUID.randomUUID().toString())
        return try {
            Parsed.Ok(build(op, id, p), webId ?: id)
        } catch (_: Bad) {
            Parsed.Rejected(webId ?: id, op, ErrorCode.BAD_REQUEST)
        }
    }

    private fun build(op: Op, id: String, p: JSONObject): RuntimeRequest = when (op) {
        Op.INSTALL -> RuntimeRequest.Install(
            id, str(p, "apkUrl")!!, str(p, "expectedSha256", false), str(p, "packageId", false), str(p, "expectedCertSha256", false),
        )
        Op.INSPECT -> RuntimeRequest.Inspect(id, str(p, "packageId")!!)
        Op.ENABLE -> RuntimeRequest.Enable(id, str(p, "packageId")!!)
        Op.DISABLE -> RuntimeRequest.Disable(id, str(p, "packageId")!!)
        Op.UNINSTALL -> RuntimeRequest.Uninstall(id, str(p, "packageId")!!)
        Op.LIST_SOURCES -> RuntimeRequest.ListSources(id, str(p, "packageId", false))
        Op.SEARCH -> RuntimeRequest.Search(id, str(p, "packageId")!!, sourceId(p), str(p, "query", false) ?: "", int(p, "page", 1))
        Op.DETAILS -> RuntimeRequest.Details(id, str(p, "packageId")!!, sourceId(p), str(p, "remoteId")!!)
        Op.CHAPTERS -> RuntimeRequest.Chapters(id, str(p, "packageId")!!, sourceId(p), str(p, "remoteId")!!)
        Op.PAGES -> RuntimeRequest.Pages(id, str(p, "packageId")!!, sourceId(p), str(p, "chapterRemoteId")!!)
        Op.DOWNLOAD -> {
            val maxStorageBytes = (p.opt("maxStorageBytes") as? Number)?.toLong() ?: 0L
            val cleanupAfterDays = (p.opt("cleanupAfterDays") as? Number)?.toInt() ?: 0
            if (maxStorageBytes != 0L && (maxStorageBytes < 64L * 1024L * 1024L || maxStorageBytes > IpcLimits.MAX_OFFLINE_STORAGE_BYTES)) throw Bad()
            if (cleanupAfterDays < 0 || cleanupAfterDays > IpcLimits.MAX_CLEANUP_DAYS) throw Bad()
            RuntimeRequest.Download(
                id, str(p, "canonicalMangaId")!!, str(p, "canonicalChapterId")!!,
                str(p, "extensionId", false) ?: str(p, "packageId")!!, sourceId(p),
                str(p, "mangaRemoteId")!!, str(p, "chapterRemoteId")!!, maxStorageBytes, cleanupAfterDays,
            )
        }
        Op.DELETE_DOWNLOAD -> RuntimeRequest.DeleteDownload(
            id, str(p, "canonicalMangaId")!!, str(p, "canonicalChapterId")!!,
            str(p, "extensionId", false) ?: str(p, "packageId")!!, sourceId(p), str(p, "remoteChapterId", false) ?: str(p, "chapterRemoteId")!!,
        )
        Op.CANCEL -> RuntimeRequest.Cancel(id, str(p, "targetRequestId")!!)
        Op.HEALTH -> RuntimeRequest.Health(id)
    }

    private fun str(p: JSONObject, k: String, required: Boolean = true): String? {
        if (!p.has(k) || p.isNull(k)) { if (required) throw Bad(); return null }
        val v = p.get(k)
        if (v !is String || v.length > 4096) throw Bad()
        return v.takeIf { it.isNotEmpty() } ?: if (required) throw Bad() else null
    }

    private fun int(p: JSONObject, k: String, default: Int): Int {
        if (!p.has(k) || p.isNull(k)) return default
        val v = p.get(k)
        if (v !is Int) throw Bad()
        return v
    }

    /** Accepts a decimal Long source id or a full `mihon:<extension>:<id>` key (the id part is used). */
    private fun sourceId(p: JSONObject): Long {
        val raw = p.opt("sourceId")
        val text = when (raw) {
            is Int -> raw.toString()
            is Long -> raw.toString()
            is String -> raw
            else -> throw Bad()
        }
        val tail = if (text.startsWith("mihon:")) text.substringAfterLast(':') else text
        if (!Regex("-?[0-9]{1,19}").matches(tail)) throw Bad()
        return tail.toLongOrNull() ?: throw Bad()
    }
}
