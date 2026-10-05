package app.mangahive.mihon.runtime

import android.graphics.BitmapFactory
import app.mangahive.mihon.apk.ApkDownloader
import app.mangahive.mihon.ipc.contract.ChapterDto
import app.mangahive.mihon.ipc.contract.DetailsDto
import app.mangahive.mihon.ipc.contract.ErrorCode
import app.mangahive.mihon.ipc.contract.ExtensionHealthDto
import app.mangahive.mihon.ipc.contract.ExtensionInfo
import app.mangahive.mihon.ipc.contract.ExtensionState
import app.mangahive.mihon.ipc.contract.IPC_PROTOCOL_VERSION
import app.mangahive.mihon.ipc.contract.IpcError
import app.mangahive.mihon.ipc.contract.IpcLimits
import app.mangahive.mihon.ipc.contract.MangaDto
import app.mangahive.mihon.ipc.contract.PageDto
import app.mangahive.mihon.ipc.contract.Payload
import app.mangahive.mihon.ipc.contract.RuntimeHealth
import app.mangahive.mihon.ipc.contract.RuntimeRequest
import app.mangahive.mihon.ipc.contract.RuntimeResponse
import app.mangahive.mihon.ipc.contract.SourceDto
import app.mangahive.mihon.loader.LoadFailureCode
import app.mangahive.mihon.loader.LoadOutcome
import app.mangahive.mihon.loader.ExtensionLoader
import app.mangahive.mihon.loader.ManifestReader
import app.mangahive.mihon.loader.MangaHiveSourceAdapter
import app.mangahive.mihon.loader.MihonSourceRegistry
import app.mangahive.mihon.loader.SourceInfo
import app.mangahive.mihon.loader.SourceKey
import app.mangahive.mihon.install.AndroidPackageInstaller
import app.mangahive.mihon.install.ApkFacts
import app.mangahive.mihon.install.InstallPolicy
import app.mangahive.mihon.install.RepoEntry
import app.mangahive.mihon.install.States
import app.mangahive.mihon.install.MetadataValidator
import app.mangahive.mihon.loader.ExtensionDetector
import app.mangahive.mihon.offline.DownloadFailure
import app.mangahive.mihon.offline.DownloadIdentity
import app.mangahive.mihon.offline.DownloadState
import app.mangahive.mihon.offline.OfflineDownloadJobStore
import app.mangahive.mihon.offline.OfflineDownloadStore
import app.mangahive.mihon.net.BrokerEngine
import app.mangahive.mihon.spi.BrokerRequest
import app.mangahive.mihon.spi.BrokerResponse
import app.mangahive.mihon.spi.RequestContext
import app.mangahive.mihon.spi.CancelScope
import java.io.File
import java.io.BufferedInputStream
import java.io.FileOutputStream
import java.util.concurrent.ConcurrentHashMap
import java.util.concurrent.ExecutorService
import java.util.concurrent.TimeUnit

/**
 * THE runtime. Runs only inside :mihon. Executes each typed [RuntimeRequest] against the single production
 * pipeline: ExtensionLoader (manifest -> compat check -> per-extension ClassLoader -> gateway) and
 * MihonSourceRegistry. There is no second execution path and no reflective entry point: a request is a sealed
 * type, and the only way extension code runs is the source adapters in the registry.
 *
 * Nothing thrown here is ever serialised: every failure becomes an [IpcError] (code + optional enum-like token).
 */
class RuntimeEngine(
    private val loader: ExtensionLoader,
    private val registry: MihonSourceRegistry,
    private val records: ExtensionRecords,
    private val acquirer: ApkAcquirer,
    private val manifests: ManifestReader,
    private val compatAvailable: () -> Boolean,
    private val urlPolicy: (String) -> String?,
    private val process: ProcessInfo,
    private val inFlight: () -> Int,
    private val log: (String, Throwable?) -> Unit = { _, _ -> },
    private val clock: () -> Long = { System.currentTimeMillis() },
    /** Stage 5/6: once per uninstall: abort the extension's other in-flight work, drop its limits and cookies. */
    private val onUninstall: (extensionId: String, byRequestId: String) -> Unit = { _, _ -> },
    /** Real Android PackageInstaller path. Null is retained for pure-JVM/unit tests. */
    private val androidInstaller: AndroidPackageInstaller? = null,
    private val thisContext: android.content.Context? = null,
    private val sourceCache: SourceDataCache = SourceDataCache(null),
    private val broker: BrokerEngine? = null,
    private val offlineDownloads: OfflineDownloadStore? = null,
    private val offlineJobs: OfflineDownloadJobStore? = null,
    private val offlinePageWorkers: ExecutorService? = null,
) {
    class ProcessInfo(val pid: Int, val name: String, val startedAtMs: Long)

    private class Fail(val error: IpcError) : RuntimeException()

    private val mutation = Any()
    private val loadFailures = ConcurrentHashMap<String, String>()
    private val offlineRunning = ConcurrentHashMap.newKeySet<String>()

    /** Call once at startup: an extension that was mid-load when the process last died is quarantined. */
    fun recoverFromCrash() {
        val suspect = records.takeLoadingSuspect() ?: return
        val rec = records.get(suspect) ?: return
        records.put(rec.copy(enabled = false, quarantined = true, lastFailure = "CRASHED_WHILE_LOADING"))
        log("quarantined $suspect: runtime died while loading it", null)
    }

    /** Rebuilds executable source state from the persistent extension registry after process restart. */
    fun recoverEnabledExtensions() {
        for (rec in records.all()) {
            if (!rec.enabled || rec.quarantined) continue
            synchronized(mutation) {
                if (registry.sourcesOf(rec.extensionId).isNotEmpty()) continue
                val error = try { loadRecord(rec) } catch (t: Throwable) {
                    log("startup load failed for ${rec.extensionId}", t)
                    IpcError(ErrorCode.LOAD_FAILED)
                }
                if (error != null) log("startup isolated extension ${rec.extensionId}: ${error.code.name}", null)
            }
        }
    }

    fun handle(req: RuntimeRequest, token: CancelToken): RuntimeResponse = try {
        dispatch(req, token)
    } catch (f: Fail) {
        fail(req, f.error)
    } catch (_: CancelledException) {
        fail(req, IpcError(ErrorCode.CANCELLED))
    } catch (e: VirtualMachineError) {
        throw e
    } catch (t: Throwable) {
        log("unexpected failure in ${req.op.wire}", t)
        fail(req, IpcError(ErrorCode.INTERNAL))
    }

    private fun dispatch(req: RuntimeRequest, token: CancelToken): RuntimeResponse {
        token.throwIfCancelled()
        return when (req) {
            is RuntimeRequest.Health -> ok(req, Payload.Health(health()))
            is RuntimeRequest.Cancel -> ok(req, Payload.Ack) // handled by the dispatcher; harmless here
            is RuntimeRequest.Install -> install(req, token)
            is RuntimeRequest.Inspect -> ok(req, Payload.Extension(info(record(req.extensionId))))
            is RuntimeRequest.Enable -> enable(req)
            is RuntimeRequest.Disable -> disable(req)
            is RuntimeRequest.Uninstall -> uninstall(req)
            is RuntimeRequest.ListSources -> listSources(req, token)
            is RuntimeRequest.Search -> {
                val key = cacheKey(req.extensionId, req.sourceId, "search", req.query, req.page.toString())
                val payload = try {
                    val page = callSource(req, token) { a -> a.search(token.ctx, req.query, req.page).getOrElse { sourceFailure(req, it) } }
                    Payload.SearchPage(page.items.map { MangaDto(it.remoteId, it.title, it.coverUrl) }, page.hasNextPage).also { sourceCache.write(key, encodeCached(it)) }
                } catch (f: Fail) { cachedPayload(key, Payload::class.java, f) }
                token.throwIfCancelled(); ok(req, payload as Payload.SearchPage)
            }
            is RuntimeRequest.Details -> {
                val key = cacheKey(req.extensionId, req.sourceId, "details", req.mangaRemoteId)
                val payload = try {
                    val d = callSource(req, token) { a -> a.details(token.ctx, req.mangaRemoteId).getOrElse { sourceFailure(req, it) } }
                    Payload.Details(DetailsDto(d.remoteId, d.title, d.author, d.artist, d.description, d.genres, d.status, d.coverUrl)).also { sourceCache.write(key, encodeCached(it)) }
                } catch (f: Fail) { cachedPayload(key, Payload::class.java, f) }
                token.throwIfCancelled(); ok(req, payload as Payload.Details)
            }
            is RuntimeRequest.Chapters -> {
                val key = cacheKey(req.extensionId, req.sourceId, "chapters", req.mangaRemoteId)
                val payload = try {
                    val list = callSource(req, token) { a -> a.chapters(token.ctx, req.mangaRemoteId).getOrElse { sourceFailure(req, it) } }
                    Payload.Chapters(list.map { ChapterDto(it.remoteId, it.title, it.number, it.dateUpload, it.scanlator) }).also { sourceCache.write(key, encodeCached(it)) }
                } catch (f: Fail) { cachedPayload(key, Payload::class.java, f) }
                token.throwIfCancelled(); ok(req, payload as Payload.Chapters)
            }
            is RuntimeRequest.Pages -> {
                val key = cacheKey(req.extensionId, req.sourceId, "pages", req.chapterRemoteId)
                val payload = try {
                    val list = callSource(req, token) { a -> a.pages(token.ctx, req.chapterRemoteId).getOrElse { sourceFailure(req, it) } }
                    Payload.Pages(list.map { PageDto(it.index, it.url, it.imageUrl) }).also { sourceCache.write(key, encodeCached(it)) }
                } catch (f: Fail) { cachedPayload(key, Payload::class.java, f) }
                token.throwIfCancelled(); ok(req, payload as Payload.Pages)
            }
            is RuntimeRequest.Download -> download(req, token)
            is RuntimeRequest.DeleteDownload -> deleteDownload(req)
        }
    }

    // ───────────── offline chapter runtime ─────────────

    /** Download a Mihon chapter entirely inside the native runtime. Page bytes never cross the IPC/WebView boundary. */
    private fun download(req: RuntimeRequest.Download, token: CancelToken): RuntimeResponse {
        val broker = broker ?: throw Fail(IpcError(ErrorCode.RUNTIME_UNAVAILABLE, "BROKER_UNAVAILABLE"))
        val store = offlineDownloads ?: throw Fail(IpcError(ErrorCode.RUNTIME_UNAVAILABLE, "OFFLINE_STORE_UNAVAILABLE"))
        val journal = offlineJobs ?: throw Fail(IpcError(ErrorCode.RUNTIME_UNAVAILABLE, "OFFLINE_JOB_STORE_UNAVAILABLE"))
        val identity = DownloadIdentity(req.canonicalMangaId, req.canonicalChapterId, req.extensionId, req.sourceId.toString(), req.chapterRemoteId)
        val current = journal.get(identity)
        if (current?.state == DownloadState.COMPLETED && store.validate(identity)) {
            return ok(req, offlinePayload(identity, store))
        }
        if (!offlineRunning.add(identity.stableKey)) throw Fail(IpcError(ErrorCode.BUSY, "DOWNLOAD_IN_PROGRESS"))
        if (current != null && current.state == DownloadState.DOWNLOADING && current.updatedAt > System.currentTimeMillis() - 30_000L) {
            offlineRunning.remove(identity.stableKey)
            throw Fail(IpcError(ErrorCode.BUSY, "DOWNLOAD_IN_PROGRESS"))
        }

        val rec = current ?: OfflineDownloadJobStore.Record(identity, req.mangaRemoteId, req.chapterRemoteId, DownloadState.QUEUED)
        rec.state = DownloadState.RESOLVING
        rec.failure = null
        rec.maxStorageBytes = req.maxStorageBytes
        rec.cleanupAfterDays = req.cleanupAfterDays
        rec.updatedAt = System.currentTimeMillis()
        journal.upsert(rec)
        val tempRoot = File((thisContext ?: throw Fail(IpcError(ErrorCode.INTERNAL))).filesDir, "offline_download_jobs")
        tempRoot.mkdirs()
        val tempDir = File(tempRoot, store.identityHash(identity))
        if (!tempDir.exists()) check(tempDir.mkdirs()) { "offline temp mkdir failed" }

        val tempPages = ArrayList<File>()
        val mimeTypes = ArrayList<String>()
        try {
            token.throwIfCancelled()
            val adapterPages = callSource(req, token) { a ->
                a.pages(token.ctx, req.chapterRemoteId).getOrElse { sourceFailure(req, it) }
            }.sortedBy { it.index }
            if (adapterPages.isEmpty()) throw Fail(IpcError(OFFLINE_DOWNLOAD_FAILED, "NO_PAGES"))
            if (adapterPages.size > IpcLimits.MAX_PAGES) throw Fail(IpcError(OFFLINE_DOWNLOAD_FAILED, "TOO_MANY_PAGES"))
            if (adapterPages.map { it.index }.distinct().size != adapterPages.size) throw Fail(IpcError(OFFLINE_DOWNLOAD_FAILED, "DUPLICATE_PAGE_INDEX"))

            rec.state = DownloadState.DOWNLOADING
            rec.totalPages = adapterPages.size
            rec.completedPages = 0
            rec.bytesDownloaded = 0
            rec.bytesTotal = 0
            rec.updatedAt = System.currentTimeMillis()
            journal.upsert(rec)

            val maxStorage = if (req.maxStorageBytes > 0L) req.maxStorageBytes else IpcLimits.DEFAULT_OFFLINE_STORAGE_BYTES
            val protectedKeys = journal.all().filter { it.state !in setOf(DownloadState.COMPLETED, DownloadState.CANCELLED, DownloadState.FAILED) }.map { it.identity.stableKey }.toSet() + identity.stableKey
            val cutoff = if (req.cleanupAfterDays > 0) System.currentTimeMillis() - TimeUnit.DAYS.toMillis(req.cleanupAfterDays.toLong()) else null
            if (cutoff != null) store.cleanupOlderThan(cutoff, protectedKeys)

            val worker = offlinePageWorkers ?: java.util.concurrent.Executors.newFixedThreadPool(1)
            val ownedWorker = offlinePageWorkers == null
            try {
                val completion = java.util.concurrent.ExecutorCompletionService<Pair<Int, Pair<File, String>>>(worker)
                adapterPages.forEachIndexed { position, page ->
                    val url = (page.imageUrl ?: page.url).orEmpty()
                    if (url.isBlank()) throw Fail(IpcError(OFFLINE_DOWNLOAD_FAILED, "PAGE_URL_MISSING"))
                    completion.submit(java.util.concurrent.Callable {
                        token.throwIfCancelled()
                        val file = File(tempDir, "%04d.page".format(position))
                        downloadPageToFileWithRetry(broker, req, url, token.ctx, file, token)
                        val mime = detectImageMime(file) ?: throw Fail(IpcError(OFFLINE_DOWNLOAD_FAILED, "IMAGE_INVALID"))
                        position to (file to mime)
                    })
                }
                val results = arrayOfNulls<Pair<File, String>>(adapterPages.size)
                var total = 0L
                repeat(adapterPages.size) {
                    token.throwIfCancelled()
                    val result = completion.take().get()
                    val file = result.second.first
                    total += file.length()
                    if (total > IpcLimits.MAX_OFFLINE_BYTES) throw Fail(IpcError(OFFLINE_DOWNLOAD_FAILED, "CHAPTER_TOO_LARGE"))
                    results[result.first] = file to result.second.second
                    rec.completedPages += 1
                    rec.bytesDownloaded = total
                    rec.bytesTotal = total
                    rec.updatedAt = System.currentTimeMillis()
                    journal.upsert(rec)
                }
                tempPages.clear(); mimeTypes.clear()
                results.forEach { pair ->
                    require(pair != null)
                    tempPages += pair.first
                    mimeTypes += pair.second
                }
                token.throwIfCancelled()
                try {
                    store.writeAtomically(identity, tempPages, mimeTypes, maxStorage, cutoff, protectedKeys)
                } catch (_: IllegalStateException) {
                    throw Fail(IpcError(OFFLINE_STORAGE_FULL, "STORAGE_LIMIT"))
                }
            } finally {
                if (ownedWorker) worker.shutdownNow()
            }
            if (!store.validate(identity)) throw Fail(IpcError(OFFLINE_CORRUPTED, "VALIDATION_FAILED"))
            rec.state = DownloadState.COMPLETED
            rec.completedPages = tempPages.size
            rec.totalPages = tempPages.size
            rec.bytesTotal = total
            rec.updatedAt = System.currentTimeMillis()
            journal.upsert(rec)
            return ok(req, offlinePayload(identity, store))
        } catch (e: Fail) {
            if (e.error.code == ErrorCode.CANCELLED) {
                rec.state = DownloadState.CANCELLED
                rec.failure = DownloadFailure.CANCELLED
            } else {
                rec.state = DownloadState.FAILED
                rec.failure = mapDownloadFailure(e.error.code)
            }
            rec.updatedAt = System.currentTimeMillis()
            journal.upsert(rec)
            throw e
        } catch (e: Throwable) {
            if (token.isCancelled || e is InterruptedException) {
                rec.state = DownloadState.CANCELLED
                rec.failure = DownloadFailure.CANCELLED
                rec.updatedAt = System.currentTimeMillis()
                journal.upsert(rec)
                throw CancelledException()
            }
            rec.state = DownloadState.FAILED
            rec.failure = DownloadFailure.UNKNOWN
            rec.updatedAt = System.currentTimeMillis()
            journal.upsert(rec)
            log("offline Mihon download failed", e)
            throw Fail(IpcError(ErrorCode.OFFLINE_DOWNLOAD_FAILED))
        } finally {
            tempPages.forEach { try { it.delete() } catch (_: Exception) {} }
            try { tempDir.deleteRecursively() } catch (_: Exception) {}
            offlineRunning.remove(identity.stableKey)
        }
    }

    private fun deleteDownload(req: RuntimeRequest.DeleteDownload): RuntimeResponse {
        val store = offlineDownloads ?: throw Fail(IpcError(ErrorCode.RUNTIME_UNAVAILABLE, "OFFLINE_STORE_UNAVAILABLE"))
        val journal = offlineJobs ?: throw Fail(IpcError(ErrorCode.RUNTIME_UNAVAILABLE, "OFFLINE_JOB_STORE_UNAVAILABLE"))
        val identity = DownloadIdentity(req.canonicalMangaId, req.canonicalChapterId, req.extensionId, req.sourceId.toString(), req.remoteChapterId)
        val removed = store.delete(identity)
        journal.remove(identity)
        return if (removed) ok(req, Payload.Ack) else throw Fail(IpcError(ErrorCode.OFFLINE_CORRUPTED, "DELETE_FAILED"))
    }

    /** Called only at service startup; jobs are reconstructed from the durable journal, not from in-memory state. */
    fun recoverOfflineDownloads(workers: ExecutorService) {
        val journal = offlineJobs ?: return
        for (record in journal.all()) {
            if (record.state !in setOf(DownloadState.QUEUED, DownloadState.RESOLVING, DownloadState.DOWNLOADING)) continue
            record.state = DownloadState.QUEUED
            record.updatedAt = System.currentTimeMillis()
            journal.upsert(record)
            try {
                workers.execute {
                    val sourceId = record.identity.sourceId.toLongOrNull()
                    if (sourceId == null) {
                        record.state = DownloadState.FAILED
                        record.failure = DownloadFailure.INVALID_RESPONSE
                        record.updatedAt = System.currentTimeMillis()
                        journal.upsert(record)
                        return@execute
                    }
                    // Internal job id — NOT an external request id.
                    // External request ids are minted only at the IPC boundary
                    // (WebRequestParser / MihonJsBridge / MihonServiceClient).
                    val internalJobId = "job-offline-recovery-" + record.identity.stableKey.hashCode().toString(16) + "-" + record.updatedAt
                    val request = RuntimeRequest.Download(
                        internalJobId, record.identity.canonicalMangaId, record.identity.canonicalChapterId,
                        record.identity.extensionId, sourceId, record.mangaRemoteId, record.chapterRemoteId,
                        record.maxStorageBytes, record.cleanupAfterDays,
                    )
                    try { download(request, CancelToken(RequestContext(request.requestId, CancelScope.root()))) }
                    catch (t: Throwable) { log("offline recovery failed for ${record.identity.stableKey.hashCode()}", t) }
                }
            } catch (t: Throwable) {
                log("could not schedule offline recovery", t)
            }
        }
    }

    private fun downloadPageToFileWithRetry(
        broker: BrokerEngine, req: RuntimeRequest.Download, url: String, parentCtx: RequestContext, target: File, token: CancelToken,
    ) {
        var attempt = 0
        var last: Throwable? = null
        while (attempt < 3) {
            token.throwIfCancelled()
            attempt++
            try {
                downloadPageToFile(broker, req, url, parentCtx, target)
                return
            } catch (t: Throwable) {
                if (t is CancelledException) throw t
                last = t
                if (attempt >= 3) throw t
                try { Thread.sleep(minOf(30_000L, 1_000L * (1L shl (attempt - 1)))) } catch (_: InterruptedException) { throw CancelledException() }
            }
        }
        throw last ?: Fail(IpcError(OFFLINE_DOWNLOAD_FAILED))
    }

    private fun downloadPageToFile(broker: BrokerEngine, req: RuntimeRequest.Download, url: String, parentCtx: RequestContext, target: File) {
        val scoped = broker.open(req.extensionId, req.sourceId)
        val response = try {
            scoped.execute(BrokerRequest("GET", url, emptyList(), null, null, true, 15_000, 45_000, 120_000), parentCtx)
        } catch (t: Throwable) {
            sourceFailure(req, t)
        }
        response.use { r: BrokerResponse ->
            if (r.status !in 200..299) throw Fail(IpcError(OFFLINE_DOWNLOAD_FAILED, "HTTP_${r.status.coerceIn(100, 599)}"))
            if (r.contentLength > IpcLimits.MAX_PAGE_BYTES) throw Fail(IpcError(OFFLINE_DOWNLOAD_FAILED, "PAGE_TOO_LARGE"))
            target.parentFile?.mkdirs()
            var written = 0L
            BufferedInputStream(r.body(), 64 * 1024).use { input ->
                FileOutputStream(target).use { output ->
                    val buf = ByteArray(64 * 1024)
                    while (true) {
                        if (parentCtx.cancel.isCancelled || Thread.currentThread().isInterrupted) throw CancelledException()
                        val n = input.read(buf)
                        if (n < 0) break
                        if (n == 0) continue
                        written += n
                        if (written > IpcLimits.MAX_PAGE_BYTES) throw Fail(IpcError(OFFLINE_DOWNLOAD_FAILED, "PAGE_TOO_LARGE"))
                        output.write(buf, 0, n)
                    }
                }
            }
            if (written <= 0) throw Fail(IpcError(OFFLINE_DOWNLOAD_FAILED, "EMPTY_PAGE"))
        }
    }

    private fun imageDimensions(file: File): Pair<Int, Int> {
        val o = BitmapFactory.Options().apply { inJustDecodeBounds = true }
        BitmapFactory.decodeFile(file.absolutePath, o)
        val width = o.outWidth
        val height = o.outHeight
        if (width <= 0 || height <= 0 || width > 20_000 || height > 20_000) throw Fail(IpcError(OFFLINE_DOWNLOAD_FAILED, "IMAGE_INVALID"))
        return width to height
    }

    private fun detectImageMime(file: File): String? {
        if (!file.isFile || file.length() <= 0 || file.length() > IpcLimits.MAX_PAGE_BYTES) return null
        val h = ByteArray(32)
        val n = file.inputStream().use { it.read(h) }
        if (n >= 8 && h[0].toInt() == 0x89 && h[1].toInt() == 0x50 && h[2].toInt() == 0x4E && h[3].toInt() == 0x47) return "image/png"
        if (n >= 3 && h[0].toInt() == 0xFF && h[1].toInt() == 0xD8 && h[2].toInt() == 0xFF) return "image/jpeg"
        if (n >= 6 && String(h, 0, 6, Charsets.US_ASCII).startsWith("GIF")) return "image/gif"
        if (n >= 12 && String(h, 0, 4, Charsets.US_ASCII) == "RIFF" && String(h, 8, 4, Charsets.US_ASCII) == "WEBP") return "image/webp"
        if (n >= 2 && h[0].toInt() == 0x42 && h[1].toInt() == 0x4D) return "image/bmp"
        if (n >= 12 && String(h, 4, 8, Charsets.US_ASCII).lowercase() == "ftypavif") return "image/avif"
        return null
    }

    private fun mapDownloadFailure(code: ErrorCode): DownloadFailure = when (code) {
        ErrorCode.TIMEOUT -> DownloadFailure.TIMEOUT
        ErrorCode.SOURCE_ERROR, ErrorCode.RUNTIME_DIED, ErrorCode.RUNTIME_UNAVAILABLE -> DownloadFailure.NETWORK
        ErrorCode.RESPONSE_TOO_LARGE -> DownloadFailure.TOO_LARGE
        ErrorCode.CANCELLED -> DownloadFailure.CANCELLED
        ErrorCode.BUSY -> DownloadFailure.RATE_LIMITED
        else -> DownloadFailure.UNKNOWN
    }

    private fun offlinePayload(identity: DownloadIdentity, store: OfflineDownloadStore): Payload.OfflineDownload {
        val manifest = store.readManifest(identity) ?: throw Fail(IpcError(ErrorCode.OFFLINE_CORRUPTED))
        val arr = manifest.optJSONArray("pages") ?: throw Fail(IpcError(ErrorCode.OFFLINE_CORRUPTED))
        val pages = (0 until arr.length()).map { i ->
            val o = arr.getJSONObject(i)
            app.mangahive.mihon.ipc.contract.OfflinePageDto(
                i, store.pageUrl(identity, i), o.optLong("bytes"), o.optString("sha256"), o.optString("contentType"),
                o.optInt("width", 0), o.optInt("height", 0)
            )
        }
        val total = pages.sumOf { it.byteSize }
        return Payload.OfflineDownload(app.mangahive.mihon.ipc.contract.OfflineDownloadDto(
            identity.canonicalMangaId, identity.canonicalChapterId, identity.extensionId, identity.sourceId.toLong(), identity.remoteChapterId,
            pages.size, total, pages,
        ))
    }

    // ───────────── lifecycle ops ─────────────

    private fun install(req: RuntimeRequest.Install, token: CancelToken): RuntimeResponse {
        if (!compatAvailable()) throw Fail(IpcError(ErrorCode.COMPAT_RUNTIME_UNAVAILABLE))
        if (urlPolicy(req.apkUrl) != null) throw Fail(IpcError(ErrorCode.DOWNLOAD_FAILED, "URL_REJECTED"))

        val apk = try {
            acquirer.acquire(req.apkUrl, req.expectedSha256, token.ctx)
        } catch (e: ApkDownloader.DownloadException) {
            if (token.isCancelled) throw CancelledException()
            throw Fail(IpcError(ErrorCode.DOWNLOAD_FAILED, detailToken(e.message)))
        } catch (e: java.io.IOException) {
            if (token.isCancelled) throw CancelledException()
            throw Fail(IpcError(ErrorCode.DOWNLOAD_FAILED))
        }

        var installedSourcePath: String? = null
        try {
            token.throwIfCancelled()
            val raw = manifests.read(apk.file) ?: throw Fail(IpcError(ErrorCode.VERIFICATION_FAILED, "UNREADABLE_APK"))
            val ext = raw.packageName
            if (req.expectedPackage != null && req.expectedPackage != ext) throw Fail(IpcError(ErrorCode.VERIFICATION_FAILED, "PACKAGE_MISMATCH"))
            if (req.expectedSignerSha256 != null && raw.signerSha256.none { it.equals(req.expectedSignerSha256, ignoreCase = true) }) {
                throw Fail(IpcError(ErrorCode.VERIFICATION_FAILED, "SIGNER_MISMATCH"))
            }

            // Stage 7 policy is now authoritative for Android installs. The current IPC install request represents a
            // direct install, so repository-only fields are synthesized from the verified APK/request rather than invented.
            val stage7 = records as? Stage7ExtensionRecords
            if (stage7 != null) {
                val inspector = app.mangahive.mihon.apk.ApkInspector(requireNotNull(thisContext) { "Stage 7 Android context is required" })
                val report = inspector.inspect(apk.file)
                val facts = ApkFacts().apply {
                    packageName = report.packageName
                    versionName = report.versionName
                    versionCode = report.versionCode ?: -1L
                    applicationLabel = report.label
                    minSdk = report.minSdk ?: 0
                    targetSdk = report.targetSdk ?: 0
                    permissions = report.permissions
                    certSha256 = report.certSha256
                    sizeBytes = apk.file.length()
                    sha256 = apk.sha256
                    error = report.error
                    hasExtensionFeature = ExtensionDetector.FEATURE in raw.features
                    extensionLib = raw.meta[ExtensionDetector.META_LIB]
                    entryClassesValid = ExtensionDetector.resolveEntryClasses(raw.packageName, raw.meta[ExtensionDetector.META_CLASS] ?: "") != null
                }
                val entry = RepoEntry().apply {
                    ecosystem = "mihon"
                    repositoryId = "direct"
                    extensionId = ext
                    packageName = ext
                    versionName = raw.versionName ?: "unknown"
                    versionCode = raw.versionCode
                    downloadUrl = req.apkUrl
                    sha256 = req.expectedSha256 ?: apk.sha256
                    certSha256 = req.expectedSignerSha256 ?: raw.signerSha256.firstOrNull()
                    language = "all"
                    sourceIds = listOf("pending")
                }
                val metadataErrors = MetadataValidator.validate(entry)
                if (metadataErrors.isNotEmpty()) throw Fail(IpcError(ErrorCode.VERIFICATION_FAILED, "METADATA_INVALID"))
                val installed = stage7.stage7().get(ext)
                val ctx = InstallPolicy.Context().apply {
                    trust = States.RepoTrust.DIRECT
                    ownership = States.Ownership.PRIMARY
                    this.installed = installed
                    supportedLibs = setOf(compat.get().apiVersion)
                    hostVersion = 1
                    pinnedCert = req.expectedSignerSha256
                    androidHost = true
                }
                val decision = InstallPolicy.evaluate(entry, facts, ctx)
                if (decision.state == States.Lifecycle.INSTALLED && decision.code == "up-to-date") {
                    deleteIfUnreferenced(apk.file.absolutePath)
                    return ok(req, Payload.Extension(info(records.get(ext)!!)))
                }
                if (!decision.ok()) throw Fail(mapInstallPolicyFailure(decision))
            }

            // If running on Android, require a real PackageInstaller transaction before executing third-party code.
            // Unit tests keep the old null installer and exercise the loader with fixture APKs.
            if (androidInstaller != null) {
                val installedVersion = androidInstaller.installedVersionCode(ext)
                if (installedVersion != null && raw.versionCode < installedVersion) {
                    throw Fail(IpcError(ErrorCode.DOWNGRADE_BLOCKED))
                }
                val result = androidInstaller.install(apk.file, ext, raw.versionCode)
                if (!result.success) throw Fail(IpcError(ErrorCode.VERIFICATION_FAILED, detailToken(result.message) ?: "INSTALL_FAILED"))
                installedSourcePath = result.sourceDir
                if (installedSourcePath.isNullOrBlank()) throw Fail(IpcError(ErrorCode.VERIFICATION_FAILED, "INSTALLED_APK_PATH_MISSING"))
                val installedManifest = manifests.read(File(installedSourcePath!!))
                    ?: throw Fail(IpcError(ErrorCode.VERIFICATION_FAILED, "INSTALLED_APK_UNREADABLE"))
                if (installedManifest.packageName != ext) throw Fail(IpcError(ErrorCode.VERIFICATION_FAILED, "INSTALLED_PACKAGE_MISMATCH"))
                if (installedManifest.versionCode != raw.versionCode) throw Fail(IpcError(ErrorCode.VERIFICATION_FAILED, "INSTALLED_VERSION_MISMATCH"))
                if (installedManifest.signerSha256.toSet() != raw.signerSha256.toSet()) {
                    throw Fail(IpcError(ErrorCode.VERIFICATION_FAILED, "INSTALLED_SIGNER_MISMATCH"))
                }
                if (req.expectedSignerSha256 != null && installedManifest.signerSha256.none { it.equals(req.expectedSignerSha256, true) }) {
                    throw Fail(IpcError(ErrorCode.VERIFICATION_FAILED, "INSTALLED_SIGNER_MISMATCH"))
                }
            }

            synchronized(mutation) {
                val prev = records.get(ext)
                if (prev != null && raw.versionCode < prev.versionCode) throw Fail(IpcError(ErrorCode.DOWNGRADE_BLOCKED))
                records.markLoading(ext)
                val loadFile = File(installedSourcePath ?: apk.file.absolutePath)
                val outcome = try { loader.load(loadFile, ext) } finally { records.clearLoading() }
                when (outcome) {
                    is LoadOutcome.Failed -> {
                        log("install load failed: ${outcome.code}", outcome.cause)
                        loadFailures[ext] = outcome.code.name
                        // PackageInstaller has already committed the package. We cannot claim automatic rollback.
                        // Persist the NEW installed package as recovery-required so startup tracks the real package.
                        val recovery = ExtRecord(
                            extensionId = ext,
                            apkPath = installedSourcePath ?: apk.file.absolutePath,
                            sha256 = apk.sha256,
                            versionCode = raw.versionCode,
                            versionName = raw.versionName,
                            displayName = raw.versionName ?: ext,
                            apiVersion = null,
                            signerSha256 = raw.signerSha256,
                            enabled = false,
                            quarantined = true,
                            lastFailure = "RECOVERY_REQUIRED:LOAD_FAILED:${outcome.code.name}",
                        )
                        records.put(recovery)
                        if (outcome.code == LoadFailureCode.OWNER_MISMATCH) throw Fail(IpcError(ErrorCode.OWNER_MISMATCH))
                        throw Fail(IpcError(ErrorCode.LOAD_FAILED, outcome.code.name))
                    }
                    is LoadOutcome.Loaded -> {
                        loadFailures.remove(ext)
                        val d = outcome.descriptor
                        val rec = ExtRecord(
                            ext,
                            installedSourcePath ?: apk.file.absolutePath,
                            apk.sha256,
                            d.versionCode,
                            d.versionName,
                            d.displayName,
                            d.apiVersion,
                            d.signerSha256,
                            enabled = true,
                            quarantined = false,
                            lastFailure = null,
                        )
                        records.put(rec)
                        if (stage7 != null) stage7.updateSources(ext, outcome.sources.map { it.sourceId.toString() })
                        if (prev != null && prev.apkPath != rec.apkPath) deleteIfUnreferenced(prev.apkPath)
                        return ok(req, Payload.Extension(info(rec)))
                    }
                }
            }
        } catch (t: Throwable) {
            // A downloaded APK that was never adopted by the authoritative registry is disposable.
            if (installedSourcePath == null) deleteIfUnreferenced(apk.file.absolutePath)
            throw t
        }
    }

    private fun cacheKey(extensionId: String, sourceId: Long, kind: String, vararg parts: String): String =
        listOf(extensionId, sourceId.toString(), kind).plus(parts.toList()).joinToString("\u001f")

    private fun encodeCached(p: Payload): String = when (p) {
        is Payload.SearchPage -> org.json.JSONObject().put("type", "search").put("hasNextPage", p.hasNextPage).put("items", org.json.JSONArray().also { a -> p.items.forEach { a.put(org.json.JSONObject().put("remoteId", it.remoteId).put("title", it.title).put("coverUrl", it.coverUrl)) } }).toString()
        is Payload.Details -> org.json.JSONObject().put("type", "details").put("details", org.json.JSONObject().put("remoteId", p.details.remoteId).put("title", p.details.title).put("author", p.details.author).put("artist", p.details.artist).put("description", p.details.description).put("genres", org.json.JSONArray(p.details.genres)).put("status", p.details.status).put("coverUrl", p.details.coverUrl)).toString()
        is Payload.Chapters -> org.json.JSONObject().put("type", "chapters").put("chapters", org.json.JSONArray().also { a -> p.chapters.forEach { a.put(org.json.JSONObject().put("remoteId", it.remoteId).put("title", it.title).put("number", it.number).put("dateUpload", it.dateUpload).put("scanlator", it.scanlator)) } }).toString()
        is Payload.Pages -> org.json.JSONObject().put("type", "pages").put("pages", org.json.JSONArray().also { a -> p.pages.forEach { a.put(org.json.JSONObject().put("index", it.index).put("url", it.url).put("imageUrl", it.imageUrl)) } }).toString()
        else -> throw IllegalArgumentException("not cacheable")
    }

    private fun cachedPayload(key: String, ignored: Class<Payload>, failure: Fail): Payload {
        val raw = sourceCache.read(key) ?: throw failure
        return try {
            val o = org.json.JSONObject(raw)
            when (o.optString("type")) {
                "search" -> Payload.SearchPage((0 until o.optJSONArray("items").length()).map { i -> val x=o.getJSONArray("items").getJSONObject(i); MangaDto(x.getString("remoteId"),x.getString("title"),x.optString("coverUrl").takeIf { !x.isNull("coverUrl") }) }, o.optBoolean("hasNextPage"))
                "details" -> { val x=o.getJSONObject("details"); Payload.Details(DetailsDto(x.getString("remoteId"),x.getString("title"),x.optString("author").takeIf { !x.isNull("author") },x.optString("artist").takeIf { !x.isNull("artist") },x.optString("description").takeIf { !x.isNull("description") },(0 until x.getJSONArray("genres").length()).map { j -> x.getJSONArray("genres").getString(j) },x.optInt("status"),x.optString("coverUrl").takeIf { !x.isNull("coverUrl") })) }
                "chapters" -> Payload.Chapters((0 until o.getJSONArray("chapters").length()).map { i -> val x=o.getJSONArray("chapters").getJSONObject(i); ChapterDto(x.getString("remoteId"),x.getString("title"),if(x.isNull("number")) null else x.optDouble("number"),x.optLong("dateUpload"),x.optString("scanlator").takeIf { !x.isNull("scanlator") }) })
                "pages" -> Payload.Pages((0 until o.getJSONArray("pages").length()).map { i -> val x=o.getJSONArray("pages").getJSONObject(i); PageDto(x.optInt("index",i),x.optString("url").takeIf { !x.isNull("url") },x.optString("imageUrl").takeIf { !x.isNull("imageUrl") }) })
                else -> throw IllegalArgumentException("bad cache type")
            }
        } catch (_: Throwable) { throw failure }
    }

    private fun cacheKey(extensionId: String, sourceId: Long, kind: String, vararg parts: String): String =
        listOf(extensionId, sourceId.toString(), kind).plus(parts.toList()).joinToString("\u001f")

    private fun encodeCached(p: Payload): String = when (p) {
        is Payload.SearchPage -> org.json.JSONObject().put("type", "search").put("hasNextPage", p.hasNextPage).put("items", org.json.JSONArray().also { a -> p.items.forEach { a.put(org.json.JSONObject().put("remoteId", it.remoteId).put("title", it.title).put("coverUrl", it.coverUrl)) } }).toString()
        is Payload.Details -> org.json.JSONObject().put("type", "details").put("details", org.json.JSONObject().put("remoteId", p.details.remoteId).put("title", p.details.title).put("author", p.details.author).put("artist", p.details.artist).put("description", p.details.description).put("genres", org.json.JSONArray(p.details.genres)).put("status", p.details.status).put("coverUrl", p.details.coverUrl)).toString()
        is Payload.Chapters -> org.json.JSONObject().put("type", "chapters").put("chapters", org.json.JSONArray().also { a -> p.chapters.forEach { a.put(org.json.JSONObject().put("remoteId", it.remoteId).put("title", it.title).put("number", it.number).put("dateUpload", it.dateUpload).put("scanlator", it.scanlator)) } }).toString()
        is Payload.Pages -> org.json.JSONObject().put("type", "pages").put("pages", org.json.JSONArray().also { a -> p.pages.forEach { a.put(org.json.JSONObject().put("index", it.index).put("url", it.url).put("imageUrl", it.imageUrl)) } }).toString()
        else -> throw IllegalArgumentException("not cacheable")
    }

    private fun cachedPayload(key: String, ignored: Class<Payload>, failure: Fail): Payload {
        val raw = sourceCache.read(key) ?: throw failure
        return try {
            val o = org.json.JSONObject(raw)
            when (o.optString("type")) {
                "search" -> Payload.SearchPage((0 until o.optJSONArray("items").length()).map { i -> val x=o.getJSONArray("items").getJSONObject(i); MangaDto(x.getString("remoteId"),x.getString("title"),x.optString("coverUrl").takeIf { !x.isNull("coverUrl") }) }, o.optBoolean("hasNextPage"))
                "details" -> { val x=o.getJSONObject("details"); Payload.Details(DetailsDto(x.getString("remoteId"),x.getString("title"),x.optString("author").takeIf { !x.isNull("author") },x.optString("artist").takeIf { !x.isNull("artist") },x.optString("description").takeIf { !x.isNull("description") },(0 until x.getJSONArray("genres").length()).map { j -> x.getJSONArray("genres").getString(j) },x.optInt("status"),x.optString("coverUrl").takeIf { !x.isNull("coverUrl") })) }
                "chapters" -> Payload.Chapters((0 until o.getJSONArray("chapters").length()).map { i -> val x=o.getJSONArray("chapters").getJSONObject(i); ChapterDto(x.getString("remoteId"),x.getString("title"),if(x.isNull("number")) null else x.optDouble("number"),x.optLong("dateUpload"),x.optString("scanlator").takeIf { !x.isNull("scanlator") }) })
                "pages" -> Payload.Pages((0 until o.getJSONArray("pages").length()).map { i -> val x=o.getJSONArray("pages").getJSONObject(i); PageDto(x.optInt("index",i),x.optString("url").takeIf { !x.isNull("url") },x.optString("imageUrl").takeIf { !x.isNull("imageUrl") }) })
                else -> throw IllegalArgumentException("bad cache type")
            }
        } catch (_: Throwable) { throw failure }
    }

    private fun mapInstallPolicyFailure(o: InstallPolicy.Outcome): IpcError = when (o.state) {
        States.Lifecycle.HASH_MISMATCH, States.Lifecycle.PACKAGE_MISMATCH, States.Lifecycle.SIGNATURE_MISMATCH,
        States.Lifecycle.MALFORMED, States.Lifecycle.INCOMPATIBLE, States.Lifecycle.OBSOLETE,
        States.Lifecycle.BLOCKED, States.Lifecycle.UNTRUSTED -> IpcError(ErrorCode.VERIFICATION_FAILED, detailToken(o.code) ?: "VERIFICATION_FAILED")
        else -> IpcError(ErrorCode.VERIFICATION_FAILED, detailToken(o.code) ?: "VERIFICATION_FAILED")
    }

    private fun enable(req: RuntimeRequest.Enable): RuntimeResponse {
        val rec = record(req.extensionId)
        synchronized(mutation) {
            if (rec.quarantined) throw Fail(IpcError(ErrorCode.QUARANTINED))
            val candidate = rec.copy(enabled = true, quarantined = false, lastFailure = null)
            records.put(candidate)
            val loadError = loadRecord(candidate)
            if (loadError != null) {
                val failed = records.get(req.extensionId) ?: candidate
                records.put(failed.copy(enabled = false, quarantined = true, lastFailure = "RECOVERY_REQUIRED:ENABLE:${loadError.code.name}"))
                throw Fail(loadError)
            }
            return ok(req, Payload.Extension(info(candidate)))
        }
    }

    private fun disable(req: RuntimeRequest.Disable): RuntimeResponse {
        val rec = record(req.extensionId)
        synchronized(mutation) {
            loader.unload(rec.extensionId)
            val updated = rec.copy(enabled = false)
            records.put(updated)
            return ok(req, Payload.Extension(info(updated)))
        }
    }

    private fun uninstall(req: RuntimeRequest.Uninstall): RuntimeResponse {
        val rec = record(req.extensionId)
        synchronized(mutation) {
            loader.unload(rec.extensionId)
            if (androidInstaller != null && rec.extensionId.isNotBlank()) {
                val result = androidInstaller.uninstall(rec.extensionId)
                if (!result.success && result.message != "uninstall-no-result") {
                    throw Fail(IpcError(ErrorCode.VERIFICATION_FAILED, detailToken(result.message) ?: "UNINSTALL_FAILED"))
                }
            }
            records.remove(rec.extensionId)
            loadFailures.remove(rec.extensionId)
            deleteIfUnreferenced(rec.apkPath)
            try { onUninstall(rec.extensionId, req.requestId) } catch (t: Throwable) { log("uninstall hook failed", t) }
        }
        return ok(req, Payload.Ack)
    }

    private fun listSources(req: RuntimeRequest.ListSources, token: CancelToken): RuntimeResponse {
        val explicit = req.extensionId
        val ids = if (explicit != null) listOf(explicit)
        else records.all().filter { it.enabled && !it.quarantined }.map { it.extensionId }
        for (id in ids) {
            token.throwIfCancelled()
            try { requireLoaded(id) } catch (f: Fail) { if (explicit != null) throw f }
        }
        val dtos = ids.flatMap { registry.sourcesOf(it) }.take(IpcLimits.MAX_SOURCES).map(::sourceDto)
        return ok(req, Payload.Sources(dtos))
    }

    // ───────────── helpers ─────────────

    private fun record(id: String): ExtRecord = records.get(id) ?: throw Fail(IpcError(ErrorCode.NOT_FOUND))

    /** Lazy load: extension code first runs on the first source call, not at process start. */
    private fun requireLoaded(id: String) {
        val rec = record(id)
        if (rec.quarantined) throw Fail(IpcError(ErrorCode.QUARANTINED))
        if (!rec.enabled) throw Fail(IpcError(ErrorCode.DISABLED))
        if (registry.sourcesOf(id).isNotEmpty()) return
        synchronized(mutation) {
            if (registry.sourcesOf(id).isNotEmpty()) return
            loadRecord(rec)?.let { throw Fail(it) }
        }
    }

    private fun loadRecord(rec: ExtRecord): IpcError? {
        val file = File(rec.apkPath)
        if (!file.isFile) return IpcError(ErrorCode.LOAD_FAILED, "APK_MISSING")
        if (!compatAvailable()) return IpcError(ErrorCode.COMPAT_RUNTIME_UNAVAILABLE)
        records.markLoading(rec.extensionId)
        val outcome = try { loader.load(file, rec.extensionId) } finally { records.clearLoading() }
        return when (outcome) {
            is LoadOutcome.Loaded -> { loadFailures.remove(rec.extensionId); null }
            is LoadOutcome.Failed -> {
                log("load failed: ${outcome.code}", outcome.cause)
                loadFailures[rec.extensionId] = outcome.code.name
                val quarantined = rec.copy(
                    enabled = false,
                    quarantined = true,
                    lastFailure = "RECOVERY_REQUIRED:LOAD_FAILED:${outcome.code.name}",
                )
                try { records.put(quarantined) } catch (persist: Throwable) { log("could not persist load quarantine", persist) }
                if (outcome.code == LoadFailureCode.OWNER_MISMATCH) IpcError(ErrorCode.OWNER_MISMATCH)
                else IpcError(ErrorCode.LOAD_FAILED, outcome.code.name)
            }
        }
    }

    private fun <T> callSource(req: RuntimeRequest, token: CancelToken, block: (MangaHiveSourceAdapter) -> T): T {
        val key = SourceKey.of(req.extensionIdOrNull ?: throw Fail(IpcError(ErrorCode.BAD_REQUEST)), req.sourceIdForRuntime()).value
        if (!registry.health.canProbe(key)) throw Fail(IpcError(ErrorCode.SOURCE_ERROR, "SOURCE_COOLDOWN"))
        val started = clock()
        return try {
            val value = block(adapter(req.extensionIdOrNull!!, req.sourceIdForRuntime(), token))
            registry.health.success(key, (clock() - started).coerceAtLeast(0))
            value
        } catch (t: Throwable) {
            registry.health.failure(key)
            throw t
        }
    }

    private fun RuntimeRequest.sourceIdForRuntime(): Long = when (this) {
        is RuntimeRequest.Search -> sourceId
        is RuntimeRequest.Details -> sourceId
        is RuntimeRequest.Chapters -> sourceId
        is RuntimeRequest.Pages -> sourceId
        else -> throw IllegalArgumentException("not a source request")
    }

    private fun adapter(extensionId: String, sourceId: Long, token: CancelToken): MangaHiveSourceAdapter {
        requireLoaded(extensionId)
        token.throwIfCancelled()
        val key = SourceKey.of(extensionId, sourceId).value
        return registry.get(key) ?: throw Fail(IpcError(ErrorCode.NOT_FOUND))
    }

    private fun sourceFailure(req: RuntimeRequest, t: Throwable): Nothing {
        // java.net.SocketTimeoutException IS-A InterruptedIOException, so the bare type says nothing about WHY the I/O ended.
        // Only an explicit cancel signal (or a thread interrupt) is a cancel; a timeout-shaped I/O failure is decided by code below.
        if (t is CancelledException || t is InterruptedException) throw CancelledException()
        // Codes can arrive as a BrokerException (HTTP layer) or a GatewayException (compat gateway) anywhere in the cause chain.
        val codes = generateSequence(t) { it.cause }.mapNotNull {
            when (it) {
                is app.mangahive.mihon.spi.BrokerException -> it.code
                is app.mangahive.mihon.spi.GatewayException -> it.code
                else -> null
            }
        }.toList()
        // Only the CODE crosses to the web layer: never exception messages, stack traces, paths or the Source's own text.
        if ("CANCELLED" in codes) throw CancelledException()
        // A deadline/read timeout is TIMEOUT, not a cancel (if the JOB deadline fired, the dispatcher already replied TIMEOUT first).
        if ("TIMEOUT" in codes) throw Fail(IpcError(ErrorCode.TIMEOUT))
        // A raw read timeout that reached us without a broker code (extension-built client, OkHttp AsyncTimeout) is still a TIMEOUT.
        if (generateSequence(t) { it.cause }.any { it is java.net.SocketTimeoutException || (it is java.io.InterruptedIOException && it.message.equals("timeout", ignoreCase = true)) }) throw Fail(IpcError(ErrorCode.TIMEOUT))
        if (generateSequence(t) { it.cause }.any { it is java.io.InterruptedIOException }) throw CancelledException()
        if ("RESPONSE_TOO_LARGE" in codes) throw Fail(IpcError(ErrorCode.RESPONSE_TOO_LARGE))
        codes.firstOrNull { it == "RATE_LIMITED" || it == "CONCURRENCY_LIMIT" }?.let { throw Fail(IpcError(ErrorCode.BUSY, it)) }
        // NETWORK_FAILURE: there is deliberately no separate wire code (adding one changes the IPC contract); every other
        // broker/transport failure is the generic retryable SOURCE_ERROR, with the cause only in this process's logcat.
        log("source error in ${req.op.wire}", t) // stays in this process's logcat; never serialised
        throw Fail(IpcError(ErrorCode.SOURCE_ERROR))
    }

    private fun info(rec: ExtRecord): ExtensionInfo {
        val loaded = registry.sourcesOf(rec.extensionId).isNotEmpty()
        val state = when {
            rec.quarantined -> ExtensionState.QUARANTINED
            !rec.enabled -> ExtensionState.DISABLED
            loaded -> ExtensionState.LOADED
            loadFailures.containsKey(rec.extensionId) -> ExtensionState.LOAD_FAILED
            else -> ExtensionState.NOT_LOADED
        }
        return ExtensionInfo(rec.extensionId, rec.displayName, rec.versionName, rec.versionCode, rec.apiVersion, state,
            rec.signerSha256, registry.sourcesOf(rec.extensionId).size, loadFailures[rec.extensionId] ?: rec.lastFailure)
    }

    private fun health(): RuntimeHealth = RuntimeHealth(
        IPC_PROTOCOL_VERSION, process.pid, process.name, clock() - process.startedAtMs, compatAvailable(), inFlight(),
        records.all().take(IpcLimits.MAX_EXTENSIONS).map { ExtensionHealthDto(it.extensionId, info(it).state) },
    )

    private fun sourceDto(s: SourceInfo): SourceDto { val h = registry.health.snapshot(s.key); return SourceDto(s.key, s.extensionId, s.sourceId.toString(), s.name, s.lang, s.supportsLatest, s.baseUrl, h.status.name, h.consecutiveFailures, h.lastSuccessAt, h.lastFailureAt, h.cooldownUntil, h.lastLatencyMs) }

    private fun deleteIfUnreferenced(path: String) {
        if (records.all().none { it.apkPath == path }) try { File(path).delete() } catch (_: Exception) {}
    }

    private fun detailToken(message: String?): String? {
        val t = message?.uppercase()?.replace(Regex("[^A-Z0-9]+"), "_")?.trim('_')?.take(48)
        return t?.takeIf { IpcLimits.DETAIL.matches(it) }
    }

    private fun ok(req: RuntimeRequest, p: Payload): RuntimeResponse = RuntimeResponse.Success(req.requestId, req.op, p)
    private fun fail(req: RuntimeRequest, e: IpcError): RuntimeResponse = RuntimeResponse.Failure(req.requestId, req.op, e)
}
