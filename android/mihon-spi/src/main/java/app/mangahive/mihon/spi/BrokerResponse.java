package app.mangahive.mihon.spi;

import java.io.Closeable;
import java.io.IOException;
import java.io.InputStream;
import java.util.ArrayList;
import java.util.Collections;
import java.util.List;

/**
 * A real HTTP response, not a byte array with a made-up 200. Carries what OkHttp's Response exposes to Sources:
 * status, reason phrase, protocol, headers (ordered, repeated), final URL and method, the redirect chain that led
 * here, content type/length, timing, and a STREAMING body that the caller must close.
 */
public final class BrokerResponse implements Closeable {
    /** One earlier hop of a redirect chain (its response was not delivered to the Source, only described). */
    public static final class Hop {
        public final int status;
        public final String message;
        public final String url;
        public final String method;
        public final List<String[]> headers;
        public Hop(int status, String message, String url, String method, List<String[]> headers) {
            this.status = status; this.message = message; this.url = url; this.method = method;
            this.headers = Collections.unmodifiableList(new ArrayList<String[]>(headers));
        }
    }

    public final int status;
    public final String message;
    /** "http/1.1", "h2", ... (OkHttp Protocol.toString spelling). */
    public final String protocol;
    /** URL of the request that produced THIS response (after redirects). */
    public final String finalUrl;
    /** Method of the request that produced this response (differs from the original after a 301/302/303). */
    public final String finalMethod;
    /** Headers as delivered to the Source (after transparent decompression: Content-Encoding/-Length removed). */
    public final List<String[]> headers;
    public final String contentType;
    /** -1 = unknown (chunked, or decompressed). */
    public final long contentLength;
    /** Earlier hops, oldest first. Empty when no redirect happened. */
    public final List<Hop> priorHops;
    public final long sentAtMillis, receivedAtMillis;
    private final InputStream body;

    public BrokerResponse(int status, String message, String protocol, String finalUrl, String finalMethod,
                          List<String[]> headers, String contentType, long contentLength, List<Hop> priorHops,
                          long sentAtMillis, long receivedAtMillis, InputStream body) {
        this.status = status; this.message = message; this.protocol = protocol;
        this.finalUrl = finalUrl; this.finalMethod = finalMethod;
        this.headers = Collections.unmodifiableList(new ArrayList<String[]>(headers));
        this.contentType = contentType; this.contentLength = contentLength;
        this.priorHops = Collections.unmodifiableList(new ArrayList<Hop>(priorHops));
        this.sentAtMillis = sentAtMillis; this.receivedAtMillis = receivedAtMillis;
        this.body = body;
    }

    /** Never null; empty stream for HEAD/204/304 etc. Reading it enforces size and cancellation limits. */
    public InputStream body() { return body; }

    @Override public void close() throws IOException { body.close(); }
}
