package app.mangahive.mihon.net;

import java.io.ByteArrayOutputStream;
import java.io.IOException;
import java.io.InputStream;
import java.io.OutputStream;
import java.net.InetAddress;
import java.net.InetSocketAddress;
import java.net.Socket;
import java.nio.charset.Charset;
import java.util.ArrayList;
import java.util.Collections;
import java.util.List;
import java.util.concurrent.CopyOnWriteArrayList;
import java.util.concurrent.atomic.AtomicReference;
import app.mangahive.mihon.spi.Registration;
import javax.net.ssl.SNIHostName;
import javax.net.ssl.SSLContext;
import javax.net.ssl.SSLParameters;
import javax.net.ssl.SSLSocket;

/**
 * TEST transport: a minimal HTTP/1.1-over-TLS client on raw sockets. It connects ONLY to the addresses the engine
 * passes (like the production OkHttp transport must), verifies the certificate against the URL's host NAME, and does
 * nothing else (no redirects, cookies, decompression). It records every connection so tests can assert what was dialled.
 */
final class PinnedSocketTransport implements Transport {
    private static final Charset ISO = Charset.forName("ISO-8859-1");
    private final SSLContext ctx;
    final List<String> dialled = new CopyOnWriteArrayList<String>();   // "host@ip:port"
    final List<String> requestIds = new CopyOnWriteArrayList<String>(); // request id seen on every HTTP call (every hop)
    final List<List<String[]>> sentHeaders = new CopyOnWriteArrayList<List<String[]>>();

    PinnedSocketTransport(SSLContext ctx) { this.ctx = ctx; }

    @Override public Response execute(Request r) throws IOException {
        requestIds.add(r.requestId);
        if (r.addresses.isEmpty()) throw new IOException("no pinned address");
        IOException last = null;
        // contract: the cancel hook closes whatever socket is current, from the cancelling thread
        final AtomicReference<Socket> current = new AtomicReference<Socket>();
        final Registration reg = r.cancel.onCancel(new Runnable() { @Override public void run() { Socket s = current.get(); if (s != null) { try { s.close(); } catch (IOException ignored) { } } } });
        for (InetAddress a : r.addresses) {
            dialled.add(r.url.host + "@" + a.getHostAddress() + ":" + r.url.port);
            Socket raw = new Socket();
            current.set(raw);
            if (r.cancel.isCancelled()) { try { raw.close(); } catch (IOException ignored) { } reg.close(); throw new IOException("cancelled"); }
            try {
                raw.connect(new InetSocketAddress(a, r.url.port), r.connectTimeoutMs);
                raw.setSoTimeout(r.readTimeoutMs);
                SSLSocket ssl = (SSLSocket) ctx.getSocketFactory().createSocket(raw, r.url.host, r.url.port, true);
                SSLParameters p = ssl.getSSLParameters();
                p.setEndpointIdentificationAlgorithm("HTTPS");                       // hostname check against the NAME
                p.setServerNames(Collections.singletonList(new SNIHostName(r.url.host)));
                ssl.setSSLParameters(p);
                ssl.startHandshake();
                current.set(ssl);
                return exchange(ssl, r, current, reg);
            } catch (IOException e) {
                last = e;
                try { raw.close(); } catch (IOException ignored) { }
                if (e instanceof javax.net.ssl.SSLException || r.cancel.isCancelled()) { reg.close(); throw e; }
            }
        }
        reg.close();
        throw last;
    }

    private Response exchange(final SSLSocket s, Request r, final AtomicReference<Socket> current, final Registration reg) throws IOException {
        try {
            return exchange0(s, r, reg);
        } catch (IOException e) { reg.close(); try { s.close(); } catch (IOException ignored) { } throw e; }
    }

    private Response exchange0(final SSLSocket s, Request r, final Registration reg) throws IOException {
        sentHeaders.add(new ArrayList<String[]>(r.headers));
        OutputStream out = s.getOutputStream();
        StringBuilder sb = new StringBuilder();
        sb.append(r.method).append(' ').append(r.url.pathAndQuery).append(" HTTP/1.1\r\n");
        sb.append("Host: ").append(r.url.authority()).append("\r\nConnection: close\r\n");
        for (String[] h : r.headers) sb.append(h[0]).append(": ").append(h[1]).append("\r\n");
        if (r.body != null) sb.append("Content-Length: ").append(r.body.length).append("\r\n");
        sb.append("\r\n");
        out.write(sb.toString().getBytes(ISO));
        if (r.body != null) out.write(r.body);
        out.flush();

        InputStream in = s.getInputStream();
        String status = line(in);
        if (status == null || !status.startsWith("HTTP/1.")) throw new IOException("bad status line: " + status);
        String[] sp = status.split(" ", 3);
        int code = Integer.parseInt(sp[1]);
        String msg = sp.length > 2 ? sp[2] : "";
        List<String[]> headers = new ArrayList<String[]>();
        String l;
        while ((l = line(in)) != null && !l.isEmpty()) {
            int c = l.indexOf(':');
            if (c > 0) headers.add(new String[] { l.substring(0, c).trim(), l.substring(c + 1).trim() });
        }
        String te = null, cl = null;
        for (String[] h : headers) { if (h[0].equalsIgnoreCase("Transfer-Encoding")) te = h[1]; if (h[0].equalsIgnoreCase("Content-Length")) cl = h[1]; }
        InputStream body;
        if (r.method.equals("HEAD") || code == 204 || code == 304) body = new ByteArrayInputStreamEmpty(s);
        else if (te != null && te.equalsIgnoreCase("chunked")) body = new Chunked(in, s);
        else if (cl != null) body = new Fixed(in, Long.parseLong(cl.trim()), s);
        else body = new Closing(in, s);
        Runnable abort = new Runnable() { @Override public void run() { try { s.close(); } catch (IOException ignored) { } } };
        Runnable closed = new Runnable() { @Override public void run() { reg.close(); } };
        return new Response(code, msg, "http/1.1", headers, body, abort, closed);
    }

    private static String line(InputStream in) throws IOException {
        ByteArrayOutputStream b = new ByteArrayOutputStream();
        int c;
        while ((c = in.read()) >= 0) {
            if (c == '\n') { String s = new String(b.toByteArray(), ISO); return s.endsWith("\r") ? s.substring(0, s.length() - 1) : s; }
            b.write(c);
        }
        return b.size() == 0 ? null : new String(b.toByteArray(), ISO);
    }

    private static class Closing extends InputStream {
        final InputStream in; final Socket s;
        Closing(InputStream in, Socket s) { this.in = in; this.s = s; }
        @Override public int read() throws IOException { return in.read(); }
        @Override public int read(byte[] b, int o, int l) throws IOException { return in.read(b, o, l); }
        @Override public void close() throws IOException { s.close(); }
    }
    private static final class ByteArrayInputStreamEmpty extends Closing {
        ByteArrayInputStreamEmpty(Socket s) throws IOException { super(null, s); }
        @Override public int read() { return -1; }
        @Override public int read(byte[] b, int o, int l) { return -1; }
    }
    private static final class Fixed extends Closing {
        long left;
        Fixed(InputStream in, long n, Socket s) { super(in, s); left = n; }
        @Override public int read() throws IOException { if (left <= 0) return -1; int c = in.read(); if (c >= 0) left--; return c; }
        @Override public int read(byte[] b, int o, int l) throws IOException {
            if (left <= 0) return -1;
            int n = in.read(b, o, (int) Math.min(l, left));
            if (n > 0) left -= n;
            return n;
        }
    }
    private static final class Chunked extends Closing {
        long left = 0; boolean done = false;
        Chunked(InputStream in, Socket s) { super(in, s); }
        private void next() throws IOException {
            if (left == 0 && !done) {
                String l = line(in);
                if (l != null && l.isEmpty()) l = line(in);
                if (l == null) { done = true; return; }
                int semi = l.indexOf(';');
                left = Long.parseLong((semi >= 0 ? l.substring(0, semi) : l).trim(), 16);
                if (left == 0) done = true;
            }
        }
        @Override public int read() throws IOException { byte[] one = new byte[1]; int n = read(one, 0, 1); return n < 0 ? -1 : one[0] & 0xff; }
        @Override public int read(byte[] b, int o, int l) throws IOException {
            next();
            if (done) return -1;
            int n = in.read(b, o, (int) Math.min(l, left));
            if (n > 0) left -= n;
            return n;
        }
    }
}
