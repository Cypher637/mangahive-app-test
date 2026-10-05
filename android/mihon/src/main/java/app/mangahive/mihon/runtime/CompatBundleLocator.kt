package app.mangahive.mihon.runtime

import app.mangahive.mihon.loader.CompatRuntime
import app.mangahive.mihon.loader.CompatRuntimeUnavailable
import app.mangahive.mihon.loader.PinnedCompatRuntime
import app.mangahive.mihon.loader.PinnedFile
import org.json.JSONException
import org.json.JSONObject
import java.io.File

/**
 * Finds the pinned compat bundle (real upstream API + gateway) in the runtime's private storage:
 *   <dir>/manifest.json  {"apiVersion":"1.6","files":[{"name":"compat.dex.jar","sha256":"<hex>"}]}
 * No manifest = no bundle = every load fails closed with COMPAT_RUNTIME_UNAVAILABLE (the honest Stage 3 state).
 */
class CompatBundleLocator(private val dir: File) {
    @Volatile private var cached: CompatRuntime? = null

    @Synchronized
    fun get(): CompatRuntime {
        cached?.let { return it }
        val manifest = File(dir, "manifest.json")
        if (!manifest.isFile) throw CompatRuntimeUnavailable("no compat bundle configured")
        val files: List<PinnedFile>
        val api: String
        try {
            val o = JSONObject(manifest.readText())
            api = o.getString("apiVersion")
            val arr = o.getJSONArray("files")
            files = (0 until arr.length()).map { i ->
                val f = arr.getJSONObject(i)
                val name = f.getString("name")
                if (name.contains('/') || name.contains('\\') || name.startsWith(".")) throw CompatRuntimeUnavailable("bad bundle file name")
                PinnedFile(File(dir, name), f.getString("sha256"))
            }
        } catch (e: JSONException) {
            throw CompatRuntimeUnavailable("bundle manifest unreadable", e)
        }
        return PinnedCompatRuntime.create(files, api).also { cached = it }
    }

    fun isAvailable(): Boolean = try { get(); true } catch (_: CompatRuntimeUnavailable) { false }
}
