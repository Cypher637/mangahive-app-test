package eu.kanade.tachiyomi.extension.all.mhfixture

import eu.kanade.tachiyomi.network.GET
import eu.kanade.tachiyomi.source.model.FilterList
import eu.kanade.tachiyomi.source.model.Page
import eu.kanade.tachiyomi.source.model.SChapter
import eu.kanade.tachiyomi.source.model.SManga
import eu.kanade.tachiyomi.source.online.ParsedHttpSource
import okhttp3.Request
import org.jsoup.nodes.Document
import org.jsoup.nodes.Element

/**
 * Classic HTML Source on the deprecated ParsedHttpSource helpers, i.e. the Rx path (fetch* -> asObservableSuccess) that the
 * host's CatalogueSource suspend defaults bridge to. Uses the DEFAULT client (network.client), not a customised one.
 */
@Suppress("DEPRECATION", "OVERRIDE_DEPRECATION")
class MhFixtureHtmlSource : ParsedHttpSource() {
    override val name = "MH Fixture HTML"
    override val lang = "en"
    override val baseUrl = fixtureBaseUrl()
    override val supportsLatest = true

    override fun popularMangaRequest(page: Int): Request = GET("$baseUrl/html/search?q=&page=$page", headers)
    override fun popularMangaSelector() = "div.m"
    override fun popularMangaFromElement(element: Element) = mangaFrom(element)
    override fun popularMangaNextPageSelector() = "a.next"

    override fun searchMangaRequest(page: Int, query: String, filters: FilterList): Request =
        GET("$baseUrl/html/search?q=$query&page=$page", headers)
    override fun searchMangaSelector() = "div.m"
    override fun searchMangaFromElement(element: Element) = mangaFrom(element)
    override fun searchMangaNextPageSelector() = "a.next"

    override fun latestUpdatesRequest(page: Int): Request = popularMangaRequest(page)
    override fun latestUpdatesSelector() = "div.m"
    override fun latestUpdatesFromElement(element: Element) = mangaFrom(element)
    override fun latestUpdatesNextPageSelector(): String? = null

    override fun mangaDetailsParse(document: Document): SManga = SManga.create().apply {
        title = document.selectFirst("h1")!!.text()
        author = document.selectFirst(".author")?.text()
        genre = document.select(".genre").joinToString { it.text() }
        description = document.selectFirst(".desc")?.text()
        status = SManga.COMPLETED
    }

    override fun chapterListSelector() = "li.ch a"
    override fun chapterFromElement(element: Element): SChapter = SChapter.create().apply {
        setUrlWithoutDomain(element.absUrl("href"))
        name = element.text()
        chapter_number = element.attr("data-n").toFloat()
    }

    override fun pageListParse(document: Document): List<Page> =
        document.select("img.page").mapIndexed { i, img -> Page(i, imageUrl = img.absUrl("src")) }

    override fun imageUrlParse(document: Document): String = throw UnsupportedOperationException()

    private fun mangaFrom(element: Element): SManga = SManga.create().apply {
        val a = element.selectFirst("a")!!
        setUrlWithoutDomain(a.absUrl("href"))
        title = a.text()
    }
}
