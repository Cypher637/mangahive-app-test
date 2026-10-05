package app.mangahive.mihon.loader

import app.mangahive.mihon.spi.CompatGateway
import app.mangahive.mihon.spi.BrokerException
import app.mangahive.mihon.spi.BrokerRequest
import app.mangahive.mihon.spi.BrokerResponse
import app.mangahive.mihon.spi.CancelSignal
import app.mangahive.mihon.spi.GatewayException
import app.mangahive.mihon.spi.HttpBroker
import app.mangahive.mihon.spi.HttpBrokerHost
import app.mangahive.mihon.spi.RequestContext
import java.io.File

/** Ports so the pipeline is testable without Android; Android implementations are in AndroidLoaderPorts.kt. */
interface ManifestReader { fun read(apk: File): RawManifest? }
interface ExtensionClassLoaderFactory { fun create(apk: File, extensionId: String, parent: ClassLoader): ClassLoader }

class CompatRuntimeUnavailable(message: String, cause: Throwable? = null) : RuntimeException(message, cause)

/** The real-API bundle: its ClassLoader (upstream API + pinned deps) and the gateway living inside it. */
interface CompatRuntime {
    val apiVersion: String
    val compatLoader: ClassLoader
    val gateway: CompatGateway
}

sealed class LoadOutcome {
    data class Loaded(val descriptor: ExtensionDescriptor, val sources: List<SourceInfo>) : LoadOutcome()
    data class Failed(val code: LoadFailureCode, val detail: String, val cause: Throwable? = null) : LoadOutcome()
}

/**
 * APK -> manifest inspection -> compatibility detection -> dedicated ClassLoader -> entry points -> Sources
 * (via the compat gateway) -> registration. Never loads a class before the manifest is accepted, and never
 * registers anything from an extension that failed anywhere along the way.
 */
class ExtensionLoader(
    private val manifests: ManifestReader,
    private val compat: () -> CompatRuntime,
    private val classLoaders: ExtensionClassLoaderFactory,
    private val registry: MihonSourceRegistry,
    /** Stage 5: the only network capability handed to the compat bundle. Default = no network at all (fail closed). */
    private val brokers: HttpBrokerHost = DenyAllBrokers,
) {
    private val loaders = HashMap<String, ClassLoader>()

    @Synchronized
    fun load(apk: File, expectedPackage: String): LoadOutcome {
        val raw = manifests.read(apk) ?: return fail(LoadFailureCode.UNREADABLE_APK, "manifest unreadable")
        if (raw.packageName != expectedPackage) return fail(LoadFailureCode.PACKAGE_MISMATCH, "apk package differs from expected")

        val runtime = try { compat() } catch (e: CompatRuntimeUnavailable) {
            return fail(LoadFailureCode.COMPAT_RUNTIME_UNAVAILABLE, e.message ?: "unavailable", e)
        }
        val descriptor = when (val d = ExtensionDetector.detect(raw, setOf(runtime.apiVersion))) {
            is Detection.Rejected -> return Failed(d.code, d.detail)
            is Detection.Compatible -> d.descriptor
        }
        if (!registry.mayOwn(descriptor.extensionId, descriptor.signerSha256)) {
            return fail(LoadFailureCode.OWNER_MISMATCH, "extension id already owned by a different signer, or APK unsigned")
        }

        val boundary = BoundaryClassLoader(listOf(ExtensionBoundaries.FRAMEWORK, ExtensionBoundaries.compatApi(runtime.compatLoader)))
        val loader = try { classLoaders.create(apk, descriptor.extensionId, boundary) } catch (t: Throwable) {
            rethrowFatal(t); return fail(LoadFailureCode.CLASSLOADER_FAILED, t.javaClass.simpleName, t)
        }

        val handles = try { runtime.gateway.instantiate(loader, descriptor.extensionId, descriptor.entryClasses, brokers) } catch (e: GatewayException) {
            return fail(LoadFailureCode.INIT_FAILED, "${e.code}: ${e.message}", e)
        } catch (t: Throwable) {
            rethrowFatal(t); return fail(LoadFailureCode.INIT_FAILED, t.javaClass.simpleName, t)
        }
        if (handles.isEmpty()) return fail(LoadFailureCode.NO_SOURCES, "entry points produced no sources")

        val entries = ArrayList<MihonSourceRegistry.Entry>()
        val seen = HashSet<Long>()
        for (h in handles) {
            val name = h.name()
            val lang = h.lang()
            if (name.isNullOrBlank() || name.length > 128 || lang == null || !LANG.matches(lang)) {
                return fail(LoadFailureCode.BAD_SOURCE_METADATA, "invalid name/lang from ${h.entryClassName()}")
            }
            if (!seen.add(h.sourceId())) return fail(LoadFailureCode.DUPLICATE_SOURCE, "source id ${h.sourceId()} produced twice")
            val key = SourceKey.of(descriptor.extensionId, h.sourceId())
            val info = SourceInfo(key.value, descriptor.extensionId, h.sourceId(), name, lang, h.supportsLatest(), h.baseUrl(), h.entryClassName())
            entries += MihonSourceRegistry.Entry(key, descriptor.signerSha256.toSet(), MangaHiveSourceAdapter(info, h))
        }
        try { registry.replaceExtension(descriptor.extensionId, descriptor.signerSha256, entries) } catch (e: IllegalArgumentException) {
            return fail(if (e.message?.startsWith("DUPLICATE") == true) LoadFailureCode.DUPLICATE_SOURCE else LoadFailureCode.OWNER_MISMATCH, e.message ?: "", e)
        }
        loaders[descriptor.extensionId] = loader
        return LoadOutcome.Loaded(descriptor, entries.map { it.adapter.info })
    }

    @Synchronized
    fun unload(extensionId: String) {
        registry.unregister(extensionId)
        loaders.remove(extensionId) // ClassLoader becomes GC-eligible
    }

    private fun fail(code: LoadFailureCode, detail: String, cause: Throwable? = null) = LoadOutcome.Failed(code, detail, cause)
    private fun Failed(code: LoadFailureCode, detail: String) = LoadOutcome.Failed(code, detail)
    private fun rethrowFatal(t: Throwable) { if (t is VirtualMachineError) throw t }

    companion object { private val LANG = Regex("[A-Za-z0-9]{2,8}([-_][A-Za-z0-9]{1,8})*") }
}

/** Used when no broker is wired: every request fails with NETWORK_UNAVAILABLE. Never a silent direct connection. */
object DenyAllBrokers : HttpBrokerHost {
    override fun open(extensionId: String, sourceId: Long): HttpBroker = object : HttpBroker {
        override fun execute(request: BrokerRequest, ctx: RequestContext): BrokerResponse =
            throw BrokerException("NETWORK_UNAVAILABLE", "no network broker configured")
    }
}
