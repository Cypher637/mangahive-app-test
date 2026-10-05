package app.mangahive.mihon.offline

import org.json.JSONArray
import org.json.JSONObject
import java.io.File
import java.nio.charset.StandardCharsets

/**
 * Small, durable job journal for native offline downloads. It is deliberately data-only: no extension objects,
 * class names, URLs or tokens are persisted here. Writes are atomic so a process kill cannot leave half a JSON file.
 */
class OfflineDownloadJobStore(private val root: File) {
    data class Record(
        val identity: DownloadIdentity,
        val mangaRemoteId: String,
        val chapterRemoteId: String,
        var state: DownloadState,
        var retryCount: Int = 0,
        var completedPages: Int = 0,
        var totalPages: Int = 0,
        var bytesDownloaded: Long = 0L,
        var bytesTotal: Long = 0L,
        var updatedAt: Long = System.currentTimeMillis(),
        var failure: DownloadFailure? = null,
        var maxStorageBytes: Long = 0L,
        var cleanupAfterDays: Int = 0,
    )

    private val lock = Any()
    private val file = File(root, "jobs.json")

    init { root.mkdirs() }

    fun upsert(record: Record) = synchronized(lock) { write(allLocked().also { it[record.identity.stableKey] = record }) }

    fun remove(identity: DownloadIdentity) = synchronized(lock) { write(allLocked().also { it.remove(identity.stableKey) }) }

    fun get(identity: DownloadIdentity): Record? = synchronized(lock) { allLocked()[identity.stableKey] }

    fun all(): List<Record> = synchronized(lock) { allLocked().values.toList() }

    private fun allLocked(): LinkedHashMap<String, Record> {
        if (!file.isFile) return LinkedHashMap()
        return runCatching {
            val arr = JSONArray(file.readText(StandardCharsets.UTF_8))
            LinkedHashMap<String, Record>().also { out ->
                for (i in 0 until arr.length()) {
                    val o = arr.getJSONObject(i)
                    val identity = DownloadIdentity(
                        o.getString("canonicalMangaId"), o.getString("canonicalChapterId"),
                        o.getString("extensionId"), o.getString("sourceId"), o.getString("remoteChapterId"),
                    )
                    val state = DownloadState.valueOf(o.getString("state"))
                    val failure = o.optString("failure").takeIf { it.isNotBlank() }?.let { DownloadFailure.valueOf(it) }
                    val record = Record(identity, o.getString("mangaRemoteId"), o.getString("chapterRemoteId"), state,
                        o.optInt("retryCount", 0), o.optInt("completedPages", 0), o.optInt("totalPages", 0),
                        o.optLong("bytesDownloaded", 0L), o.optLong("bytesTotal", 0L), o.optLong("updatedAt", 0L), failure,
                        o.optLong("maxStorageBytes", 0L), o.optInt("cleanupAfterDays", 0))
                    out[identity.stableKey] = record
                }
            }
        }.getOrElse { error ->
            val corrupt = File(root, "jobs.json.corrupt-${System.currentTimeMillis()}")
            runCatching { if (file.isFile) file.renameTo(corrupt) }
            LinkedHashMap()
        }
    }

    private fun write(map: LinkedHashMap<String, Record>) {
        val tmp = File(root, "jobs.json.tmp")
        val arr = JSONArray()
        map.values.forEach { r ->
            arr.put(JSONObject().apply {
                put("canonicalMangaId", r.identity.canonicalMangaId)
                put("canonicalChapterId", r.identity.canonicalChapterId)
                put("extensionId", r.identity.extensionId)
                put("sourceId", r.identity.sourceId)
                put("remoteChapterId", r.identity.remoteChapterId)
                put("mangaRemoteId", r.mangaRemoteId)
                put("chapterRemoteId", r.chapterRemoteId)
                put("state", r.state.name)
                put("retryCount", r.retryCount)
                put("completedPages", r.completedPages)
                put("totalPages", r.totalPages)
                put("bytesDownloaded", r.bytesDownloaded)
                put("bytesTotal", r.bytesTotal)
                put("updatedAt", r.updatedAt)
                put("failure", r.failure?.name ?: JSONObject.NULL)
                put("maxStorageBytes", r.maxStorageBytes)
                put("cleanupAfterDays", r.cleanupAfterDays)
            })
        }
        tmp.writeText(arr.toString(), StandardCharsets.UTF_8)
        if (file.exists() && !file.delete()) error("cannot replace offline job journal")
        check(tmp.renameTo(file)) { "cannot finalize offline job journal" }
    }
}
