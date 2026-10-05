package app.mangahive.mihon.loader

/** MangaHive-side description of a registered Mihon source. Plain data; safe to serialize to the WebView layer. */
data class SourceInfo(
    val key: String,
    val extensionId: String,
    val sourceId: Long,
    val name: String,
    val lang: String,
    val supportsLatest: Boolean,
    val baseUrl: String?,
    val entryClass: String,
) {
    fun toBridgeMap(): Map<String, Any?> = mapOf(
        "key" to key, "extensionId" to extensionId, "sourceId" to sourceId.toString(),
        "name" to name, "lang" to lang, "supportsLatest" to supportsLatest, "baseUrl" to baseUrl,
    )
}

data class AdaptedManga(val remoteId: String, val title: String, val coverUrl: String?)
data class AdaptedMangaPage(val items: List<AdaptedManga>, val hasNextPage: Boolean)
data class AdaptedDetails(
    val remoteId: String, val title: String, val author: String?, val artist: String?,
    val description: String?, val genres: List<String>, val status: Int, val coverUrl: String?,
)
data class AdaptedChapter(val remoteId: String, val title: String, val number: Double?, val dateUpload: Long, val scanlator: String?)
data class AdaptedPageImage(val index: Int, val url: String?, val imageUrl: String?)
