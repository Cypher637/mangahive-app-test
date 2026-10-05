package app.mangahive.mihon.runtime

import java.io.File
import java.nio.charset.StandardCharsets
import java.security.MessageDigest

/** Durable, bounded cache of normalized extension-backed source data. It never stores executable code. */
class SourceDataCache(private val root: File?, private val maxBytes: Long = 8L * 1024L * 1024L) {
    private val lock = Any()
    private val maxAgeMs = 7L * 24L * 60L * 60L * 1000L

    fun read(key: String): String? {
        val dir = root ?: return null
        val f = fileFor(key)
        synchronized(lock) {
            return try {
                if (!f.isFile || System.currentTimeMillis() - f.lastModified() > maxAgeMs) {
                    if (f.exists()) f.delete()
                    null
                } else f.readText(StandardCharsets.UTF_8).takeIf { it.isNotBlank() }
            } catch (_: Throwable) { null }
        }
    }

    fun write(key: String, payload: String) {
        val dir = root ?: return
        if (payload.toByteArray(StandardCharsets.UTF_8).size > 512 * 1024) return
        synchronized(lock) {
            try {
                dir.mkdirs()
                val f = fileFor(key)
                val tmp = File(dir, f.name + ".tmp")
                tmp.writeText(payload, StandardCharsets.UTF_8)
                if (!tmp.renameTo(f)) { f.delete(); tmp.renameTo(f) }
                File(dir, f.name + ".key").writeText(key, StandardCharsets.UTF_8)
                evict(dir)
            } catch (_: Throwable) { /* cache is never authoritative */ }
        }
    }

    fun clearExtension(extensionId: String) {
        val dir = root ?: return
        // Cache filenames are hashes of the complete namespaced key, so an
        // extension cannot be removed by filename prefix. Keep a small key
        // sidecar for each entry and delete only records whose first key
        // component matches the extension. This is cleanup-only; cache data
        // is never authoritative.
        synchronized(lock) {
            try {
                dir.listFiles()?.filter { it.isFile && it.name.endsWith(".json") }?.forEach { f ->
                    val keyFile = File(dir, f.name + ".key")
                    val key = if (keyFile.isFile) keyFile.readText(StandardCharsets.UTF_8) else ""
                    if (key.substringBefore("\u001f", "") == extensionId) {
                        f.delete(); keyFile.delete()
                    }
                }
            } catch (_: Throwable) {}
        }
    }

    fun clearAll() { synchronized(lock) { try { root?.deleteRecursively() } catch (_: Throwable) {} } }

    private fun fileFor(key: String): File = File(requireNotNull(root), hash(key) + ".json")
    private fun hash(s: String): String = MessageDigest.getInstance("SHA-256")
        .digest(s.toByteArray(StandardCharsets.UTF_8)).joinToString("") { "%02x".format(it) }

    private fun evict(dir: File) {
        val files = dir.listFiles()?.filter { it.isFile && it.name.endsWith(".json") } ?: return
        var total = files.sumOf { it.length() }
        if (total <= maxBytes) return
        files.sortedBy { it.lastModified() }.forEach { f ->
            if (total <= maxBytes) return@forEach
            total -= f.length(); f.delete(); File(dir, f.name + ".key").delete()
        }
    }
}
