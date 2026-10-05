package eu.kanade.tachiyomi.network

import android.content.Context
import app.mangahive.compat.gateway.HostNetwork
import okhttp3.OkHttpClient

/**
 * MangaHive host implementation of the tachiyomix 1.6.0 `NetworkHelper`.
 *
 * Holds no client and no state: every read of [client] asks [HostNetwork] for the brokered client of the extension the HOST
 * has made current (construction scope or Source call scope). Any NetworkHelper instance, however obtained, therefore
 * resolves to the same broker-bound client, and outside a host scope it fails closed (BrokerException NO_IDENTITY).
 */
@Suppress("Unused", "UNUSED_PARAMETER")
class NetworkHelper private constructor(marker: Unit) {
    constructor(context: Context) : this(Unit)

    /** Host registration path (the compat bundle has no Android Context). */
    internal constructor() : this(Unit)

    val client: OkHttpClient
        get() = HostNetwork.clientForCurrentExtension()

    /** Same brokered client; there is no separate Cloudflare/WebView path in MangaHive. */
    @Deprecated(
        message = "The provided regular client should have cloudflare handling capability",
        replaceWith = ReplaceWith("client"),
    )
    val cloudflareClient: OkHttpClient
        get() = HostNetwork.clientForCurrentExtension()
}
