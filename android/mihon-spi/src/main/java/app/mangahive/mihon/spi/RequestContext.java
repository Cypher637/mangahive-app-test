package app.mangahive.mihon.spi;

/**
 * The one identity of a unit of work. {@code requestId} is minted by the web layer (or, if absent, by the bridge, the
 * top layer) and is carried unchanged through IPC, the runtime job, the Source call and every HTTP call it makes.
 * No lower layer mints its own id.
 */
public final class RequestContext {
    public final String requestId;
    public final CancelScope cancel;

    public RequestContext(String requestId, CancelScope cancel) {
        if (requestId == null || !requestId.matches("[A-Za-z0-9_.-]{1,64}")) throw new IllegalArgumentException("bad requestId");
        if (cancel == null) throw new IllegalArgumentException("no cancel scope");
        this.requestId = requestId;
        this.cancel = cancel;
    }

    /** Same request id, narrower scope (one HTTP call, one download). */
    public RequestContext withScope(CancelScope scope) { return new RequestContext(requestId, scope); }
}
