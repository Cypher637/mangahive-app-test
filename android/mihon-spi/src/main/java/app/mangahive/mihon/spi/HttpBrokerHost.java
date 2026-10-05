package app.mangahive.mihon.spi;

/**
 * Handed to the compat gateway at {@code instantiate}. Returns the identity-bound broker for a source.
 * The gateway calls it once per Source it creates; it is host code, so a hostile or buggy extension cannot ask
 * for another extension's broker through the extension-visible API (SPI is not on the extension's class path).
 */
public interface HttpBrokerHost {
    HttpBroker open(String extensionId, long sourceId);
}
