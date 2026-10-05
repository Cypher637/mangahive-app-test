package app.mangahive.mihon.runtime

import android.content.Context
import org.json.JSONArray
import org.json.JSONObject
import java.util.concurrent.ConcurrentHashMap

/** What the runtime remembers about an installed extension. Lives only inside the :mihon process. */
data class ExtRecord(
    val extensionId: String,
    val apkPath: String,
    val sha256: String,
    val versionCode: Long,
    val versionName: String?,
    val displayName: String,
    val apiVersion: String?,
    val signerSha256: List<String>,
    val enabled: Boolean,
    val quarantined: Boolean,
    val lastFailure: String?,
)

interface ExtensionRecords {
    fun all(): List<ExtRecord>
    fun get(extensionId: String): ExtRecord?
    fun put(record: ExtRecord)
    fun remove(extensionId: String)

    /** Written (synchronously) before extension code is first executed, cleared after. Survives a process crash. */
    fun markLoading(extensionId: String)
    fun clearLoading()
    /** Returns and clears the extension that was loading when the process last died, if any. */
    fun takeLoadingSuspect(): String?
}

class InMemoryExtensionRecords : ExtensionRecords {
    private val map = ConcurrentHashMap<String, ExtRecord>()
    @Volatile private var loading: String? = null
    override fun all() = map.values.toList()
    override fun get(extensionId: String) = map[extensionId]
    override fun put(record: ExtRecord) { map[record.extensionId] = record }
    override fun remove(extensionId: String) { map.remove(extensionId) }
    override fun markLoading(extensionId: String) { loading = extensionId }
    override fun clearLoading() { loading = null }
    override fun takeLoadingSuspect(): String? = loading.also { loading = null }
}

/**
 * SharedPreferences-backed records. New file name: records written by the pre-Stage-4 stub runtime
 * ("mihon_ext_records") are deliberately not read; they described a runtime that no longer exists.
 */
class PrefsExtensionRecords(context: Context) : ExtensionRecords {
    private val prefs = context.getSharedPreferences("mihon_runtime_records_v2", Context.MODE_PRIVATE)
    private val cache = ConcurrentHashMap<String, ExtRecord>()

    init {
        prefs.all.forEach { (k, v) ->
            if (k == LOADING_KEY || v !is String) return@forEach
            try { cache[k] = decode(k, JSONObject(v)) } catch (_: Exception) { /* skip corrupt entry */ }
        }
    }

    override fun all() = cache.values.toList()
    override fun get(extensionId: String) = cache[extensionId]
    override fun put(record: ExtRecord) {
        cache[record.extensionId] = record
        prefs.edit().putString(record.extensionId, encode(record).toString()).commit()
    }
    override fun remove(extensionId: String) {
        cache.remove(extensionId)
        prefs.edit().remove(extensionId).commit()
    }
    override fun markLoading(extensionId: String) { prefs.edit().putString(LOADING_KEY, extensionId).commit() }
    override fun clearLoading() { prefs.edit().remove(LOADING_KEY).commit() }
    override fun takeLoadingSuspect(): String? {
        val s = prefs.getString(LOADING_KEY, null)
        if (s != null) prefs.edit().remove(LOADING_KEY).commit()
        return s
    }

    private fun encode(r: ExtRecord) = JSONObject()
        .put("apkPath", r.apkPath).put("sha256", r.sha256).put("versionCode", r.versionCode).put("versionName", r.versionName)
        .put("displayName", r.displayName).put("apiVersion", r.apiVersion).put("enabled", r.enabled)
        .put("quarantined", r.quarantined).put("lastFailure", r.lastFailure)
        .put("signers", JSONArray().also { a -> r.signerSha256.forEach { a.put(it) } })

    private fun decode(id: String, o: JSONObject): ExtRecord {
        val s = o.optJSONArray("signers")
        return ExtRecord(
            id, o.getString("apkPath"), o.getString("sha256"), o.getLong("versionCode"),
            if (o.isNull("versionName")) null else o.getString("versionName"),
            o.optString("displayName", id), if (o.isNull("apiVersion")) null else o.optString("apiVersion"),
            if (s == null) emptyList() else (0 until s.length()).map { s.getString(it) },
            o.optBoolean("enabled", true), o.optBoolean("quarantined", false),
            if (o.isNull("lastFailure")) null else o.optString("lastFailure"),
        )
    }

    private companion object { const val LOADING_KEY = "__loading__" }
}
