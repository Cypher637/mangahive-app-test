package app.mangahive.mihon.spi;

/**
 * The only way a Source's HTTP leaves the compat bundle. One instance is bound by the HOST to one
 * (extensionId, sourceId) pair; the bundle cannot pick or change that identity per request.
 */
public interface HttpBroker {
    /**
     * Executes the request (following redirects only if {@link BrokerRequest#followRedirects}). Caller closes the response.
     * {@code ctx} carries the request id and the cancel scope: cancelling it aborts the connection attempt, the
     * in-flight read and the body stream, not merely the next poll.
     */
    BrokerResponse execute(BrokerRequest request, RequestContext ctx) throws BrokerException;
}
