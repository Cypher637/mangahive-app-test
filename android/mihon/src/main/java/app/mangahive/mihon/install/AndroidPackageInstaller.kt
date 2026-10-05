package app.mangahive.mihon.install

import android.app.PendingIntent
import android.content.Context
import android.content.Intent
import android.content.pm.PackageInstaller
import android.os.Build
import java.io.File
import java.util.concurrent.CountDownLatch
import java.util.concurrent.TimeUnit
import java.util.concurrent.atomic.AtomicInteger

/**
 * Real Android PackageInstaller bridge. PackageInstaller session IDs are never used as MangaHive operation IDs.
 * Every request receives an independent local operation ID and the callback carries both identifiers.
 */
class AndroidPackageInstaller(private val context: Context) {
    data class Result(
        val success: Boolean,
        val packageName: String?,
        val versionCode: Long?,
        val sourceDir: String?,
        val message: String?,
        val operationId: String = ""
    )

    fun installedVersionCode(packageName: String): Long? = try {
        val pi = if (Build.VERSION.SDK_INT >= 33) {
            context.packageManager.getPackageInfo(packageName, android.content.pm.PackageManager.PackageInfoFlags.of(0))
        } else {
            @Suppress("DEPRECATION")
            context.packageManager.getPackageInfo(packageName, 0)
        }
        if (Build.VERSION.SDK_INT >= 28) pi.longVersionCode else @Suppress("DEPRECATION") pi.versionCode.toLong()
    } catch (_: android.content.pm.PackageManager.NameNotFoundException) {
        null
    }

    fun uninstall(packageName: String, timeoutMs: Long = 120_000L): Result {
        val operationId = "install-op-${OPERATION_IDS.getAndIncrement()}"
        val callbackId = CALLBACK_IDS.getAndIncrement()
        val latch = CountDownLatch(1)
        AndroidPackageInstallReceiver.register(callbackId, operationId, null, packageName, latch)
        try {
            val flags = PendingIntent.FLAG_UPDATE_CURRENT or
                (if (Build.VERSION.SDK_INT >= 23) PendingIntent.FLAG_IMMUTABLE else 0)
            val pending = PendingIntent.getBroadcast(
                context, callbackId,
                Intent(context, AndroidPackageInstallReceiver::class.java)
                    .setAction(ACTION_UNINSTALL)
                    .putExtra(AndroidPackageInstallReceiver.EXTRA_LOCAL_ID, callbackId)
                    .putExtra(AndroidPackageInstallReceiver.EXTRA_OPERATION_ID, operationId),
                flags
            )
            context.packageManager.packageInstaller.uninstall(packageName, pending.intentSender)
            if (!latch.await(timeoutMs, TimeUnit.MILLISECONDS)) {
                return Result(false, packageName, null, null, "uninstall-timeout", operationId)
            }
            return AndroidPackageInstallReceiver.result(callbackId)
                ?: Result(false, packageName, null, null, "uninstall-no-result", operationId)
        } catch (t: Throwable) {
            return Result(false, packageName, null, null, t.javaClass.simpleName, operationId)
        } finally {
            AndroidPackageInstallReceiver.unregister(callbackId)
        }
    }

    fun install(apk: File, expectedPackage: String, expectedVersionCode: Long, timeoutMs: Long = 120_000L): Result {
        require(apk.isFile) { "APK missing" }
        if (Build.VERSION.SDK_INT >= 26 && !context.packageManager.canRequestPackageInstalls()) {
            return Result(false, null, null, null, "install-permission-required")
        }
        val operationId = "install-op-${OPERATION_IDS.getAndIncrement()}"
        val installer = context.packageManager.packageInstaller
        val params = PackageInstaller.SessionParams(PackageInstaller.SessionParams.MODE_FULL_INSTALL).apply {
            setAppPackageName(expectedPackage)
            setSize(apk.length())
        }
        val sessionId = installer.createSession(params)
        val callbackId = CALLBACK_IDS.getAndIncrement()
        val latch = CountDownLatch(1)
        AndroidPackageInstallReceiver.register(callbackId, operationId, sessionId, expectedPackage, latch)
        try {
            installer.openSession(sessionId).use { session ->
                apk.inputStream().use { input ->
                    session.openWrite("base.apk", 0, apk.length()).use { output ->
                        input.copyTo(output, 64 * 1024)
                        session.fsync(output)
                    }
                }
                val pending = PendingIntent.getBroadcast(
                    context, callbackId,
                    Intent(context, AndroidPackageInstallReceiver::class.java)
                        .setAction(ACTION_INSTALL)
                        .putExtra(AndroidPackageInstallReceiver.EXTRA_LOCAL_ID, callbackId)
                        .putExtra(AndroidPackageInstallReceiver.EXTRA_OPERATION_ID, operationId)
                        .putExtra(PackageInstaller.EXTRA_SESSION_ID, sessionId),
                    PendingIntent.FLAG_UPDATE_CURRENT or
                        (if (Build.VERSION.SDK_INT >= 23) PendingIntent.FLAG_IMMUTABLE else 0)
                )
                session.commit(pending.intentSender)
            }
            if (!latch.await(timeoutMs, TimeUnit.MILLISECONDS)) {
                try { installer.abandonSession(sessionId) } catch (_: Exception) {}
                return Result(false, expectedPackage, null, null, "install-timeout", operationId)
            }
            val callback = AndroidPackageInstallReceiver.result(callbackId)
                ?: return Result(false, expectedPackage, null, null, "install-no-result", operationId)
            if (!callback.success) return callback

            val pi = if (Build.VERSION.SDK_INT >= 33) {
                context.packageManager.getPackageInfo(expectedPackage, android.content.pm.PackageManager.PackageInfoFlags.of(
                    android.content.pm.PackageManager.GET_SIGNING_CERTIFICATES.toLong()))
            } else {
                @Suppress("DEPRECATION")
                context.packageManager.getPackageInfo(expectedPackage, android.content.pm.PackageManager.GET_SIGNING_CERTIFICATES)
            }
            val installedVersion = if (Build.VERSION.SDK_INT >= 28) pi.longVersionCode else @Suppress("DEPRECATION") pi.versionCode.toLong()
            if (installedVersion != expectedVersionCode) {
                return Result(false, expectedPackage, installedVersion, pi.applicationInfo?.sourceDir, "installed-version-mismatch", operationId)
            }
            return Result(true, pi.packageName, installedVersion, pi.applicationInfo?.sourceDir, null, operationId)
        } catch (t: Throwable) {
            try { installer.abandonSession(sessionId) } catch (_: Exception) {}
            return Result(false, expectedPackage, null, null, t.javaClass.simpleName, operationId)
        } finally {
            AndroidPackageInstallReceiver.unregister(callbackId)
        }
    }

    companion object {
        private const val ACTION_INSTALL = "app.mangahive.mihon.PACKAGE_INSTALL"
        private const val ACTION_UNINSTALL = "app.mangahive.mihon.PACKAGE_UNINSTALL"
        private val CALLBACK_IDS = AtomicInteger(1000)
        private val OPERATION_IDS = AtomicInteger(1)
    }
}

/** Broadcast receiver keyed by a unique local callback ID, never by package hash or synthetic PackageInstaller session IDs. */
class AndroidPackageInstallReceiver : android.content.BroadcastReceiver() {
    override fun onReceive(context: Context, intent: Intent) {
        val localId = intent.getIntExtra(EXTRA_LOCAL_ID, -1)
        if (localId < 0) return
        val status = intent.getIntExtra(PackageInstaller.EXTRA_STATUS, PackageInstaller.STATUS_FAILURE)
        if (status == PackageInstaller.STATUS_PENDING_USER_ACTION) {
            val confirmation = if (Build.VERSION.SDK_INT >= 33) intent.getParcelableExtra(PackageInstaller.EXTRA_INTENT, Intent::class.java)
            else @Suppress("DEPRECATION") intent.getParcelableExtra<Intent>(PackageInstaller.EXTRA_INTENT)
            if (confirmation != null) {
                confirmation.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
                try { context.startActivity(confirmation) } catch (_: Exception) {}
            }
            return
        }
        complete(localId, AndroidPackageInstaller.Result(
            status == PackageInstaller.STATUS_SUCCESS,
            intent.getStringExtra(PackageInstaller.EXTRA_PACKAGE_NAME) ?: pendingPackage(localId),
            null, null, intent.getStringExtra(PackageInstaller.EXTRA_STATUS_MESSAGE),
            pendingOperation(localId) ?: ""
        ))
    }

    companion object {
        const val EXTRA_LOCAL_ID = "app.mangahive.mihon.extra.LOCAL_INSTALL_ID"
        const val EXTRA_OPERATION_ID = "app.mangahive.mihon.extra.OPERATION_ID"
        private data class Pending(val operationId: String, val sessionId: Int?, val packageName: String?, val latch: CountDownLatch)
        private val waits = java.util.concurrent.ConcurrentHashMap<Int, Pending>()
        private val results = java.util.concurrent.ConcurrentHashMap<Int, AndroidPackageInstaller.Result>()

        fun register(id: Int, operationId: String, sessionId: Int?, packageName: String?, latch: CountDownLatch) {
            waits[id] = Pending(operationId, sessionId, packageName, latch)
            results.remove(id)
        }
        fun unregister(id: Int) { waits.remove(id); results.remove(id) }
        fun result(id: Int): AndroidPackageInstaller.Result? = results[id]
        private fun pendingOperation(id: Int): String? = waits[id]?.operationId
        private fun pendingPackage(id: Int): String? = waits[id]?.packageName
        private fun complete(id: Int, result: AndroidPackageInstaller.Result) { results[id] = result; waits[id]?.latch?.countDown() }
    }
}
