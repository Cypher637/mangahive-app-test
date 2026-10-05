package app.mangahive.mihon.ipc.contract

/** Every request the main process may send. A closed hierarchy: there is no "call this class/method" member. */
sealed class RuntimeRequest {
    abstract val requestId: String
    abstract val op: Op
    open val extensionIdOrNull: String? get() = null

    data class Install(
        override val requestId: String,
        val apkUrl: String,
        val expectedSha256: String?,
        val expectedPackage: String?,
        val expectedSignerSha256: String?,
    ) : RuntimeRequest() { override val op: Op get() = Op.INSTALL }

    data class Inspect(override val requestId: String, val extensionId: String) : RuntimeRequest() {
        override val op: Op get() = Op.INSPECT
        override val extensionIdOrNull: String? get() = extensionId
    }

    data class Enable(override val requestId: String, val extensionId: String) : RuntimeRequest() {
        override val op: Op get() = Op.ENABLE
        override val extensionIdOrNull: String? get() = extensionId
    }

    data class Disable(override val requestId: String, val extensionId: String) : RuntimeRequest() {
        override val op: Op get() = Op.DISABLE
        override val extensionIdOrNull: String? get() = extensionId
    }

    data class Uninstall(override val requestId: String, val extensionId: String) : RuntimeRequest() {
        override val op: Op get() = Op.UNINSTALL
        override val extensionIdOrNull: String? get() = extensionId
    }

    data class ListSources(override val requestId: String, val extensionId: String?) : RuntimeRequest() {
        override val op: Op get() = Op.LIST_SOURCES
        override val extensionIdOrNull: String? get() = extensionId
    }

    data class Search(
        override val requestId: String, val extensionId: String, val sourceId: Long, val query: String, val page: Int,
    ) : RuntimeRequest() {
        override val op: Op get() = Op.SEARCH
        override val extensionIdOrNull: String? get() = extensionId
    }

    data class Details(
        override val requestId: String, val extensionId: String, val sourceId: Long, val mangaRemoteId: String,
    ) : RuntimeRequest() {
        override val op: Op get() = Op.DETAILS
        override val extensionIdOrNull: String? get() = extensionId
    }

    data class Chapters(
        override val requestId: String, val extensionId: String, val sourceId: Long, val mangaRemoteId: String,
    ) : RuntimeRequest() {
        override val op: Op get() = Op.CHAPTERS
        override val extensionIdOrNull: String? get() = extensionId
    }

    data class Pages(
        override val requestId: String, val extensionId: String, val sourceId: Long, val chapterRemoteId: String,
    ) : RuntimeRequest() {
        override val op: Op get() = Op.PAGES
        override val extensionIdOrNull: String? get() = extensionId
    }

    data class Download(
        override val requestId: String,
        val canonicalMangaId: String,
        val canonicalChapterId: String,
        val extensionId: String,
        val sourceId: Long,
        val mangaRemoteId: String,
        val chapterRemoteId: String,
        val maxStorageBytes: Long = 0L,
        val cleanupAfterDays: Int = 0,
    ) : RuntimeRequest() {
        override val op: Op get() = Op.DOWNLOAD
        override val extensionIdOrNull: String? get() = extensionId
    }

    data class DeleteDownload(
        override val requestId: String,
        val canonicalMangaId: String,
        val canonicalChapterId: String,
        val extensionId: String,
        val sourceId: Long,
        val remoteChapterId: String,
    ) : RuntimeRequest() {
        override val op: Op get() = Op.DELETE_DOWNLOAD
        override val extensionIdOrNull: String? get() = extensionId
    }

    data class Cancel(override val requestId: String, val targetRequestId: String) : RuntimeRequest() {
        override val op: Op get() = Op.CANCEL
    }

    data class Health(override val requestId: String) : RuntimeRequest() {
        override val op: Op get() = Op.HEALTH
    }
}

/** A failure is a code plus an optional machine token (never free text). The message comes from [ErrorCode]. */
data class IpcError(val code: ErrorCode, val detail: String? = null) {
    val message: String get() = code.message
    val retryable: Boolean get() = code.retryable
}

sealed class RuntimeResponse {
    abstract val requestId: String
    abstract val op: Op?

    data class Success(override val requestId: String, override val op: Op, val payload: Payload) : RuntimeResponse()
    data class Failure(override val requestId: String, override val op: Op?, val error: IpcError) : RuntimeResponse()
}

enum class ExtensionState { LOADED, NOT_LOADED, DISABLED, QUARANTINED, LOAD_FAILED }

data class ExtensionInfo(
    val extensionId: String,
    val displayName: String,
    val versionName: String?,
    val versionCode: Long,
    val apiVersion: String?,
    val state: ExtensionState,
    val signerSha256: List<String>,
    val sourceCount: Int,
    val lastFailure: String?,
)

data class SourceDto(
    val key: String, val extensionId: String, val sourceId: String, val name: String, val lang: String,
    val supportsLatest: Boolean, val baseUrl: String?, val healthStatus: String, val consecutiveFailures: Int,
    val lastSuccessAt: Long, val lastFailureAt: Long, val cooldownUntil: Long, val lastLatencyMs: Long,
)
data class MangaDto(val remoteId: String, val title: String, val coverUrl: String?)
data class DetailsDto(
    val remoteId: String, val title: String, val author: String?, val artist: String?, val description: String?,
    val genres: List<String>, val status: Int, val coverUrl: String?,
)
data class ChapterDto(val remoteId: String, val title: String, val number: Double?, val dateUpload: Long, val scanlator: String?)
data class PageDto(val index: Int, val url: String?, val imageUrl: String?)
data class OfflinePageDto(
    val index: Int,
    val url: String,
    val byteSize: Long,
    val sha256: String,
    val contentType: String,
    val width: Int,
    val height: Int,
)
data class OfflineDownloadDto(
    val canonicalMangaId: String,
    val canonicalChapterId: String,
    val extensionId: String,
    val sourceId: Long,
    val remoteChapterId: String,
    val pageCount: Int,
    val totalBytes: Long,
    val pages: List<OfflinePageDto>,
)
data class ExtensionHealthDto(val extensionId: String, val state: ExtensionState)
data class RuntimeHealth(
    val protocol: Int, val pid: Int, val processName: String, val uptimeMs: Long,
    val compatAvailable: Boolean, val inFlight: Int, val extensions: List<ExtensionHealthDto>,
)

sealed class Payload {
    object Ack : Payload()
    data class Extension(val info: ExtensionInfo) : Payload()
    data class Sources(val sources: List<SourceDto>) : Payload()
    data class SearchPage(val items: List<MangaDto>, val hasNextPage: Boolean) : Payload()
    data class Details(val details: DetailsDto) : Payload()
    data class Chapters(val chapters: List<ChapterDto>) : Payload()
    data class Pages(val pages: List<PageDto>) : Payload()
    data class OfflineDownload(val download: OfflineDownloadDto) : Payload()
    data class Health(val health: RuntimeHealth) : Payload()
}
