package eu.kanade.tachiyomi.source.online

import eu.kanade.tachiyomi.source.model.MangasPage
import eu.kanade.tachiyomi.source.model.Page
import eu.kanade.tachiyomi.source.model.SChapter
import eu.kanade.tachiyomi.source.model.SManga
import eu.kanade.tachiyomi.util.asJsoup
import okhttp3.Response
import org.jsoup.nodes.Document
import org.jsoup.nodes.Element

/** tachiyomix 1.6.0 `ParsedHttpSource`: CSS-selector helpers over [HttpSource]. */
@Suppress("Unused", "DEPRECATION")
@Deprecated(
    message = "In most cases sources only require a subset of the methods from this class. " +
        "Source developers should make their own implementation according to their needs.",
)
abstract class ParsedHttpSource : HttpSource() {
    @Deprecated(HELPER_DEPRECATION)
    override fun popularMangaParse(response: Response): MangasPage =
        parsePage(response.asJsoup(), popularMangaSelector(), popularMangaNextPageSelector()) { popularMangaFromElement(it) }

    protected abstract fun popularMangaSelector(): String

    protected abstract fun popularMangaFromElement(element: Element): SManga

    protected abstract fun popularMangaNextPageSelector(): String?

    @Deprecated(HELPER_DEPRECATION)
    override fun searchMangaParse(response: Response): MangasPage =
        parsePage(response.asJsoup(), searchMangaSelector(), searchMangaNextPageSelector()) { searchMangaFromElement(it) }

    protected abstract fun searchMangaSelector(): String

    protected abstract fun searchMangaFromElement(element: Element): SManga

    protected abstract fun searchMangaNextPageSelector(): String?

    @Deprecated(HELPER_DEPRECATION)
    override fun latestUpdatesParse(response: Response): MangasPage =
        parsePage(response.asJsoup(), latestUpdatesSelector(), latestUpdatesNextPageSelector()) { latestUpdatesFromElement(it) }

    protected abstract fun latestUpdatesSelector(): String

    protected abstract fun latestUpdatesFromElement(element: Element): SManga

    protected abstract fun latestUpdatesNextPageSelector(): String?

    @Deprecated(HELPER_DEPRECATION)
    override fun mangaDetailsParse(response: Response): SManga = mangaDetailsParse(response.asJsoup())

    protected abstract fun mangaDetailsParse(document: Document): SManga

    @Deprecated(HELPER_DEPRECATION)
    override fun chapterListParse(response: Response): List<SChapter> =
        response.asJsoup().select(chapterListSelector()).map { chapterFromElement(it) }

    protected abstract fun chapterListSelector(): String

    protected abstract fun chapterFromElement(element: Element): SChapter

    @Deprecated(HELPER_DEPRECATION)
    override fun pageListParse(response: Response): List<Page> = pageListParse(response.asJsoup())

    protected abstract fun pageListParse(document: Document): List<Page>

    @Deprecated(HELPER_DEPRECATION)
    override fun imageUrlParse(response: Response): String = imageUrlParse(response.asJsoup())

    protected abstract fun imageUrlParse(document: Document): String

    private inline fun parsePage(
        document: Document,
        selector: String,
        nextPageSelector: String?,
        fromElement: (Element) -> SManga,
    ): MangasPage {
        val mangas = document.select(selector).map(fromElement)
        val hasNextPage = nextPageSelector?.let { document.select(it).first() } != null
        return MangasPage(mangas, hasNextPage)
    }
}
