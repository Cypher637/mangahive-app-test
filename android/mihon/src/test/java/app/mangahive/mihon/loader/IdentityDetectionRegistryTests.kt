package app.mangahive.mihon.loader

import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Assert.fail
import org.junit.Test

class SourceKeyTest {
    @Test fun roundTrips() {
        val k = SourceKey.of("eu.kanade.tachiyomi.extension.all.mhfixture", 123456789012L)
        assertEquals("mihon:eu.kanade.tachiyomi.extension.all.mhfixture:123456789012", k.value)
        assertEquals(k, SourceKey.parse(k.value))
    }

    @Test fun rejectsAmbiguousOrForeignKeys() {
        for (s in listOf("mihon:a.b:1:2", "mihon:a.b:", "mihon::1", "mihon:a:1", "other:a.b:1", "mihon:a.b:x", "mihon:a.b:99999999999999999999", "mihon:a b.c:1", "")) {
            assertNull("should reject '$s'", SourceKey.parse(s))
        }
        try { SourceKey.of("evil:colon.x", 1); fail() } catch (_: IllegalArgumentException) {}
    }

    @Test fun sameSourceIdInDifferentExtensionsDoesNotCollide() {
        assertTrue(SourceKey.of("a.b", 7) != SourceKey.of("c.d", 7))
    }
}

class ExtensionDetectorTest {
    private val pkg = "eu.kanade.tachiyomi.extension.all.mhfixture"
    private fun raw(
        features: Set<String> = setOf("tachiyomi.extension"),
        lib: String? = "1.6", cls: String? = ".FixtureSource", warning: String? = "0",
    ) = RawManifest(pkg, "1.6.1", 1, features,
        mapOf("tachiyomix.extensionLib" to lib, "tachiyomi.extension.class" to cls, "tachiyomix.contentWarning" to warning, "tachiyomix.name" to "Tachiyomi: MH Fixture"),
        listOf("aa"))
    private val ok = setOf("1.6")

    private fun rejected(r: RawManifest) = (ExtensionDetector.detect(r, ok) as Detection.Rejected).code

    @Test fun acceptsRelativeEntryClass() {
        val d = (ExtensionDetector.detect(raw(), ok) as Detection.Compatible).descriptor
        assertEquals(listOf("$pkg.FixtureSource"), d.entryClasses)
        assertEquals("1.6", d.apiVersion)
    }

    @Test fun acceptsSeveralEntryClasses() {
        val d = (ExtensionDetector.detect(raw(cls = ".A; $pkg.sub.B ;C"), ok) as Detection.Compatible).descriptor
        assertEquals(listOf("$pkg.A", "$pkg.sub.B", "$pkg.C"), d.entryClasses)
    }

    @Test fun rejectsIncompatibleOrMissingApi() {
        assertEquals(LoadFailureCode.INCOMPATIBLE_API, rejected(raw(lib = "1.4")))
        assertEquals(LoadFailureCode.INCOMPATIBLE_API, rejected(raw(lib = "1.6.0")))
        assertEquals(LoadFailureCode.INCOMPATIBLE_API, rejected(raw(lib = null)))
    }

    @Test fun rejectsNonExtensions() {
        assertEquals(LoadFailureCode.NOT_AN_EXTENSION, rejected(raw(features = emptySet())))
        assertEquals(LoadFailureCode.NOT_AN_EXTENSION, rejected(raw(warning = "7")))
    }

    @Test fun rejectsEntryClassesOutsideThePackageByExactMatch() {
        for (c in listOf("app.mangahive.mihon.runtime.MihonExtensionService", "com.evil.X", "${pkg}evil.X", "eu.kanade.tachiyomi.extension.all.mhfixturefoo.X", "", ";", "..X")) {
            assertEquals("'$c'", LoadFailureCode.BAD_ENTRY_POINT, rejected(raw(cls = c)))
        }
        assertEquals(LoadFailureCode.BAD_ENTRY_POINT, rejected(raw(cls = null)))
    }

    @Test fun tooManyEntryClassesRejected() {
        assertEquals(LoadFailureCode.BAD_ENTRY_POINT, rejected(raw(cls = (1..17).joinToString(";") { "C$it" })))
    }
}

class MihonSourceRegistryTest {
    private fun entry(ext: String, id: Long, signers: Set<String>) =
        MihonSourceRegistry.Entry(SourceKey.of(ext, id), signers, TestFixtures.adapter(ext, id))

    @Test fun ownerBoundToFirstSigner() {
        val r = MihonSourceRegistry()
        r.replaceExtension("a.b", listOf("s1"), listOf(entry("a.b", 1, setOf("s1"))))
        assertTrue(r.mayOwn("a.b", listOf("s1")))
        assertTrue(!r.mayOwn("a.b", listOf("s2")))
        assertTrue(!r.mayOwn("a.b", emptyList()))
        try { r.replaceExtension("a.b", listOf("s2"), listOf(entry("a.b", 1, setOf("s2")))); fail() } catch (_: IllegalArgumentException) {}
        assertEquals(1, r.all().size)
    }

    @Test fun cannotRegisterAnotherExtensionsKey() {
        val r = MihonSourceRegistry()
        try { r.replaceExtension("a.b", listOf("s"), listOf(entry("c.d", 1, setOf("s")))); fail() } catch (_: IllegalArgumentException) {}
        assertTrue(r.all().isEmpty())
    }

    @Test fun duplicateIdsWithinOneExtensionAreAtomicallyRejected() {
        val r = MihonSourceRegistry()
        try { r.replaceExtension("a.b", listOf("s"), listOf(entry("a.b", 1, setOf("s")), entry("a.b", 1, setOf("s")))); fail() } catch (_: IllegalArgumentException) {}
        assertTrue(r.all().isEmpty())
    }

    @Test fun replaceSwapsOnlyThatExtension() {
        val r = MihonSourceRegistry()
        r.replaceExtension("a.b", listOf("s"), listOf(entry("a.b", 1, setOf("s")), entry("a.b", 2, setOf("s"))))
        r.replaceExtension("c.d", listOf("t"), listOf(entry("c.d", 1, setOf("t"))))
        r.replaceExtension("a.b", listOf("s"), listOf(entry("a.b", 3, setOf("s"))))
        assertEquals(setOf("mihon:a.b:3", "mihon:c.d:1"), r.all().map { it.key }.toSet())
    }
}
