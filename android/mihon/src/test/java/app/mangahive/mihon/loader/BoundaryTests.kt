package app.mangahive.mihon.loader

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Assert.fail
import org.junit.Test

class PackageBoundaryTest {
    private val b = PackageBoundary.builder().tree("okhttp3", "eu.kanade.tachiyomi.source").exact("app.mangahive.mihon.spi").build()

    @Test fun treeAdmitsPackageAndDescendants() {
        assertTrue(b.allows("okhttp3.Request"))
        assertTrue(b.allows("okhttp3.internal.Util"))
        assertTrue(b.allows("eu.kanade.tachiyomi.source.model.SManga"))
        assertTrue(b.allows("okhttp3.Request\$Builder"))
    }

    @Test fun siblingPrefixesAreNotAdmitted() { // the naive startsWith() bug class
        assertFalse(b.allows("okhttp3evil.Request"))
        assertFalse(b.allows("eu.kanade.tachiyomi.sourcefoo.X"))
        assertFalse(b.allows("eu.kanade.tachiyomi.extension.all.mhfixture.FixtureSource"))
        assertFalse(b.allows("eu.kanade.tachiyomi.Other"))
    }

    @Test fun exactDoesNotAdmitSubpackages() {
        assertTrue(b.allows("app.mangahive.mihon.spi.SourceGateway"))
        assertFalse(b.allows("app.mangahive.mihon.spi.sub.X"))
        assertFalse(b.allows("app.mangahive.mihon.loader.ExtensionLoader"))
        assertFalse(b.allows("app.mangahive.MainActivity"))
    }

    @Test fun malformedNamesNeverPass() {
        for (n in listOf("", "Foo", ".Foo", "okhttp3.", "okhttp3..Foo", "okhttp3/Request", "okhttp3.Re quest", "[Lokhttp3.Request;", "okhttp3.Request;")) {
            assertFalse("should reject '$n'", b.allows(n))
        }
    }

    @Test fun builderRejectsBadPackages() {
        try { PackageBoundary.builder().tree("a..b"); fail() } catch (_: IllegalArgumentException) {}
    }
}

class BoundaryClassLoaderTest {
    private val frameworkOnly = BoundaryClassLoader(listOf(ExtensionBoundaries.FRAMEWORK))
    private val withCompat = BoundaryClassLoader(listOf(ExtensionBoundaries.FRAMEWORK, ExtensionBoundaries.compatApi(ClassLoader.getSystemClassLoader())))

    private fun blocked(l: ClassLoader, name: String) {
        try { l.loadClass(name); fail("$name must not load") } catch (_: ClassNotFoundException) {}
    }

    @Test fun platformClassesLoad() {
        assertEquals("java.lang.String", frameworkOnly.loadClass("java.lang.String").name)
    }

    @Test fun hostInternalsAreInvisible() {
        for (l in listOf(frameworkOnly, withCompat)) {
            blocked(l, "app.mangahive.mihon.loader.SourceKey")
            blocked(l, "app.mangahive.mihon.runtime.RuntimeEngine")
            blocked(l, "app.mangahive.mihon.bridge.MihonJsBridge")
            blocked(l, "app.mangahive.MainActivity")
            blocked(l, "io.github.jan.supabase.SupabaseClient")
            blocked(l, "androidx.room.Room")
        }
    }

    @Test fun webViewIsDeniedEvenThoughAndroidIsAllowed() {
        blocked(frameworkOnly, "android.webkit.WebView")
    }

    @Test fun compatPackagesOnlyWhenRouted() {
        blocked(frameworkOnly, "kotlin.Unit")
        assertEquals("kotlin.Unit", withCompat.loadClass("kotlin.Unit").name)
        blocked(withCompat, "okhttp3evil.X")
        blocked(withCompat, "eu.kanade.tachiyomi.sourcefoo.X")
        blocked(withCompat, "eu.kanade.tachiyomi.extension.all.x.Y")
    }

    @Test fun resourcesAreNeverServed() {
        assertNull(withCompat.getResource("META-INF/MANIFEST.MF"))
        assertNull(withCompat.getResourceAsStream("META-INF/MANIFEST.MF"))
        assertFalse(withCompat.getResources("META-INF/MANIFEST.MF").hasMoreElements())
        assertNotNull(withCompat)
    }
}
