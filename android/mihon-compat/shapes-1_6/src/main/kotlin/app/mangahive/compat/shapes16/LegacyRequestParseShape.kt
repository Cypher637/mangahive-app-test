@file:Suppress("DEPRECATION")

package app.mangahive.compat.shapes16

import eu.kanade.tachiyomi.source.model.FilterList
import eu.kanade.tachiyomi.source.model.MangasPage
import eu.kanade.tachiyomi.source.model.Page
import eu.kanade.tachiyomi.source.model.SChapter
import eu.kanade.tachiyomi.source.model.SManga
import eu.kanade.tachiyomi.source.online.HttpSource
import okhttp3.Request
import okhttp3.Response

/**
 * COMPILE-TIME SHAPE ONLY. Never executed, never loaded.
 *
 * The classic request/parse HttpSource shape. tachiyomix 1.6.0 CHANGELOG: "HttpSource.xxxRequest and
 * HttpSource.xxxParse except HttpSource.imageRequest; Deprecated with no replacement" - deprecated, therefore
 * still present, and still what most published extensions are written in.
 * `@file:Suppress("DEPRECATION")` is deliberate.
 */
class LegacyRequestParseShape : HttpSource() {
    override val name = "Shape"
    override val lang = "en"
    override val baseUrl = "https://example.invalid"
    override val supportsLatest = true

    override fun popularMangaRequest(page: Int): Request =
        Request.Builder().url("$baseUrl/popular?page=$page").headers(headers).build()
    override fun popularMangaParse(response: Response): MangasPage = MangasPage(emptyList(), false)

    override fun latestUpdatesRequest(page: Int): Request =
        Request.Builder().url("$baseUrl/latest?page=$page").headers(headers).build()
    override fun latestUpdatesParse(response: Response): MangasPage = MangasPage(emptyList(), false)

    override fun searchMangaRequest(page: Int, query: String, filters: FilterList): Request =
        Request.Builder().url("$baseUrl/search?q=$query&page=$page").headers(headers).build()
    override fun searchMangaParse(response: Response): MangasPage = MangasPage(emptyList(), false)

    override fun mangaDetailsParse(response: Response): SManga = SManga.create().apply {
        title = "t"
        url = "/m/1"
    }

    override fun chapterListParse(response: Response): List<SChapter> = listOf(
        SChapter.create().apply {
            name = "Chapter 1"
            url = "/c/1"
        },
    )

    override fun pageListParse(response: Response): List<Page> = listOf(Page(0, imageUrl = "https://example.invalid/1.png"))

    override fun imageUrlParse(response: Response): String = ""
}
