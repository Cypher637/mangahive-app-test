package app.mangahive.compat.shapes16

import eu.kanade.tachiyomi.source.model.Filter
import eu.kanade.tachiyomi.source.model.MangasPage
import eu.kanade.tachiyomi.source.model.Page
import eu.kanade.tachiyomi.source.model.SChapter
import eu.kanade.tachiyomi.source.online.HttpSource

/**
 * COMPILE-TIME SHAPE ONLY.
 *
 * Call surface of the 1.6 suspend API as a host would use it. Each name comes from the tachiyomix 1.6.0
 * CHANGELOG ("Source.getPopularManga", "getLatestUpdates", "getSearchManga", "getPageList", "getFilterList");
 * argument lists follow the Keiyoushi CONTRIBUTING signatures for the same methods.
 *
 * NOT covered, deliberately: Source.getMangaUpdate. The CHANGELOG names it and a tachiyomix PR (#37) shows its
 * result type SMangaUpdate is still changing, but no exact signature was read from the 1.6.0 sources. It must be
 * added only after reading them (see verify-pins.sh / README "Unresolved"). If any call below fails to compile,
 * that is a real finding about the 1.6 API, not a build glitch.
 */
@Suppress("unused", "UNUSED_VARIABLE")
suspend fun suspendCallSurface(source: HttpSource, chapter: SChapter): List<Page> {
    val popular: MangasPage = source.getPopularManga(1)
    val latest: MangasPage = source.getLatestUpdates(1)
    val search: MangasPage = source.getSearchManga(1, "query", source.getFilterList())
    return source.getPageList(chapter)
}

/** Custom Filter subclass: verbatim pattern from Keiyoushi CONTRIBUTING ("UriPartFilter"). */
open class UriPartFilter(displayName: String, private val vals: Array<Pair<String, String>>) :
    Filter.Select<String>(displayName, vals.map { it.first }.toTypedArray()) {
    fun toUriPart() = vals[state].second
}
