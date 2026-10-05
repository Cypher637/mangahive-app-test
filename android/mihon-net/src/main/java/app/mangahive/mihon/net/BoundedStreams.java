package app.mangahive.mihon.net;

import app.mangahive.mihon.spi.BrokerException;
import app.mangahive.mihon.spi.CancelScope;

import java.io.ByteArrayOutputStream;
import java.io.IOException;
import java.io.InputStream;
import java.io.OutputStream;
import java.nio.charset.Charset;
import java.util.Arrays;

/**
 * The bounded streaming reader. The size limit is enforced WHILE bytes arrive: never {@code readAllBytes()}, never
 * "read it all, then check". A body of unknown length (chunked, no Content-Length) is held to the same limit.
 *
 *  - at most {@code limit + 1} bytes are ever pulled from the wire; the first byte past the limit aborts the connection
 *    and throws, and no byte beyond the limit is ever handed to the caller;
 *  - the abort is the transport's (socket/call teardown), not a drain;
 *  - cancellation and timeout are checked on every read AND tear the connection down from the cancelling thread
 *    (see {@link CancelScope}), so a read parked on a stalled socket is interrupted, not merely noticed later.
 */
public final class BoundedStreams {
    private BoundedStreams() { }

    /** Body of one response. Enforces the limit, owns the response's lifecycle (abort on failure, release exactly once). */
    static final class Body extends InputStream {
        private final InputStream in;
        private final long max;
        private final CancelScope scope;
        private final Runnable abortTransport;
        private final Runnable release;
        private final String tooLargeCode;
        private long total;
        private boolean eof, done;

        Body(InputStream in, long max, CancelScope scope, Runnable abortTransport, Runnable release, String tooLargeCode) {
            this.in = in; this.max = max; this.scope = scope; this.abortTransport = abortTransport; this.release = release;
            this.tooLargeCode = tooLargeCode;
        }

        long bytesRead() { return total; }

        @Override public int read() throws IOException {
            byte[] one = new byte[1];
            int n;
            do { n = read(one, 0, 1); } while (n == 0);
            return n < 0 ? -1 : one[0] & 0xff;
        }

        @Override public int read(byte[] buf, int off, int len) throws IOException {
            if (len == 0) return 0;
            if (done) { if (eof) return -1; throw new BrokerException("CANCELLED", "stream closed"); }
            if (scope.isCancelled()) throw fail(scope.asException());
            // Never ask the wire for more than one byte past the limit: that byte is the proof of oversize.
            int want = (int) Math.min((long) len, (max - total) + 1L);
            int n;
            try {
                n = in.read(buf, off, want);
            } catch (BrokerException e) {
                throw fail(e);
            } catch (IOException e) {
                if (scope.isCancelled()) throw fail(scope.asException()); // the abort hook closed the socket under us
                // Same classifier as the engine: okio/OkHttp reads time out as InterruptedIOException("timeout"), not only SocketTimeoutException.
                throw fail(new BrokerException(BrokerEngine.isTimeout(e) ? "TIMEOUT" : "IO_ERROR",
                    e.getClass().getSimpleName() + ": " + e.getMessage(), e));
            }
            if (n < 0) {
                // An abort that closed the socket can surface as a clean EOF; a cancelled/timed-out call must never look complete.
                if (scope.isCancelled()) throw fail(scope.asException());
                eof = true; finish(false); return -1;
            }
            total += n;
            if (total > max) throw fail(new BrokerException(tooLargeCode, "body exceeds " + max + " bytes"));
            if (scope.isCancelled()) throw fail(scope.asException());
            return n;
        }

        @Override public long skip(long n) throws IOException {
            byte[] tmp = new byte[(int) Math.min(8192, Math.max(1, n))];
            long skipped = 0;
            while (skipped < n) { int r = read(tmp, 0, (int) Math.min(tmp.length, n - skipped)); if (r < 0) break; skipped += r; }
            return skipped;
        }

        @Override public boolean markSupported() { return false; }

        /** Closing before EOF abandons the rest of the body: the connection is torn down, not drained. */
        @Override public void close() { if (!done) finish(!eof); }

        private BrokerException fail(BrokerException e) { finish(true); return e; }

        private void finish(boolean abort) {
            if (done) return;
            done = true;
            try {
                if (abort) { try { abortTransport.run(); } catch (Throwable ignored) { } }
                try { in.close(); } catch (Throwable ignored) { }
            } finally {
                if (release != null) release.run();
            }
        }
    }

    /** Reads at most {@code limit} bytes from {@code in}; the first byte beyond it throws {@code RESPONSE_TOO_LARGE}. */
    public static byte[] readBounded(InputStream in, long limit) throws IOException {
        ByteArrayOutputStream out = new ByteArrayOutputStream((int) Math.min(Math.max(limit, 16), 8192));
        copyBounded(in, out, limit);
        return out.toByteArray();
    }

    public static String readUtf8Bounded(InputStream in, long limit) throws IOException {
        return new String(readBounded(in, limit), Charset.forName("UTF-8"));
    }

    /** Chunked copy with the same rule: counts bytes as they arrive and stops at the first byte past {@code limit}. */
    public static long copyBounded(InputStream in, OutputStream out, long limit) throws IOException {
        byte[] buf = new byte[16 * 1024];
        long total = 0;
        while (true) {
            int want = (int) Math.min((long) buf.length, (limit - total) + 1L);
            int n = in.read(buf, 0, want);
            if (n < 0) return total;
            total += n;
            if (total > limit) throw new BrokerException("RESPONSE_TOO_LARGE", "body exceeds " + limit + " bytes");
            out.write(buf, 0, n);
        }
    }

    static byte[] copyOf(byte[] a, int n) { return Arrays.copyOf(a, n); }
}
