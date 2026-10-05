package app.mangahive.mihon.runtime

import android.app.Application
import android.content.Context
import android.os.Build
import java.io.File

/**
 * Hard guard: third-party extension code may only be class-loaded inside the `:mihon` process.
 *
 * Closed by default. Only [app.mangahive.mihon.runtime.MihonExtensionService.onCreate] opens it, and only after
 * confirming the current process name is `<package>:mihon`. Every ClassLoader factory in the loader calls
 * [require] first, so even a wiring mistake that tried to load an extension in the UI process fails with an
 * exception instead of executing the bytecode.
 */
object RuntimeProcessGate {
    @Volatile private var open = false

    fun isRuntimeProcessName(processName: String?, packageName: String): Boolean = processName == "$packageName:mihon"

    fun currentProcessName(): String? {
        if (Build.VERSION.SDK_INT >= 28) return Application.getProcessName()
        return try {
            File("/proc/self/cmdline").inputStream().use { it.readBytes() }.toString(Charsets.UTF_8).substringBefore('\u0000')
        } catch (_: Exception) { null }
    }

    fun openIfRuntimeProcess(context: Context): Boolean {
        val ok = isRuntimeProcessName(currentProcessName(), context.packageName)
        open = ok
        return ok
    }

    fun require() {
        check(open) { "extension code may only be loaded in the :mihon runtime process" }
    }

    /** Test hook (JVM unit tests and the instrumented gate test, which runs outside :mihon). */
    internal fun setOpenForTests(value: Boolean) { open = value }
}
