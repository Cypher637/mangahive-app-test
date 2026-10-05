package eu.kanade.tachiyomi.network

import android.content.Context

/**
 * tachiyomix 1.6.0 `JavaScriptEngine` (since 1.4). Present with the exact upstream ABI so extensions that reference it still
 * link, but MangaHive does not execute extension-supplied JavaScript (no eval, no embedded JS engine, no WebView):
 * [evaluate] always fails with [UnsupportedOperationException]. Sources that depend on it are unsupported.
 */
@Suppress("Unused", "UNUSED_PARAMETER", "RedundantSuspendModifier")
class JavaScriptEngine(context: Context) {
    suspend fun <T> evaluate(script: String): T =
        throw UnsupportedOperationException("MangaHive does not execute JavaScript from extensions")
}
