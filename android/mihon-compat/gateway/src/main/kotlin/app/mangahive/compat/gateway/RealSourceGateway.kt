package app.mangahive.compat.gateway

import app.mangahive.mihon.spi.BrokerException
import app.mangahive.mihon.spi.CancelScope
import app.mangahive.mihon.spi.GatewayException
import app.mangahive.mihon.spi.HostIdentityScope
import app.mangahive.mihon.spi.RequestContext
import app.mangahive.mihon.spi.SourceGateway
import eu.kanade.tachiyomi.source.Source
import eu.kanade.tachiyomi.source.model.SChapter
import eu.kanade.tachiyomi.source.model.SManga
import eu.kanade.tachiyomi.source.online.HttpSource
import kotlinx.coroutines.runBlocking
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.jsonObject
import org.json.JSONArray
import org.json.JSONObject

/**
 * One real Source behind JDK-typed methods. Blocking by design; the host calls it off the main thread. UNCOMPILED.
 *
 * Stage 6.5: there is no client parameter any more. A Source's network is whatever the host-provided NetworkHelper/HttpSource
 * hand out, and that is only [HostNetwork.clientForCurrentExtension]. Identity (extensionId from this constructor, sourceId from
 * `source.id`, requestId from the host's RequestContext) is fixed here by the host for every call ([HostIdentityScope.Call]).
 *
 * API used, verbatim from tachiyomix 1.6.0 (see MIHON_API_PROFILES.md):
 *   getSearchManga(page: Int, query: String, filters: FilterList): MangasPage
 *   getMangaUpdate(manga: SManga, chapters: List<SChapter>, fetchDetails: Boolean, fetchChapters: Boolean): SMangaUpdate
 *   getPageList(chapter: SChapter): List<Page>
 */
internal class RealSourceGateway(
    private val entryClass: String,
    private val extensionId: String,
    private val source: Source,
) : SourceGateway {
    private val http: HttpSource? get() = source as? HttpSource

    override fun entryClassName() = entryClass
    override fun sourceId(): Long = source.id
    override fun name(): String = source.name
    override fun lang(): String = (source as? eu.kanade.tachiyomi.source.CatalogueSource)?.lang ?: ""
    override fun supportsLatest(): Boolean = source.supportsLatest
    override fun baseUrl(): String? = http?.baseUrl

    override fun searchJson(ctx: RequestContext, page: Int, query: String): String = call(ctx, "SEARCH_FAILED") { hc ->
        val result = runBlocking(RequestScope.element(hc)) { source.getSearchManga(page, query, source.getFilterList()) }
        JSONObject()
            .put("hasNextPage", result.hasNextPage)
            .put("mangas", JSONArray().also { arr ->
                result.mangas.forEach { m ->
                    arr.put(JSONObject().put("url", m.url).put("title", m.title).put("thumbnailUrl", m.thumbnail_url ?: JSONObject.NULL))
                }
            }).toString()
    }

    override fun detailsJson(ctx: RequestContext, mangaUrl: String): String = detailsJson(ctx, mangaUrl, null)
    override fun chaptersJson(ctx: RequestContext, mangaUrl: String): String = chaptersJson(ctx, mangaUrl, null)
    override fun pagesJson(ctx: RequestContext, chapterUrl: String): String = pagesJson(ctx, chapterUrl, null)

    /** getMangaUpdate(manga, emptyList(), fetchDetails = true, fetchChapters = false): only `result.manga` is read. */
    override fun detailsJson(ctx: RequestContext, mangaUrl: String, mangaMemoJson: String?): String = call(ctx, "DETAILS_FAILED") { hc ->
        val update = runBlocking(RequestScope.element(hc)) {
            source.getMangaUpdate(mangaOf(mangaUrl, mangaMemoJson), emptyList(), fetchDetails = true, fetchChapters = false)
        }
        val m = update.manga
        // Upstream parsers (e.g. ParsedHttpSource.mangaDetailsParse) return a fresh SManga that usually leaves url/title unset;
        // Mihon copies the fetched fields onto the manga it asked about. Same here: unset lateinit fields fall back to the request.
        val o = JSONObject().put("url", m.urlOrNull() ?: mangaUrl).put("status", m.status)
        m.titleOrNull()?.let { o.put("title", it) }
        // Only fields the 1.6.0 SManga really has. `genre` is a comma-separated string upstream; the list is derived, not invented.
        m.author?.let { o.put("author", it) }
        m.artist?.let { o.put("artist", it) }
        m.description?.let { o.put("description", it) }
        m.thumbnail_url?.let { o.put("thumbnailUrl", it) }
        val genres = (m.genre ?: "").split(',').map { it.trim() }.filter { it.isNotEmpty() }
        if (genres.isNotEmpty()) o.put("genres", JSONArray(genres))
        o.put("memo", JSONObject(m.memo.toString()))
        o.toString()
    }

    /** getMangaUpdate(manga, emptyList(), fetchDetails = false, fetchChapters = true): only `result.chapters` is read. */
    override fun chaptersJson(ctx: RequestContext, mangaUrl: String, mangaMemoJson: String?): String = call(ctx, "CHAPTERS_FAILED") { hc ->
        val update = runBlocking(RequestScope.element(hc)) {
            source.getMangaUpdate(mangaOf(mangaUrl, mangaMemoJson), emptyList(), fetchDetails = false, fetchChapters = true)
        }
        JSONObject().put("chapters", JSONArray().also { arr ->
            update.chapters.forEach { c ->
                val o = JSONObject().put("url", c.url).put("name", c.name).put("number", c.chapter_number.toDouble()).put("dateUpload", c.date_upload)
                c.scanlator?.let { o.put("scanlator", it) }
                o.put("memo", JSONObject(c.memo.toString()))
                arr.put(o)
            }
        }).toString()
    }

    override fun pagesJson(ctx: RequestContext, chapterUrl: String, chapterMemoJson: String?): String = call(ctx, "PAGES_FAILED") { hc ->
        val chapter = SChapter.create().apply { url = chapterUrl; chapterMemoJson?.let { memo = parseMemo(it) } }
        val pages = runBlocking(RequestScope.element(hc)) { source.getPageList(chapter) }
        JSONObject().put("pages", JSONArray().also { arr ->
            pages.forEach { p -> arr.put(JSONObject().put("index", p.index).put("url", p.url).put("imageUrl", p.imageUrl ?: JSONObject.NULL)) }
        }).toString()
    }

    private fun mangaOf(url: String, memoJson: String?): SManga = SManga.create().apply {
        this.url = url
        memoJson?.let { memo = parseMemo(it) }
    }

    private fun SManga.urlOrNull(): String? = try { url } catch (_: UninitializedPropertyAccessException) { null }
    private fun SManga.titleOrNull(): String? = try { title } catch (_: UninitializedPropertyAccessException) { null }

    private fun parseMemo(s: String): JsonObject = try { Json.parseToJsonElement(s).jsonObject } catch (e: Exception) { throw GatewayException("BAD_MEMO", "memo is not a JSON object") }

    /**
     * Makes the host-fixed identity current for the whole Source call (this thread, its coroutines, OkHttp dispatcher threads it
     * starts). A cancel/timeout of the scope has already closed the sockets; the failure that comes back is reported as such, not
     * as a Source bug. Messages from the Source are never forwarded (code only).
     */
    private inline fun call(ctx: RequestContext, code: String, crossinline block: (HostIdentityScope.Call) -> String): String {
        val hc = HostIdentityScope.Call(extensionId, source.id, ctx)
        return try {
            RequestScope.with(hc) { block(hc) }
        } catch (e: GatewayException) {
            throw e
        } catch (e: Exception) {
            val b = generateSequence<Throwable>(e) { it.cause }.filterIsInstance<BrokerException>().firstOrNull()
            if (ctx.cancel.isCancelled) throw GatewayException(if (ctx.cancel.reason() == CancelScope.Reason.TIMEOUT) "TIMEOUT" else "CANCELLED", "request ended", e)
            throw GatewayException(b?.code ?: code, b?.code ?: e.javaClass.simpleName, e)
        }
    }
}
