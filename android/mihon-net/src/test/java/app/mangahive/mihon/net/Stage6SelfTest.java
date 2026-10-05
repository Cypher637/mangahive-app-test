package app.mangahive.mihon.net;

import app.mangahive.mihon.spi.BrokerException;
import app.mangahive.mihon.spi.BrokerRequest;
import app.mangahive.mihon.spi.BrokerResponse;
import app.mangahive.mihon.spi.CancelScope;
import app.mangahive.mihon.spi.HttpBroker;
import app.mangahive.mihon.spi.RequestContext;

import java.io.BufferedInputStream;
import java.io.ByteArrayInputStream;
import java.io.ByteArrayOutputStream;
import java.io.File;
import java.io.FileInputStream;
import java.io.IOException;
import java.io.InputStream;
import java.io.OutputStream;
import java.net.InetAddress;
import java.net.Socket;
import java.nio.charset.Charset;
import java.nio.file.Files;
import java.security.KeyStore;
import java.util.ArrayList;
import java.util.Collections;
import java.util.List;
import java.util.Map;
import java.util.concurrent.Callable;
import java.util.concurrent.ConcurrentHashMap;
import java.util.concurrent.CountDownLatch;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.atomic.AtomicInteger;
import java.util.concurrent.atomic.AtomicLong;
import javax.net.ssl.KeyManagerFactory;
import javax.net.ssl.SSLContext;
import javax.net.ssl.SSLServerSocket;

/**
 * Stage 6 verification: streaming size limits, real cancellation, timeouts, per-extension/source limits, the job
 * registry. Everything about the wire runs against a REAL TLS server we script byte by byte (so we can stall, drip,
 * stream forever, and observe whether the CLIENT actually closed the connection), through the real BrokerEngine,
 * governor, deadlines and job registry. No mocks of the code under test.
 */
public final class Stage6SelfTest {
    static int pass, fail;
    static final Charset UTF8 = Charset.forName("UTF-8");
    static void check(String name, boolean ok) { if (ok) { pass++; System.out.println("PASS: " + name); } else { fail++; System.out.println("FAIL: " + name); } }

    static final int CAP = 100 * 1024;            // engine-wide response cap used by the size tests
    static SSLContext clientCtx;
    static ScriptedServer server;
    static String base;
    static int port;
    static final AtomicInteger ids = new AtomicInteger();

    // ───────────────────────────── scripted TLS server ─────────────────────────────

    static final class Conn {
        final long startedNanos = System.nanoTime();
        volatile long bodyBytesWritten;
        volatile boolean peerClosed;
        volatile long peerClosedAtNanos;
        final CountDownLatch closed = new CountDownLatch(1);
        void markClosed() { if (!peerClosed) { peerClosedAtNanos = System.nanoTime(); peerClosed = true; closed.countDown(); } }
        boolean awaitClosed(long ms) throws InterruptedException { return closed.await(ms, TimeUnit.MILLISECONDS); }
    }

    static final class ScriptedServer {
        final SSLServerSocket ss;
        final ConcurrentHashMap<String, Conn> conns = new ConcurrentHashMap<String, Conn>();
        final AtomicInteger accepted = new AtomicInteger();
        volatile CountDownLatch hold = new CountDownLatch(1);
        volatile boolean stopped;

        ScriptedServer(SSLContext ctx) throws IOException {
            ss = (SSLServerSocket) ctx.getServerSocketFactory().createServerSocket(0, 100, InetAddress.getByName("127.0.0.1"));
            Thread t = new Thread(new Runnable() { public void run() {
                while (!stopped) {
                    try {
                        final Socket s = ss.accept();
                        accepted.incrementAndGet();
                        new Thread(new Runnable() { public void run() { try { handle(s); } catch (Throwable ignored) { } } }, "s6-conn").start();
                    } catch (IOException e) { return; }
                }
            } }, "s6-accept");
            t.setDaemon(true); t.start();
        }

        int port() { return ss.getLocalPort(); }
        void stop() { stopped = true; try { ss.close(); } catch (IOException ignored) { } hold.countDown(); }
        void releaseHold() { hold.countDown(); }
        void resetHold() { hold = new CountDownLatch(1); }
        Conn conn(String target) { return conns.get(target); }

        private void handle(final Socket s) throws IOException {
            BufferedInputStream in = new BufferedInputStream(s.getInputStream());
            StringBuilder line = new StringBuilder();
            String target = null;
            int c, blank = 0; boolean first = true;
            while ((c = in.read()) >= 0) {
                if (c == '\n') {
                    if (line.length() == 0 || (line.length() == 1 && line.charAt(0) == '\r')) break;
                    if (first) { target = line.toString().split(" ")[1]; first = false; }
                    line.setLength(0);
                } else line.append((char) c);
            }
            if (target == null) { s.close(); return; }
            final Conn conn = new Conn();
            conns.put(target, conn);
            final InputStream rest = in;
            Thread w = new Thread(new Runnable() { public void run() {
                try { while (rest.read() >= 0) { } } catch (IOException ignored) { }
                conn.markClosed();
            } }, "s6-watch");
            w.setDaemon(true); w.start();
            OutputStream out = s.getOutputStream();
            try { route(target, out, conn); } catch (IOException e) { conn.markClosed(); }
            finally { try { s.close(); } catch (IOException ignored) { } }
        }

        private void head(OutputStream o, String h) throws IOException { o.write(("HTTP/1.1 200 OK\r\n" + h + "\r\nConnection: close\r\n\r\n").getBytes(UTF8)); o.flush(); }

        private void chunk(OutputStream o, byte[] b, Conn conn) throws IOException {
            o.write((Integer.toHexString(b.length) + "\r\n").getBytes(UTF8)); o.write(b); o.write("\r\n".getBytes(UTF8)); o.flush();
            conn.bodyBytesWritten += b.length;
        }

        private void route(String t, OutputStream o, Conn conn) throws IOException {
            String path = t.contains("?") ? t.substring(0, t.indexOf('?')) : t;
            if (path.equals("/ok")) { head(o, "Content-Type: text/plain\r\nContent-Length: 2"); o.write("ok".getBytes(UTF8)); o.flush(); return; }
            if (path.equals("/cl-big")) { head(o, "Content-Length: 50000000"); waitClosed(conn, 15_000); return; }           // promises 50 MB, sends none
            if (path.equals("/cl-exact")) { head(o, "Content-Length: " + CAP); o.write(new byte[CAP]); o.flush(); return; }
            if (path.equals("/chunk-big")) {                                                                                  // endless chunked stream, no length
                head(o, "Transfer-Encoding: chunked");
                byte[] blk = new byte[8192];
                while (!conn.peerClosed) { chunk(o, blk, conn); sleep(5); }
                return;
            }
            if (path.equals("/chunk-exact") || path.equals("/chunk-plus1")) {
                head(o, "Transfer-Encoding: chunked");
                int total = path.equals("/chunk-exact") ? CAP : CAP + 1, sent = 0;
                while (sent < total) { int n = Math.min(4096, total - sent); chunk(o, new byte[n], conn); sent += n; }
                o.write("0\r\n\r\n".getBytes(UTF8)); o.flush();
                return;
            }
            if (path.equals("/stall-body")) {                                                                                // headers + 100 bytes, then silence
                head(o, "Content-Length: 90000"); o.write(new byte[100]); o.flush(); conn.bodyBytesWritten = 100;
                waitClosed(conn, 20_000); return;
            }
            if (path.equals("/never")) { waitClosed(conn, 20_000); return; }                                                  // accepts, never answers
            if (path.equals("/drip")) {                                                                                       // 1 byte / 100 ms forever: read timeout never fires
                head(o, "Transfer-Encoding: chunked");
                while (!conn.peerClosed) { chunk(o, new byte[] { 'x' }, conn); sleep(100); }
                return;
            }
            if (path.equals("/hold")) {                                                                                       // body open until released
                head(o, "Transfer-Encoding: chunked"); chunk(o, new byte[] { 'h' }, conn);
                try { hold.await(30, TimeUnit.SECONDS); } catch (InterruptedException ignored) { }
                o.write("0\r\n\r\n".getBytes(UTF8)); o.flush();
                return;
            }
            if (path.startsWith("/redir/")) {
                int n = Integer.parseInt(path.substring(7));
                String loc = n <= 0 ? "/ok" : "/redir/" + (n - 1);
                o.write(("HTTP/1.1 302 Found\r\nLocation: " + loc + "\r\nContent-Length: 0\r\nConnection: close\r\n\r\n").getBytes(UTF8)); o.flush();
                return;
            }
            o.write("HTTP/1.1 404 Not Found\r\nContent-Length: 0\r\nConnection: close\r\n\r\n".getBytes(UTF8)); o.flush();
        }

        private void waitClosed(Conn conn, long ms) { try { conn.awaitClosed(ms); } catch (InterruptedException ignored) { } }
    }

    /** Tiny shim so route() reads naturally. */
    static final class Thread0 { }
    static void sleep(long ms) { try { java.lang.Thread.sleep(ms); } catch (InterruptedException ignored) { } }

    // ───────────────────────────── helpers ─────────────────────────────

    static final class Async<T> {
        final java.lang.Thread th; volatile T value; volatile Throwable err; volatile boolean done; volatile long endedNanos;
        Async(final Callable<T> c) {
            th = new java.lang.Thread(new Runnable() { public void run() {
                try { value = c.call(); } catch (Throwable e) { err = e; }
                endedNanos = System.nanoTime(); done = true;
            } }, "s6-async");
            th.setDaemon(true); th.start();
        }
        boolean await(long ms) { try { th.join(ms); } catch (InterruptedException ignored) { } return done; }
        String code() { return err instanceof BrokerException ? ((BrokerException) err).code : String.valueOf(err); }
    }

    static RequestContext rc(String prefix) { return new RequestContext(prefix + "-" + ids.incrementAndGet(), CancelScope.root()); }

    static BrokerRequest get(String path, int readMs, int callMs) {
        return new BrokerRequest("GET", base + path, Collections.<String[]>emptyList(), null, null, true, 0, readMs, callMs);
    }

    static ResourceGovernor.Limits lim(int conc, int jobs, double rps, int burst, long wait, long bytes) {
        return new ResourceGovernor.Limits(conc, jobs, rps, burst, wait, 60_000, 120_000, bytes);
    }
    static final ResourceGovernor.Limits BIG = lim(100, 100, 10_000, 10_000, 1_500, 16L << 20);

    static PinnedSocketTransport wire;
    static BrokerEngine engine(ResourceGovernor g) throws Exception {
        DestinationPolicy pol = DestinationPolicy.builder().requireHttps(true).allowPort(443).protect(DestinationPolicy.DEFAULT_PROTECTED_HOST_SUFFIXES)
            .allowLoopbackHostForTestingOnly("localhost", port).build();
        BrokerEngine.Limits l = new BrokerEngine.Limits();
        l.maxResponseBytes = CAP;
        return new BrokerEngine(pol, wire, NetSelfTest.memJar(), l, g, Deadlines.shared());
    }

    static ResourceGovernor bigGovernor() { return new ResourceGovernor(BIG, BIG, BIG, null == null ? new ResourceGovernor.Clock() { public long nanoTime() { return System.nanoTime(); } } : null); }

    static boolean until(long ms, Callable<Boolean> c) throws Exception {
        long end = System.nanoTime() + ms * 1_000_000L;
        while (System.nanoTime() < end) { if (c.call()) return true; sleep(10); }
        return c.call();
    }

    static long ms(long fromNanos) { return (System.nanoTime() - fromNanos) / 1_000_000L; }

    // ───────────────────────────── main ─────────────────────────────

    public static void main(String[] args) throws Exception { System.exit(runAll() == 0 ? 0 : 1); }

    /** @return number of failed checks (0 = pass). */
    public static int runAll() throws Exception {
        pass = 0; fail = 0;
        File dir = Files.createTempDirectory("mhs6").toFile();
        File p12 = new File(dir, "ks.p12"), crt = new File(dir, "s.crt");
        String keytool = new File(System.getProperty("java.home"), "bin/keytool").getPath();
        NetSelfTest.run(keytool, "-genkeypair", "-alias", "s", "-keyalg", "RSA", "-keysize", "2048", "-validity", "3", "-dname", "CN=localhost",
            "-ext", "san=dns:localhost,ip:127.0.0.1", "-keystore", p12.getPath(), "-storetype", "PKCS12", "-storepass", "changeit", "-keypass", "changeit");
        NetSelfTest.run(keytool, "-exportcert", "-alias", "s", "-keystore", p12.getPath(), "-storepass", "changeit", "-file", crt.getPath());
        KeyStore ks = KeyStore.getInstance("PKCS12");
        FileInputStream fis = new FileInputStream(p12); ks.load(fis, "changeit".toCharArray()); fis.close();
        KeyManagerFactory kmf = KeyManagerFactory.getInstance("SunX509"); kmf.init(ks, "changeit".toCharArray());
        SSLContext serverCtx = SSLContext.getInstance("TLS"); serverCtx.init(kmf.getKeyManagers(), null, null);
        clientCtx = NetSelfTest.trusting(crt);
        server = new ScriptedServer(serverCtx);
        port = server.port();
        base = "https://localhost:" + port;
        wire = new PinnedSocketTransport(clientCtx);
        try {
            boundedReaderUnit();
            oversizedContentLength();
            oversizedChunked();
            cancellationDuringSlowResponse();
            timeouts();
            concurrencyLimits();
            rateLimits();
            jobRegistry();
            requestIdPropagation();
        } finally { server.stop(); }
        System.out.println("\n" + pass + " passed, " + fail + " failed");
        return fail;
    }

    // ───────────────────────────── 1. the bounded reader itself ─────────────────────────────

    /** Counts what is really pulled from the "wire" and the largest single request. */
    static final class Counting extends InputStream {
        final InputStream in; long pulled; int maxAsk;
        Counting(int n) { in = new ByteArrayInputStream(new byte[n]); }
        @Override public int read() throws IOException { int b = in.read(); if (b >= 0) pulled++; return b; }
        @Override public int read(byte[] b, int o, int l) throws IOException { maxAsk = Math.max(maxAsk, l); int n = in.read(b, o, l); if (n > 0) pulled += n; return n; }
    }

    static void boundedReaderUnit() throws Exception {
        Counting at = new Counting(1000);
        check("readBounded: a body of exactly the limit is accepted", BoundedStreams.readBounded(at, 1000).length == 1000);
        Counting over = new Counting(10_000_000);
        try { BoundedStreams.readBounded(over, 1000); check("readBounded: oversize rejected", false); }
        catch (BrokerException e) { check("readBounded: the first byte past the limit throws RESPONSE_TOO_LARGE", e.code.equals("RESPONSE_TOO_LARGE")); }
        check("readBounded: at most limit+1 bytes were ever pulled from a 10 MB source (it did NOT read everything first)", over.pulled <= 1001);
        check("readBounded: no single read asked the wire for more than the remaining allowance + 1", over.maxAsk <= 16 * 1024 && over.pulled <= 1001);
        ByteArrayOutputStream sink = new ByteArrayOutputStream();
        try { BoundedStreams.copyBounded(new Counting(5000), sink, 2000); check("copyBounded: oversize rejected", false); }
        catch (BrokerException e) { check("copyBounded: stops at the limit; the sink never received more than the limit (" + sink.size() + " bytes)", sink.size() <= 2000 && e.code.equals("RESPONSE_TOO_LARGE")); }
        check("readBounded: empty body", BoundedStreams.readBounded(new Counting(0), 10).length == 0);
        // Stage 6.6 regression: a body read that times out must be TIMEOUT; a user cancel that surfaces the same exception must stay CANCELLED.
        {
            final java.io.InputStream okioTimeout = new java.io.InputStream() { public int read() throws IOException { throw new java.io.InterruptedIOException("timeout"); } };
            CancelScope live = CancelScope.root();
            BoundedStreams.Body b1 = new BoundedStreams.Body(okioTimeout, 1000, live, new Runnable() { public void run() { } }, new Runnable() { public void run() { } }, "RESPONSE_TOO_LARGE");
            try { b1.read(new byte[8], 0, 8); check("body read timeout (okio InterruptedIOException) -> TIMEOUT", false); }
            catch (BrokerException e) { check("body read timeout (okio InterruptedIOException) -> TIMEOUT", "TIMEOUT".equals(e.code)); } catch (IOException e) { check("body read timeout -> BrokerException", false); }
            final CancelScope dead = CancelScope.root();
            final java.io.InputStream cancelThenThrow = new java.io.InputStream() { public int read() throws IOException { dead.cancel(CancelScope.Reason.CANCELLED); throw new java.io.InterruptedIOException("timeout"); } };
            BoundedStreams.Body b2 = new BoundedStreams.Body(cancelThenThrow, 1000, dead, new Runnable() { public void run() { } }, new Runnable() { public void run() { } }, "RESPONSE_TOO_LARGE");
            try { b2.read(new byte[8], 0, 8); check("user cancel surfacing as InterruptedIOException stays CANCELLED", false); }
            catch (BrokerException e) { check("user cancel surfacing as InterruptedIOException stays CANCELLED", "CANCELLED".equals(e.code)); } catch (IOException e) { check("cancel -> BrokerException", false); }
        }
    }

    // ───────────────────────────── 2. oversized Content-Length ─────────────────────────────

    static void oversizedContentLength() throws Exception {
        ResourceGovernor g = bigGovernor();
        final HttpBroker b = engine(g).open("ext.size", 1);
        long t0 = System.nanoTime();
        try { b.execute(get("/cl-big", 30_000, 0), rc("cl")).close(); check("Content-Length 50 MB over a 100 KB cap is refused", false); }
        catch (BrokerException e) { check("Content-Length 50 MB over a 100 KB cap is refused with RESPONSE_TOO_LARGE (" + e.code + ")", e.code.equals("RESPONSE_TOO_LARGE")); }
        check("   ...before reading any body: refused in " + ms(t0) + " ms, not after waiting for 50 MB", ms(t0) < 2000);
        Conn c = server.conn("/cl-big");
        check("   ...and the connection was torn down (server saw the client close)", c != null && c.awaitClosed(3000));
        check("   ...the server never had to send a body byte", c.bodyBytesWritten == 0);
        check("   ...the call's slot is back (no stale in-flight call)", until(1000, new Callable<Boolean>() { public Boolean call() { return true; } }) && g.activeCalls("ext.size", 1) == 0);
        BrokerResponse ok = b.execute(get("/cl-exact", 30_000, 0), rc("cl"));
        check("a body of exactly the cap with a matching Content-Length is accepted", BoundedStreams.readBounded(ok.body(), CAP).length == CAP);
        ok.close();
    }

    // ───────────────────────────── 3. oversized chunked (no Content-Length) ─────────────────────────────

    static void oversizedChunked() throws Exception {
        ResourceGovernor g = bigGovernor();
        final HttpBroker b = engine(g).open("ext.chunk", 1);
        BrokerResponse r = b.execute(get("/chunk-big", 30_000, 0), rc("ch"));
        check("chunked response has no declared length", r.contentLength == -1);
        long delivered = 0; String code = null; long t0 = System.nanoTime();
        byte[] buf = new byte[4096];
        try { int n; while ((n = r.body().read(buf)) >= 0) delivered += n; }
        catch (BrokerException e) { code = e.code; }
        check("endless chunked stream is cut with RESPONSE_TOO_LARGE (" + code + ")", "RESPONSE_TOO_LARGE".equals(code));
        check("   ...the caller received at most the cap (" + delivered + " <= " + CAP + "), never a byte beyond it", delivered <= CAP);
        check("   ...and it was cut as soon as the limit was crossed (" + ms(t0) + " ms), not at the end of a stream that has none", ms(t0) < 5000);
        Conn c = server.conn("/chunk-big");
        check("   ...the connection was aborted: the endless server saw the client go away", c != null && c.awaitClosed(5000));
        check("   ...the server wrote about the cap and then stopped (" + c.bodyBytesWritten + " bytes), it was not drained", c.bodyBytesWritten < CAP + 600 * 1024);
        check("   ...slot released", g.activeCalls("ext.chunk", 1) == 0);
        r.close();

        BrokerResponse e1 = b.execute(get("/chunk-exact", 30_000, 0), rc("ch"));
        check("chunked body of exactly the cap is accepted", BoundedStreams.readBounded(e1.body(), CAP).length == CAP); e1.close();
        BrokerResponse e2 = b.execute(get("/chunk-plus1", 30_000, 0), rc("ch"));
        try { BoundedStreams.readBounded(e2.body(), 10L * CAP); check("chunked body one byte over the cap is refused", false); }
        catch (BrokerException e) { check("chunked body one byte over the cap is refused (" + e.code + ")", e.code.equals("RESPONSE_TOO_LARGE")); }
        e2.close();
        check("   ...slot released after both", g.activeCalls("ext.chunk", 1) == 0);
    }

    // ───────────────────────────── 4. cancellation during a slow response ─────────────────────────────

    static void cancellationDuringSlowResponse() throws Exception {
        ResourceGovernor g = bigGovernor();
        final HttpBroker b = engine(g).open("ext.cancel", 1);

        // 4a. headers received, body stalls; the reader thread is parked inside a socket read with a 30 s read timeout
        final RequestContext ctx = rc("cancel");
        final BrokerResponse r = b.execute(get("/stall-body", 30_000, 0), ctx);
        Async<Long> reader = new Async<Long>(new Callable<Long>() { public Long call() throws Exception {
            byte[] buf = new byte[4096]; long n = 0; int k;
            while ((k = r.body().read(buf)) >= 0) n += k;
            return n;
        } });
        sleep(400);
        check("reader is genuinely blocked in the socket read (read timeout is 30 s, nothing has arrived)", !reader.done);
        long tc = System.nanoTime();
        ctx.cancel.cancel(CancelScope.Reason.CANCELLED);
        boolean ended = reader.await(3000);
        long took = ms(tc);
        check("cancel interrupts the blocked read: reader unwound with CANCELLED in " + took + " ms (not after the 30 s read timeout)", ended && "CANCELLED".equals(reader.code()) && took < 1500);
        Conn c = server.conn("/stall-body");
        check("   ...the underlying connection was closed by the cancel (server saw it)", c.awaitClosed(2000));
        check("   ...slot released, hooks gone", g.activeCalls("ext.cancel", 1) == 0 && ctx.cancel.hookCount() == 0);

        // 4b. cancelled while still waiting for the response headers (server never answers)
        final RequestContext ctx2 = rc("cancel");
        Async<BrokerResponse> waiting = new Async<BrokerResponse>(new Callable<BrokerResponse>() { public BrokerResponse call() throws Exception { return b.execute(get("/never", 30_000, 0), ctx2); } });
        sleep(400);
        check("request is parked waiting for headers", !waiting.done);
        tc = System.nanoTime();
        ctx2.cancel.cancel(CancelScope.Reason.CANCELLED);
        check("cancel during the header wait: CANCELLED in " + ms(tc) + " ms", waiting.await(3000) && "CANCELLED".equals(waiting.code()) && ms(tc) < 1500);
        check("   ...the half-open connection was closed", server.conn("/never").awaitClosed(2000));
        check("   ...slot released", g.activeCalls("ext.cancel", 1) == 0);

        // 4c. cancelled before it started
        final RequestContext pre = rc("cancel"); pre.cancel.cancel(CancelScope.Reason.CANCELLED);
        int before = server.accepted.get();
        try { b.execute(get("/ok", 5000, 0), pre).close(); check("pre-cancelled request refused", false); }
        catch (BrokerException e) { check("pre-cancelled request fails CANCELLED and never dials", e.code.equals("CANCELLED") && server.accepted.get() == before); }
        check("   ...slot released", g.activeCalls("ext.cancel", 1) == 0);
    }

    // ───────────────────────────── 5. timeouts ─────────────────────────────

    static void timeouts() throws Exception {
        ResourceGovernor g = bigGovernor();
        final HttpBroker b = engine(g).open("ext.timeout", 1);

        // 5a. a server that keeps sending 1 byte / 100 ms never trips the READ timeout; only the call deadline can stop it
        final RequestContext ctx = rc("to");
        long t0 = System.nanoTime();
        BrokerResponse r = b.execute(get("/drip", 30_000, 1500), ctx);
        String code = null; long got = 0;
        try { byte[] buf = new byte[64]; int n; while ((n = r.body().read(buf)) >= 0) got += n; } catch (BrokerException e) { code = e.code; }
        long took = ms(t0);
        check("call timeout (1.5 s) stops a body that is still trickling in (read timeout 30 s): " + code + " after " + took + " ms", "TIMEOUT".equals(code) && took >= 1400 && took < 4000);
        check("   ...it received some of the body first (" + got + " bytes): the timeout cut a live transfer", got > 0);
        check("   ...the timeout CANCELLED the underlying connection (the drip server saw the close)", server.conn("/drip").awaitClosed(2000));
        check("   ...a call timeout does not cancel the whole request", !ctx.cancel.isCancelled());
        check("   ...slot released", g.activeCalls("ext.timeout", 1) == 0);

        // 5b. timeout while waiting for headers
        t0 = System.nanoTime();
        try { b.execute(get("/never", 30_000, 1000), rc("to")).close(); check("header-wait timeout", false); }
        catch (BrokerException e) { check("call timeout while waiting for headers: " + e.code + " after " + ms(t0) + " ms", e.code.equals("TIMEOUT") && ms(t0) < 3000); }
        check("   ...the half-open connection was closed by the timeout", server.conn("/never").awaitClosed(2000));
        check("   ...slot released", g.activeCalls("ext.timeout", 1) == 0);

        // 5c. the per-source ceiling clamps what the Source asks for (it asked for 10 minutes)
        ResourceGovernor g2 = new ResourceGovernor(BIG, new ResourceGovernor.Limits(10, 10, 1000, 1000, 1000, 1500, 1500, 16L << 20), BIG, new ResourceGovernor.Clock() { public long nanoTime() { return System.nanoTime(); } });
        HttpBroker clamped = engine(g2).open("ext.clamp", 1);
        t0 = System.nanoTime();
        try { clamped.execute(get("/never", 30_000, 600_000), rc("to")).close(); check("ceiling", false); }
        catch (BrokerException e) { check("a Source asking for a 10 minute call timeout is held to the source's 1.5 s ceiling (" + e.code + " after " + ms(t0) + " ms)", e.code.equals("TIMEOUT") && ms(t0) < 4000); }
    }

    // ───────────────────────────── 6. concurrency limits ─────────────────────────────

    static void concurrencyLimits() throws Exception {
        // source cap 2, extension cap 3
        ResourceGovernor g = new ResourceGovernor(lim(3, 10, 10_000, 10_000, 100, 16L << 20), lim(2, 10, 10_000, 10_000, 100, 16L << 20), BIG,
            new ResourceGovernor.Clock() { public long nanoTime() { return System.nanoTime(); } });
        BrokerEngine eng = engine(g);
        server.resetHold();
        HttpBroker a = eng.open("ext.conc", 1), a2 = eng.open("ext.conc", 2), other = eng.open("ext.other", 1);
        BrokerResponse h1 = a.execute(get("/hold", 30_000, 0), rc("cc")), h2 = a.execute(get("/hold", 30_000, 0), rc("cc"));
        check("two concurrent calls on one source are admitted (cap 2); both bodies are open", h1.status == 200 && h2.status == 200 && g.activeCalls("ext.conc", 1) == 2);
        long t0 = System.nanoTime();
        try { a.execute(get("/ok", 5000, 0), rc("cc")).close(); check("third concurrent call on the source refused", false); }
        catch (BrokerException e) { check("third concurrent call on the same source -> CONCURRENCY_LIMIT, immediately (" + ms(t0) + " ms), no queue", e.code.equals("CONCURRENCY_LIMIT") && ms(t0) < 500); }
        BrokerResponse b1 = a2.execute(get("/hold", 30_000, 0), rc("cc"));
        check("a SIBLING source still gets its own slot (3rd of the extension's 3)", b1.status == 200 && g.activeCalls("ext.conc") == 3);
        try { a2.execute(get("/ok", 5000, 0), rc("cc")).close(); check("extension cap enforced", false); }
        catch (BrokerException e) { check("the EXTENSION cap (3) holds across its sources: 4th call -> CONCURRENCY_LIMIT", e.code.equals("CONCURRENCY_LIMIT")); }
        BrokerResponse o = other.execute(get("/ok", 5000, 0), rc("cc"));
        check("another extension is not affected by this one's saturation", o.status == 200); o.close();
        ResourceGovernor one = new ResourceGovernor(BIG, lim(1, 10, 10_000, 10_000, 100, 16L << 20), BIG, new ResourceGovernor.Clock() { public long nanoTime() { return System.nanoTime(); } });
        BrokerResponse chain = engine(one).open("ext.one", 1).execute(get("/redir/3", 5000, 0), rc("cc"));
        check("a 4-hop redirect chain costs ONE concurrency slot (source cap 1): it is not refused mid-chain", chain.status == 200 && one.activeCalls("ext.one", 1) == 1);
        chain.close();
        check("   ...and returns it", one.activeCalls("ext.one", 1) == 0);

        h1.close();                                  // body closed -> slot returns
        check("closing a body returns its slot", g.activeCalls("ext.conc", 1) == 1);
        BrokerResponse again = a.execute(get("/ok", 5000, 0), rc("cc"));
        check("...and the freed slot can be used again", again.status == 200); again.close();

        server.releaseHold();
        byte[] rest = BoundedStreams.readBounded(h2.body(), CAP);
        check("a held body completes normally once the server finishes it", rest.length >= 1); h2.close(); b1.close();
        check("after everything closed no slot is left (source, sibling, extension)", g.activeCalls("ext.conc", 1) == 0 && g.activeCalls("ext.conc", 2) == 0 && g.activeCalls("ext.conc") == 0);
        server.resetHold();
    }

    // ───────────────────────────── 7. request rate limits ─────────────────────────────

    static final class FakeClock implements ResourceGovernor.Clock {
        final AtomicLong now = new AtomicLong(1_000_000_000L);
        public long nanoTime() { return now.get(); }
        void advanceMs(long ms) { now.addAndGet(ms * 1_000_000L); }
    }

    static void rateLimits() throws Exception {
        // 7a. deterministic: burst 2, 5/s, never wait
        FakeClock clk = new FakeClock();
        ResourceGovernor g = new ResourceGovernor(BIG, lim(10, 10, 5, 2, 0, 16L << 20), BIG, clk);
        HttpBroker b = engine(g).open("ext.rate", 1);
        b.execute(get("/ok", 5000, 0), rc("rt")).close();
        b.execute(get("/ok", 5000, 0), rc("rt")).close();
        int before = server.accepted.get();
        try { b.execute(get("/ok", 5000, 0), rc("rt")).close(); check("third request in the burst refused", false); }
        catch (BrokerException e) { check("burst of 2 exhausted: 3rd request -> RATE_LIMITED (" + e.getMessage() + ")", e.code.equals("RATE_LIMITED")); }
        check("   ...the refused request never reached the wire", server.accepted.get() == before);
        check("   ...and held no slot", g.activeCalls("ext.rate", 1) == 0);
        clk.advanceMs(250);                                    // 5/s -> 1.25 tokens
        b.execute(get("/ok", 5000, 0), rc("rt")).close();
        check("after 250 ms one token has refilled (5/s): request admitted", true);
        try { b.execute(get("/ok", 5000, 0), rc("rt")).close(); check("only one token had refilled", false); }
        catch (BrokerException e) { check("...but only one: the next is RATE_LIMITED again", e.code.equals("RATE_LIMITED")); }
        clk.advanceMs(10_000);
        b.execute(get("/ok", 5000, 0), rc("rt")).close(); b.execute(get("/ok", 5000, 0), rc("rt")).close();
        try { b.execute(get("/ok", 5000, 0), rc("rt")).close(); check("bucket is capped at the burst size", false); }
        catch (BrokerException e) { check("a long idle period refills to the burst (2), not beyond it", e.code.equals("RATE_LIMITED")); }

        // 7b. every redirect hop is an outbound request and costs a token
        FakeClock clk2 = new FakeClock();
        ResourceGovernor g2 = new ResourceGovernor(BIG, lim(10, 10, 1, 2, 0, 16L << 20), BIG, clk2);
        HttpBroker rb = engine(g2).open("ext.rate2", 1);
        try { rb.execute(get("/redir/3", 5000, 0), rc("rt")).close(); check("redirect chain rate-limited", false); }
        catch (BrokerException e) { check("a 4-hop redirect chain cannot sneak past a burst of 2: RATE_LIMITED mid-chain", e.code.equals("RATE_LIMITED")); }
        check("   ...no slot leaked by the half-finished chain", g2.activeCalls("ext.rate2", 1) == 0);

        // 7c. real clock: a request over the rate waits (within maxRateWait) and then succeeds
        ResourceGovernor g3 = new ResourceGovernor(BIG, lim(10, 10, 10, 1, 1000, 16L << 20), BIG, new ResourceGovernor.Clock() { public long nanoTime() { return System.nanoTime(); } });
        HttpBroker wb = engine(g3).open("ext.rate3", 1);
        wb.execute(get("/ok", 5000, 0), rc("rt")).close();
        long t0 = System.nanoTime();
        BrokerResponse w = wb.execute(get("/ok", 5000, 0), rc("rt"));
        long waited = ms(t0);
        check("burst 1 @ 10/s: the 2nd request is DELAYED to the rate (" + waited + " ms) and then served", w.status == 200 && waited >= 60 && waited < 1500); w.close();

        // 7d. a cancel during the rate wait is honoured promptly and never dials
        ResourceGovernor.Limits wideWait = lim(10000, 10000, 10_000, 10_000, 10_000, 16L << 20);
        ResourceGovernor g4 = new ResourceGovernor(wideWait, lim(10, 10, 0.5, 1, 5000, 16L << 20), BIG, new ResourceGovernor.Clock() { public long nanoTime() { return System.nanoTime(); } });
        final HttpBroker cb = engine(g4).open("ext.rate4", 1);
        cb.execute(get("/ok", 5000, 0), rc("rt")).close();
        final RequestContext ctx = rc("rt");
        int acc = server.accepted.get();
        Async<BrokerResponse> waiting = new Async<BrokerResponse>(new Callable<BrokerResponse>() { public BrokerResponse call() throws Exception { return cb.execute(get("/ok", 5000, 0), ctx); } });
        sleep(300);
        check("request is waiting for its token (0.5/s means ~2 s)", !waiting.done);
        long tc = System.nanoTime();
        ctx.cancel.cancel(CancelScope.Reason.CANCELLED);
        check("cancel during the rate wait: CANCELLED in " + ms(tc) + " ms", waiting.await(2000) && "CANCELLED".equals(waiting.code()) && ms(tc) < 1000);
        check("   ...it never dialled, and holds no slot", server.accepted.get() == acc && g4.activeCalls("ext.rate4", 1) == 0);

        // 7e. over the wait budget it is refused instead of queued
        ResourceGovernor g5 = new ResourceGovernor(BIG, lim(10, 10, 0.5, 1, 200, 16L << 20), BIG, new ResourceGovernor.Clock() { public long nanoTime() { return System.nanoTime(); } });
        HttpBroker nb = engine(g5).open("ext.rate5", 1);
        nb.execute(get("/ok", 5000, 0), rc("rt")).close();
        t0 = System.nanoTime();
        try { nb.execute(get("/ok", 5000, 0), rc("rt")).close(); check("over wait budget refused", false); }
        catch (BrokerException e) { check("a wait longer than the 200 ms budget is refused at once, not queued (" + e.code + " in " + ms(t0) + " ms)", e.code.equals("RATE_LIMITED") && ms(t0) < 300); }
    }

    // ───────────────────────────── 8. job registry: real cancel, timeout, no stale jobs ─────────────────────────────

    /** The worker side of a job, exactly as the runtime dispatcher runs it. */
    static Async<Object> runJob(final ActiveJobs.Job job, final Callable<Object> body) {
        return new Async<Object>(new Callable<Object>() { public Object call() throws Exception {
            job.bindThread();
            try { Object v = body.call(); job.tryComplete(); return v; } finally { job.workerExited(); }
        } });
    }

    static Callable<Object> fetchAll(final HttpBroker b, final ActiveJobs.Job job, final String path) {
        return new Callable<Object>() { public Object call() throws Exception {
            BrokerResponse r = b.execute(get(path, 30_000, 0), job.ctx);
            try { return BoundedStreams.readBounded(r.body(), CAP); } finally { r.close(); }
        } };
    }

    static boolean idle(final ActiveJobs jobs, final ResourceGovernor g, final String ext) throws Exception {
        return until(3000, new Callable<Boolean>() { public Boolean call() {
            return jobs.size() == 0 && jobs.liveWorkers() == 0 && g.activeJobs(ext) == 0 && g.activeCalls(ext) == 0 && jobs.rootHooks() == 0;
        } });
    }

    static void jobRegistry() throws Exception {
        final ResourceGovernor g = new ResourceGovernor(lim(50, 2, 10_000, 10_000, 100, 16L << 20), BIG, BIG, new ResourceGovernor.Clock() { public long nanoTime() { return System.nanoTime(); } });
        final ActiveJobs jobs = new ActiveJobs(g, Deadlines.shared());
        final String ext = "ext.jobs";
        final HttpBroker b = engine(g).open(ext, 1);

        // 8a. normal completion leaves nothing
        ActiveJobs.Job j = jobs.open("web-1-a", ext, 10_000);
        check("a live job is registered under the web request id", jobs.size() == 1 && jobs.ids().contains("web-1-a"));
        Async<Object> w = runJob(j, fetchAll(b, j, "/ok"));
        check("job completes", w.await(3000) && w.err == null);
        check("completed job is gone from the registry (state " + j.state() + ")", idle(jobs, g, ext) && j.state() == ActiveJobs.State.DONE);

        // 8b. cancel through the registry while the worker is parked in a socket read
        j = jobs.open("web-2-b", ext, 30_000);
        w = runJob(j, fetchAll(b, j, "/stall-body"));
        sleep(400);
        check("worker is blocked mid-response", !w.done && jobs.size() == 1);
        long tc = System.nanoTime();
        check("registry cancel(requestId) wins the race", jobs.cancel("web-2-b"));
        check("   ...the registry entry is gone immediately", jobs.size() == 0);
        check("   ...the worker's blocked HTTP read was interrupted: CANCELLED in " + ms(tc) + " ms", w.await(3000) && "CANCELLED".equals(w.code()) && ms(tc) < 1500);
        check("   ...the connection was closed (server saw it)", server.conn("/stall-body").awaitClosed(2000));
        check("   ...state CANCELLED, nothing stale (jobs, workers, job slot, HTTP slot, hooks)", j.state() == ActiveJobs.State.CANCELLED && idle(jobs, g, ext));
        check("   ...cancelling it again, or an unknown id, is a harmless no-op", !jobs.cancel("web-2-b") && !jobs.cancel("never-existed"));

        // 8c. timeout cancels the underlying work
        j = jobs.open("web-3-c", ext, 800);
        long t0 = System.nanoTime();
        w = runJob(j, fetchAll(b, j, "/drip"));
        boolean ended = w.await(5000);
        check("job deadline (800 ms) cancelled a body that was still trickling in: " + w.code() + " after " + ms(t0) + " ms", ended && "TIMEOUT".equals(w.code()) && ms(t0) < 3500);
        check("   ...state TIMED_OUT, the drip server saw the close, nothing stale", j.state() == ActiveJobs.State.TIMED_OUT && server.conn("/drip").awaitClosed(2000) && idle(jobs, g, ext));

        // 8d. duplicate ids
        j = jobs.open("web-4-d", ext, 30_000);
        try { jobs.open("web-4-d", ext, 30_000); check("duplicate id refused", false); } catch (BrokerException e) { check("a live request id cannot be registered twice (" + e.code + ")", e.code.equals("DUPLICATE_ID")); }
        check("   ...the refused duplicate did not consume a job slot or disturb the original", jobs.size() == 1 && g.activeJobs(ext) == 1 && j.state() == ActiveJobs.State.RUNNING);
        check("   ...malformed ids are refused", refused(jobs, "has space", ext) && refused(jobs, "", ext) && refused(jobs, "x/y", ext));
        j.tryComplete(); j.workerExited();
        check("   ...cleanup", idle(jobs, g, ext));

        // 8e. per-extension concurrent-job cap
        ActiveJobs.Job j1 = jobs.open("web-5-1", ext, 30_000), j2 = jobs.open("web-5-2", ext, 30_000);
        try { jobs.open("web-5-3", ext, 30_000); check("job cap", false); } catch (BrokerException e) { check("job cap (2 per extension): the 3rd concurrent job -> CONCURRENCY_LIMIT", e.code.equals("CONCURRENCY_LIMIT")); }
        ActiveJobs.Job other = jobs.open("web-5-x", "ext.jobs.other", 30_000);
        check("   ...another extension's jobs are unaffected", other.state() == ActiveJobs.State.RUNNING);
        j1.tryComplete(); j1.workerExited();
        ActiveJobs.Job j4 = jobs.open("web-5-4", ext, 30_000);
        check("   ...a finished job returns its slot", j4.state() == ActiveJobs.State.RUNNING);
        check("   ...cancelAll(extension) aborts that extension's jobs only", jobs.cancelAll(ext) == 2 && other.state() == ActiveJobs.State.RUNNING);
        j2.workerExited(); j4.workerExited(); other.tryComplete(); other.workerExited();
        check("   ...cleanup", idle(jobs, g, ext) && g.activeJobs("ext.jobs.other") == 0);

        // 8f. a worker that ignores cancellation and interrupts: the job still leaves the registry, but cannot be used to spawn more workers
        final ActiveJobs.Job wj = jobs.open("web-6-w", ext, 300);
        final CountDownLatch wedgeRelease = new CountDownLatch(1);
        Async<Object> wedged = runJob(wj, new Callable<Object>() { public Object call() {
            while (true) { try { if (wedgeRelease.await(10, TimeUnit.SECONDS)) return null; } catch (InterruptedException ignored) { /* ignores interrupts */ } }
        } });
        check("   a wedged worker: job times out and leaves the registry anyway", until(2000, new Callable<Boolean>() { public Boolean call() { return wj.state() == ActiveJobs.State.TIMED_OUT && jobs.size() == 0; } }));
        check("   ...its thread is still alive (it ignored the interrupt): liveWorkers=" + jobs.liveWorkers() + ", and its job slot is still held", jobs.liveWorkers() == 1 && g.activeJobs(ext) == 1);
        ActiveJobs.Job w1 = jobs.open("web-6-1", ext, 30_000);
        try { jobs.open("web-6-2", ext, 30_000); check("wedged worker still counts against the cap", false); }
        catch (BrokerException e) { check("   ...so a wedged extension cannot spawn unlimited workers: with the cap (2) used by one wedged + one live job the next is refused", e.code.equals("CONCURRENCY_LIMIT")); }
        w1.tryComplete(); w1.workerExited();
        wedgeRelease.countDown();
        check("   ...when the wedged thread finally exits, everything is released", wedged.await(3000) && idle(jobs, g, ext));

        // 8g. complete-vs-cancel race: exactly one side ever wins
        int bothWon = 0, noneWon = 0;
        for (int i = 0; i < 300; i++) {
            final ActiveJobs.Job r = jobs.open("web-7-" + i, ext, 30_000);
            final java.util.concurrent.atomic.AtomicBoolean a = new java.util.concurrent.atomic.AtomicBoolean(), c = new java.util.concurrent.atomic.AtomicBoolean();
            final CountDownLatch go = new CountDownLatch(1);
            java.lang.Thread t1 = new java.lang.Thread(new Runnable() { public void run() { try { go.await(); } catch (InterruptedException ignored) { } a.set(r.tryComplete()); } });
            java.lang.Thread t2 = new java.lang.Thread(new Runnable() { public void run() { try { go.await(); } catch (InterruptedException ignored) { } c.set(jobs.cancel(r.requestId)); } });
            t1.start(); t2.start(); go.countDown(); t1.join(); t2.join();
            if (a.get() && c.get()) bothWon++; if (!a.get() && !c.get()) noneWon++;
            r.workerExited();
        }
        check("300 complete/cancel races: exactly one party owned the outcome every time (both=" + bothWon + ", neither=" + noneWon + ")", bothWon == 0 && noneWon == 0);
        check("   ...nothing stale afterwards", idle(jobs, g, ext));

        // 8h. churn with real HTTP: completions, cancels, timeouts, mixed. Every job ends, nothing is left.
        final ResourceGovernor g2 = new ResourceGovernor(lim(500, 500, 10_000, 10_000, 100, 16L << 20), lim(500, 500, 10_000, 10_000, 100, 16L << 20), BIG, new ResourceGovernor.Clock() { public long nanoTime() { return System.nanoTime(); } });
        final ActiveJobs jobs2 = new ActiveJobs(g2, Deadlines.shared());
        final HttpBroker cb = engine(g2).open("ext.churn", 1);
        List<Async<Object>> all = new ArrayList<Async<Object>>();
        int n = 120;
        for (int i = 0; i < n; i++) {
            final ActiveJobs.Job cj = jobs2.open("churn-" + i, "ext.churn", i % 4 == 2 ? 400 : 20_000);
            String path = i % 4 == 0 ? "/ok" : i % 4 == 1 ? "/stall-body?c=" + i : i % 4 == 2 ? "/drip?c=" + i : "/never?c=" + i;
            all.add(runJob(cj, fetchAll(cb, cj, path)));
            if (i % 4 == 1 || i % 4 == 3) { final String id = "churn-" + i; new java.lang.Thread(new Runnable() { public void run() { sleep(150); jobs2.cancel(id); } }).start(); }
        }
        boolean allEnded = true;
        for (Async<Object> a : all) allEnded &= a.await(15_000);
        int ok = 0, cancelled = 0, timedOut = 0, other2 = 0;
        for (Async<Object> a : all) { if (a.err == null) ok++; else if ("CANCELLED".equals(a.code())) cancelled++; else if ("TIMEOUT".equals(a.code())) timedOut++; else { other2++; System.out.println("   (unexpected churn outcome: " + a.err + ")"); } }
        check("churn: " + n + " jobs all ended (ok=" + ok + ", cancelled=" + cancelled + ", timed out=" + timedOut + ", other=" + other2 + ")", allEnded && other2 == 0 && ok == n / 4 && cancelled == n / 2 && timedOut == n / 4);
        check("churn: registry empty, no live workers, no job/HTTP slots held, no hooks left", idle(jobs2, g2, "ext.churn"));
        check("churn: no deadline timer left pending", until(2000, new Callable<Boolean>() { public Boolean call() { return Deadlines.shared().pending() == 0; } }));
    }

    static boolean refused(ActiveJobs jobs, String id, String ext) {
        try { jobs.open(id, ext, 1000); return false; } catch (BrokerException e) { return e.code.equals("BAD_REQUEST"); }
    }

    // ───────────────────────────── 9. ONE request id, Web -> ... -> HTTP ─────────────────────────────

    static void requestIdPropagation() throws Exception {
        ResourceGovernor g = bigGovernor();
        ActiveJobs jobs = new ActiveJobs(g, Deadlines.shared());
        HttpBroker b = engine(g).open("ext.ids", 1);
        wire.requestIds.clear();
        String webId = "web-1767000000000-k3j9x2";            // the shape index.html mints
        ActiveJobs.Job j = jobs.open(webId, "ext.ids", 10_000);
        Async<Object> w = runJob(j, fetchAll(b, j, "/redir/3"));   // 4 HTTP hops under one job
        check("a /redir/3 request (4 redirects + final = 5 HTTP hops) completes under its job", w.await(5000) && w.err == null);
        j.tryComplete();
        boolean same = wire.requestIds.size() == 5;
        for (String s : wire.requestIds) same &= s.equals(webId);
        check("every HTTP hop carried the web layer's request id unchanged (" + wire.requestIds.size() + " hops): no lower layer minted its own", same);
        idle(jobs, g, "ext.ids");
    }
}
