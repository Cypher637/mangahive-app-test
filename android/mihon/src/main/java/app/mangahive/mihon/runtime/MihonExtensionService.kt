package app.mangahive.mihon.runtime

import android.app.Service
import android.content.Intent
import android.os.Binder
import android.os.IBinder
import android.os.Process
import android.os.RemoteException
import android.os.SystemClock
import android.util.Log
import app.mangahive.mihon.ipc.IMihonRuntime
import app.mangahive.mihon.ipc.IMihonRuntimeCallback
import app.mangahive.mihon.ipc.contract.ErrorCode
import app.mangahive.mihon.ipc.contract.IPC_PROTOCOL_VERSION
import app.mangahive.mihon.ipc.contract.IpcCodec
import app.mangahive.mihon.ipc.contract.IpcError
import app.mangahive.mihon.ipc.contract.IpcLimits
import app.mangahive.mihon.ipc.contract.RuntimeResponse
import app.mangahive.mihon.loader.ExtensionLoader
import app.mangahive.mihon.loader.MihonSourceRegistry
import app.mangahive.mihon.loader.SourceHealthTracker
import app.mangahive.mihon.loader.PackageManagerManifestReader
import app.mangahive.mihon.loader.PathClassLoaderFactory
import app.mangahive.mihon.net.ActiveJobs
import app.mangahive.mihon.net.Deadlines
import app.mangahive.mihon.net.DestinationPolicy
import app.mangahive.mihon.net.ResourceGovernor
import app.mangahive.mihon.network.DefaultBrokerEngine
import java.io.File
import java.util.concurrent.ArrayBlockingQueue
import java.util.concurrent.ThreadPoolExecutor
import java.util.concurrent.TimeUnit

/**
 * The authoritative extension runtime. Declared with android:process=":mihon" (see the app manifest) and
 * android:exported="false". This is the ONLY class that constructs an [ExtensionLoader]; the UI process links
 * to none of it (it addresses this service by name through app.mangahive.mihon.ipc.MihonServiceClient).
 *
 * Binder surface = [IMihonRuntime]: two methods, String in / String out, strict codec on both ends.
 */
class MihonExtensionService : Service() {

    private var dispatcher: RuntimeDispatcher? = null
    private var offlinePageWorkers: ExecutorService? = null

    private val binder = object : IMihonRuntime.Stub() {
        override fun protocolVersion(): Int = IPC_PROTOCOL_VERSION

        override fun submit(requestJson: String?, callback: IMihonRuntimeCallback?) {
            if (callback == null) return
            val replier = CallbackReplier(callback)
            val d = dispatcher
            if (d == null || Binder.getCallingUid() != Process.myUid()) {
                replier.send(RuntimeResponse.Failure("unknown", null, IpcError(ErrorCode.RUNTIME_UNAVAILABLE)))
                return
            }
            if (requestJson == null) {
                replier.send(RuntimeResponse.Failure("unknown", null, IpcError(ErrorCode.BAD_REQUEST)))
                return
            }
            when (val decoded = IpcCodec.decodeRequest(requestJson)) {
                is IpcCodec.Decoded.Ok -> d.submit(decoded.value, replier)
                is IpcCodec.Decoded.Rejected ->
                    replier.send(RuntimeResponse.Failure(decoded.requestId ?: "unknown", decoded.op, IpcError(decoded.code)))
            }
        }
    }

    override fun onCreate() {
        super.onCreate()
        if (!RuntimeProcessGate.openIfRuntimeProcess(this)) {
            Log.e(TAG, "refusing to start outside the :mihon process")
            stopSelf()
            return
        }
        Log.i(TAG, "runtime up pid=${Process.myPid()}")

        val registry = MihonSourceRegistry(SourceHealthTracker(persistenceFile = File(filesDir, "mihon_source_health.json")))
        val compat = CompatBundleLocator(File(filesDir, "mihon_compat"))
        val manifests = PackageManagerManifestReader(this)
        // Stage 5: ONE policy, ONE broker. Extension HTTP, APK downloads and every redirect hop share them.
        val policy = DestinationPolicy.production()
        // Stage 6: ONE governor (per-extension / per-source / download limits) shared by the broker and the job registry.
        val governor = ResourceGovernor()
        val broker = DefaultBrokerEngine.create(File(filesDir, "mihon_cookies"), policy, governor)
        val jobs = ActiveJobs(governor, Deadlines.shared())
        val loader = ExtensionLoader(manifests, { compat.get() }, PathClassLoaderFactory(), registry, broker)
        val records = Stage7ExtensionRecords(this)
        // Stage 10: durable, data-only offline chapter storage. It is deliberately
        // independent of the executable extension lifecycle; completed pages can
        // remain readable after an extension is disabled or uninstalled.
        val offlineRoot = File(filesDir, "offline_downloads")
        val offlineDownloads = app.mangahive.mihon.offline.OfflineDownloadStore(offlineRoot)
        val offlineJobs = app.mangahive.mihon.offline.OfflineDownloadJobStore(File(filesDir, "offline_download_jobs"))

        val workers = ThreadPoolExecutor(4, 4, 30, TimeUnit.SECONDS, ArrayBlockingQueue(16),
            { r -> Thread(r, "mihon-worker").apply { isDaemon = true; priority = Thread.NORM_PRIORITY - 1 } },
            ThreadPoolExecutor.AbortPolicy()).apply { allowCoreThreadTimeOut(true) }

        val engine = RuntimeEngine(
            loader = loader, registry = registry, records = records,
            acquirer = DownloadingApkAcquirer(File(filesDir, "mihon_apks"), broker),
            manifests = manifests, compatAvailable = compat::isAvailable,
            urlPolicy = policy::screen,
            process = RuntimeEngine.ProcessInfo(Process.myPid(), RuntimeProcessGate.currentProcessName() ?: ":mihon", SystemClock.elapsedRealtime()),
            inFlight = { jobs.size() },
            log = { m, t -> if (t != null) Log.w(TAG, m, t) else Log.i(TAG, m) },
            clock = { SystemClock.elapsedRealtime() },
            onUninstall = { id, byRequest ->
                jobs.cancelAll(id, byRequest)               // in-flight work of the removed extension is aborted, not left to finish
                governor.clearExtension(id)
                broker.cookies().clearExtension(id)
            },
            androidInstaller = app.mangahive.mihon.install.AndroidPackageInstaller(this),
            thisContext = this,
            sourceCache = SourceDataCache(File(filesDir, "mihon_source_cache")),
            broker = broker,
            offlineDownloads = offlineDownloads,
            offlineJobs = offlineJobs,
            offlinePageWorkers = java.util.concurrent.Executors.newFixedThreadPool(3) { r -> Thread(r, "offline-page-worker").apply { isDaemon = true; priority = Thread.NORM_PRIORITY - 1 } }.also { offlinePageWorkers = it },
        )
        records.reconcileInstalledPackages(this)
        engine.recoverFromCrash()
        // Rebuild the in-memory source ownership/signing view from the persistent Stage 7 registry before serving IPC.
        for (r in records.stage7().all()) {
            if (r.enabled && !r.state.isHardBlock() && r.certSha256.isNotEmpty()) {
                try {
                    registry.restoreOwnership(r.extensionId, r.certSha256)
                } catch (t: Throwable) {
                    // A corrupt/conflicting persisted signer identity must quarantine only that extension,
                    // never prevent unrelated extensions from starting.
                    Log.e(TAG, "quarantining extension with invalid persisted ownership: ${r.extensionId}", t)
                    val updated = r.copy()
                    updated.enabled = false
                    updated.state = app.mangahive.mihon.install.States.Lifecycle.SIGNATURE_MISMATCH
                    updated.failureCode = "persisted-owner-mismatch"
                    updated.lastFailure = "Persisted signer ownership no longer matches the installed extension."
                    records.stage7().put(updated)
                }
            }
        }
        // Stage 8: executable source state is reconstructed from the persistent extension registry before IPC opens.
        // Each extension is isolated; one broken APK is quarantined without blocking unrelated sources.
        engine.recoverEnabledExtensions()
        // Stage 10.1: reconstruct any native offline jobs left mid-download by process death.
        // They are data-only jobs and therefore recover independently from extension install state.
        engine.recoverOfflineDownloads(workers)
        dispatcher = RuntimeDispatcher(
            engine::handle, workers, jobs,
            deadlineMs = 90_000L,
            deadlineFor = { request -> when (request.op) {
                app.mangahive.mihon.ipc.contract.Op.DOWNLOAD -> 20 * 60 * 1000L
                app.mangahive.mihon.ipc.contract.Op.INSTALL -> 3 * 60 * 1000L
                else -> 90_000L
            } }
        )
    }

    override fun onDestroy() {
        offlinePageWorkers?.shutdownNow()
        offlinePageWorkers = null
        dispatcher = null
        super.onDestroy()
    }

    override fun onBind(intent: Intent?): IBinder? = if (dispatcher != null) binder else null

    private class CallbackReplier(private val cb: IMihonRuntimeCallback) : Replier {
        override fun send(response: RuntimeResponse) {
            var json = IpcCodec.encodeResponse(response)
            if (json.length > IpcLimits.MAX_RESPONSE_CHARS) {
                json = IpcCodec.encodeResponse(RuntimeResponse.Failure(response.requestId, response.op, IpcError(ErrorCode.RESPONSE_TOO_LARGE)))
            }
            try { cb.onResponse(json) } catch (_: RemoteException) { } catch (_: RuntimeException) { }
        }
    }

    private companion object { const val TAG = "MihonRuntime" }
}
