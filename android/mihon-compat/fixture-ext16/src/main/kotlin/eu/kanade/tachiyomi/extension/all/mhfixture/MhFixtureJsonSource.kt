package eu.kanade.tachiyomi.extension.all.mhfixture

import eu.kanade.tachiyomi.network.GET
import eu.kanade.tachiyomi.network.HttpException
import eu.kanade.tachiyomi.network.NetworkHelper
import eu.kanade.tachiyomi.network.await
import eu.kanade.tachiyomi.network.awaitSuccess
import eu.kanade.tachiyomi.network.interceptor.rateLimit
import eu.kanade.tachiyomi.source.model.FilterList
import eu.kanade.tachiyomi.source.model.MangasPage
import eu.kanade.tachiyomi.source.model.Page
import eu.kanade.tachiyomi.source.model.SChapter
import eu.kanade.tachiyomi.source.model.SManga
import eu.kanade.tachiyomi.source.model.SMangaUpdate
import eu.kanade.tachiyomi.source.online.HttpSource
import kotlinx.coroutines.TimeoutCancellationException
import kotlinx.coroutines.withTimeout
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.int
import kotlinx.serialization.json.jsonArray
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import kotlinx.serialization.json.long
import okhttp3.Headers
import okhttp3.OkHttpClient
import uy.kohesive.injekt.Injekt
import uy.kohesive.injekt.api.InjektScope
import uy.kohesive.injekt.api.get
import uy.kohesive.injekt.injectLazy
import uy.kohesive.injekt.registry.default.DefaultRegistrar
import java.util.concurrent.TimeUnit

/**
 * JSON-API style Source using the 1.6.0 suspend API (getSearchManga / getMangaUpdate / getPageList), Injekt, a client
 * customised in a PROPERTY INITIALISER (network.client.newBuilder()...), an extension interceptor and rateLimit.
 * Some queries deliberately misbehave so the host's controls can be observed.
 */
@Suppress("DEPRECATION")
class MhFixtureJsonSource : HttpSource() {
    override val name = "MH Fixture JSON"
    override val lang = "all"
    override val baseUrl = fixtureBaseUrl()
    override val supportsLatest = false

    private val json: Json by injectLazy()

    override val client: OkHttpClient = network.client.newBuilder()
        .addInterceptor { chain ->
            chain.proceed(chain.request().newBuilder().header("X-Fixture-Interceptor", "1").build())
        }
        .rateLimit(100)
        .build()

    override fun headersBuilder(): Headers.Builder = super.headersBuilder().add("Referer", "$baseUrl/")

    /** For the host test: what `network.client` resolves to right now (fails closed outside a host scope). */
    fun currentNetworkClient(): OkHttpClient = network.client

    /** For the host test: a synchronous request on whatever thread (and host scope, if any) calls this. */
    fun requestFromCurrentThread(path: String): Int = client.newCall(GET("$baseUrl$path", headers)).execute().use { it.code }

    override suspend fun getPopularManga(page: Int): MangasPage = getSearchManga(page, "", FilterList())

    override suspend fun getLatestUpdates(page: Int): MangasPage = throw UnsupportedOperationException()

    override suspend fun getSearchManga(page: Int, query: String, filters: FilterList): MangasPage = when {
        query == "privileged" -> {
            client.newCall(GET("$baseUrl/api/search?q=privileged", headers.newBuilder().add("X-MangaHive-Token", "x").build())).awaitSuccess()
            single("unreachable")
        }
        query == "detach" -> try {
            val detached = client.newBuilder().apply { interceptors().clear() }.build()
            detached.newCall(GET("$baseUrl/detach", headers)).execute().close()
            single("detach-NOT-blocked")
        } catch (e: Exception) {
            single("detach-blocked:" + e.javaClass.simpleName)
        }
        query == "slow" -> {
            client.newBuilder().readTimeout(1, TimeUnit.SECONDS).build().newCall(GET("$baseUrl/slow", headers)).awaitSuccess()
            single("unreachable")
        }
        query == "hang" -> {
            client.newCall(GET("$baseUrl/hang", headers)).await()
            single("unreachable")
        }
        query == "selfcancel" -> try {
            withTimeout(700) { client.newCall(GET("$baseUrl/hang", headers)).await() }
            single("unreachable")
        } catch (e: TimeoutCancellationException) {
            single("self-cancelled")
        }
        query == "big" -> {
            client.newCall(GET("$baseUrl/big", headers)).awaitSuccess().use { it.body.bytes() }
            single("unreachable")
        }
        query == "httperror" -> try {
            client.newCall(GET("$baseUrl/status/500", headers)).awaitSuccess()
            single("unreachable")
        } catch (e: HttpException) {
            single("http-error:" + e.code + ":" + e.message)
        }
        query == "injekt" -> {
            val viaInjekt = Injekt.get<NetworkHelper>()
            single("injekt:" + (viaInjekt === network) + ":" + (Injekt.get<Json>() === json))
        }
        query == "injekt-hijack" -> {
            // Hostile: replace the global registry. The host must restore its scope before the next construction.
            Injekt = InjektScope(DefaultRegistrar())
            single("injekt-hijacked")
        }
        query.startsWith("live:") -> {
            val code = client.newCall(GET(query.removePrefix("live:"), headers)).await().use { it.code }
            single("live:$code")
        }
        else -> {
            val body = client.newCall(GET("$baseUrl/api/search?q=$query&page=$page", headers)).awaitSuccess().use { it.body.string() }
            val o = json.parseToJsonElement(body).jsonObject
            val mangas = o["mangas"]!!.jsonArray.map { e ->
                val m = e.jsonObject
                SManga.create().apply {
                    url = m["url"]!!.jsonPrimitive.content
                    title = m["title"]!!.jsonPrimitive.content
                    thumbnail_url = m["thumb"]?.jsonPrimitive?.content
                }
            }
            MangasPage(mangas, o["hasNext"]!!.jsonPrimitive.content.toBoolean())
        }
    }

    override suspend fun getMangaUpdate(
        manga: SManga,
        chapters: List<SChapter>,
        fetchDetails: Boolean,
        fetchChapters: Boolean,
    ): SMangaUpdate {
        val details = if (fetchDetails) {
            val o = getJson("$baseUrl/api/manga?url=${manga.url}").jsonObject
            SManga.create().apply {
                url = manga.url
                title = o["title"]!!.jsonPrimitive.content
                author = o["author"]?.jsonPrimitive?.content
                artist = o["artist"]?.jsonPrimitive?.content
                description = o["description"]?.jsonPrimitive?.content
                genre = o["genre"]?.jsonPrimitive?.content
                status = o["status"]!!.jsonPrimitive.int
                thumbnail_url = o["thumb"]?.jsonPrimitive?.content
                memo = JsonObject(manga.memo + ("fetchedBy" to JsonPrimitive(name)))
                initialized = true
            }
        } else {
            manga
        }
        val list = if (fetchChapters) {
            // Synchronous execute() on the calling (host-scoped) thread, unlike the enqueue-based awaits above.
            val body = client.newCall(GET("$baseUrl/api/chapters?url=${manga.url}", headers)).execute().use { it.body.string() }
            json.parseToJsonElement(body).jsonArray.map { e ->
                val c = e.jsonObject
                SChapter.create().apply {
                    url = c["url"]!!.jsonPrimitive.content
                    name = c["name"]!!.jsonPrimitive.content
                    chapter_number = c["number"]!!.jsonPrimitive.content.toFloat()
                    date_upload = c["date"]!!.jsonPrimitive.long
                    scanlator = c["scanlator"]?.jsonPrimitive?.content
                }
            }
        } else {
            chapters
        }
        return SMangaUpdate(details, list)
    }

    override suspend fun getPageList(chapter: SChapter): List<Page> =
        getJson("$baseUrl/api/pages?url=${chapter.url}").jsonArray.mapIndexed { i, e ->
            val p = e.jsonObject
            Page(i, p["url"]!!.jsonPrimitive.content, p["imageUrl"]?.jsonPrimitive?.content)
        }

    private suspend fun getJson(url: String) =
        json.parseToJsonElement(client.newCall(GET(url, headers)).awaitSuccess().use { it.body.string() })

    private fun single(title: String) = MangasPage(listOf(SManga.create().apply { url = "/x"; this.title = title }), false)
}
