package app.mangahive.mihon.loader

import android.content.Context
import android.content.pm.PackageManager
import android.os.Build
import app.mangahive.mihon.runtime.RuntimeProcessGate
import app.mangahive.mihon.spi.CompatGateway
import dalvik.system.PathClassLoader
import java.io.File
import java.security.MessageDigest

/** Reads the manifest with PackageManager; executes no extension code. */
class PackageManagerManifestReader(private val context: Context) : ManifestReader {
    @Suppress("DEPRECATION")
    override fun read(apk: File): RawManifest? {
        if (!apk.isFile) return null
        val flags = PackageManager.GET_META_DATA or PackageManager.GET_CONFIGURATIONS or
            (if (Build.VERSION.SDK_INT >= 28) PackageManager.GET_SIGNING_CERTIFICATES else PackageManager.GET_SIGNATURES)
        val pm = context.packageManager
        val pi = (if (Build.VERSION.SDK_INT >= 33) pm.getPackageArchiveInfo(apk.absolutePath, PackageManager.PackageInfoFlags.of(flags.toLong()))
        else pm.getPackageArchiveInfo(apk.absolutePath, flags)) ?: return null
        val signers = if (Build.VERSION.SDK_INT >= 28) pi.signingInfo?.apkContentsSigners?.map { sha256(it.toByteArray()) }.orEmpty()
        else pi.signatures?.map { sha256(it.toByteArray()) }.orEmpty()
        val meta = pi.applicationInfo?.metaData
        val metaMap = meta?.keySet()?.associateWith { k -> meta.get(k)?.toString() }.orEmpty()
        val version = if (Build.VERSION.SDK_INT >= 28) pi.longVersionCode else pi.versionCode.toLong()
        return RawManifest(pi.packageName, pi.versionName, version, pi.reqFeatures?.mapNotNull { it.name }?.toSet().orEmpty(), metaMap, signers)
    }
}

/** One dedicated PathClassLoader per extension. Dex must be read-only on Android 14+. */
class PathClassLoaderFactory : ExtensionClassLoaderFactory {
    override fun create(apk: File, extensionId: String, parent: ClassLoader): ClassLoader {
        RuntimeProcessGate.require() // extension bytecode may only be loaded in :mihon
        apk.setReadOnly()
        return PathClassLoader(apk.absolutePath, parent)
    }
}

class PinnedFile(val file: File, val sha256: String)

/**
 * Loads the compat bundle (real upstream API + pinned dependency versions + gateway implementation) in its own
 * ClassLoader that sees only the framework and the SPI package of this app. Hash mismatch = unavailable.
 */
object PinnedCompatRuntime {
    const val GATEWAY_CLASS = "app.mangahive.compat.gateway.RealCompatGateway"

    fun create(files: List<PinnedFile>, expectedApiVersion: String): CompatRuntime {
        RuntimeProcessGate.require() // the compat bundle loads upstream code too: runtime process only
        if (files.isEmpty()) throw CompatRuntimeUnavailable("no compat bundle configured")
        for (f in files) {
            if (!f.file.isFile) throw CompatRuntimeUnavailable("bundle file missing: ${f.file.name}")
            if (!sha256(f.file).equals(f.sha256, ignoreCase = true)) throw CompatRuntimeUnavailable("bundle hash mismatch: ${f.file.name}")
            f.file.setReadOnly()
        }
        val parent = BoundaryClassLoader(listOf(ExtensionBoundaries.FRAMEWORK, ExtensionBoundaries.hostSpi(CompatGateway::class.java.classLoader!!)))
        val loader = PathClassLoader(files.joinToString(File.pathSeparator) { it.file.absolutePath }, parent)
        val gw = try {
            loader.loadClass(GATEWAY_CLASS).getDeclaredConstructor().newInstance() as CompatGateway
        } catch (t: Throwable) {
            if (t is VirtualMachineError) throw t
            throw CompatRuntimeUnavailable("gateway not loadable: ${t.javaClass.simpleName}", t)
        }
        if (gw.apiVersion() != expectedApiVersion) throw CompatRuntimeUnavailable("bundle implements ${gw.apiVersion()}, expected $expectedApiVersion")
        return object : CompatRuntime {
            override val apiVersion: String = gw.apiVersion()
            override val compatLoader: ClassLoader = loader
            override val gateway: CompatGateway = gw
        }
    }

    private fun sha256(f: File): String {
        val md = MessageDigest.getInstance("SHA-256")
        f.inputStream().use { s -> val b = ByteArray(8192); while (true) { val n = s.read(b); if (n < 0) break; md.update(b, 0, n) } }
        return md.digest().joinToString("") { "%02x".format(it) }
    }
}

private fun sha256(bytes: ByteArray) = MessageDigest.getInstance("SHA-256").digest(bytes).joinToString("") { "%02x".format(it) }
