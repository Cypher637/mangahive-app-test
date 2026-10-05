package eu.kanade.tachiyomi.source.online

import app.mangahive.compat.gateway.HostRuntimeInfo
import app.mangahive.compat.gateway.awaitSingle
import eu.kanade.tachiyomi.network.GET
import eu.kanade.tachiyomi.network.NetworkHelper
import eu.kanade.tachiyomi.network.asObservableSuccess
import eu.kanade.tachiyomi.source.CatalogueSource
import eu.kanade.tachiyomi.source.model.FilterList
import eu.kanade.tachiyomi.source.model.MangasPage
import eu.kanade.tachiyomi.source.model.Page
import eu.kanade.tachiyomi.source.model.SChapter
import eu.kanade.tachiyomi.source.model.SManga
import okhttp3.Headers
import okhttp3.OkHttpClient
import okhttp3.Request
import okhttp3.Response
import rx.Observable
import uy.kohesive.injekt.injectLazy
import java.net.URI
import java.net.URISyntaxException
import java.security.MessageDigest

/**
 * tachiyomix 1.6.0 `HttpSource`, MangaHive host implementation.
 *
 * [network] is the host NetworkHelper registered in Injekt before any extension is constructed; [client] defaults to its
 * brokered client. Overriding [client] (typically `network.client.newBuilder()...build()`) keeps the broker: the builder copy
 * carries the terminal BrokerInterceptor, which also runs the interceptors the extension adds.
 */
@Suppress("UNUSED", "UnusedReceiverParameter")
abstract class HttpSource : CatalogueSource {
    protected val network: NetworkHelper by injectLazy()

    abstract val baseUrl: String

    open fun getHomeUrl(): String = baseUrl

    open val versionId: Int = 1

    /** MD5 of "name/lang/versionId", same derivation as upstream hosts, so ids are stable across hosts. */
    override val id: Long by lazy { generateId(name, lang, versionId) }

    val headers: Headers by lazy { headersBuilder().build() }

    open val client: OkHttpClient
        get() = network.client

    private fun generateId(name: String, lang: String, versionId: Int): Long {
        val key = "${name.lowercase()}/$lang/$versionId"
        val bytes = MessageDigest.getInstance("MD5").digest(key.toByteArray())
        return (0..7).map { bytes[it].toLong() and 0xff shl 8 * (7 - it) }.reduce(Long::or) and Long.MAX_VALUE
    }

    protected open fun headersBuilder(): Headers.Builder = Headers.Builder().apply {
        add("User-Agent", HostRuntimeInfo.defaultUserAgent)
    }

    override fun toString(): String = "$name (${lang.uppercase()})"

    @Suppress("DEPRECATION")
    @Deprecated("Use the suspend API instead", ReplaceWith("getPopularManga"))
    override fun fetchPopularManga(page: Int): Observable<MangasPage> =
        client.newCall(popularMangaRequest(page)).asObservableSuccess().map { popularMangaParse(it) }

    @Deprecated(HELPER_DEPRECATION)
    protected open fun popularMangaRequest(page: Int): Request = throw UnsupportedOperationException()

    @Deprecated(HELPER_DEPRECATION)
    protected open fun popularMangaParse(response: Response): MangasPage = throw UnsupportedOperationException()

    @Suppress("DEPRECATION")
    @Deprecated("Use the suspend API instead", ReplaceWith("getSearchManga"))
    override fun fetchSearchManga(page: Int, query: String, filters: FilterList): Observable<MangasPage> =
        client.newCall(searchMangaRequest(page, query, filters)).asObservableSuccess().map { searchMangaParse(it) }

    @Deprecated(HELPER_DEPRECATION)
    protected open fun searchMangaRequest(page: Int, query: String, filters: FilterList): Request =
        throw UnsupportedOperationException()

    @Deprecated(HELPER_DEPRECATION)
    protected open fun searchMangaParse(response: Response): MangasPage = throw UnsupportedOperationException()

    @Suppress("DEPRECATION")
    @Deprecated("Use the suspend API instead", ReplaceWith("getLatestUpdates"))
    override fun fetchLatestUpdates(page: Int): Observable<MangasPage> =
        client.newCall(latestUpdatesRequest(page)).asObservableSuccess().map { latestUpdatesParse(it) }

    @Deprecated(HELPER_DEPRECATION)
    protected open fun latestUpdatesRequest(page: Int): Request = throw UnsupportedOperationException()

    @Deprecated(HELPER_DEPRECATION)
    protected open fun latestUpdatesParse(response: Response): MangasPage = throw UnsupportedOperationException()

    @Suppress("DEPRECATION")
    @Deprecated("Use the combined suspend API instead", replaceWith = ReplaceWith("getMangaUpdate"))
    override fun fetchMangaDetails(manga: SManga): Observable<SManga> =
        client.newCall(mangaDetailsRequest(manga)).asObservableSuccess()
            .map { mangaDetailsParse(it).apply { initialized = true } }

    @Deprecated(HELPER_DEPRECATION)
    open fun mangaDetailsRequest(manga: SManga): Request = GET(baseUrl + manga.url, headers)

    @Deprecated(HELPER_DEPRECATION)
    protected open fun mangaDetailsParse(response: Response): SManga = throw UnsupportedOperationException()

    @Suppress("DEPRECATION")
    @Deprecated("Use the combined suspend API instead", replaceWith = ReplaceWith("getMangaUpdate"))
    override fun fetchChapterList(manga: SManga): Observable<List<SChapter>> =
        client.newCall(chapterListRequest(manga)).asObservableSuccess().map { chapterListParse(it) }

    @Deprecated(HELPER_DEPRECATION)
    protected open fun chapterListRequest(manga: SManga): Request = GET(baseUrl + manga.url, headers)

    @Deprecated(HELPER_DEPRECATION)
    protected open fun chapterListParse(response: Response): List<SChapter> = throw UnsupportedOperationException()

    @Suppress("DEPRECATION")
    @Deprecated("Use the suspend API instead", ReplaceWith("getPageList"))
    override fun fetchPageList(chapter: SChapter): Observable<List<Page>> =
        client.newCall(pageListRequest(chapter)).asObservableSuccess().map { pageListParse(it) }

    @Deprecated(HELPER_DEPRECATION)
    protected open fun pageListRequest(chapter: SChapter): Request = GET(baseUrl + chapter.url, headers)

    @Deprecated(HELPER_DEPRECATION)
    protected open fun pageListParse(response: Response): List<Page> = throw UnsupportedOperationException()

    @Suppress("DEPRECATION")
    @Deprecated("Use the suspend API instead", ReplaceWith("getImageUrl"))
    open fun fetchImageUrl(page: Page): Observable<String> =
        client.newCall(imageUrlRequest(page)).asObservableSuccess().map { imageUrlParse(it) }

    @Suppress("DEPRECATION")
    open suspend fun getImageUrl(page: Page): String = fetchImageUrl(page).awaitSingle()

    @Deprecated(HELPER_DEPRECATION)
    protected open fun imageUrlRequest(page: Page): Request = GET(page.url, headers)

    @Deprecated(HELPER_DEPRECATION)
    protected open fun imageUrlParse(response: Response): String = throw UnsupportedOperationException()

    protected open fun imageRequest(page: Page): Request = GET(page.imageUrl!!, headers)

    fun SChapter.setUrlWithoutDomain(url: String) {
        this.url = getUrlWithoutDomain(url)
    }

    fun SManga.setUrlWithoutDomain(url: String) {
        this.url = getUrlWithoutDomain(url)
    }

    private fun getUrlWithoutDomain(orig: String): String = try {
        val uri = URI(orig.replace(" ", "%20"))
        var out = uri.path
        if (uri.query != null) out += "?" + uri.query
        if (uri.fragment != null) out += "#" + uri.fragment
        out
    } catch (_: URISyntaxException) {
        orig
    }

    @Suppress("DEPRECATION")
    open fun getMangaUrl(manga: SManga): String = mangaDetailsRequest(manga).url.toString()

    @Suppress("DEPRECATION")
    open fun getChapterUrl(chapter: SChapter): String = pageListRequest(chapter).url.toString()

    @Deprecated("All modifications should be done when constructing the chapter")
    open fun prepareNewChapter(chapter: SChapter, manga: SManga) {}
}

internal const val HELPER_DEPRECATION =
    "The helper functions are inherently limiting and hides the underlying implementation. " +
        "Source developers should make their own implementation according to their needs."
