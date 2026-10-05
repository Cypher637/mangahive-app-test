package app.mangahive.mihon.offline

/** Persistent identity for a downloaded canonical chapter. */
data class DownloadIdentity(
    val canonicalMangaId: String,
    val canonicalChapterId: String,
    val extensionId: String,
    val sourceId: String,
    val remoteChapterId: String,
) {
    init {
        require(canonicalMangaId.isNotBlank())
        require(canonicalChapterId.isNotBlank())
        require(extensionId.isNotBlank())
        require(sourceId.isNotBlank())
        require(remoteChapterId.isNotBlank())
    }

    val stableKey: String
        get() = listOf(canonicalMangaId, canonicalChapterId, extensionId, sourceId, remoteChapterId)
            .joinToString("\u001f")
}

enum class DownloadState { QUEUED, RESOLVING, DOWNLOADING, PAUSED, COMPLETED, FAILED, CANCELLED, DELETING, CORRUPTED }

enum class DownloadPriority { HIGH, NORMAL, LOW }

enum class DownloadFailure {
    NETWORK, TIMEOUT, RATE_LIMITED, SOURCE_UNAVAILABLE, EXTENSION_FAILED,
    INVALID_RESPONSE, IMAGE_INVALID, TOO_LARGE, STORAGE, CANCELLED,
    POLICY_BLOCKED, UNKNOWN
}

data class DownloadProgress(
    val completedPages: Int,
    val totalPages: Int,
    val bytesDownloaded: Long = 0,
    val bytesTotal: Long = 0,
) {
    val fraction: Float
        get() = if (totalPages <= 0) 0f else (completedPages.toFloat() / totalPages).coerceIn(0f, 1f)
}
