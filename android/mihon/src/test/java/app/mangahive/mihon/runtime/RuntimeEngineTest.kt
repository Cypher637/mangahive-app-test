package app.mangahive.mihon.runtime

import app.mangahive.mihon.ipc.contract.ErrorCode
import app.mangahive.mihon.ipc.contract.ExtensionState
import app.mangahive.mihon.ipc.contract.Payload
import app.mangahive.mihon.ipc.contract.RuntimeRequest
import app.mangahive.mihon.ipc.contract.RuntimeResponse
import app.mangahive.mihon.loader.CompatRuntimeUnavailable
import app.mangahive.mihon.loader.ExtensionLoader
import app.mangahive.mihon.loader.MihonSourceRegistry
import app.mangahive.mihon.loader.TestFixtures
import app.mangahive.mihon.loader.TestFixtures.CountingFactory
import app.mangahive.mihon.loader.TestFixtures.FakeManifests
import app.mangahive.mihon.loader.TestFixtures.FakeRuntime
import app.mangahive.mihon.loader.TestFixtures.FakeSource
import app.mangahive.mihon.loader.TestFixtures.PKG
import app.mangahive.mihon.loader.TestFixtures.manifest
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test
import java.io.File
import app.mangahive.mihon.spi.RequestContext

class RuntimeEngineTest {
    private val registry = MihonSourceRegistry()
    private val records = InMemoryExtensionRecords()
    private val manifests = FakeManifests(manifest())
    private var compatUp = true
    private var downloads = 0
    private val rt = FakeRuntime { _, names -> listOf(FakeSource(names[0], 1L)) }
    private val loader = ExtensionLoader(manifests, { if (compatUp) rt else throw CompatRuntimeUnavailable("none") }, CountingFactory(), registry)
    private val acquirer = object : ApkAcquirer {
        override fun acquire(httpsUrl: String, expectedSha256: String?, ctx: RequestContext): AcquiredApk { downloads++; return AcquiredApk(File("unused-$downloads.apk"), "ab".repeat(32)) }
    }
    private val engine = RuntimeEngine(loader, registry, records, acquirer, manifests, { compatUp }, { null },
        RuntimeEngine.ProcessInfo(1, "app:mihon", 0L), { 0 })

    private fun install(id: String = "i1") = engine.handle(RuntimeRequest.Install(id, "https://x.example/e.apk", null, PKG, null), CancelToken())
    private fun code(r: RuntimeResponse) = (r as RuntimeResponse.Failure).error.code

    @Test fun installThenSearchGoesThroughTheSingleLoaderPipeline() {
        val r = install() as RuntimeResponse.Success
        assertEquals(ExtensionState.LOADED, (r.payload as Payload.Extension).info.state)
        val s = engine.handle(RuntimeRequest.Search("s1", PKG, 1L, "hive", 1), CancelToken()) as RuntimeResponse.Success
        assertEquals("Hive Alpha", (s.payload as Payload.SearchPage).items.single().title)
    }

    @Test fun withoutACompatBundleInstallFailsBeforeDownloading() {
        compatUp = false
        assertEquals(ErrorCode.COMPAT_RUNTIME_UNAVAILABLE, code(install()))
        assertEquals(0, downloads)
    }

    @Test fun sourceCallsLoadLazilyAndRespectDisableAndQuarantine() {
        install()
        loader.unload(PKG)                                   // simulate a fresh runtime process: records survive, registry empty
        assertEquals(ErrorCode.NOT_FOUND, code(engine.handle(RuntimeRequest.Search("s", PKG, 99L, "q", 1), CancelToken()))) // loaded on demand, unknown source id
        engine.handle(RuntimeRequest.Disable("d", PKG), CancelToken())
        assertEquals(ErrorCode.DISABLED, code(engine.handle(RuntimeRequest.Search("s2", PKG, 1L, "q", 1), CancelToken())))
        records.put(records.get(PKG)!!.copy(enabled = true, quarantined = true))
        assertEquals(ErrorCode.QUARANTINED, code(engine.handle(RuntimeRequest.Search("s3", PKG, 1L, "q", 1), CancelToken())))
    }

    @Test fun anExtensionThatWasLoadingWhenTheProcessDiedIsQuarantinedAtRestart() {
        install()
        records.markLoading(PKG)                             // process died here
        engine.recoverFromCrash()
        val rec = records.get(PKG)!!
        assertTrue(rec.quarantined); assertFalse(rec.enabled); assertEquals("CRASHED_WHILE_LOADING", rec.lastFailure)
        assertNull(records.takeLoadingSuspect())
    }

    @Test fun cancelledTokenStopsTheRequestWithCancelled() {
        install()
        val t = CancelToken().also { it.cancel() }
        assertEquals(ErrorCode.CANCELLED, code(engine.handle(RuntimeRequest.Search("s", PKG, 1L, "q", 1), t)))
    }

    @Test fun sourceFailuresNeverLeakMessages() {
        val bad = FakeSource("$PKG.FixtureFactory", 5L)
        val rt2 = FakeRuntime { _, names -> listOf(object : app.mangahive.mihon.spi.SourceGateway by bad {
            override fun searchJson(ctx: app.mangahive.mihon.spi.RequestContext, page: Int, query: String): String = throw IllegalStateException("/data/user/0/app/secret")
        }.let { it }) }
        val reg = MihonSourceRegistry()
        val e = RuntimeEngine(ExtensionLoader(manifests, { rt2 }, CountingFactory(), reg), reg, InMemoryExtensionRecords(), acquirer, manifests, { true }, { null },
            RuntimeEngine.ProcessInfo(1, "app:mihon", 0L), { 0 })
        e.handle(RuntimeRequest.Install("i", "https://x.example/e.apk", null, null, null), CancelToken())
        val f = e.handle(RuntimeRequest.Search("s", PKG, 5L, "q", 1), CancelToken()) as RuntimeResponse.Failure
        assertEquals(ErrorCode.SOURCE_ERROR, f.error.code)
        assertNull(f.error.detail)
    }
}
