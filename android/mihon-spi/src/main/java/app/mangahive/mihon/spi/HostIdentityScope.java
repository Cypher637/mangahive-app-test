package app.mangahive.mihon.spi;

import java.util.concurrent.Callable;
import java.util.concurrent.ConcurrentHashMap;

/**
 * Host-established identity for a Source's network use. JDK-only so it can be tested on a plain JVM.
 *
 * Two scopes, both entered ONLY by host code (the gateway), never by the extension and never from anything the extension
 * returns or sends (no header, no argument, no field):
 *
 *  - {@link #construction}: the host is loading extension E (instantiate / createSources). Only the extension id is known;
 *    the Source's id does not exist yet. An HTTP client the extension asks for here (typically
 *    {@code override val client = network.client.newBuilder()...build()} in a property initialiser) is bound to E.
 *  - {@link #call}: the host is serving one Source call. Carries (extensionId, sourceId, RequestContext). This is where the
 *    source id and the request id come from.
 *
 * Both are thread-local with save/restore, so there is no mutable global "active extension"/"current source". The gateway
 * re-installs {@link Call} on coroutine and OkHttp dispatcher threads (RequestScope.element / wrap). A request with no
 * {@link Call} is refused (fail closed), as is a client used under another extension's call.
 */
public final class HostIdentityScope {
    private HostIdentityScope() { }

    /** One Source call, fixed by the host. */
    public static final class Call {
        public final String extensionId;
        public final long sourceId;
        public final RequestContext request;

        public Call(String extensionId, long sourceId, RequestContext request) {
            if (extensionId == null || extensionId.isEmpty()) throw new IllegalArgumentException("no extensionId");
            if (request == null) throw new IllegalArgumentException("no request");
            this.extensionId = extensionId;
            this.sourceId = sourceId;
            this.request = request;
        }
    }

    private static final ThreadLocal<String> CONSTRUCTION = new ThreadLocal<String>();
    private static final ThreadLocal<Call> CALL = new ThreadLocal<Call>();

    public static <T> T construction(String extensionId, Callable<T> body) throws Exception {
        if (extensionId == null || extensionId.isEmpty()) throw new IllegalArgumentException("no extensionId");
        String prev = CONSTRUCTION.get();
        CONSTRUCTION.set(extensionId);
        try { return body.call(); } finally { restore(CONSTRUCTION, prev); }
    }

    public static <T> T call(Call c, Callable<T> body) throws Exception {
        Call prev = CALL.get();
        CALL.set(c);
        try { return body.call(); } finally { restore(CALL, prev); }
    }

    /** Re-installs {@code c} on the current thread (coroutine / executor hop); returns what to pass to {@link #leave}. */
    public static Call enter(Call c) { Call prev = CALL.get(); if (c == null) CALL.remove(); else CALL.set(c); return prev; }
    public static void leave(Call prev) { restore(CALL, prev); }

    public static Call currentCall() { return CALL.get(); }

    /**
     * Which extension a client being created now belongs to: the running call's extension, else the extension being
     * constructed. Neither => no client (an extension thread of its own cannot obtain a brokered client).
     */
    public static String extensionIdForNewClient() throws BrokerException {
        Call c = CALL.get();
        if (c != null) return c.extensionId;
        String e = CONSTRUCTION.get();
        if (e != null) return e;
        throw new BrokerException("NO_IDENTITY", "client requested outside a host-established scope");
    }

    private static <T> void restore(ThreadLocal<T> tl, T prev) { if (prev == null) tl.remove(); else tl.set(prev); }

    /**
     * The HttpBroker behind a client created for ONE extension. Source id and request come from the running {@link Call};
     * the extension id is the one the client was bound to when the HOST handed it out. Anything else is refused.
     * Resolves {@code host.open(extensionId, sourceId)} once per source (cookie jars stay per (extension, source)).
     */
    public static final class ScopedBroker implements HttpBroker {
        private final String extensionId;
        private final HttpBrokerHost host;
        private final ConcurrentHashMap<Long, HttpBroker> bySource = new ConcurrentHashMap<Long, HttpBroker>();

        public ScopedBroker(String extensionId, HttpBrokerHost host) {
            if (extensionId == null || extensionId.isEmpty() || host == null) throw new IllegalArgumentException("unbound");
            this.extensionId = extensionId;
            this.host = host;
        }

        public String extensionId() { return extensionId; }

        @Override public BrokerResponse execute(BrokerRequest request, RequestContext ctx) throws BrokerException {
            Call c = CALL.get();
            if (c == null) throw new BrokerException("NO_REQUEST_CONTEXT", "HTTP call outside a host-established Source call");
            if (!c.extensionId.equals(extensionId)) throw new BrokerException("IDENTITY_MISMATCH", "client belongs to another extension");
            HttpBroker b = bySource.get(c.sourceId);
            if (b == null) {
                HttpBroker opened = host.open(extensionId, c.sourceId);
                HttpBroker raced = bySource.putIfAbsent(c.sourceId, opened);
                b = raced != null ? raced : opened;
            }
            return b.execute(request, ctx);
        }
    }
}
