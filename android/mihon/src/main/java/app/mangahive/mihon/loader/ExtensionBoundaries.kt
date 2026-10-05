package app.mangahive.mihon.loader

/**
 * The only classes an extension (or the compat bundle) may see. Allow-lists only; unknown packages fail closed.
 * Everything named here that is marked ASSUMED comes from Stage 1 evidence, not from reading the upstream artifact:
 * if a real extension needs another package it fails with ClassNotFoundException naming it, and the list is amended
 * deliberately.
 */
object ExtensionBoundaries {
    private const val SPI = "app.mangahive.mihon.spi"

    /** Platform classes. WebView is excluded: WebView-dependent sources are unsupported (MIHON_API_PROFILES.md). */
    val FRAMEWORK = BoundaryClassLoader.Route(
        "framework",
        PackageBoundary.builder().tree("java", "javax", "android", "org.json", "org.xml.sax", "org.w3c.dom").build(),
        PackageBoundary.builder().tree("android.webkit").build(),
        platformLoader(),
    )

    /** Extension-visible upstream surface, served from the compat bundle's loader only (never the app loader). */
    fun compatApi(compatLoader: ClassLoader) = BoundaryClassLoader.Route(
        "compat-api",
        PackageBoundary.builder().tree(
            "kotlin", "kotlinx.coroutines", "kotlinx.serialization",
            "okhttp3", "okio", "org.jsoup",
            "rx",                                // io.reactivex:rxjava 1.x: deprecated Rx Source API (tachiyomix 1.6.0 pom)
            "uy.kohesive.injekt",                // com.github.mihonapp:injekt registry API (verified, Stage 6.6A); dev.mihon.injekt stays host-only
            "eu.kanade.tachiyomi.source",        // Source, SourceFactory, model.*, online.HttpSource (verified 1.6.0 AAR)
            "eu.kanade.tachiyomi.network",       // NetworkHelper, GET/POST, await/awaitSuccess, HttpException, interceptor.*
            "eu.kanade.tachiyomi.util",          // Response.asJsoup
        ).exact(
            "eu.kanade.tachiyomi",               // AppInfo only (the bundle defines nothing else in this package)
        ).build(),
        PackageBoundary.NONE,
        compatLoader,
    )

    /** What the compat bundle may see from the HOST: the SPI package, exactly. Nothing else of MangaHive. */
    fun hostSpi(hostLoader: ClassLoader) = BoundaryClassLoader.Route(
        "host-spi", PackageBoundary.builder().exact(SPI).build(), PackageBoundary.NONE, hostLoader,
    )

    private fun platformLoader(): ClassLoader? = Any::class.java.classLoader
}
