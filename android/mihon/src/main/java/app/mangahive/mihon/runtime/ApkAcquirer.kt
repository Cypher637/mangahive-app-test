package app.mangahive.mihon.runtime

import app.mangahive.mihon.apk.ApkDownloader
import java.io.File
import app.mangahive.mihon.spi.RequestContext

class AcquiredApk(val file: File, val sha256: String)

/** Port so the engine can be unit-tested without a network. */
interface ApkAcquirer {
    /** @throws ApkDownloader.DownloadException with a short machine-readable message. */
    fun acquire(httpsUrl: String, expectedSha256: String?, ctx: RequestContext): AcquiredApk
}

/** Downloads inside the runtime process (never the UI process) into content-addressed files. */
class DownloadingApkAcquirer(private val dir: File, private val broker: app.mangahive.mihon.net.BrokerEngine) : ApkAcquirer {
    override fun acquire(httpsUrl: String, expectedSha256: String?, ctx: RequestContext): AcquiredApk {
        dir.mkdirs()
        val part = File.createTempFile("dl-", ".apk.part", dir) // a temp NAME, not a request id
        try {
            val r = ApkDownloader(broker).download(httpsUrl, part, ctx, expectedSha256)
            val dest = File(dir, "${r.sha256.take(32)}.apk")
            if (dest.exists()) {
                part.delete()
            } else if (!part.renameTo(dest)) {
                throw ApkDownloader.DownloadException("store-failed")
            }
            return AcquiredApk(dest, r.sha256)
        } finally {
            if (part.exists()) part.delete()
        }
    }
}
