package app.mangahive.mihon.loader

import org.json.JSONArray
import org.json.JSONObject
import java.io.File
import java.nio.charset.StandardCharsets
import java.util.concurrent.ConcurrentHashMap

/** Bounded per-source health with optional atomic persistence across :mihon restarts. */
class SourceHealthTracker(
    private val cooldownMs: Long = 30_000L,
    private val offlineAfter: Int = 3,
    private val persistenceFile: File? = null,
) {
    data class Snapshot(
        val sourceKey: String, val status: Status, val consecutiveFailures: Int,
        val lastSuccessAt: Long, val lastFailureAt: Long, val cooldownUntil: Long, val lastLatencyMs: Long,
    )
    enum class Status { UNKNOWN, HEALTHY, DEGRADED, OFFLINE }
    private data class Mutable(var failures: Int = 0, var success: Long = 0, var failure: Long = 0, var cooldown: Long = 0, var latency: Long = 0)
    private val states = ConcurrentHashMap<String, Mutable>()

    init { load() }

    fun canProbe(key: String, now: Long = System.currentTimeMillis()): Boolean = states[key]?.cooldown?.let { now >= it } ?: true

    fun success(key: String, latencyMs: Long, now: Long = System.currentTimeMillis()) {
        val s = states.computeIfAbsent(key) { Mutable() }
        synchronized(s) { s.failures = 0; s.success = now; s.cooldown = 0; s.latency = latencyMs.coerceAtLeast(0) }
        persist()
    }

    fun failure(key: String, now: Long = System.currentTimeMillis()) {
        val s = states.computeIfAbsent(key) { Mutable() }
        synchronized(s) { s.failures = (s.failures + 1).coerceAtMost(offlineAfter + 10); s.failure = now; s.cooldown = now + cooldownMs.coerceAtMost(10 * 60_000L) }
        persist()
    }

    fun snapshot(key: String, now: Long = System.currentTimeMillis()): Snapshot {
        val s = states[key] ?: return Snapshot(key, Status.UNKNOWN, 0, 0, 0, 0, 0)
        synchronized(s) {
            val status = when { s.failures >= offlineAfter -> Status.OFFLINE; s.failures > 0 -> Status.DEGRADED; s.success > 0 -> Status.HEALTHY; else -> Status.UNKNOWN }
            return Snapshot(key, status, s.failures, s.success, s.failure, s.cooldown, s.latency)
        }
    }

    fun all(): List<Snapshot> = states.keys.map { snapshot(it) }.sortedBy { it.sourceKey }
    fun clear(key: String) { states.remove(key); persist() }
    fun clearExtension(extensionId: String) { states.keys.filter { SourceKey.parse(it)?.extensionId == extensionId }.forEach(states::remove); persist() }

    private fun load() {
        val f = persistenceFile ?: return
        try {
            if (!f.isFile || System.currentTimeMillis() - f.lastModified() > 7L * 24L * 60L * 60L * 1000L) return
            val arr = JSONArray(f.readText(StandardCharsets.UTF_8))
            for (i in 0 until minOf(arr.length(), 512)) {
                val o = arr.getJSONObject(i); val key = o.getString("key")
                if (SourceKey.parse(key) == null) continue
                states[key] = Mutable(o.optInt("failures",0),o.optLong("success",0),o.optLong("failure",0),o.optLong("cooldown",0),o.optLong("latency",0))
            }
        } catch (_: Throwable) { states.clear() }
    }

    @Synchronized private fun persist() {
        val f = persistenceFile ?: return
        try {
            f.parentFile?.mkdirs()
            val arr = JSONArray()
            states.entries.sortedBy { it.key }.take(512).forEach { (key, s) -> synchronized(s) { arr.put(JSONObject().put("key",key).put("failures",s.failures).put("success",s.success).put("failure",s.failure).put("cooldown",s.cooldown).put("latency",s.latency)) } }
            val tmp = File(f.parentFile, f.name + ".tmp")
            tmp.writeText(arr.toString(), StandardCharsets.UTF_8)
            if (!tmp.renameTo(f)) { f.delete(); tmp.renameTo(f) }
        } catch (_: Throwable) {}
    }
}
