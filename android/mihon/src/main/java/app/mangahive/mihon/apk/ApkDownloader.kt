package app.mangahive.mihon.apk

import app.mangahive.mihon.net.BoundedStreams
import app.mangahive.mihon.net.BrokerEngine
import app.mangahive.mihon.spi.BrokerException
import app.mangahive.mihon.spi.BrokerRequest
import app.mangahive.mihon.spi.RequestContext
import java.io.File
import java.io.FileOutputStream
import java.security.MessageDigest

/**
 * Streaming APK download, brokered. Size is enforced WHILE the bytes arrive (BrokerEngine's bounded body, plus the
 * explicit cap below on this loop), never after the file is complete. Declared-oversize is refused before the first
 * body byte; a chunked body with no Content-Length is cut at the cap. Cancel/timeout of [ctx] closes the socket under
 * the read. The partial file is deleted on every failure. Rate and concurrency: the engine's download bucket.
 */
class ApkDownloader(
    private val broker: BrokerEngine,
    private val maxBytes: Long = 80L * 1024L * 1024L,
) {
    data class Result(val file: File, val sha256: String, val bytes: Long, val finalUrl: String)

    class DownloadException(message: String) : Exception(message)

    fun download(httpsUrl: String, destFile: File, ctx: RequestContext, expectedSha256: String? = null): Result {
        val req = BrokerRequest("GET", httpsUrl,
            listOf(arrayOf("Accept", "application/vnd.android.package-archive,*/*"), arrayOf("Accept-Encoding", "identity")),
            null, null, true, 15_000, 60_000, 600_000)
        val resp = try { broker.download(req, ctx, maxBytes) } catch (e: BrokerException) { throw DownloadException(map(e.code)) }
        resp.use {
            if (it.status !in 200..299) throw DownloadException("HTTP ${it.status}")
            destFile.parentFile?.mkdirs()
            val digest = MessageDigest.getInstance("SHA-256")
            var total = 0L
            try {
                FileOutputStream(destFile).use { out ->
                    val buf = ByteArray(64 * 1024)
                    val input = it.body()
                    while (true) {
                        val want = minOf(buf.size.toLong(), maxBytes - total + 1).toInt() // never pull more than 1 byte past the cap
                        val n = input.read(buf, 0, want)
                        if (n < 0) break
                        total += n
                        if (total > maxBytes) throw BrokerException("RESPONSE_TOO_LARGE", "apk exceeds $maxBytes")
                        digest.update(buf, 0, n)
                        out.write(buf, 0, n)
                    }
                }
            } catch (e: BrokerException) {
                destFile.delete(); throw DownloadException(map(e.code))
            } catch (e: java.io.IOException) {
                destFile.delete(); throw DownloadException(if (ctx.cancel.isCancelled) "cancelled" else "io-error")
            }
            val sha = digest.digest().joinToString("") { b -> "%02x".format(b) }
            if (expectedSha256 != null && !expectedSha256.equals(sha, ignoreCase = true)) {
                destFile.delete(); throw DownloadException("sha256-mismatch")
            }
            return Result(destFile, sha, total, it.finalUrl)
        }
    }

    private fun map(code: String) = when (code) {
        "RESPONSE_TOO_LARGE" -> "response-too-large"
        "CANCELLED" -> "cancelled"
        "TIMEOUT" -> "timeout"
        "REDIRECT_BLOCKED", "REDIRECT_LOOP", "TOO_MANY_REDIRECTS" -> "redirect-blocked"
        else -> code.lowercase().replace('_', '-')
    }
}
