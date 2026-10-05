package app.mangahive.mihon.ipc.contract

import org.json.JSONArray
import org.json.JSONException
import org.json.JSONObject

/**
 * Strict, versioned JSON codec for the runtime IPC.
 *
 * Both processes decode with this. The decoder rejects unknown keys, wrong JSON types, over-long strings and
 * over-long lists, so a compromised peer (the runtime hosts third-party code) cannot smuggle structure through.
 * Encoding is field by field from typed classes; no generic map/object ever reaches the wire.
 */
object IpcCodec {

    sealed class Decoded<out T> {
        class Ok<out T>(val value: T) : Decoded<T>()
        class Rejected(val requestId: String?, val op: Op?, val code: ErrorCode) : Decoded<Nothing>()
    }

    private class Bad(val code: ErrorCode) : RuntimeException()

    // ───────────────────────── requests ─────────────────────────

    fun encodeRequest(r: RuntimeRequest): String {
        val args = JSONObject()
        when (r) {
            is RuntimeRequest.Install -> args.put("apkUrl", r.apkUrl).put("expectedSha256", r.expectedSha256)
                .put("expectedPackage", r.expectedPackage).put("expectedSignerSha256", r.expectedSignerSha256)
            is RuntimeRequest.Inspect -> args.put("extensionId", r.extensionId)
            is RuntimeRequest.Enable -> args.put("extensionId", r.extensionId)
            is RuntimeRequest.Disable -> args.put("extensionId", r.extensionId)
            is RuntimeRequest.Uninstall -> args.put("extensionId", r.extensionId)
            is RuntimeRequest.ListSources -> args.put("extensionId", r.extensionId)
            is RuntimeRequest.Search -> args.put("extensionId", r.extensionId).put("sourceId", r.sourceId)
                .put("query", r.query).put("page", r.page)
            is RuntimeRequest.Details -> args.put("extensionId", r.extensionId).put("sourceId", r.sourceId)
                .put("mangaRemoteId", r.mangaRemoteId)
            is RuntimeRequest.Chapters -> args.put("extensionId", r.extensionId).put("sourceId", r.sourceId)
                .put("mangaRemoteId", r.mangaRemoteId)
            is RuntimeRequest.Pages -> args.put("extensionId", r.extensionId).put("sourceId", r.sourceId)
                .put("chapterRemoteId", r.chapterRemoteId)
            is RuntimeRequest.Download -> args.put("canonicalMangaId", r.canonicalMangaId).put("canonicalChapterId", r.canonicalChapterId)
                .put("extensionId", r.extensionId).put("sourceId", r.sourceId)
                .put("mangaRemoteId", r.mangaRemoteId).put("chapterRemoteId", r.chapterRemoteId)
                .put("maxStorageBytes", r.maxStorageBytes).put("cleanupAfterDays", r.cleanupAfterDays)
            is RuntimeRequest.DeleteDownload -> args.put("canonicalMangaId", r.canonicalMangaId).put("canonicalChapterId", r.canonicalChapterId)
                .put("extensionId", r.extensionId).put("sourceId", r.sourceId).put("remoteChapterId", r.remoteChapterId)
            is RuntimeRequest.Cancel -> args.put("targetRequestId", r.targetRequestId)
            is RuntimeRequest.Health -> Unit
        }
        return JSONObject().put("v", IPC_PROTOCOL_VERSION).put("id", r.requestId).put("op", r.op.wire).put("args", args).toString()
    }

    fun decodeRequest(raw: String): Decoded<RuntimeRequest> {
        if (raw.length > IpcLimits.MAX_REQUEST_CHARS) return Decoded.Rejected(null, null, ErrorCode.BAD_REQUEST)
        val root = try { JSONObject(raw) } catch (_: JSONException) { return Decoded.Rejected(null, null, ErrorCode.BAD_REQUEST) }
        var rid: String? = null
        var op: Op? = null
        return try {
            root.onlyKeys("v", "id", "op", "args")
            val id = root.str("id", 64)!!
            if (!IpcLimits.REQUEST_ID.matches(id)) throw Bad(ErrorCode.BAD_REQUEST)
            rid = id
            val v = root.opt("v")
            if (v !is Int || v != IPC_PROTOCOL_VERSION) throw Bad(ErrorCode.UNSUPPORTED_VERSION)
            val o = Op.fromWire(root.str("op", 32)!!) ?: throw Bad(ErrorCode.UNKNOWN_OP)
            op = o
            val args = root.opt("args") as? JSONObject ?: throw Bad(ErrorCode.BAD_REQUEST)
            Decoded.Ok(decodeArgs(o, id, args))
        } catch (b: Bad) {
            Decoded.Rejected(rid, op, b.code)
        } catch (_: JSONException) {
            Decoded.Rejected(rid, op, ErrorCode.BAD_REQUEST)
        }
    }

    private fun decodeArgs(op: Op, id: String, a: JSONObject): RuntimeRequest = when (op) {
        Op.INSTALL -> {
            a.onlyKeys("apkUrl", "expectedSha256", "expectedPackage", "expectedSignerSha256")
            RuntimeRequest.Install(
                id, a.str("apkUrl", IpcLimits.MAX_URL)!!,
                a.str("expectedSha256", 64, required = false)?.also { if (!IpcLimits.SHA256.matches(it)) throw Bad(ErrorCode.BAD_REQUEST) },
                a.extId("expectedPackage", required = false),
                a.str("expectedSignerSha256", 64, required = false)?.also { if (!IpcLimits.SHA256.matches(it)) throw Bad(ErrorCode.BAD_REQUEST) },
            )
        }
        Op.INSPECT -> { a.onlyKeys("extensionId"); RuntimeRequest.Inspect(id, a.extId("extensionId")!!) }
        Op.ENABLE -> { a.onlyKeys("extensionId"); RuntimeRequest.Enable(id, a.extId("extensionId")!!) }
        Op.DISABLE -> { a.onlyKeys("extensionId"); RuntimeRequest.Disable(id, a.extId("extensionId")!!) }
        Op.UNINSTALL -> { a.onlyKeys("extensionId"); RuntimeRequest.Uninstall(id, a.extId("extensionId")!!) }
        Op.LIST_SOURCES -> { a.onlyKeys("extensionId"); RuntimeRequest.ListSources(id, a.extId("extensionId", required = false)) }
        Op.SEARCH -> {
            a.onlyKeys("extensionId", "sourceId", "query", "page")
            val page = a.int("page")
            if (page < 1 || page > IpcLimits.MAX_PAGE_NUMBER) throw Bad(ErrorCode.BAD_REQUEST)
            RuntimeRequest.Search(id, a.extId("extensionId")!!, a.long("sourceId"), a.str("query", IpcLimits.MAX_QUERY)!!, page)
        }
        Op.DETAILS -> {
            a.onlyKeys("extensionId", "sourceId", "mangaRemoteId")
            RuntimeRequest.Details(id, a.extId("extensionId")!!, a.long("sourceId"), a.nonBlank("mangaRemoteId", IpcLimits.MAX_URL))
        }
        Op.CHAPTERS -> {
            a.onlyKeys("extensionId", "sourceId", "mangaRemoteId")
            RuntimeRequest.Chapters(id, a.extId("extensionId")!!, a.long("sourceId"), a.nonBlank("mangaRemoteId", IpcLimits.MAX_URL))
        }
        Op.PAGES -> {
            a.onlyKeys("extensionId", "sourceId", "chapterRemoteId")
            RuntimeRequest.Pages(id, a.extId("extensionId")!!, a.long("sourceId"), a.nonBlank("chapterRemoteId", IpcLimits.MAX_URL))
        }
        Op.DOWNLOAD -> {
            a.onlyKeys("canonicalMangaId", "canonicalChapterId", "extensionId", "sourceId", "mangaRemoteId", "chapterRemoteId", "maxStorageBytes", "cleanupAfterDays")
            val maxStorageBytes = if (a.has("maxStorageBytes") && !a.isNull("maxStorageBytes")) a.long("maxStorageBytes") else 0L
            val cleanupAfterDays = if (a.has("cleanupAfterDays") && !a.isNull("cleanupAfterDays")) a.int("cleanupAfterDays") else 0
            if (maxStorageBytes != 0L && (maxStorageBytes < 64L * 1024L * 1024L || maxStorageBytes > IpcLimits.MAX_OFFLINE_STORAGE_BYTES)) throw Bad(ErrorCode.BAD_REQUEST)
            if (cleanupAfterDays < 0 || cleanupAfterDays > IpcLimits.MAX_CLEANUP_DAYS) throw Bad(ErrorCode.BAD_REQUEST)
            RuntimeRequest.Download(
                id,
                a.nonBlank("canonicalMangaId", IpcLimits.MAX_CANONICAL_ID),
                a.nonBlank("canonicalChapterId", IpcLimits.MAX_CANONICAL_ID),
                a.extId("extensionId")!!,
                a.long("sourceId"),
                a.nonBlank("mangaRemoteId", IpcLimits.MAX_REMOTE_ID),
                a.nonBlank("chapterRemoteId", IpcLimits.MAX_REMOTE_ID),
                maxStorageBytes,
                cleanupAfterDays,
            )
        }
        Op.DELETE_DOWNLOAD -> {
            a.onlyKeys("canonicalMangaId", "canonicalChapterId", "extensionId", "sourceId", "remoteChapterId")
            RuntimeRequest.DeleteDownload(
                id,
                a.nonBlank("canonicalMangaId", IpcLimits.MAX_CANONICAL_ID),
                a.nonBlank("canonicalChapterId", IpcLimits.MAX_CANONICAL_ID),
                a.extId("extensionId")!!,
                a.long("sourceId"),
                a.nonBlank("remoteChapterId", IpcLimits.MAX_REMOTE_ID),
            )
        }
        Op.CANCEL -> {
            a.onlyKeys("targetRequestId")
            val t = a.str("targetRequestId", 64)!!
            if (!IpcLimits.REQUEST_ID.matches(t)) throw Bad(ErrorCode.BAD_REQUEST)
            RuntimeRequest.Cancel(id, t)
        }
        Op.HEALTH -> { a.onlyKeys(); RuntimeRequest.Health(id) }
    }

    // ───────────────────────── responses ─────────────────────────

    fun encodeResponse(r: RuntimeResponse): String {
        val o = JSONObject().put("v", IPC_PROTOCOL_VERSION).put("id", r.requestId).put("op", r.op?.wire)
        when (r) {
            is RuntimeResponse.Failure -> {
                val e = JSONObject().put("code", r.error.code.name)
                r.error.detail?.takeIf { IpcLimits.DETAIL.matches(it) }?.let { e.put("detail", it) }
                o.put("ok", false).put("error", e)
            }
            is RuntimeResponse.Success -> o.put("ok", true).put("data", encodePayload(r.payload))
        }
        return o.toString()
    }

    fun decodeResponse(raw: String): Decoded<RuntimeResponse> {
        if (raw.length > IpcLimits.MAX_RESPONSE_CHARS) return Decoded.Rejected(null, null, ErrorCode.RESPONSE_TOO_LARGE)
        val root = try { JSONObject(raw) } catch (_: JSONException) { return Decoded.Rejected(null, null, ErrorCode.INTERNAL) }
        var rid: String? = null
        var op: Op? = null
        return try {
            root.onlyKeys("v", "id", "op", "ok", "data", "error")
            val id = root.str("id", 64)!!
            if (!IpcLimits.REQUEST_ID.matches(id)) throw Bad(ErrorCode.INTERNAL)
            rid = id
            val v = root.opt("v")
            if (v !is Int || v != IPC_PROTOCOL_VERSION) throw Bad(ErrorCode.UNSUPPORTED_VERSION)
            op = root.str("op", 32, required = false)?.let { Op.fromWire(it) ?: throw Bad(ErrorCode.INTERNAL) }
            val ok = root.opt("ok") as? Boolean ?: throw Bad(ErrorCode.INTERNAL)
            if (ok) {
                if (root.has("error")) throw Bad(ErrorCode.INTERNAL)
                val o = op ?: throw Bad(ErrorCode.INTERNAL)
                val data = root.opt("data") as? JSONObject ?: throw Bad(ErrorCode.INTERNAL)
                Decoded.Ok(RuntimeResponse.Success(id, o, decodePayload(data)))
            } else {
                if (root.has("data")) throw Bad(ErrorCode.INTERNAL)
                val e = root.opt("error") as? JSONObject ?: throw Bad(ErrorCode.INTERNAL)
                e.onlyKeys("code", "detail")
                val code = ErrorCode.fromWire(e.str("code", 48)!!) ?: throw Bad(ErrorCode.INTERNAL)
                val detail = e.str("detail", 48, required = false)?.also { if (!IpcLimits.DETAIL.matches(it)) throw Bad(ErrorCode.INTERNAL) }
                Decoded.Ok(RuntimeResponse.Failure(id, op, IpcError(code, detail)))
            }
        } catch (b: Bad) {
            Decoded.Rejected(rid, op, b.code)
        } catch (_: JSONException) {
            Decoded.Rejected(rid, op, ErrorCode.INTERNAL)
        }
    }

    private fun encodePayload(p: Payload): JSONObject = when (p) {
        Payload.Ack -> JSONObject().put("type", "ack")
        is Payload.Extension -> JSONObject().put("type", "extension").put("info", encodeInfo(p.info))
        is Payload.Sources -> JSONObject().put("type", "sources").put("sources", arr(p.sources.take(IpcLimits.MAX_SOURCES)) { s ->
            JSONObject().put("key", s.key).put("extensionId", s.extensionId).put("sourceId", s.sourceId)
                .put("name", s.name.take(IpcLimits.MAX_TEXT)).put("lang", s.lang.take(32))
                .put("supportsLatest", s.supportsLatest).put("baseUrl", s.baseUrl?.take(IpcLimits.MAX_URL))
                .put("healthStatus", s.healthStatus).put("consecutiveFailures", s.consecutiveFailures)
                .put("lastSuccessAt", s.lastSuccessAt).put("lastFailureAt", s.lastFailureAt)
                .put("cooldownUntil", s.cooldownUntil).put("lastLatencyMs", s.lastLatencyMs)
        })
        is Payload.SearchPage -> JSONObject().put("type", "search").put("hasNextPage", p.hasNextPage)
            .put("items", arr(p.items.take(IpcLimits.MAX_MANGA)) { m ->
                JSONObject().put("remoteId", m.remoteId).put("title", m.title.take(IpcLimits.MAX_TEXT)).put("coverUrl", m.coverUrl?.take(IpcLimits.MAX_URL))
            })
        is Payload.Details -> JSONObject().put("type", "details").put("details", p.details.let { d ->
            JSONObject().put("remoteId", d.remoteId).put("title", d.title.take(IpcLimits.MAX_TEXT))
                .put("author", d.author?.take(IpcLimits.MAX_TEXT)).put("artist", d.artist?.take(IpcLimits.MAX_TEXT))
                .put("description", d.description?.take(IpcLimits.MAX_DESCRIPTION))
                .put("genres", JSONArray().also { g -> d.genres.take(IpcLimits.MAX_GENRES).forEach { g.put(it.take(64)) } })
                .put("status", d.status).put("coverUrl", d.coverUrl?.take(IpcLimits.MAX_URL))
        })
        is Payload.Chapters -> JSONObject().put("type", "chapters").put("chapters", arr(p.chapters.take(IpcLimits.MAX_CHAPTERS)) { c ->
            JSONObject().put("remoteId", c.remoteId).put("title", c.title.take(IpcLimits.MAX_TEXT)).put("number", c.number)
                .put("dateUpload", c.dateUpload).put("scanlator", c.scanlator?.take(IpcLimits.MAX_TEXT))
        })
        is Payload.Pages -> JSONObject().put("type", "pages").put("pages", arr(p.pages.take(IpcLimits.MAX_PAGES)) { g ->
            JSONObject().put("index", g.index).put("url", g.url?.take(IpcLimits.MAX_URL)).put("imageUrl", g.imageUrl?.take(IpcLimits.MAX_URL))
        })
        is Payload.OfflineDownload -> JSONObject().put("type", "offlineDownload").put("download", JSONObject().apply {
            put("canonicalMangaId", p.download.canonicalMangaId)
            put("canonicalChapterId", p.download.canonicalChapterId)
            put("extensionId", p.download.extensionId)
            put("sourceId", p.download.sourceId)
            put("remoteChapterId", p.download.remoteChapterId)
            put("pageCount", p.download.pageCount)
            put("totalBytes", p.download.totalBytes)
            put("pages", arr(p.download.pages.take(IpcLimits.MAX_PAGES)) { g ->
                JSONObject().put("index", g.index).put("url", g.url.take(IpcLimits.MAX_URL))
                    .put("byteSize", g.byteSize).put("sha256", g.sha256).put("contentType", g.contentType.take(128))
                    .put("width", g.width).put("height", g.height)
            })
        })
        is Payload.Health -> JSONObject().put("type", "health").put("health", p.health.let { h ->
            JSONObject().put("protocol", h.protocol).put("pid", h.pid).put("processName", h.processName.take(128))
                .put("uptimeMs", h.uptimeMs).put("compatAvailable", h.compatAvailable).put("inFlight", h.inFlight)
                .put("extensions", arr(h.extensions.take(IpcLimits.MAX_EXTENSIONS)) { e ->
                    JSONObject().put("extensionId", e.extensionId).put("state", e.state.name)
                })
        })
    }

    private fun decodePayload(d: JSONObject): Payload {
        return when (d.str("type", 16)) {
            "ack" -> { d.onlyKeys("type"); Payload.Ack }
            "extension" -> { d.onlyKeys("type", "info"); Payload.Extension(decodeInfo(d.obj("info"))) }
            "sources" -> {
                d.onlyKeys("type", "sources")
                Payload.Sources(d.list("sources", IpcLimits.MAX_SOURCES) { s ->
                    s.onlyKeys("key", "extensionId", "sourceId", "name", "lang", "supportsLatest", "baseUrl", "healthStatus", "consecutiveFailures", "lastSuccessAt", "lastFailureAt", "cooldownUntil", "lastLatencyMs")
                    SourceDto(s.str("key", 300)!!, s.extId("extensionId")!!, s.str("sourceId", 24)!!, s.str("name", IpcLimits.MAX_TEXT)!!,
                        s.str("lang", 32)!!, s.bool("supportsLatest"), s.str("baseUrl", IpcLimits.MAX_URL, required = false),
                        s.str("healthStatus", 16)!!, s.int("consecutiveFailures"), s.long("lastSuccessAt"), s.long("lastFailureAt"),
                        s.long("cooldownUntil"), s.long("lastLatencyMs"))
                })
            }
            "search" -> {
                d.onlyKeys("type", "hasNextPage", "items")
                Payload.SearchPage(d.list("items", IpcLimits.MAX_MANGA) { m ->
                    m.onlyKeys("remoteId", "title", "coverUrl")
                    MangaDto(m.nonBlank("remoteId", IpcLimits.MAX_URL), m.str("title", IpcLimits.MAX_TEXT)!!, m.str("coverUrl", IpcLimits.MAX_URL, required = false))
                }, d.bool("hasNextPage"))
            }
            "details" -> {
                d.onlyKeys("type", "details")
                val x = d.obj("details")
                x.onlyKeys("remoteId", "title", "author", "artist", "description", "genres", "status", "coverUrl")
                Payload.Details(DetailsDto(
                    x.nonBlank("remoteId", IpcLimits.MAX_URL), x.str("title", IpcLimits.MAX_TEXT)!!,
                    x.str("author", IpcLimits.MAX_TEXT, required = false), x.str("artist", IpcLimits.MAX_TEXT, required = false),
                    x.str("description", IpcLimits.MAX_DESCRIPTION, required = false),
                    x.strings("genres", IpcLimits.MAX_GENRES, 64), x.int("status"), x.str("coverUrl", IpcLimits.MAX_URL, required = false),
                ))
            }
            "chapters" -> {
                d.onlyKeys("type", "chapters")
                Payload.Chapters(d.list("chapters", IpcLimits.MAX_CHAPTERS) { c ->
                    c.onlyKeys("remoteId", "title", "number", "dateUpload", "scanlator")
                    ChapterDto(c.nonBlank("remoteId", IpcLimits.MAX_URL), c.str("title", IpcLimits.MAX_TEXT)!!, c.dbl("number", required = false),
                        c.long("dateUpload"), c.str("scanlator", IpcLimits.MAX_TEXT, required = false))
                })
            }
            "pages" -> {
                d.onlyKeys("type", "pages")
                Payload.Pages(d.list("pages", IpcLimits.MAX_PAGES) { g ->
                    g.onlyKeys("index", "url", "imageUrl")
                    PageDto(g.int("index"), g.str("url", IpcLimits.MAX_URL, required = false), g.str("imageUrl", IpcLimits.MAX_URL, required = false))
                })
            }
            "offlineDownload" -> {
                d.onlyKeys("type", "download")
                val x = d.obj("download")
                x.onlyKeys("canonicalMangaId", "canonicalChapterId", "extensionId", "sourceId", "remoteChapterId", "pageCount", "totalBytes", "pages")
                val pages = x.list("pages", IpcLimits.MAX_PAGES) { g ->
                    g.onlyKeys("index", "url", "byteSize", "sha256", "contentType", "width", "height")
                    val hash = g.str("sha256", 64)!!
                    if (!IpcLimits.SHA256.matches(hash)) throw Bad(ErrorCode.INTERNAL)
                    val size = g.long("byteSize")
                    if (size <= 0L || size > IpcLimits.MAX_PAGE_BYTES) throw Bad(ErrorCode.INTERNAL)
                    val contentType = g.str("contentType", 128)!!
                    val width = g.int("width")
                    val height = g.int("height")
                    if (!contentType.startsWith("image/", ignoreCase = true) || width <= 0 || height <= 0 || width > 20_000 || height > 20_000) throw Bad(ErrorCode.INTERNAL)
                    OfflinePageDto(g.int("index"), g.nonBlank("url", IpcLimits.MAX_URL), size, hash, contentType, width, height)
                }
                val count = x.int("pageCount")
                if (count != pages.size || count <= 0 || count > IpcLimits.MAX_PAGES) throw Bad(ErrorCode.INTERNAL)
                val total = x.long("totalBytes")
                if (total <= 0L || total > IpcLimits.MAX_OFFLINE_BYTES || total != pages.sumOf { it.byteSize }) throw Bad(ErrorCode.INTERNAL)
                if (pages.indices.any { pages[it].index != it }) throw Bad(ErrorCode.INTERNAL)
                if (!IpcLimits.EXTENSION_ID.matches(x.str("extensionId", IpcLimits.MAX_EXTENSION_ID)!!)) throw Bad(ErrorCode.INTERNAL)
                if (x.nonBlank("canonicalMangaId", IpcLimits.MAX_CANONICAL_ID).isBlank() || x.nonBlank("canonicalChapterId", IpcLimits.MAX_CANONICAL_ID).isBlank()) throw Bad(ErrorCode.INTERNAL)
                Payload.OfflineDownload(OfflineDownloadDto(
                    x.nonBlank("canonicalMangaId", IpcLimits.MAX_CANONICAL_ID),
                    x.nonBlank("canonicalChapterId", IpcLimits.MAX_CANONICAL_ID),
                    x.extId("extensionId")!!, x.long("sourceId"), x.nonBlank("remoteChapterId", IpcLimits.MAX_REMOTE_ID), count, total, pages
                ))
            }
            "health" -> {
                d.onlyKeys("type", "health")
                val h = d.obj("health")
                h.onlyKeys("protocol", "pid", "processName", "uptimeMs", "compatAvailable", "inFlight", "extensions")
                Payload.Health(RuntimeHealth(
                    h.int("protocol"), h.int("pid"), h.str("processName", 128)!!, h.long("uptimeMs"), h.bool("compatAvailable"), h.int("inFlight"),
                    h.list("extensions", IpcLimits.MAX_EXTENSIONS) { e ->
                        e.onlyKeys("extensionId", "state")
                        ExtensionHealthDto(e.extId("extensionId")!!, e.state("state"))
                    },
                ))
            }
            else -> throw Bad(ErrorCode.INTERNAL)
        }
    }

    private fun encodeInfo(i: ExtensionInfo): JSONObject = JSONObject()
        .put("extensionId", i.extensionId).put("displayName", i.displayName.take(IpcLimits.MAX_TEXT)).put("versionName", i.versionName?.take(64))
        .put("versionCode", i.versionCode).put("apiVersion", i.apiVersion?.take(32)).put("state", i.state.name)
        .put("signers", JSONArray().also { a -> i.signerSha256.take(IpcLimits.MAX_SIGNERS).forEach { a.put(it) } })
        .put("sourceCount", i.sourceCount)
        .put("lastFailure", i.lastFailure?.takeIf { IpcLimits.DETAIL.matches(it) })

    private fun decodeInfo(o: JSONObject): ExtensionInfo {
        o.onlyKeys("extensionId", "displayName", "versionName", "versionCode", "apiVersion", "state", "signers", "sourceCount", "lastFailure")
        return ExtensionInfo(
            o.extId("extensionId")!!, o.str("displayName", IpcLimits.MAX_TEXT)!!, o.str("versionName", 64, required = false),
            o.long("versionCode"), o.str("apiVersion", 32, required = false), o.state("state"),
            o.strings("signers", IpcLimits.MAX_SIGNERS, 64).also { s -> if (s.any { !IpcLimits.SHA256.matches(it) }) throw Bad(ErrorCode.INTERNAL) },
            o.int("sourceCount"),
            o.str("lastFailure", 48, required = false)?.also { if (!IpcLimits.DETAIL.matches(it)) throw Bad(ErrorCode.INTERNAL) },
        )
    }

    // ───────────────────────── strict field access ─────────────────────────

    private fun <T> arr(items: List<T>, f: (T) -> JSONObject): JSONArray = JSONArray().also { a -> items.forEach { a.put(f(it)) } }

    private fun JSONObject.onlyKeys(vararg allowed: String) {
        val it = keys()
        while (it.hasNext()) if (it.next() !in allowed) throw Bad(ErrorCode.BAD_REQUEST)
    }

    private fun JSONObject.str(k: String, max: Int, required: Boolean = true): String? {
        if (!has(k) || isNull(k)) { if (required) throw Bad(ErrorCode.BAD_REQUEST); return null }
        val v = get(k)
        if (v !is String || v.length > max) throw Bad(ErrorCode.BAD_REQUEST)
        return v
    }

    private fun JSONObject.nonBlank(k: String, max: Int): String {
        val v = str(k, max)!!
        if (v.isBlank()) throw Bad(ErrorCode.BAD_REQUEST)
        return v
    }

    private fun JSONObject.extId(k: String, required: Boolean = true): String? {
        val v = str(k, IpcLimits.MAX_EXTENSION_ID, required) ?: return null
        if (!IpcLimits.EXTENSION_ID.matches(v)) throw Bad(ErrorCode.BAD_REQUEST)
        return v
    }

    private fun JSONObject.long(k: String): Long {
        val v = opt(k)
        if (v !is Int && v !is Long) throw Bad(ErrorCode.BAD_REQUEST)
        return (v as Number).toLong()
    }

    private fun JSONObject.int(k: String): Int {
        val v = opt(k)
        if (v !is Int) throw Bad(ErrorCode.BAD_REQUEST)
        return v
    }

    private fun JSONObject.dbl(k: String, required: Boolean): Double? {
        if (!has(k) || isNull(k)) { if (required) throw Bad(ErrorCode.BAD_REQUEST); return null }
        val v = get(k)
        if (v !is Number) throw Bad(ErrorCode.BAD_REQUEST)
        val d = v.toDouble()
        if (d.isNaN() || d.isInfinite()) throw Bad(ErrorCode.BAD_REQUEST)
        return d
    }

    private fun JSONObject.bool(k: String): Boolean = opt(k) as? Boolean ?: throw Bad(ErrorCode.BAD_REQUEST)

    private fun JSONObject.obj(k: String): JSONObject = opt(k) as? JSONObject ?: throw Bad(ErrorCode.BAD_REQUEST)

    private fun JSONObject.state(k: String): ExtensionState {
        val s = str(k, 24)!!
        return ExtensionState.values().firstOrNull { it.name == s } ?: throw Bad(ErrorCode.BAD_REQUEST)
    }

    private fun JSONObject.strings(k: String, maxItems: Int, maxLen: Int): List<String> {
        val a = opt(k) as? JSONArray ?: throw Bad(ErrorCode.BAD_REQUEST)
        if (a.length() > maxItems) throw Bad(ErrorCode.BAD_REQUEST)
        return (0 until a.length()).map { i ->
            val v = a.get(i)
            if (v !is String || v.length > maxLen) throw Bad(ErrorCode.BAD_REQUEST)
            v
        }
    }

    private fun <T> JSONObject.list(k: String, maxItems: Int, f: (JSONObject) -> T): List<T> {
        val a = opt(k) as? JSONArray ?: throw Bad(ErrorCode.BAD_REQUEST)
        if (a.length() > maxItems) throw Bad(ErrorCode.BAD_REQUEST)
        return (0 until a.length()).map { i -> f(a.get(i) as? JSONObject ?: throw Bad(ErrorCode.BAD_REQUEST)) }
    }
}
