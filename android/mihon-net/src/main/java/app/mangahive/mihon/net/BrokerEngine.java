package app.mangahive.mihon.net;

import app.mangahive.mihon.spi.BrokerException;
import app.mangahive.mihon.spi.BrokerRequest;
import app.mangahive.mihon.spi.BrokerResponse;
import app.mangahive.mihon.spi.CancelScope;
import app.mangahive.mihon.spi.Registration;
import app.mangahive.mihon.spi.RequestContext;
import app.mangahive.mihon.spi.HttpBroker;
import app.mangahive.mihon.spi.HttpBrokerHost;

import java.io.FilterInputStream;
import java.io.IOException;
import java.io.InputStream;
import java.net.ConnectException;
import java.net.SocketTimeoutException;
import java.net.UnknownHostException;
import java.util.ArrayList;
import java.util.Arrays;
import java.util.HashMap;
import java.util.HashSet;
import java.util.List;
import java.util.Locale;
import java.util.Map;
import java.util.Set;
import java.util.zip.GZIPInputStream;
import javax.net.ssl.SSLException;

/**
 * MangaHive Network Broker. Every outbound byte of extension HTTP, repository downloads and APK downloads goes
 * through {@link #execute}: DestinationPolicy (every hop) -> header policy -> cookie jar -> {@link Transport}
 * (SecureHttpClient's wire) -> response with real HTTP semantics.
 *
 * Redirects are followed HERE, one hop at a time, each hop through the full policy again (scheme, https, port, host
 * rules, fresh DNS resolution, address classification). The transport never follows one.
 */
public final class BrokerEngine implements HttpBrokerHost {

    public static final class Limits {
        public int maxRequestBodyBytes = 8 * 1024 * 1024;
        public long maxResponseBytes = 64L * 1024 * 1024;
        public int maxRedirects = 20;                   // OkHttp's follow-up ceiling
        public int defaultConnectMs = 15_000, defaultReadMs = 30_000, defaultCallMs = 120_000;
        public String defaultUserAgent = "Mozilla/5.0 (Linux; Android 13) AppleWebKit/537.36 (KHTML, like Gecko) Mobile Safari/537.36";
    }

    private static final int MIN_MS = 1_000, MAX_CONNECT_MS = 60_000, MAX_READ_MS = 120_000, MAX_CALL_MS = 600_000;
    private static final Set<String> METHODS = new HashSet<String>(Arrays.asList("GET", "HEAD", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"));
    private static final int LOOP_VISITS = 3;

    private final DestinationPolicy policy;
    private final Transport transport;
    private final CookieStore cookies;
    private final Limits limits;
    private final ResourceGovernor governor;
    private final Deadlines deadlines;

    public BrokerEngine(DestinationPolicy policy, Transport transport, CookieStore cookies, Limits limits) {
        this(policy, transport, cookies, limits, new ResourceGovernor(), Deadlines.shared());
    }

    public BrokerEngine(DestinationPolicy policy, Transport transport, CookieStore cookies, Limits limits,
                        ResourceGovernor governor, Deadlines deadlines) {
        this.policy = policy; this.transport = transport; this.cookies = cookies; this.limits = limits;
        this.governor = governor; this.deadlines = deadlines;
    }

    public ResourceGovernor governor() { return governor; }

    /** Identity-bound broker. The pair is captured here and is not a parameter of any later call. */
    @Override public HttpBroker open(final String extensionId, final long sourceId) {
        final CookieScope scope = new CookieScope(extensionId, sourceId);
        return new HttpBroker() {
            @Override public BrokerResponse execute(BrokerRequest r, RequestContext c) throws BrokerException {
                return BrokerEngine.this.execute(scope, r, c, limits.maxResponseBytes);
            }
        };
    }

    /** Repository / APK downloads: same policy and wire, but no cookies and no extension identity. */
    public BrokerResponse download(BrokerRequest r, RequestContext c, long maxBytes) throws BrokerException {
        return execute(null, r, c, maxBytes);
    }

    public CookieStore cookies() { return cookies; }

    // ───────────────────────────── the one pipeline ─────────────────────────────

    public BrokerResponse execute(CookieScope scope, BrokerRequest req, RequestContext ctx, long maxBody) throws BrokerException {
        if (ctx == null) throw new BrokerException("NO_REQUEST_CONTEXT", "every request belongs to a request id");
        String method = req.method == null ? "" : req.method.toUpperCase(Locale.ROOT);
        if (!METHODS.contains(method)) throw new BrokerException("METHOD_NOT_ALLOWED", method);
        boolean noBody = method.equals("GET") || method.equals("HEAD");
        if (noBody && req.body != null) throw new BrokerException("BAD_REQUEST", method + " cannot carry a body");
        if (req.body != null && req.body.length > limits.maxRequestBodyBytes) throw new BrokerException("REQUEST_TOO_LARGE", Integer.toString(req.body.length));

        List<String[]> headers;
        try { headers = HeaderPolicy.sanitize(req.headers).headers; }
        catch (PolicyViolation v) { throw new BrokerException(v.reason, v.detail); }
        SafeUrl url;
        try { url = SafeUrl.parse(req.url); } catch (PolicyViolation v) { throw new BrokerException(v.reason, v.detail); }

        // Resources: concurrency slot + first rate token, per source AND per extension (downloads: their own bucket).
        final ResourceGovernor.Lease lease = scope != null
            ? governor.admitCall(scope.extensionId, scope.sourceId, ctx.cancel)
            : governor.admitDownload(ctx.cancel);
        final long cap = Math.min(maxBody, lease.maxResponseBytes());
        final int connectMs = clamp(req.connectTimeoutMs, limits.defaultConnectMs, MAX_CONNECT_MS);
        final int readMs = clamp(req.readTimeoutMs, limits.defaultReadMs, MAX_READ_MS);
        final int callMs = lease.callMs(req.callTimeoutMs);

        // One cancel scope + one deadline per HTTP call (all hops and the body). Timeout CANCELS it: sockets are closed.
        final CancelScope call = ctx.cancel.child();
        final Registration timer = deadlines.after(callMs, new Runnable() {
            @Override public void run() { call.cancel(CancelScope.Reason.TIMEOUT); }
        });
        final Runnable release = new Runnable() {
            @Override public void run() { timer.close(); call.close(); lease.close(); }
        };
        try {
            return run(scope, req, method, headers, url, connectMs, readMs, cap, call, lease, release, ctx.requestId);
        } catch (BrokerException e) {
            release.run(); throw e;
        } catch (RuntimeException e) {
            release.run(); throw e;
        }
    }

    private BrokerResponse run(CookieScope scope, BrokerRequest req, String method, List<String[]> headers, SafeUrl url,
                               int connectMs, int readMs, long cap, CancelScope call, ResourceGovernor.Lease lease,
                               Runnable release, String requestId) throws BrokerException {
        byte[] body = req.body;
        String bodyType = req.bodyContentType;
        boolean callerAcceptEncoding = HeaderPolicy.has(headers, "Accept-Encoding");

        List<BrokerResponse.Hop> prior = new ArrayList<BrokerResponse.Hop>();
        Map<String, Integer> visits = new HashMap<String, Integer>();
        int followUps = 0;
        boolean firstHop = true;

        while (true) {
            if (call.isCancelled()) throw call.asException();
            if (!firstHop) lease.hop(call);          // every redirect hop is a real outbound request
            firstHop = false;

            // 1. policy for THIS hop (first request and every redirect target alike)
            Destination dest;
            try { dest = policy.check(url); }
            catch (PolicyViolation v) {
                if (call.isCancelled()) throw call.asException();   // an interrupted lookup is a cancel, not a DNS verdict
                if (prior.isEmpty()) throw new BrokerException(v.reason, v.detail);
                throw new BrokerException("REDIRECT_BLOCKED", v.reason + (v.detail.isEmpty() ? "" : " " + v.detail));
            }
            if (call.isCancelled()) throw call.asException();   // DNS resolution cannot be interrupted; do not dial after it

            // 2. outgoing headers
            List<String[]> out = new ArrayList<String[]>(headers);
            if (!HeaderPolicy.has(out, "User-Agent")) out.add(new String[] { "User-Agent", limits.defaultUserAgent });
            boolean transparentGzip = false;
            if (!callerAcceptEncoding && !HeaderPolicy.has(out, "Range") && !method.equals("HEAD")) {
                out.add(new String[] { "Accept-Encoding", "gzip" });
                transparentGzip = true;
            }
            if (scope != null && !HeaderPolicy.has(out, "Cookie")) {
                String c = cookies.cookieHeader(scope, url);
                if (c != null) out.add(new String[] { "Cookie", c });
            }
            if (body != null && bodyType != null && !HeaderPolicy.has(out, "Content-Type")) out.add(new String[] { "Content-Type", bodyType });

            // 3. the wire (the transport registers its abort hook on `call`: cancel/timeout close the socket)
            long sent = System.currentTimeMillis();
            Transport.Response tr;
            try {
                tr = transport.execute(new Transport.Request(method, url, dest.addresses, out, body, connectMs, readMs, requestId, call));
            } catch (BrokerException e) {
                throw e;
            } catch (IOException e) {
                throw mapIo(e, call);
            }
            long received = System.currentTimeMillis();

            // 4. cookies from EVERY hop (redirect hops included), into this scope's jar only
            if (scope != null) cookies.saveFromResponse(scope, url, all(tr.headers, "Set-Cookie"));

            // 5. redirect?
            int code = tr.status;
            if (req.followRedirects && isRedirect(code)) {
                String loc = HeaderPolicy.first(tr.headers, "Location");
                // 307/308 on a non-idempotent method is returned to the caller untouched, exactly as OkHttp does.
                boolean followable = loc != null && (!(code == 307 || code == 308) || method.equals("GET") || method.equals("HEAD"));
                if (followable) {
                    SafeUrl next;
                    try { next = SafeUrl.resolve(url, loc); }
                    catch (PolicyViolation v) { abortQuietly(tr); throw new BrokerException("REDIRECT_BLOCKED", v.reason + (v.detail.isEmpty() ? "" : " " + v.detail)); }
                    if (++followUps > limits.maxRedirects) { abortQuietly(tr); throw new BrokerException("TOO_MANY_REDIRECTS", Integer.toString(followUps)); }

                    boolean toGet = !method.equals("GET") && !method.equals("HEAD") && !(code == 307 || code == 308);
                    String nextMethod = toGet ? "GET" : method;
                    String key = nextMethod + " " + next;
                    Integer seen = visits.get(key);
                    int n = seen == null ? 1 : seen + 1;
                    visits.put(key, n);
                    if (n >= LOOP_VISITS) { abortQuietly(tr); throw new BrokerException("REDIRECT_LOOP", next.toString()); }

                    prior.add(new BrokerResponse.Hop(code, tr.message, url.toString(), method, tr.headers));
                    abortQuietly(tr);                 // the redirect's body is of no interest: do not read or drain it
                    List<String[]> nextHeaders = headers;
                    if (toGet) {
                        method = "GET"; body = null; bodyType = null;
                        nextHeaders = HeaderPolicy.without(nextHeaders, "Content-Type", "Content-Length", "Transfer-Encoding");
                    }
                    if (!next.sameOrigin(url)) {
                        // OkHttp drops Authorization when the connection can't be reused; an explicit Cookie header is the
                        // same kind of credential and goes too. The jar is consulted afresh for the new origin.
                        nextHeaders = HeaderPolicy.without(nextHeaders, "Authorization", "Cookie", "Proxy-Authorization");
                    }
                    headers = nextHeaders;
                    url = next;
                    continue;
                }
            }

            // 6. deliver
            return deliver(tr, url, method, transparentGzip, prior, sent, received, cap, call, release);
        }
    }

    private BrokerResponse deliver(final Transport.Response tr, SafeUrl url, String method, boolean transparentGzip,
                                   List<BrokerResponse.Hop> prior, long sent, long received, long maxBody,
                                   CancelScope call, Runnable release) throws BrokerException {
        int code = tr.status;
        boolean bodyless = method.equals("HEAD") || code == 204 || code == 304 || (code >= 100 && code < 200);
        List<String[]> hdrs = new ArrayList<String[]>(tr.headers);
        String ce = HeaderPolicy.first(hdrs, "Content-Encoding");
        boolean decode = transparentGzip && !bodyless && ce != null && ce.trim().equalsIgnoreCase("gzip");
        long declared = parseLong(HeaderPolicy.first(hdrs, "Content-Length"), -1);
        // A declared oversize body is refused before a single body byte is read, and the connection is torn down.
        if (!bodyless && !decode && declared > maxBody) { abortQuietly(tr); throw new BrokerException("RESPONSE_TOO_LARGE", "declared " + declared); }

        InputStream stream;
        if (bodyless) {
            closeQuietly(tr);
            release.run();                 // nothing left to stream: the call is over
            stream = new Empty();
        } else {
            InputStream src = tr.body;
            if (decode) {
                src = new LazyGzip(src);
                hdrs = HeaderPolicy.without(hdrs, "Content-Encoding", "Content-Length");
                declared = -1;
            }
            // closing the body closes the transport response (unregisters its cancel hook) as well
            final InputStream inner = src;
            InputStream viaTransport = new FilterInputStream(inner) {
                @Override public void close() throws IOException { try { inner.close(); } finally { tr.close(); } }
            };
            // Size is enforced as the stream is read (chunked / unknown length included); failure aborts the connection.
            stream = new BoundedStreams.Body(viaTransport, maxBody, call, new Runnable() { @Override public void run() { tr.abort(); } },
                release, "RESPONSE_TOO_LARGE");
        }
        String ct = HeaderPolicy.first(hdrs, "Content-Type");
        return new BrokerResponse(code, tr.message == null ? "" : tr.message, tr.protocol == null ? "http/1.1" : tr.protocol,
            url.toString(), method, hdrs, ct, declared, prior, sent, received, stream);
    }

    // ───────────────────────────── helpers ─────────────────────────────

    private static boolean isRedirect(int c) { return c == 300 || c == 301 || c == 302 || c == 303 || c == 307 || c == 308; }

    private static int clamp(int requested, int dflt, int max) {
        int v = requested <= 0 ? dflt : requested;
        return Math.max(MIN_MS, Math.min(max, v));
    }

    private static long parseLong(String s, long dflt) {
        if (s == null) return dflt;
        try { return Long.parseLong(s.trim()); } catch (NumberFormatException e) { return dflt; }
    }

    private static List<String> all(List<String[]> h, String name) {
        List<String> out = new ArrayList<String>();
        for (String[] e : h) if (e[0].equalsIgnoreCase(name)) out.add(e[1]);
        return out;
    }

    private static void closeQuietly(Transport.Response r) { try { r.close(); } catch (IOException ignored) { } }

    /** Gives up on a response without reading the rest of it. */
    private static void abortQuietly(Transport.Response r) { try { r.abort(); } catch (RuntimeException ignored) { } }

    /**
     * Timeout shapes seen from real transports: java.net.SocketTimeoutException (plain sockets), okio/OkHttp's
     * InterruptedIOException("timeout") (SocketTimeoutException's superclass, thrown by AsyncTimeout), JSSE read timeouts
     * wrapped in an SSLException ("Read timed out"), and any of those as the CAUSE of another IOException. A cancel/deadline
     * owned by this request is decided first (it is reported as CANCELLED/TIMEOUT by the scope), so a user cancel that
     * surfaces as an InterruptedIOException is never misreported as a network timeout.
     */
    static boolean isTimeout(Throwable e) {
        int depth = 0;
        for (Throwable t = e; t != null && depth < 8; t = t.getCause(), depth++) {
            if (t instanceof SocketTimeoutException) return true;
            if (t instanceof java.io.InterruptedIOException) return true;
            String m = t.getMessage();
            if (m != null && (t instanceof SSLException || t instanceof IOException) && (m.equalsIgnoreCase("timeout") || m.toLowerCase(java.util.Locale.ROOT).contains("timed out"))) return true;
        }
        return false;
    }

    static BrokerException mapIo(IOException e, CancelScope cancel) {
        if (cancel.isCancelled()) return cancel.asException();
        if (isTimeout(e)) return new BrokerException("TIMEOUT", "socket timeout", e);
        if (e instanceof UnknownHostException) return new BrokerException("DNS_FAILURE", "unknown host", e);
        if (e instanceof ConnectException) return new BrokerException("CONNECT_FAILED", String.valueOf(e.getMessage()), e);
        if (e instanceof SSLException) return new BrokerException("TLS_FAILURE", e.getClass().getSimpleName() + ": " + e.getMessage(), e);
        return new BrokerException("IO_ERROR", e.getClass().getSimpleName() + ": " + e.getMessage(), e);
    }

    /** GZIPInputStream reads its header in the constructor; defer that to the first read so errors surface as stream errors. */
    private static final class LazyGzip extends InputStream {
        private final InputStream raw;
        private InputStream gz;
        LazyGzip(InputStream raw) { this.raw = raw; }
        private InputStream s() throws IOException { if (gz == null) gz = new GZIPInputStream(raw); return gz; }
        @Override public int read() throws IOException { return s().read(); }
        @Override public int read(byte[] b, int o, int l) throws IOException { return s().read(b, o, l); }
        @Override public void close() throws IOException { try { if (gz != null) gz.close(); } finally { raw.close(); } }
    }
}
