package app.mangahive.compat.gateway

/** Host-owned values the 1.6.0 API exposes (AppInfo, HttpSource default User-Agent). Never extension-supplied. */
internal object HostRuntimeInfo {
    const val versionCode: Int = 1
    const val versionName: String = "1.0.0"

    /** Same default the broker applies when a request has no User-Agent (BrokerEngine.Limits.defaultUserAgent). */
    const val defaultUserAgent: String =
        "Mozilla/5.0 (Linux; Android 13) AppleWebKit/537.36 (KHTML, like Gecko) Mobile Safari/537.36"
}
