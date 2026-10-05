package app.mangahive.mihon.spi;

import java.util.ArrayList;
import java.util.Collections;
import java.util.List;

/**
 * One HTTP request as the Source's OkHttp client expressed it. JDK types only. Immutable.
 * Nothing here carries identity: identity is bound to the {@link HttpBroker} instance the host handed out, never
 * to a field the caller can set.
 */
public final class BrokerRequest {
    public final String method;
    public final String url;
    /** Ordered, repeated names allowed. Each entry is {name, value}. */
    public final List<String[]> headers;
    /** null = no body. */
    public final byte[] body;
    /** Content type of {@link #body}, or null. */
    public final String bodyContentType;
    /** OkHttpClient.followRedirects: when false the first 3xx is returned untouched. */
    public final boolean followRedirects;
    /** 0 = use broker default. Always clamped by the broker. */
    public final int connectTimeoutMs, readTimeoutMs, callTimeoutMs;

    public BrokerRequest(String method, String url, List<String[]> headers, byte[] body, String bodyContentType,
                         boolean followRedirects, int connectTimeoutMs, int readTimeoutMs, int callTimeoutMs) {
        this.method = method;
        this.url = url;
        List<String[]> copy = new ArrayList<String[]>(headers.size());
        for (String[] h : headers) copy.add(new String[] { h[0], h[1] });
        this.headers = Collections.unmodifiableList(copy);
        this.body = body == null ? null : body.clone();
        this.bodyContentType = bodyContentType;
        this.followRedirects = followRedirects;
        this.connectTimeoutMs = connectTimeoutMs;
        this.readTimeoutMs = readTimeoutMs;
        this.callTimeoutMs = callTimeoutMs;
    }
}
