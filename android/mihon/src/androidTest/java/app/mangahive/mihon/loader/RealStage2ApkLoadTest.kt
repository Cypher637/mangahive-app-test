package app.mangahive.mihon.loader

import androidx.test.platform.app.InstrumentationRegistry
import app.mangahive.mihon.runtime.RuntimeProcessGate
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Assume.assumeTrue
import org.junit.Test
import java.io.File

/**
 * THE Stage 3 gate. Loads the real, independently built Stage 2 APK through the real compat bundle.
 * Contains no ControlledSource and no fake gateway. Skipped (reported as skipped, NOT passed) unless all three
 * instrumentation arguments are supplied:
 *   -e stage2Apk <path> -e compatBundle <path> -e compatBundleSha256 <hex>
 * The files must already be on the device (adb push). Also needs `adb reverse tcp:8443 tcp:8443` for the search call.
 */
class RealStage2ApkLoadTest {
    private val args = InstrumentationRegistry.getArguments()
    private val ctx = InstrumentationRegistry.getInstrumentation().targetContext

    @Test fun loadsRealStage2ApkAndEnumeratesSources() {
        val apk = args.getString("stage2Apk"); val bundle = args.getString("compatBundle"); val sha = args.getString("compatBundleSha256")
        assumeTrue("Stage 2 APK / compat bundle not supplied", apk != null && bundle != null && sha != null)

        // This test process is not :mihon; the gate would (correctly) refuse. Open it for the test only.
        RuntimeProcessGate.setOpenForTests(true)
        val registry = MihonSourceRegistry()
        val loader = ExtensionLoader(
            PackageManagerManifestReader(ctx),
            { PinnedCompatRuntime.create(listOf(PinnedFile(File(bundle!!), sha!!)), "1.6") },
            PathClassLoaderFactory(), registry,
        )
        val pkg = "eu.kanade.tachiyomi.extension.all.mhfixture"
        val out = loader.load(File(apk!!), pkg)
        assertTrue("load failed: $out", out is LoadOutcome.Loaded)
        val sources = (out as LoadOutcome.Loaded).sources
        assertTrue(sources.isNotEmpty())
        sources.forEach { assertTrue(it.key.startsWith("mihon:$pkg:")); assertTrue(it.name.startsWith("MH Fixture")) }
        val page = registry.get(sources[0].key)!!.search("hive", 1).getOrThrow()
        assertEquals(listOf("Hive Alpha", "Hive Beta"), page.items.map { it.title })
    }
}
