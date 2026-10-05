package eu.kanade.tachiyomi

import app.mangahive.compat.gateway.HostRuntimeInfo

/** Host app identity as seen by extensions (tachiyomix 1.6.0 `AppInfo`). Values are MangaHive's, never the extension's. */
@Suppress("Unused")
object AppInfo {
    fun getVersionCode(): Int = HostRuntimeInfo.versionCode

    fun getVersionName(): String = HostRuntimeInfo.versionName
}
