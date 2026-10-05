package app.mangahive.mihon.loader

import app.mangahive.mihon.spi.CompatGateway
import app.mangahive.mihon.spi.GatewayException
import app.mangahive.mihon.spi.SourceGateway
import java.io.File

/**
 * Fakes of the SPI/ports only (no upstream types). They exercise the loader pipeline's decisions.
 * They are NOT the Stage 3 gate: that is RealStage2ApkLoadTest against the real APK.
 */
object TestFixtures {
    class FakeSource(
        val entry: String, val id: Long, val nm: String = "Src$id", val lg: String = "en",
        private val search: String = """{"mangas":[{"url":"/api/manga/m1","title":"Hive Alpha","thumbnailUrl":"https://x/c.png"},{"url":"","title":"dropped"}],"hasNextPage":true}""",
    ) : SourceGateway {
        override fun entryClassName() = entry
        override fun sourceId() = id
        override fun name() = nm
        override fun lang() = lg
        override fun supportsLatest() = false
        override fun baseUrl(): String? = "https://localhost:8443"
        override fun searchJson(ctx: app.mangahive.mihon.spi.RequestContext, page: Int, query: String) = search
        override fun detailsJson(ctx: app.mangahive.mihon.spi.RequestContext, mangaUrl: String): String = throw GatewayException("NOT_IMPLEMENTED", "x")
        override fun chaptersJson(ctx: app.mangahive.mihon.spi.RequestContext, mangaUrl: String): String = throw GatewayException("NOT_IMPLEMENTED", "x")
        override fun pagesJson(ctx: app.mangahive.mihon.spi.RequestContext, chapterUrl: String) = """{"pages":[{"index":0,"imageUrl":"https://x/0.png"},{"index":1,"imageUrl":"https://x/1.png"}]}"""
    }

    fun adapter(ext: String, id: Long) =
        MangaHiveSourceAdapter(SourceInfo("mihon:$ext:$id", ext, id, "Src$id", "en", false, null, "$ext.E"), FakeSource("$ext.E", id))

    class FakeRuntime(val onInstantiate: (ClassLoader, List<String>) -> List<SourceGateway>) : CompatRuntime {
        var calls = 0
        override val apiVersion = "1.6"
        override val compatLoader: ClassLoader = ClassLoader.getSystemClassLoader()
        override val gateway = object : CompatGateway {
            override fun apiVersion() = "1.6"
            override fun instantiate(extensionLoader: ClassLoader, extensionId: String, entryClassNames: List<String>, brokers: app.mangahive.mihon.spi.HttpBrokerHost): List<SourceGateway> {
                calls++; return onInstantiate(extensionLoader, entryClassNames)
            }
        }
    }

    class FakeManifests(var manifest: RawManifest?) : ManifestReader { override fun read(apk: File) = manifest }
    class CountingFactory : ExtensionClassLoaderFactory {
        var created = 0
        override fun create(apk: File, extensionId: String, parent: ClassLoader): ClassLoader { created++; return parent }
    }

    const val PKG = "eu.kanade.tachiyomi.extension.all.mhfixture"
    fun manifest(pkg: String = PKG, lib: String? = "1.6", cls: String = ".FixtureFactory", signer: String = "sig1") = RawManifest(
        pkg, "1.6.1", 1, setOf("tachiyomi.extension"),
        mapOf("tachiyomix.extensionLib" to lib, "tachiyomi.extension.class" to cls, "tachiyomix.contentWarning" to "0"), listOf(signer),
    )
}
