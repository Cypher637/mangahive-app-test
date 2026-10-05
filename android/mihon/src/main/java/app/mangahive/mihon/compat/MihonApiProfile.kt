package app.mangahive.mihon.compat

/**
 * A pinned fact about upstream. `value == null` means UNRESOLVED: nobody has verified it against the
 * upstream artifact yet. `evidence` always says where the value (or the gap) comes from.
 */
data class Pin(val value: String?, val evidence: String) {
    val resolved: Boolean get() = value != null
}

/** A library the host must provide for the API to be usable, and why it matters. */
data class HostDependency(val coordinate: String, val version: String, val reason: String)

/**
 * Explicit description of ONE upstream Mihon/Tachiyomi extension-API generation.
 *
 * This describes upstream. It is not an implementation of it: [runtimeImplemented] is false for every profile
 * in Stage 1, and nothing in MangaHive may report a profile as "supported at runtime" until a later stage
 * loads real extension bytecode against the real artifact and a test proves it.
 */
data class MihonApiProfile(
    val id: String,
    val apiGeneration: String,
    val apiVersion: String,
    val artifact: Pin,
    val releaseTag: Pin,
    val releaseCommit: Pin,
    val sourceContract: List<String>,
    val modelContract: List<String>,
    val networkContract: List<String>,
    val entryPoint: List<String>,
    val supportedCapabilities: List<String>,
    val unsupportedCapabilities: List<String>,
    val hostDependencies: List<HostDependency>,
    val notes: List<String>,
    val runtimeImplemented: Boolean = false,
)

object MihonApiProfiles {

    val MIHON_1_6 = MihonApiProfile(
        id = "MIHON_1_6",
        apiGeneration = "tachiyomix (Mihon 0.x) suspend-first generation",
        apiVersion = "1.6",
        artifact = Pin(
            "com.github.mihonapp:tachiyomix:1.6",
            "tachiyomix README: compileOnly(\"com.github.mihonapp:tachiyomix:1.6\") via https://www.jitpack.io",
        ),
        releaseTag = Pin(
            "1.6.0",
            "tachiyomix CHANGELOG: '## [1.6.0] - Jun 28, 2026'. README says coordinate version '1.6': tag vs coordinate " +
                "spelling not yet confirmed against JitPack (verify-pins.sh step 2).",
        ),
        releaseCommit = Pin(
            null,
            "UNRESOLVED: GitHub tags page is robots-blocked for automated access; run verify-pins.sh step 1 (git ls-remote).",
        ),
        sourceContract = listOf(
            "eu.kanade.tachiyomi.source.online.HttpSource (package confirmed by Mihon source-api path source/online/HttpSource.kt)",
            "Source suspend API per CHANGELOG 1.6.0: getPopularManga, getLatestUpdates, getSearchManga, getMangaUpdate, getPageList, getFilterList",
            "HttpSource additions per CHANGELOG 1.6.0: getHomeUrl, getImageUrl",
            "Legacy request/parse methods and fetch* methods still present but deprecated in 1.6.0",
        ),
        modelContract = listOf(
            "SManga, SChapter, Page, MangasPage, Filter/FilterList (eu.kanade.tachiyomi.source.model)",
            "1.6.0 adds SManga.memo and SChapter.memo (JSON objects)",
            "Unreleased on main (NOT in 1.6.0): SManga.genres/altTitles/contentRating/score/..., SChapter.number/volume/scanlators/..., Source.language",
            "SMangaUpdate result type for getMangaUpdate: exact shape NOT read from 1.6.0 sources (UNRESOLVED)",
        ),
        networkContract = listOf(
            "OkHttp request/response types appear directly in HttpSource signatures",
            "NetworkHelper.client (cloudflareClient deprecated in 1.6.0 in favour of client)",
            "HttpException and Call.awaitSuccess helpers added in 1.6.0",
            "Dependencies injected through Injekt",
        ),
        entryPoint = listOf(
            "<uses-feature android:name=\"tachiyomi.extension\"/>",
            "meta-data tachiyomix.name, tachiyomix.contentWarning (0 safe / 1 mixed / 2 NSFW), tachiyomix.extensionLib = \"1.6\"",
            "meta-data tachiyomi.extension.class = fully-qualified class, or relative like \".Mihon\"",
            "Mihon v0.20.0 (2026-06-27, commit 19f1d00) is the first Mihon release noted as supporting tachiyomix 1.6",
        ),
        supportedCapabilities = listOf(
            "TARGET (not implemented): browse popular/latest, text search with FilterList, manga+chapter update, page list, lazy image-URL resolution via an HttpSource",
        ),
        unsupportedCapabilities = listOf(
            "Not claimed: ConfigurableSource preference screens",
            "Not claimed: WebView-dependent sources and Cloudflare/WebView challenge solving",
            "Not claimed: login / account sources",
            "Not claimed: Komikku-only related-manga hooks, full-chapter download hooks, URL deeplink intents",
            "Not claimed: any API listed under 'Unreleased' on tachiyomix main",
            "Not claimed: compatibility with every published extension",
        ),
        hostDependencies = listOf(
            HostDependency("org.jetbrains.kotlin:kotlin-stdlib", "2.4.0", "stub metadata is Kotlin 2.4; older compilers cannot read it"),
            HostDependency("org.jetbrains.kotlinx:kotlinx-coroutines-core", "1.11.0", "suspend source API"),
            HostDependency("org.jetbrains.kotlinx:kotlinx-serialization-json(+json-okio,+protobuf)", "1.11.0", "memo JSON; extension DTO parsing"),
            HostDependency("com.squareup.okhttp3:okhttp(+okhttp-brotli,+okhttp-zstd)", "5.5.0", "HttpSource network types"),
            HostDependency("org.jsoup:jsoup", "1.23.1", "HTML parsing in extensions"),
            HostDependency("com.github.mihonapp:injekt", "91edab2317", "dependency lookup used by extensions"),
        ),
        notes = listOf(
            "Host-dependency versions copied from tachiyomix README on main (2026-10-01); an earlier snapshot of the same README listed older versions. Re-verify at the 1.6.0 tag.",
            "KeiSource (keiyoushi.source.KeiSource) is NOT part of this contract. It is a Keiyoushi/Yuzono build-system base class over HttpSource; " +
                "where its bytecode is packaged (inside each APK vs. host) is UNRESOLVED and must be read from a real APK in a later stage.",
        ),
    )

    val MIHON_1_4 = MihonApiProfile(
        id = "MIHON_1_4",
        apiGeneration = "legacy request/parse + Observable fetch* generation",
        apiVersion = "1.4",
        artifact = Pin(
            null,
            "UNRESOLVED: only third-party fork READMEs show 'com.github.mihonapp:tachiyomix:1.4.4' and " +
                "'com.github.mihonapp:extensions-lib:1.4.4'; no upstream-authoritative coordinate was read.",
        ),
        releaseTag = Pin(null, "UNRESOLVED: see artifact."),
        releaseCommit = Pin(null, "UNRESOLVED: see artifact."),
        sourceContract = listOf(
            "HttpSource with xxxRequest/xxxParse pairs",
            "Observable-returning fetch* methods (inferred: tachiyomix 1.6.0 CHANGELOG deprecates fetchPopularManga/fetchLatestUpdates/fetchSearchManga/fetchMangaDetails/fetchChapterList/fetchPageList and Call.asObservable)",
            "ParsedHttpSource (deprecated in 1.6.0)",
        ),
        modelContract = listOf("SManga, SChapter, Page, MangasPage, FilterList (no memo fields)"),
        networkContract = listOf(
            "OkHttp client via NetworkHelper (cloudflareClient existed, deprecated in 1.6.0)",
            "rateLimit / rateLimitHost helpers (deprecated in 1.6.0)",
        ),
        entryPoint = listOf(
            "Library version conveyed via versionName prefix per Keiyoushi CONTRIBUTING ('1.4.<code>'). Mihon's own reader of 1.4 manifests was NOT inspected.",
            "tachiyomi.extension.class meta-data (assumed unchanged; UNVERIFIED for 1.4)",
        ),
        supportedCapabilities = listOf("TARGET (not implemented): same browse/search/details/chapters/pages flow via request/parse"),
        unsupportedCapabilities = listOf(
            "Not claimed: anything until the 1.4 artifact is pinned and compiled against",
            "Not claimed: ConfigurableSource, WebView, login sources, Cloudflare bypass",
            "Not claimed: Observable/RxJava bridging",
        ),
        hostDependencies = emptyList(),
        notes = listOf("Profile is a placeholder boundary. No pinned 1.4 dependency list exists yet."),
    )

    val all: List<MihonApiProfile> = listOf(MIHON_1_6, MIHON_1_4)
}
