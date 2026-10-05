package app.mangahive.mihon.runtime

import android.content.Context
import android.content.pm.PackageManager
import android.os.Build
import java.security.MessageDigest
import app.mangahive.mihon.install.ExtensionRegistry
import app.mangahive.mihon.install.InstalledExtension
import app.mangahive.mihon.install.States
import java.io.File
import java.nio.charset.StandardCharsets

/**
 * Stage 7 is the authoritative persistence layer for runtime extensions.
 * This adapter exists only because the existing RuntimeEngine API is intentionally
 * kept stable while the old PrefsExtensionRecords store is retired.
 */
class Stage7ExtensionRecords(context: Context) : ExtensionRecords {
    private val root = File(context.filesDir, "mihon_extensions")
    private val registry = ExtensionRegistry(root)
    private val loadingMarker = File(root, "loading.marker")

    override fun all(): List<ExtRecord> = registry.all().map(::toRuntime)
    override fun get(extensionId: String): ExtRecord? = registry.get(extensionId)?.let(::toRuntime)

    override fun put(record: ExtRecord) {
        val current = registry.get(record.extensionId)
        val r = current ?: InstalledExtension().apply {
            ecosystem = "mihon"
            repositoryId = "runtime"
            extensionId = record.extensionId
            packageName = record.extensionId
            installedAt = System.currentTimeMillis()
        }
        r.apkPath = record.apkPath
        r.sha256 = record.sha256
        r.versionCode = record.versionCode
        r.versionName = record.versionName
        r.displayName = record.displayName
        r.enabled = record.enabled
        r.state = when {
            record.quarantined && record.lastFailure?.startsWith("RECOVERY_REQUIRED:") == true -> States.Lifecycle.RECOVERY_REQUIRED
            record.quarantined -> States.Lifecycle.RUNTIME_FAILED
            !record.enabled -> States.Lifecycle.DISABLED
            else -> States.Lifecycle.ENABLED
        }
        r.compatibility = States.Compatibility.SUPPORTED
        r.failureCode = record.lastFailure
        r.lastFailure = record.lastFailure
        r.certSha256 = ArrayList(record.signerSha256)
        r.updatedAt = System.currentTimeMillis()
        registry.put(r)
    }

    override fun remove(extensionId: String) {
        registry.remove(extensionId)
    }

    override fun markLoading(extensionId: String) {
        root.mkdirs()
        val tmp = File(root, "loading.marker.tmp")
        tmp.writeText(extensionId, StandardCharsets.UTF_8)
        if (loadingMarker.exists()) loadingMarker.delete()
        tmp.renameTo(loadingMarker)
    }

    override fun clearLoading() {
        loadingMarker.delete()
        File(root, "loading.marker.tmp").delete()
    }

    override fun takeLoadingSuspect(): String? {
        if (!loadingMarker.isFile) return null
        return try {
            val id = loadingMarker.readText(StandardCharsets.UTF_8).trim()
            loadingMarker.delete()
            id.takeIf { it.isNotEmpty() }
        } catch (_: Exception) {
            loadingMarker.delete()
            null
        }
    }

    fun stage7(): ExtensionRegistry = registry

    /** Reconciles persisted extension identities with PackageManager after process/app restart. */
    fun reconcileInstalledPackages(context: Context) {
        for (r in registry.all()) {
            try {
                val pi = if (Build.VERSION.SDK_INT >= 33) {
                    context.packageManager.getPackageInfo(r.packageName, PackageManager.PackageInfoFlags.of(PackageManager.GET_SIGNING_CERTIFICATES.toLong()))
                } else {
                    @Suppress("DEPRECATION")
                    context.packageManager.getPackageInfo(r.packageName, PackageManager.GET_SIGNING_CERTIFICATES)
                }
                val version = if (Build.VERSION.SDK_INT >= 28) pi.longVersionCode else @Suppress("DEPRECATION") pi.versionCode.toLong()
                val signers = if (Build.VERSION.SDK_INT >= 28) {
                    pi.signingInfo?.apkContentsSigners?.map { sha256(it.toByteArray()) } ?: emptyList()
                } else {
                    @Suppress("DEPRECATION")
                    pi.signatures?.map { sha256(it.toByteArray()) } ?: emptyList()
                }
                when {
                    version != r.versionCode -> {
                        val updated = r.copy()
                        updated.enabled = false
                        updated.state = States.Lifecycle.OBSOLETE
                        updated.failureCode = "installed-version-mismatch"
                        updated.lastFailure = "PackageManager version does not match the verified registry version."
                        registry.put(updated)
                    }
                    r.certSha256.toSet() != signers.toSet() -> {
                        val updated = r.copy()
                        updated.enabled = false
                        updated.state = States.Lifecycle.SIGNATURE_MISMATCH
                        updated.failureCode = "installed-signer-mismatch"
                        updated.lastFailure = "PackageManager signer does not match the verified registry signer."
                        registry.put(updated)
                    }
                    else -> {
                        val source = pi.applicationInfo?.sourceDir
                        if (!source.isNullOrBlank() && source != r.apkPath) {
                            val updated = r.copy()
                            updated.apkPath = source
                            updated.updatedAt = System.currentTimeMillis()
                            registry.put(updated)
                        }
                    }
                }
            } catch (_: PackageManager.NameNotFoundException) {
                val updated = r.copy()
                updated.enabled = false
                updated.state = States.Lifecycle.MISSING
                updated.failureCode = "package-missing"
                updated.lastFailure = "PackageManager no longer reports the extension package as installed."
                registry.put(updated)
            } catch (_: Throwable) {
                // A transient PackageManager failure must not falsely bless an extension. Keep the persisted row untouched;
                // normal load-time verification remains fail-closed.
            }
        }
    }

    private fun sha256(bytes: ByteArray): String = MessageDigest.getInstance("SHA-256").digest(bytes).joinToString("") { "%02x".format(it) }

    fun updateSources(extensionId: String, sourceIds: List<String>) {
        val r = registry.get(extensionId) ?: return
        r.sourceIds = ArrayList(sourceIds)
        r.updatedAt = System.currentTimeMillis()
        registry.put(r)
    }

    private fun toRuntime(r: InstalledExtension) = ExtRecord(
        extensionId = r.extensionId,
        apkPath = r.apkPath ?: "",
        sha256 = r.sha256 ?: "",
        versionCode = r.versionCode,
        versionName = r.versionName,
        displayName = r.displayName ?: r.extensionId,
        apiVersion = null,
        signerSha256 = r.certSha256.toList(),
        enabled = r.enabled,
        quarantined = r.state == States.Lifecycle.RUNTIME_FAILED,
        lastFailure = r.lastFailure,
    )
}
