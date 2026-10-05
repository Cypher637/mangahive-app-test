package app.mangahive.mihon.loader

import app.mangahive.mihon.loader.TestFixtures.CountingFactory
import app.mangahive.mihon.loader.TestFixtures.FakeManifests
import app.mangahive.mihon.loader.TestFixtures.FakeRuntime
import app.mangahive.mihon.loader.TestFixtures.FakeSource
import app.mangahive.mihon.loader.TestFixtures.PKG
import app.mangahive.mihon.loader.TestFixtures.manifest
import app.mangahive.mihon.spi.GatewayException
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test
import java.io.File

class ExtensionLoaderTest {
    private val CTX = app.mangahive.mihon.spi.RequestContext("test-1", app.mangahive.mihon.spi.CancelScope.root())
    private val apk = File("unused.apk")
    private val registry = MihonSourceRegistry()
    private val factory = CountingFactory()
    private val manifests = FakeManifests(manifest())

    private fun loader(rt: FakeRuntime?) = ExtensionLoader(manifests, { rt ?: throw CompatRuntimeUnavailable("no bundle") }, factory, registry)
    private fun failed(o: LoadOutcome) = (o as LoadOutcome.Failed).code

    @Test fun discoversMetadataAndRegistersSingleSource() {
        val rt = FakeRuntime { _, names -> listOf(FakeSource(names[0], 42, "MH Fixture (en)")) }
        val out = loader(rt).load(apk, PKG) as LoadOutcome.Loaded
        assertEquals(listOf("mihon:$PKG:42"), out.sources.map { it.key })
        assertEquals("MH Fixture (en)", out.sources[0].name)
        assertEquals("en", out.sources[0].lang)
        assertEquals("$PKG.FixtureFactory", out.sources[0].entryClass) // entry class passed through, relative name resolved
    }

    @Test fun oneApkCanYieldSeveralSources() {
        val rt = FakeRuntime { _, n -> listOf(FakeSource(n[0], 1, lg = "en"), FakeSource(n[0], 2, lg = "fr")) }
        val out = loader(rt).load(apk, PKG) as LoadOutcome.Loaded
        assertEquals(setOf("mihon:$PKG:1", "mihon:$PKG:2"), registry.all().map { it.key }.toSet())
        assertEquals(2, out.sources.size)
    }

    @Test fun sameSourceIdInTwoExtensionsDoesNotCollide() {
        val rt = FakeRuntime { _, n -> listOf(FakeSource(n[0], 7)) }
        val l = loader(rt)
        l.load(apk, PKG)
        manifests.manifest = manifest(pkg = "eu.kanade.tachiyomi.extension.en.other", cls = ".S")
        l.load(apk, "eu.kanade.tachiyomi.extension.en.other")
        assertEquals(2, registry.all().size)
    }

    @Test fun initializationFailureRegistersNothing() {
        val l1 = loader(FakeRuntime { _, _ -> throw GatewayException("ENTRY_LINKAGE", "boom") })
        assertEquals(LoadFailureCode.INIT_FAILED, failed(l1.load(apk, PKG)))
        val l2 = loader(FakeRuntime { _, _ -> throw NoSuchMethodError("x") })
        assertEquals(LoadFailureCode.INIT_FAILED, failed(l2.load(apk, PKG)))
        assertTrue(registry.all().isEmpty())
    }

    @Test fun incompatibleApiIsRejectedBeforeAnyClassLoading() {
        manifests.manifest = manifest(lib = "1.4")
        val rt = FakeRuntime { _, _ -> emptyList() }
        assertEquals(LoadFailureCode.INCOMPATIBLE_API, failed(loader(rt).load(apk, PKG)))
        assertEquals(0, factory.created); assertEquals(0, rt.calls)
    }

    @Test fun entryClassOutsidePackageIsRejectedBeforeAnyClassLoading() {
        manifests.manifest = manifest(cls = "app.mangahive.mihon.runtime.MihonExtensionService")
        val rt = FakeRuntime { _, _ -> emptyList() }
        assertEquals(LoadFailureCode.BAD_ENTRY_POINT, failed(loader(rt).load(apk, PKG)))
        assertEquals(0, factory.created); assertEquals(0, rt.calls)
    }

    @Test fun missingCompatBundleIsReportedNotThrown() {
        assertEquals(LoadFailureCode.COMPAT_RUNTIME_UNAVAILABLE, failed(loader(null).load(apk, PKG)))
    }

    @Test fun packageMismatchAndUnreadableApk() {
        val rt = FakeRuntime { _, n -> listOf(FakeSource(n[0], 1)) }
        assertEquals(LoadFailureCode.PACKAGE_MISMATCH, failed(loader(rt).load(apk, "some.other.pkg")))
        manifests.manifest = null
        assertEquals(LoadFailureCode.UNREADABLE_APK, failed(loader(rt).load(apk, PKG)))
    }

    @Test fun emptyOrDuplicateOrBadMetadataIsRejected() {
        assertEquals(LoadFailureCode.NO_SOURCES, failed(loader(FakeRuntime { _, _ -> emptyList() }).load(apk, PKG)))
        assertEquals(LoadFailureCode.DUPLICATE_SOURCE, failed(loader(FakeRuntime { _, n -> listOf(FakeSource(n[0], 1), FakeSource(n[0], 1)) }).load(apk, PKG)))
        assertEquals(LoadFailureCode.BAD_SOURCE_METADATA, failed(loader(FakeRuntime { _, n -> listOf(FakeSource(n[0], 1, lg = "en:evil")) }).load(apk, PKG)))
        assertEquals(LoadFailureCode.BAD_SOURCE_METADATA, failed(loader(FakeRuntime { _, n -> listOf(FakeSource(n[0], 1, nm = " ")) }).load(apk, PKG)))
        assertTrue(registry.all().isEmpty())
    }

    @Test fun differentSignerCannotTakeOverAnExistingExtensionId() {
        val rt = FakeRuntime { _, n -> listOf(FakeSource(n[0], 1)) }
        val l = loader(rt)
        l.load(apk, PKG)
        manifests.manifest = manifest(signer = "attacker")
        assertEquals(LoadFailureCode.OWNER_MISMATCH, failed(l.load(apk, PKG)))
        assertEquals(1, registry.sourcesOf(PKG).size) // original retained
    }

    @Test fun failedReloadKeepsPreviousRegistration() {
        var fail = false
        val rt = FakeRuntime { _, n -> if (fail) throw GatewayException("X", "y") else listOf(FakeSource(n[0], 1)) }
        val l = loader(rt)
        l.load(apk, PKG); fail = true
        assertEquals(LoadFailureCode.INIT_FAILED, failed(l.load(apk, PKG)))
        assertEquals(1, registry.all().size)
        l.unload(PKG)
        assertTrue(registry.all().isEmpty())
    }

    @Test fun adapterReturnsPlainModelsAndBoundsOutput() {
        val rt = FakeRuntime { _, n -> listOf(FakeSource(n[0], 5)) }
        loader(rt).load(apk, PKG)
        val a = registry.get("mihon:$PKG:5")!!
        val page = a.search(CTX, "hive", 1).getOrThrow()
        assertEquals(listOf(AdaptedManga("/api/manga/m1", "Hive Alpha", "https://x/c.png")), page.items) // blank-url entry dropped
        assertTrue(page.hasNextPage)
        assertEquals(2, a.pages(CTX, "/api/chapter/m1c1").getOrThrow().size)
        assertTrue(a.details(CTX, "/api/manga/m1").isFailure) // getMangaUpdate not implemented yet
        assertNull(registry.get("mihon:$PKG:999"))
    }
}
