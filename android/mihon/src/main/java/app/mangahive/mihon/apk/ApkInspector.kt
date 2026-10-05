package app.mangahive.mihon.apk

import android.content.Context
import android.content.pm.PackageManager
import android.os.Build
import java.io.File
import java.security.MessageDigest

/**
 * Static APK inspection via PackageManager — executes no extension code.
 * This is intentionally richer than repository metadata: the APK itself is authoritative for package/version,
 * manifest components, requested permissions and signing information.
 */
class ApkInspector(private val context: Context) {
    data class Report(
        val packageName: String?,
        val versionName: String?,
        val versionCode: Long?,
        val label: String?,
        val minSdk: Int?,
        val targetSdk: Int?,
        val permissions: List<String>,
        val certSha256: List<String>,
        val activities: List<String> = emptyList(),
        val services: List<String> = emptyList(),
        val receivers: List<String> = emptyList(),
        val providers: List<String> = emptyList(),
        val metadata: Map<String, String> = emptyMap(),
        val multipleSigners: Boolean = false,
        val hasPastSigningCertificates: Boolean = false,
        val error: String? = null,
    )

    fun inspect(apkFile: File): Report {
        if (!apkFile.isFile) return empty("file-missing")
        val pm = context.packageManager
        return try {
            var flags = PackageManager.GET_PERMISSIONS or PackageManager.GET_META_DATA or
                PackageManager.GET_ACTIVITIES or PackageManager.GET_SERVICES or
                PackageManager.GET_RECEIVERS or PackageManager.GET_PROVIDERS
            flags = flags or if (Build.VERSION.SDK_INT >= 28) PackageManager.GET_SIGNING_CERTIFICATES else PackageManager.GET_SIGNATURES
            val pi = if (Build.VERSION.SDK_INT >= 33) {
                pm.getPackageArchiveInfo(apkFile.absolutePath, PackageManager.PackageInfoFlags.of(flags.toLong()))
            } else {
                @Suppress("DEPRECATION") pm.getPackageArchiveInfo(apkFile.absolutePath, flags)
            } ?: return empty("unreadable-apk")

            pi.applicationInfo?.sourceDir = apkFile.absolutePath
            pi.applicationInfo?.publicSourceDir = apkFile.absolutePath
            val label = try { pi.applicationInfo?.loadLabel(pm)?.toString() } catch (_: Exception) { null }
            val perms = pi.requestedPermissions?.toList() ?: emptyList()
            val certs = mutableListOf<String>()
            var multiple = false
            var past = false
            if (Build.VERSION.SDK_INT >= 28) {
                pi.signingInfo?.let { info ->
                    multiple = info.hasMultipleSigners()
                    past = info.hasPastSigningCertificates()
                    info.apkContentsSigners?.forEach { certs += sha256(it.toByteArray()) }
                }
            } else {
                @Suppress("DEPRECATION") pi.signatures?.forEach { certs += sha256(it.toByteArray()) }
            }
            val meta = pi.applicationInfo?.metaData?.keySet()?.associateWith { key -> pi.applicationInfo?.metaData?.get(key)?.toString() ?: "" } ?: emptyMap()
            val vc = if (Build.VERSION.SDK_INT >= 28) pi.longVersionCode else @Suppress("DEPRECATION") pi.versionCode.toLong()
            Report(
                packageName = pi.packageName,
                versionName = pi.versionName,
                versionCode = vc,
                label = label,
                minSdk = pi.applicationInfo?.minSdkVersion,
                targetSdk = pi.applicationInfo?.targetSdkVersion,
                permissions = perms,
                certSha256 = certs,
                activities = pi.activities?.mapNotNull { it.name } ?: emptyList(),
                services = pi.services?.mapNotNull { it.name } ?: emptyList(),
                receivers = pi.receivers?.mapNotNull { it.name } ?: emptyList(),
                providers = pi.providers?.mapNotNull { it.name } ?: emptyList(),
                metadata = meta,
                multipleSigners = multiple,
                hasPastSigningCertificates = past,
            )
        } catch (e: Exception) {
            empty(e.message ?: "inspect-failed")
        }
    }

    private fun empty(error: String) = Report(null, null, null, null, null, null, emptyList(), emptyList(), error = error)

    private fun sha256(bytes: ByteArray): String {
        val d = MessageDigest.getInstance("SHA-256").digest(bytes)
        return d.joinToString("") { "%02x".format(it) }
    }
}
