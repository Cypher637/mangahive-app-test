package app.mangahive.compat.gateway

import app.mangahive.mihon.spi.BrokerException
import app.mangahive.mihon.spi.HostIdentityScope
import app.mangahive.mihon.spi.HttpBrokerHost
import okhttp3.OkHttpClient
import java.util.concurrent.ConcurrentHashMap

/**
 * The ONLY source of the OkHttp clients extensions see (NetworkHelper.client / cloudflareClient, hence HttpSource.client).
 * One client per extension, bound to the extension id the HOST made current ([HostIdentityScope.extensionIdForNewClient]:
 * the running Source call, else the extension being constructed). No host scope => NO_IDENTITY, no client.
 */
internal object HostNetwork {
    @Volatile private var host: HttpBrokerHost? = null
    private val clients = ConcurrentHashMap<String, OkHttpClient>()

    fun install(h: HttpBrokerHost) {
        if (host !== h) {
            host = h
            clients.clear()
        }
    }

    fun clientForCurrentExtension(): OkHttpClient {
        val extensionId = HostIdentityScope.extensionIdForNewClient()
        val h = host ?: throw BrokerException("NO_IDENTITY", "network not installed")
        return clients.getOrPut(extensionId) { BrokerClients.forExtension(extensionId, h) }
    }

    fun forget(extensionId: String) {
        clients.remove(extensionId)
    }
}
