package app.mangahive.mihon.loader

import app.mangahive.mihon.spi.RequestContext
import app.mangahive.mihon.spi.SourceGateway
import org.json.JSONArray
import org.json.JSONObject

/**
 * Real Mihon Source (behind its gateway) -> MangaHive models. The gateway is private: callers get plain data
 * classes only, so no raw Source object and no foreign-ClassLoader type can reach the WebView layer.
 * Output is size-bounded and entries without a usable remote id are dropped.
 */
class MangaHiveSourceAdapter internal constructor(val info: SourceInfo, private val gateway: SourceGateway) {
    private val memoLock = Any()
    private val mangaMemos = object : LinkedHashMap<String, String>(32, 0.75f, true) {
        override fun removeEldestEntry(eldest: MutableMap.MutableEntry<String, String>?): Boolean = size > 128
    }
    private val chapterMemos = object : LinkedHashMap<String, String>(64, 0.75f, true) {
        override fun removeEldestEntry(eldest: MutableMap.MutableEntry<String, String>?): Boolean = size > 512
    }

    fun clearSessionState() = synchronized(memoLock) { mangaMemos.clear(); chapterMemos.clear() }

    private fun mangaMemo(id: String): String? = synchronized(memoLock) { mangaMemos[id] }
    private fun chapterMemo(id: String): String? = synchronized(memoLock) { chapterMemos[id] }
    private fun putMangaMemo(id: String, memo: String?) { if (!memo.isNullOrBlank()) synchronized(memoLock) { mangaMemos[id] = memo } }
    private fun putChapterMemo(id: String, memo: String?) { if (!memo.isNullOrBlank()) synchronized(memoLock) { chapterMemos[id] = memo } }


    fun search(ctx: RequestContext, query: String, page: Int): Result<AdaptedMangaPage> = guarded {
        val o = JSONObject(gateway.searchJson(ctx, page, query))
        val arr = o.optJSONArray("mangas") ?: JSONArray()
        AdaptedMangaPage(
            items = (0 until minOf(arr.length(), MAX_MANGA)).mapNotNull { i ->
                val m = arr.getJSONObject(i)
                val url = m.optString("url").takeIf { it.isNotBlank() && it.length <= MAX_URL } ?: return@mapNotNull null
                AdaptedManga(url, m.optString("title").take(MAX_TEXT), m.optNullable("thumbnailUrl"))
            },
            hasNextPage = o.optBoolean("hasNextPage", false),
        )
    }

    fun details(ctx: RequestContext, mangaRemoteId: String): Result<AdaptedDetails> = guarded {
        val o = JSONObject(gateway.detailsJson(ctx, mangaRemoteId, mangaMemo(mangaRemoteId)))
        val resolvedId = o.optString("url").ifBlank { mangaRemoteId }
        o.optJSONObject("memo")?.let {
            val memo = it.toString()
            putMangaMemo(mangaRemoteId, memo)
            putMangaMemo(resolvedId, memo)
        }
        val g = o.optJSONArray("genres")
        AdaptedDetails(
            remoteId = resolvedId,
            title = o.optString("title").take(MAX_TEXT),
            author = o.optNullable("author"), artist = o.optNullable("artist"),
            description = o.optNullable("description", MAX_DESCRIPTION),
            genres = if (g == null) emptyList() else (0 until minOf(g.length(), 64)).map { g.getString(it).take(64) },
            status = o.optInt("status", 0), coverUrl = o.optNullable("thumbnailUrl"),
        )
    }

    fun chapters(ctx: RequestContext, mangaRemoteId: String): Result<List<AdaptedChapter>> = guarded {
        val arr = JSONObject(gateway.chaptersJson(ctx, mangaRemoteId, mangaMemo(mangaRemoteId))).optJSONArray("chapters") ?: JSONArray()
        val result = (0 until minOf(arr.length(), MAX_CHAPTERS)).mapNotNull { i ->
            val c = arr.getJSONObject(i)
            val url = c.optString("url").takeIf { it.isNotBlank() && it.length <= MAX_URL } ?: return@mapNotNull null
            val memo = c.optJSONObject("memo")?.toString()
            putChapterMemo(url, memo)
            AdaptedChapter(url, c.optString("name").take(MAX_TEXT), if (c.has("number")) c.optDouble("number") else null, c.optLong("dateUpload", 0L), c.optNullable("scanlator"))
        }.sortedWith(compareBy<AdaptedChapter>({ it.number == null }, { it.number ?: Double.POSITIVE_INFINITY }, { it.dateUpload }, { it.remoteId }))
        result
    }

    fun pages(ctx: RequestContext, chapterRemoteId: String): Result<List<AdaptedPageImage>> = guarded {
        val arr = JSONObject(gateway.pagesJson(ctx, chapterRemoteId, chapterMemo(chapterRemoteId))).optJSONArray("pages") ?: JSONArray()
        (0 until minOf(arr.length(), MAX_PAGES)).mapNotNull { i ->
            val p = arr.getJSONObject(i)
            val url = p.optNullable("url")
            val image = p.optNullable("imageUrl")
            if (url == null && image == null) null else AdaptedPageImage(p.optInt("index", i), url, image)
        }.sortedWith(compareBy({ it.index }, { it.url ?: it.imageUrl ?: "" }))
    }

    private inline fun <T> guarded(block: () -> T): Result<T> = try {
        Result.success(block())
    } catch (e: VirtualMachineError) {
        throw e
    } catch (t: Throwable) {
        Result.failure(t)
    }

    private fun JSONObject.optNullable(key: String, max: Int = MAX_URL): String? =
        if (isNull(key)) null else optString(key).takeIf { it.isNotEmpty() }?.take(max)

    companion object {
        const val MAX_MANGA = 100; const val MAX_CHAPTERS = 5000; const val MAX_PAGES = 500
        const val MAX_TEXT = 512; const val MAX_URL = 2048; const val MAX_DESCRIPTION = 8192
    }
}
