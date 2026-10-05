package app.mangahive.mihon.offline

import java.io.File
import java.security.MessageDigest

/**
 * Filesystem boundary for user-owned offline manga data.
 * IDs are hashed; titles, URLs and remote strings never become path components.
 */
class OfflineDownloadPathPolicy(private val root: File) {
    fun rootChildren(): List<File> = root.listFiles()?.toList().orEmpty()
    fun chapterDir(identity: DownloadIdentity): File = File(root, sha256(identity.stableKey))
    fun tempDir(identity: DownloadIdentity): File = File(root, ".tmp-" + sha256(identity.stableKey))
    fun pageFile(identity: DownloadIdentity, index: Int): File {
        require(index >= 0)
        return File(chapterDir(identity), "%04d.page".format(index))
    }
    fun manifestFile(identity: DownloadIdentity): File = File(chapterDir(identity), "manifest.json")

    fun isInside(candidate: File): Boolean {
        val base = root.canonicalFile.toPath()
        val target = candidate.canonicalFile.toPath()
        return target == base || target.startsWith(base)
    }

    private fun sha256(value: String): String = MessageDigest.getInstance("SHA-256")
        .digest(value.toByteArray(Charsets.UTF_8))
        .joinToString("") { "%02x".format(it) }
}
