package app.mangahive.compat.gateway

import app.mangahive.mihon.spi.CompatGateway
import app.mangahive.mihon.spi.GatewayException
import app.mangahive.mihon.spi.HostIdentityScope
import app.mangahive.mihon.spi.HttpBrokerHost
import app.mangahive.mihon.spi.SourceGateway
import eu.kanade.tachiyomi.source.Source
import eu.kanade.tachiyomi.source.SourceFactory
import java.lang.reflect.InvocationTargetException
import java.util.concurrent.Callable

/**
 * Entry-point discovery against the 1.6.0 API (verified: `eu.kanade.tachiyomi.source.SourceFactory.createSources(): List<Source>`).
 * Construction runs inside [HostIdentityScope.construction], so any client an extension obtains while being built
 * (`network.client.newBuilder()...` in a property initialiser) is bound to THIS extension by the host.
 */
class RealCompatGateway : CompatGateway {
    override fun apiVersion(): String = "1.6"

    override fun instantiate(extensionLoader: ClassLoader, extensionId: String, entryClassNames: List<String>, brokers: HttpBrokerHost): List<SourceGateway> {
        HostNetwork.install(brokers)
        HostInjekt.ensureInstalled() // NetworkHelper + Json resolvable via Injekt BEFORE any extension constructor runs
        val out = ArrayList<SourceGateway>()
        for (name in entryClassNames) {
            val instance = try {
                HostIdentityScope.construction(extensionId, Callable { Class.forName(name, true, extensionLoader).getDeclaredConstructor().newInstance() })
            } catch (e: ClassNotFoundException) {
                throw GatewayException("ENTRY_CLASS_NOT_FOUND", name, e)
            } catch (e: InvocationTargetException) {
                throw GatewayException("ENTRY_CONSTRUCTOR_THREW", "$name: ${e.targetException.javaClass.simpleName}", e.targetException)
            } catch (e: LinkageError) { // includes ExceptionInInitializerError, NoSuchMethodError, NoClassDefFoundError
                throw GatewayException("ENTRY_LINKAGE", "$name: ${e.javaClass.simpleName}: ${e.message}", e)
            } catch (e: ReflectiveOperationException) {
                throw GatewayException("ENTRY_NOT_INSTANTIABLE", name, e)
            }
            when (instance) {
                is SourceFactory -> {
                    val made = try {
                        HostIdentityScope.construction(extensionId, Callable { instance.createSources() })
                    } catch (e: Throwable) {
                        throw GatewayException("FACTORY_THREW", "$name: ${e.javaClass.simpleName}", e)
                    }
                    made.forEach { out += RealSourceGateway(name, extensionId, it) }
                }
                is Source -> out += RealSourceGateway(name, extensionId, instance)
                else -> throw GatewayException("ENTRY_NOT_A_SOURCE", "$name is neither Source nor SourceFactory")
            }
        }
        return out
    }
}
