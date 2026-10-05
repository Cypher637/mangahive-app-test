package app.mangahive.mihon.offline

import org.json.JSONArray
import org.json.JSONObject
import java.io.File
import java.nio.charset.StandardCharsets
import java.security.MessageDigest
import android.graphics.BitmapFactory

/**
 * Atomic, data-only storage for completed chapters. A failed replacement never destroys
 * the previous valid download. The extension APK is never part of this storage tree.
 */
class OfflineDownloadStore(root: File) {
    private val policy = OfflineDownloadPathPolicy(root)
    private val lock = Any()

    fun writeAtomically(
        identity: DownloadIdentity,
        pages: List<File>,
        mimeTypes: List<String>,
        maxStorageBytes: Long = Long.MAX_VALUE,
        cleanupCutoffMs: Long? = null,
        protectedStableKeys: Set<String> = emptySet(),
    ): File {
        require(pages.isNotEmpty() && pages.size <= 500)
        require(pages.size == mimeTypes.size)
        synchronized(lock) {
            val temp = policy.tempDir(identity)
            val target = policy.chapterDir(identity)
            if (cleanupCutoffMs != null) cleanupOlderThanLocked(cleanupCutoffMs, protectedStableKeys)
            if (!policy.isInside(temp) || !policy.isInside(target)) error("download path escaped root")
            temp.deleteRecursively()
            check(temp.mkdirs()) { "cannot create download staging directory" }
            val entries = JSONArray()
            pages.forEachIndexed { index, source ->
                check(source.isFile && source.length() > 0) { "invalid page" }
                check(source.length() <= 25L * 1024L * 1024L) { "page too large" }
                val dst = File(temp, "%04d.page".format(index))
                source.inputStream().use { input -> dst.outputStream().use { output -> input.copyTo(output) } }
                val bounds = BitmapFactory.Options().apply { inJustDecodeBounds = true }
                BitmapFactory.decodeFile(dst.absolutePath, bounds)
                check(bounds.outWidth > 0 && bounds.outHeight > 0 && bounds.outWidth <= 20_000 && bounds.outHeight <= 20_000) { "invalid image dimensions" }
                entries.put(JSONObject().apply {
                    put("index", index)
                    put("bytes", dst.length())
                    put("sha256", sha256(dst))
                    put("contentType", mimeTypes[index])
                    put("width", bounds.outWidth)
                    put("height", bounds.outHeight)
                })
            }
            val replacementBytes = tempPagesBytes(temp)
            if (maxStorageBytes != Long.MAX_VALUE) {
                val currentUsage = usageBytesLocked() - directoryBytes(target).coerceAtLeast(0L)
                if (currentUsage + replacementBytes > maxStorageBytes) {
                    temp.deleteRecursively()
                    throw IllegalStateException("offline storage limit reached")
                }
            }
            File(temp, "manifest.json").writeText(JSONObject().apply {
                put("schemaVersion", 2)
                put("canonicalMangaId", identity.canonicalMangaId)
                put("canonicalChapterId", identity.canonicalChapterId)
                put("extensionId", identity.extensionId)
                put("sourceId", identity.sourceId)
                put("remoteChapterId", identity.remoteChapterId)
                put("pageCount", pages.size)
                put("totalBytes", replacementBytes)
                put("completedAt", System.currentTimeMillis())
                put("pages", entries)
            }.toString(), StandardCharsets.UTF_8)

            val backup = File(target.parentFile, target.name + ".old")
            if (backup.exists()) backup.deleteRecursively()
            if (target.exists() && !target.renameTo(backup)) error("cannot stage previous download")
            check(temp.renameTo(target)) {
                if (backup.exists()) backup.renameTo(target)
                "cannot atomically finalize download"
            }
            backup.deleteRecursively()
            return target
        }
    }

    fun validate(identity: DownloadIdentity): Boolean {
        synchronized(lock) {
            val dir = policy.chapterDir(identity)
            val manifest = policy.manifestFile(identity)
            if (!dir.isDirectory || !manifest.isFile) return false
            return runCatching {
                val json = JSONObject(manifest.readText(StandardCharsets.UTF_8))
                if (json.optInt("schemaVersion") != 2) return false
                if (json.optString("canonicalMangaId") != identity.canonicalMangaId) return false
                if (json.optString("canonicalChapterId") != identity.canonicalChapterId) return false
                if (json.optString("extensionId") != identity.extensionId) return false
                if (json.optString("sourceId") != identity.sourceId) return false
                if (json.optString("remoteChapterId") != identity.remoteChapterId) return false
                val pages = json.getJSONArray("pages")
                val count = json.optInt("pageCount", -1)
                if (count != pages.length() || pages.length() == 0 || pages.length() > 500) return false
                var total = 0L
                for (i in 0 until pages.length()) {
                    val entry = pages.getJSONObject(i)
                    if (entry.optInt("index", -1) != i) return false
                    val file = File(dir, "%04d.page".format(i))
                    if (!file.isFile || file.length() <= 0 || file.length() > 25L * 1024L * 1024L) return false
                    if (entry.optLong("bytes") != file.length()) return false
                    val hash = entry.optString("sha256")
                    if (!Regex("[0-9a-fA-F]{64}").matches(hash)) return false
                    if (hash != sha256(file)) return false
                    if (entry.optString("contentType").let { it.isBlank() || it.length > 128 || !it.startsWith("image/", ignoreCase = true) }) return false
                    if (entry.optInt("width", 0) <= 0 || entry.optInt("height", 0) <= 0 || entry.optInt("width", 0) > 20_000 || entry.optInt("height", 0) > 20_000) return false
                    total += file.length()
                    if (total > 512L * 1024L * 1024L) return false
                }
                if (json.optLong("totalBytes", -1L) != total) return false
                true
            }.getOrDefault(false)
        }
    }

    fun pageUrl(identity: DownloadIdentity, index: Int): String {
        require(index >= 0)
        return "https://mangahive.local/mangahive-offline/${identityHash(identity)}/%04d.page".format(index)
    }

    fun readManifest(identity: DownloadIdentity): JSONObject? = synchronized(lock) {
        val file = policy.manifestFile(identity)
        if (!file.isFile) null else runCatching { JSONObject(file.readText(StandardCharsets.UTF_8)) }.getOrNull()
    }

    /** Total completed offline bytes only; staging files are not counted. */
    fun usageBytes(): Long = synchronized(lock) { usageBytesLocked() }

    /** Remove completed chapters older than [cutoffMs], never touching active identities. */
    fun cleanupOlderThan(cutoffMs: Long, protectedStableKeys: Set<String> = emptySet()): Long = synchronized(lock) {
        cleanupOlderThanLocked(cutoffMs, protectedStableKeys)
    }

    private fun cleanupOlderThanLocked(cutoffMs: Long, protectedStableKeys: Set<String>): Long {
        var removed = 0L
        val dirs = policyRootChildren()
        dirs.forEach { dir ->
            if (!dir.isDirectory || dir.name.startsWith(".tmp-")) return@forEach
            val manifest = File(dir, "manifest.json")
            val parsed = runCatching { JSONObject(manifest.readText(StandardCharsets.UTF_8)) }.getOrNull() ?: return@forEach
            val completedAt = parsed.optLong("completedAt", 0L)
            val key = runCatching {
                listOf(parsed.optString("canonicalMangaId"), parsed.optString("canonicalChapterId"), parsed.optString("extensionId"), parsed.optString("sourceId"), parsed.optString("remoteChapterId"))
                    .joinToString("\u001f")
            }.getOrNull().orEmpty()
            if (completedAt > 0L && completedAt <= cutoffMs && key !in protectedStableKeys) {
                removed += directoryBytes(dir)
                dir.deleteRecursively()
            }
        }
        removed
    }

    private fun usageBytesLocked(): Long = policyRootChildren().sumOf { if (it.isDirectory && !it.name.startsWith(".tmp-")) directoryBytes(it) else 0L }

    private fun tempPagesBytes(temp: File): Long = temp.listFiles()?.filter { it.isFile && it.name.endsWith(".page") }?.sumOf { it.length() } ?: 0L

    private fun directoryBytes(dir: File): Long = dir.walkTopDown().filter { it.isFile }.sumOf { it.length() }

    private fun policyRootChildren(): List<File> = policy.rootChildren()

    fun identityHash(identity: DownloadIdentity): String = MessageDigest.getInstance("SHA-256")
        .digest(identity.stableKey.toByteArray(StandardCharsets.UTF_8))
        .joinToString("") { "%02x".format(it) }

    fun delete(identity: DownloadIdentity): Boolean = synchronized(lock) {
        val target = policy.chapterDir(identity)
        if (!policy.isInside(target)) return false
        !target.exists() || target.deleteRecursively()
    }

    private fun sha256(file: File): String {
        val digest = MessageDigest.getInstance("SHA-256")
        file.inputStream().use { input ->
            val buffer = ByteArray(8192)
            while (true) {
                val n = input.read(buffer)
                if (n <= 0) break
                digest.update(buffer, 0, n)
            }
        }
        return digest.digest().joinToString("") { "%02x".format(it) }
    }
}
