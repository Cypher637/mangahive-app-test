package app.mangahive.mihon.bridge

import app.mangahive.mihon.ipc.ExtensionHealthTracker
import app.mangahive.mihon.ipc.MihonServiceClient
import app.mangahive.mihon.ipc.contract.ExtensionInfo
import app.mangahive.mihon.ipc.contract.Payload
import app.mangahive.mihon.ipc.contract.RuntimeResponse
import org.json.JSONArray
import org.json.JSONObject

/**
 * Typed [RuntimeResponse] -> the JSON the web layer already consumes (same envelope and field names as before:
 * apiVersion/requestId/operation/success/data/error, data.results / data.chapters / data.pages).
 * Built field by field from DTOs: there is no generic object serialisation, so nothing the runtime did not put
 * into a DTO field can reach the WebView, and errors carry only a code, a fixed message and a retryable flag.
 */
object WebResponseMapper {
    fun toJson(webRequestId: String, op: String, response: RuntimeResponse, host: JSONObject? = null): String {
        val o = JSONObject().put("apiVersion", "1").put("requestId", webRequestId).put("operation", op)
        when (response) {
            is RuntimeResponse.Failure -> {
                val e = JSONObject().put("code", response.error.code.name).put("message", response.error.message)
                    .put("retryable", response.error.retryable)
                response.error.detail?.let { e.put("detail", it) }
                // Health stays answerable when the runtime is down: the host-side view rides along on the error.
                if (host != null) e.put("host", host)
                o.put("success", false).put("data", JSONObject.NULL).put("error", e)
            }
            is RuntimeResponse.Success -> o.put("success", true).put("data", data(response.payload, host)).put("error", JSONObject.NULL)
        }
        return o.toString()
    }

    fun failure(webRequestId: String, op: String, code: app.mangahive.mihon.ipc.contract.ErrorCode): String =
        toJson(webRequestId, op, RuntimeResponse.Failure(webRequestId, null, app.mangahive.mihon.ipc.contract.IpcError(code)))

    fun hostJson(status: MihonServiceClient.HostStatus, health: Map<String, ExtensionHealthTracker.Health>): JSONObject {
        val ext = JSONObject()
        health.forEach { (id, h) -> ext.put(id, h.name) }
        return JSONObject().put("connected", status.connected).put("runtimeDeaths", status.deaths)
            .put("lastDeathAtMs", status.lastDeathAtMs).put("pending", status.pending).put("extensionHealth", ext)
    }

    private fun data(p: Payload, host: JSONObject?): JSONObject = when (p) {
        Payload.Ack -> JSONObject().put("ok", true)
        is Payload.Extension -> info(p.info)
        is Payload.Sources -> JSONObject().put("sources", JSONArray().also { a ->
            p.sources.forEach { s ->
                a.put(JSONObject().put("key", s.key).put("extensionId", s.extensionId).put("sourceId", s.sourceId).put("name", s.name)
                    .put("lang", s.lang).put("supportsLatest", s.supportsLatest).put("baseUrl", s.baseUrl ?: JSONObject.NULL))
            }
        })
        is Payload.SearchPage -> JSONObject().put("hasNextPage", p.hasNextPage).put("results", JSONArray().also { a ->
            p.items.forEach { m ->
                a.put(JSONObject().put("remoteId", m.remoteId).put("url", m.remoteId).put("title", m.title).put("coverUrl", m.coverUrl ?: JSONObject.NULL))
            }
        })
        is Payload.Details -> p.details.let { d ->
            JSONObject().put("remoteId", d.remoteId).put("title", d.title).put("author", d.author ?: JSONObject.NULL)
                .put("artist", d.artist ?: JSONObject.NULL).put("description", d.description ?: JSONObject.NULL)
                .put("genres", JSONArray().also { g -> d.genres.forEach { g.put(it) } }).put("status", d.status)
                .put("coverUrl", d.coverUrl ?: JSONObject.NULL)
        }
        is Payload.Chapters -> JSONObject().put("chapters", JSONArray().also { a ->
            p.chapters.forEach { c ->
                a.put(JSONObject().put("remoteId", c.remoteId).put("url", c.remoteId).put("title", c.title)
                    .put("chapterNumber", c.number ?: JSONObject.NULL).put("scanlator", c.scanlator ?: JSONObject.NULL)
                    .put("dateUpload", c.dateUpload))
            }
        })
        is Payload.Pages -> JSONObject().put("pages", JSONArray().also { a ->
            p.pages.forEach { g ->
                a.put(JSONObject().put("index", g.index).put("url", g.url ?: JSONObject.NULL).put("imageUrl", g.imageUrl ?: g.url ?: JSONObject.NULL))
            }
        })
        is Payload.OfflineDownload -> JSONObject().put("download", JSONObject().apply {
            put("canonicalMangaId", p.download.canonicalMangaId)
            put("canonicalChapterId", p.download.canonicalChapterId)
            put("extensionId", p.download.extensionId)
            put("sourceId", p.download.sourceId)
            put("remoteChapterId", p.download.remoteChapterId)
            put("pageCount", p.download.pageCount)
            put("totalBytes", p.download.totalBytes)
            put("pages", JSONArray().also { a -> p.download.pages.forEach { g ->
                a.put(JSONObject().put("index", g.index).put("url", g.url).put("byteSize", g.byteSize).put("sha256", g.sha256).put("contentType", g.contentType).put("width", g.width).put("height", g.height))
            } })
        })
        is Payload.Health -> p.health.let { h ->
            JSONObject().put("protocol", h.protocol).put("pid", h.pid).put("process", h.processName).put("uptimeMs", h.uptimeMs)
                .put("compatAvailable", h.compatAvailable).put("inFlight", h.inFlight)
                .put("extensions", JSONArray().also { a -> h.extensions.forEach { a.put(JSONObject().put("extensionId", it.extensionId).put("state", it.state.name)) } })
                .also { if (host != null) it.put("host", host) }
        }
    }

    private fun info(i: ExtensionInfo): JSONObject = JSONObject()
        .put("packageName", i.extensionId).put("displayName", i.displayName).put("versionName", i.versionName ?: JSONObject.NULL)
        .put("versionCode", i.versionCode).put("api", i.apiVersion ?: JSONObject.NULL).put("state", i.state.name)
        .put("enabled", i.state != app.mangahive.mihon.ipc.contract.ExtensionState.DISABLED && i.state != app.mangahive.mihon.ipc.contract.ExtensionState.QUARANTINED)
        .put("loaded", i.state == app.mangahive.mihon.ipc.contract.ExtensionState.LOADED)
        .put("signers", JSONArray().also { a -> i.signerSha256.forEach { a.put(it) } }).put("sourceCount", i.sourceCount)
        .put("lastFailure", i.lastFailure ?: JSONObject.NULL)
}
