package app.mangahive.mihon.net;

import app.mangahive.mihon.spi.CancelSignal;

import java.io.Closeable;
import java.io.IOException;
import java.io.InputStream;
import java.net.InetAddress;
import java.util.List;

/**
 * The raw wire: one request, one response, nothing clever. Implementations (OkHttp in production, a socket client in
 * the JVM tests) MUST:
 *  - connect only to {@link Request#addresses} (no second DNS lookup, no system/PAC proxy),
 *  - NOT follow redirects, NOT add or store cookies, NOT decompress, NOT add headers except framing (Host, Content-Length,
 *    Connection),
 *  - verify the TLS certificate against {@link Request#url}'s HOST NAME (not the pinned IP),
 *  - honour the timeouts, and honour the cancel signal BY ABORTING: register {@code request.cancel.onCancel(...)} before the
 *    first connect and keep it armed until the returned {@link Response} is closed or aborted. The hook must tear down the
 *    connection attempt / the in-flight read from the cancelling thread (OkHttp {@code Call.cancel()}, {@code Socket.close()}).
 *    Polling the signal is not enough: a thread blocked in a socket read never polls.
 * Everything else (policy, cookies, redirects, compression, limits) is the engine's job, once, for all transports.
 */
public interface Transport {
    final class Request {
        public final String method;
        public final SafeUrl url;
        public final List<InetAddress> addresses;
        public final List<String[]> headers;
        public final byte[] body;
        public final int connectTimeoutMs, readTimeoutMs;
        /** The request id this HTTP call belongs to (the web layer's id, carried unchanged; for logs and call tags only). */
        public final String requestId;
        public final CancelSignal cancel;
        public Request(String method, SafeUrl url, List<InetAddress> addresses, List<String[]> headers, byte[] body,
                       int connectTimeoutMs, int readTimeoutMs, String requestId, CancelSignal cancel) {
            this.method = method; this.url = url; this.addresses = addresses; this.headers = headers; this.body = body;
            this.connectTimeoutMs = connectTimeoutMs; this.readTimeoutMs = readTimeoutMs; this.requestId = requestId; this.cancel = cancel;
        }
    }

    final class Response implements Closeable {
        public final int status;
        public final String message;
        public final String protocol;
        public final List<String[]> headers;
        public final InputStream body;      // raw, still content-encoded
        private final Runnable abort;
        private final Runnable onClosed;
        /**
         * @param abort    force-closes the connection NOW (no draining); safe to call from any thread, any number of times
         * @param onClosed called once when the response is closed or aborted: unregisters the cancel hook, releases the call
         */
        public Response(int status, String message, String protocol, List<String[]> headers, InputStream body, Runnable abort, Runnable onClosed) {
            this.status = status; this.message = message; this.protocol = protocol; this.headers = headers; this.body = body;
            this.abort = abort; this.onClosed = onClosed;
        }
        /** Abandon the response: tear the connection down instead of reading the rest. */
        public void abort() { try { abort.run(); } finally { closedHook(); } }
        @Override public void close() throws IOException { try { body.close(); } finally { closedHook(); } }
        private void closedHook() { if (onClosed != null) { try { onClosed.run(); } catch (Throwable ignored) { } } }
    }

    Response execute(Request request) throws IOException;
}
