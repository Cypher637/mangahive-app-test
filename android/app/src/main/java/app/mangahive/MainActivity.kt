package app.mangahive

import android.annotation.SuppressLint
import android.os.Bundle
import android.webkit.WebResourceRequest
import android.webkit.WebResourceResponse
import android.webkit.WebView
import android.webkit.WebViewClient
import androidx.appcompat.app.AppCompatActivity
import app.mangahive.mihon.bridge.MihonJsBridge
import java.io.BufferedInputStream
import java.io.File
import java.security.MessageDigest

class MainActivity : AppCompatActivity() {
    @SuppressLint("SetJavaScriptEnabled")
    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        val web = WebView(this)
        setContentView(web)
        web.settings.javaScriptEnabled = true
        web.settings.domStorageEnabled = true
        web.settings.allowFileAccess = true
        web.settings.allowContentAccess = false
        web.addJavascriptInterface(MihonJsBridge(this, web), "MangaHiveNative")
        val offlineRoot = File(filesDir, "offline_downloads").canonicalFile
        web.webViewClient = object : WebViewClient() {
            override fun shouldInterceptRequest(view: WebView, request: WebResourceRequest): WebResourceResponse? {
                return serveOffline(view, request.url.toString(), offlineRoot)
            }

            @Suppress("deprecation")
            override fun shouldInterceptRequest(view: WebView, url: String): WebResourceResponse? {
                return serveOffline(view, url, offlineRoot)
            }
        }
        val prodOrigin = System.getProperty("mangahive.pwa.origin")
        if (!prodOrigin.isNullOrBlank()) web.loadUrl(prodOrigin) else web.loadUrl("file:///android_asset/index.html")
    }

    private fun serveOffline(view: WebView, rawUrl: String, root: File): WebResourceResponse? {
        val uri = runCatching { android.net.Uri.parse(rawUrl) }.getOrNull() ?: return null
        if (!uri.scheme.equals("https", true) || uri.host != "mangahive.local") return null
        val path = uri.encodedPath ?: return null
        val m = Regex("^/mangahive-offline/([0-9a-fA-F]{64})/(\\d{4})\\.page$").matchEntire(path) ?: return null
        if (!uri.query.isNullOrBlank() || !uri.fragment.isNullOrBlank()) return null
        val target = File(File(root, m.groupValues[1]), m.groupValues[2] + ".page").canonicalFile
        if (!isInside(target, root)) return null
        if (!target.isFile || target.length() <= 0 || target.length() > 25L * 1024L * 1024L) return null
        val mime = sniffMime(target) ?: return null
        return runCatching {
            WebResourceResponse(mime, null, 200, "OK", mapOf("Cache-Control" to "no-store", "Access-Control-Allow-Origin" to "*"), target.inputStream().buffered())
        }.getOrNull()
    }

    private fun isInside(candidate: File, root: File): Boolean {
        val base = root.canonicalFile.toPath()
        val path = candidate.canonicalFile.toPath()
        return path.startsWith(base)
    }

    private fun sniffMime(file: File): String? {
        val h = ByteArray(32)
        val n = BufferedInputStream(file.inputStream(), 4096).use { it.read(h) }
        if (n >= 8 && h[0].toInt() == 0x89 && h[1].toInt() == 0x50 && h[2].toInt() == 0x4E && h[3].toInt() == 0x47) return "image/png"
        if (n >= 3 && h[0].toInt() == 0xFF && h[1].toInt() == 0xD8 && h[2].toInt() == 0xFF) return "image/jpeg"
        if (n >= 6 && String(h, 0, 6, Charsets.US_ASCII).startsWith("GIF")) return "image/gif"
        if (n >= 12 && String(h, 0, 4, Charsets.US_ASCII) == "RIFF" && String(h, 8, 4, Charsets.US_ASCII) == "WEBP") return "image/webp"
        if (n >= 2 && h[0].toInt() == 0x42 && h[1].toInt() == 0x4D) return "image/bmp"
        if (n >= 12 && String(h, 4, 8, Charsets.US_ASCII).lowercase().startsWith("ftypavif")) return "image/avif"
        return null
    }
}
