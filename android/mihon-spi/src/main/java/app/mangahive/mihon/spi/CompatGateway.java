package app.mangahive.mihon.spi;

import java.util.List;

/**
 * Lives inside the compat bundle (real upstream API + pinned deps, in its own ClassLoader). The host talks to it
 * only through this interface and the other app.mangahive.mihon.spi types.
 */
public interface CompatGateway {
    /** Upstream extension-lib version this bundle implements, e.g. "1.6". */
    String apiVersion();

    /**
     * Loads each entry class from {@code extensionLoader}; a SourceFactory yields all its sources, a Source yields itself.
     * One entry class may therefore produce several sources. Throws GatewayException on the first failure.
     *
     * Stage 5: {@code brokers} is the ONLY network capability the bundle receives. Every request a Source makes must go
     * through {@code brokers.open(extensionId, sourceId)}; the bundle has no other route to the network by design.
     */
    List<SourceGateway> instantiate(ClassLoader extensionLoader, String extensionId, List<String> entryClassNames,
                                    HttpBrokerHost brokers) throws GatewayException;
}
