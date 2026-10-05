package app.mangahive.mihon.net;

import app.mangahive.mihon.spi.BrokerException;
import app.mangahive.mihon.spi.BrokerRequest;
import app.mangahive.mihon.spi.BrokerResponse;
import app.mangahive.mihon.spi.CancelScope;
import app.mangahive.mihon.spi.CancelSignal;
import app.mangahive.mihon.spi.RequestContext;
import app.mangahive.mihon.spi.HttpBroker;
import com.sun.net.httpserver.HttpExchange;
import com.sun.net.httpserver.HttpHandler;
import com.sun.net.httpserver.HttpsConfigurator;
import com.sun.net.httpserver.HttpsServer;

import java.io.ByteArrayInputStream;
import java.io.ByteArrayOutputStream;
import java.io.File;
import java.io.FileInputStream;
import java.io.IOException;
import java.io.InputStream;
import java.io.OutputStream;
import java.net.InetAddress;
import java.net.InetSocketAddress;
import java.net.UnknownHostException;
import java.nio.charset.Charset;
import java.nio.file.Files;
import java.security.KeyStore;
import java.security.cert.Certificate;
import java.security.cert.CertificateFactory;
import java.util.ArrayList;
import java.util.Arrays;
import java.util.Collections;
import java.util.HashMap;
import java.util.List;
import java.util.Map;
import java.util.concurrent.Executors;
import java.util.concurrent.atomic.AtomicBoolean;
import java.util.zip.GZIPOutputStream;
import javax.net.ssl.KeyManagerFactory;
import javax.net.ssl.SSLContext;
import javax.net.ssl.TrustManagerFactory;

/**
 * Stage 5 verification harness for the pure-JDK network core. Plain main(), no test framework (none is available in the
 * authoring sandbox). Real TLS servers (JDK HttpsServer + the real Stage 2 fixture_server.py) and a socket transport are
 * used wherever the claim is about the wire; a scripted transport is used where the claim is about policy decisions that
 * cannot be staged against the real internet (public addresses, rebinding).
 */
public final class NetSelfTest {
    static int pass = 0, fail = 0;
    static final Charset UTF8 = Charset.forName("UTF-8");

    static void check(String name, boolean ok) {
        if (ok) { pass++; System.out.println("PASS: " + name); } else { fail++; System.out.println("FAIL: " + name); }
    }

    interface Thrower { void run() throws Exception; }

    /** Expects a BrokerException whose code equals {@code code} and message contains {@code contains} (may be null). */
    static void expect(String name, String code, String contains, Thrower t) {
        try { t.run(); check(name + " (expected " + code + ", nothing thrown)", false); }
        catch (BrokerException e) {
            boolean ok = e.code.equals(code) && (contains == null || e.getMessage().contains(contains));
            if (!ok) System.out.println("   got " + e.getMessage());
            check(name, ok);
        }
        catch (Exception e) { System.out.println("   got " + e); check(name + " (wrong exception type)", false); }
    }

    // ───────────────────────── fixtures ─────────────────────────

    static InetAddress ip(String lit) {
        try { return InetAddress.getByName(lit); } catch (UnknownHostException e) { throw new RuntimeException(e); }
    }

    static final class FakeDns implements DestinationPolicy.Resolver {
        final Map<String, List<List<InetAddress>>> answers = new HashMap<String, List<List<InetAddress>>>();
        final Map<String, Integer> calls = new HashMap<String, Integer>();
        FakeDns on(String host, String... ips) {
            List<InetAddress> l = new ArrayList<InetAddress>();
            for (String s : ips) l.add(ip(s));
            List<List<InetAddress>> seq = answers.get(host);
            if (seq == null) { seq = new ArrayList<List<InetAddress>>(); answers.put(host, seq); }
            seq.add(l);   // successive answers for rebinding tests; the last one repeats
            return this;
        }
        @Override public List<InetAddress> resolve(String host) throws UnknownHostException {
            Integer n = calls.get(host);
            int i = n == null ? 0 : n;
            calls.put(host, i + 1);
            List<List<InetAddress>> seq = answers.get(host);
            if (seq == null) throw new UnknownHostException(host);
            return seq.get(Math.min(i, seq.size() - 1));
        }
    }

    static final class Seen {
        final String method; final String url; final List<InetAddress> addrs; final List<String[]> headers; final byte[] body;
        Seen(Transport.Request r) { method = r.method; url = r.url.toString(); addrs = r.addresses; headers = r.headers; body = r.body; }
        String header(String n) { return HeaderPolicy.first(headers, n); }
    }

    interface Handler { Transport.Response handle(Transport.Request r) throws IOException; }

    static final class Scripted implements Transport {
        final List<Seen> seen = new ArrayList<Seen>();
        final Handler h;
        Scripted(Handler h) { this.h = h; }
        @Override public Response execute(Request r) throws IOException { seen.add(new Seen(r)); return h.handle(r); }
    }

    static Transport.Response resp(int code, String body, String... hdrs) {
        List<String[]> h = new ArrayList<String[]>();
        for (int i = 0; i + 1 < hdrs.length; i += 2) h.add(new String[] { hdrs[i], hdrs[i + 1] });
        return new Transport.Response(code, "", "http/1.1", h, new ByteArrayInputStream(body.getBytes(UTF8)), new Runnable() { public void run() { } }, null);
    }

    static Transport.Response redirect(int code, String loc, String... more) {
        List<String> l = new ArrayList<String>(Arrays.asList("Location", loc));
        l.addAll(Arrays.asList(more));
        return resp(code, "", l.toArray(new String[0]));
    }

    static BrokerRequest req(String method, String url, boolean follow, byte[] body, String... hdrs) {
        List<String[]> h = new ArrayList<String[]>();
        for (int i = 0; i + 1 < hdrs.length; i += 2) h.add(new String[] { hdrs[i], hdrs[i + 1] });
        return new BrokerRequest(method, url, h, body, body == null ? null : "application/x-www-form-urlencoded", follow, 0, 0, 0);
    }

    static BrokerRequest get(String url, String... hdrs) { return req("GET", url, true, null, hdrs); }

    static String read(BrokerResponse r) throws IOException {
        ByteArrayOutputStream b = new ByteArrayOutputStream();
        byte[] buf = new byte[8192];
        int n;
        InputStream in = r.body();
        while ((n = in.read(buf)) >= 0) b.write(buf, 0, n);
        in.close();
        return new String(b.toByteArray(), UTF8);
    }

    static BrokerEngine engine(DestinationPolicy p, Transport t, CookieStore cs) {
        return new BrokerEngine(p, t, cs, new BrokerEngine.Limits());
    }

    static CookieStore memJar() {
        return new CookieStore(null, new CookieStore.Clock() { @Override public long nowMs() { return System.currentTimeMillis(); } });
    }

    static final String PUB = "93.184.216.34";

    // ───────────────────────── main ─────────────────────────

    /** Runs everything; returns the number of failed checks. Used by the JUnit wrapper and by main(). */
    public static int runAll() throws Exception {
        pass = 0; fail = 0;
        classifier();
        urlParsing();
        policy();
        headerPolicy();
        scriptedRedirects();
        scriptedRebinding();
        cookies();
        realTls();
        realFixture();
        System.out.println("\n" + pass + " passed, " + fail + " failed");
        return fail;
    }

    public static void main(String[] args) throws Exception { System.exit(runAll() == 0 ? 0 : 1); }

    // ───────────────────────── 1. address classification ─────────────────────────

    static void classifier() {
        String[] blocked = {
            "0.0.0.0", "0.1.2.3", "10.0.0.1", "10.255.255.255", "100.64.0.1", "100.127.255.254", "127.0.0.1", "127.255.255.254",
            "169.254.169.254", "172.16.0.1", "172.31.255.255", "192.0.0.1", "192.0.2.1", "192.168.0.1", "198.18.0.1", "198.19.255.255",
            "198.51.100.7", "203.0.113.9", "224.0.0.1", "239.255.255.250", "240.0.0.1", "255.255.255.255", "192.88.99.1",
            "::", "::1", "::ffff:127.0.0.1", "::ffff:10.1.2.3", "::127.0.0.1", "fe80::1", "fc00::1", "fd12:3456::1",
            "fec0::1", "ff02::1", "ff0e::1", "2001:db8::1", "2001::1", "2002:7f00:1::1", "2002:0a00:0001::1", "64:ff9b::7f00:1", "64:ff9b::a00:1",
            "100::1", "5f00::1", "3fff::1", "4000::1", "8000::1",
        };
        for (String b : blocked) check("classifier blocks " + b, AddressClassifier.classify(ip(b)) != null);
        byte[] mappedPublic = new byte[16]; mappedPublic[10] = (byte) 0xff; mappedPublic[11] = (byte) 0xff; mappedPublic[12] = 8; mappedPublic[13] = 8; mappedPublic[14] = 8; mappedPublic[15] = 8;
        check("raw ::ffff:8.8.8.8 bytes are refused (JDK would collapse it to a plain IPv4; the byte path never trusts that)", AddressClassifier.classify(mappedPublic) != null);
        check("InetAddress collapses ::ffff:127.0.0.1 to IPv4 loopback and it is still blocked", ip("::ffff:127.0.0.1") instanceof java.net.Inet4Address && AddressClassifier.classify(ip("::ffff:127.0.0.1")) != null);
        String[] open = { "8.8.8.8", "1.1.1.1", "93.184.216.34", "172.15.255.255", "172.32.0.1", "100.63.255.255", "100.128.0.1",
            "192.169.0.1", "198.17.255.255", "198.20.0.1", "223.255.255.255", "2606:4700:4700::1111", "2001:4860:4860::8888",
            "2620:fe::fe", "2a00:1450:4009:81f::200e", "64:ff9b::808:808", "2002:0808:0808::1" };
        for (String o : open) check("classifier allows public " + o, AddressClassifier.classify(ip(o)) == null);
    }

    // ───────────────────────── 2. strict URL parsing ─────────────────────────

    static void urlParsing() {
        String[][] bad = {
            { "https://user:pw@example.com/", "USERINFO_NOT_ALLOWED" }, { "https://example.com@evil.com/", "USERINFO_NOT_ALLOWED" },
            { "https://evil.com\\@example.com/", "MALFORMED_URL" }, { "https://example.com\\evil/", "MALFORMED_URL" },
            { "https://2130706433/", "AMBIGUOUS_IP_LITERAL" }, { "https://0x7f000001/", "AMBIGUOUS_IP_LITERAL" }, { "https://0x7f.0.0.1/", "AMBIGUOUS_IP_LITERAL" },
            { "https://017700000001/", "AMBIGUOUS_IP_LITERAL" }, { "https://0177.0.0.1/", "AMBIGUOUS_IP_LITERAL" }, { "https://127.1/", "AMBIGUOUS_IP_LITERAL" },
            { "https://1.2.3/", "AMBIGUOUS_IP_LITERAL" }, { "https://10.0.0.01/", "AMBIGUOUS_IP_LITERAL" }, { "https://256.1.1.1/", "AMBIGUOUS_IP_LITERAL" },
            { "https://[::1%25lo]/", "MALFORMED_URL" }, { "https://[::1%eth0]/", "MALFORMED_URL" }, { "https://[zzz]/", "MALFORMED_URL" }, { "https://[::1/", "MALFORMED_URL" },
            { "https://exa mple.com/", "MALFORMED_URL" }, { "https://exa%6Dple.com/", "MALFORMED_URL" }, { "https://exämple.com/", "MALFORMED_URL" },
            { "https://example.com:0/", "MALFORMED_URL" }, { "https://example.com:65536/", "MALFORMED_URL" }, { "https://example.com:abc/", "MALFORMED_URL" },
            { "https:///path", "MISSING_HOST" }, { "https://:443/", "MISSING_HOST" }, { "https://exa..mple.com/", "MALFORMED_URL" },
            { "file:///etc/passwd", "BLOCKED_SCHEME" }, { "javascript:alert(1)", "BLOCKED_SCHEME" }, { "data:text/html,x", "BLOCKED_SCHEME" },
            { "ftp://example.com/", "BLOCKED_SCHEME" }, { "gopher://example.com/", "BLOCKED_SCHEME" }, { "content://x/y", "BLOCKED_SCHEME" },
            { "blob:https://example.com/x", "BLOCKED_SCHEME" }, { "//example.com/", "MALFORMED_URL" }, { "example.com", "MALFORMED_URL" }, { "", "MALFORMED_URL" },
            { "https://example.com/\u0000", "MALFORMED_URL" }, { "https://example.com/a\nb", "MALFORMED_URL" },
        };
        for (String[] b : bad) {
            try { SafeUrl.parse(b[0]); check("parse rejects " + show(b[0]), false); }
            catch (PolicyViolation v) { if (!v.reason.equals(b[1])) System.out.println("   got " + v.reason); check("parse rejects " + show(b[0]) + " as " + b[1], v.reason.equals(b[1])); }
        }
        try {
            SafeUrl u = SafeUrl.parse("HTTPS://Example.COM:443/a/b?x=1#frag");
            check("parse normalizes case, default port, fragment", u.toString().equals("https://example.com/a/b?x=1") && u.port == 443);
            check("parse trailing-dot host", SafeUrl.parse("https://example.com./").host.equals("example.com"));
            check("parse bracket IPv6 literal", SafeUrl.parse("https://[2606:4700:4700::1111]:8443/").ipLiteral.length == 16);
            check("parse query-only path gets /", SafeUrl.parse("https://example.com?q=1").pathAndQuery.equals("/?q=1"));
            check("parse dotted-quad literal", SafeUrl.parse("https://8.8.8.8/").ipLiteral.length == 4);
            check("host named like hex words is a name, not an IP", SafeUrl.parse("https://beef.cafe/").ipLiteral == null);
            check("digits in a name are fine", SafeUrl.parse("https://123.example.com/").ipLiteral == null);
        } catch (PolicyViolation v) { check("parse accepts valid urls: " + v, false); }

        try {
            SafeUrl base = SafeUrl.parse("https://example.com/a/b/c?x=1");
            check("resolve ../", SafeUrl.resolve(base, "../d").toString().equals("https://example.com/a/d"));
            check("resolve ./x", SafeUrl.resolve(base, "./x").toString().equals("https://example.com/a/b/x"));
            check("resolve /abs", SafeUrl.resolve(base, "/abs?q=2").toString().equals("https://example.com/abs?q=2"));
            check("resolve ?q only", SafeUrl.resolve(base, "?z=9").toString().equals("https://example.com/a/b/c?z=9"));
            check("resolve //other", SafeUrl.resolve(base, "//other.org/p").toString().equals("https://other.org/p"));
            check("resolve absolute", SafeUrl.resolve(base, "https://o.net/q").toString().equals("https://o.net/q"));
            check("resolve too many ..", SafeUrl.resolve(base, "../../../../../x").toString().equals("https://example.com/x"));
            check("resolve space and utf8 are encoded, not decoded", SafeUrl.resolve(base, "/a b/\u00e9").toString().equals("https://example.com/a%20b/%C3%A9"));
            check("resolve trims header whitespace", SafeUrl.resolve(base, "  /t  ").toString().equals("https://example.com/t"));
        } catch (PolicyViolation v) { check("resolve valid: " + v, false); }
        String[] badLoc = { "javascript:alert(1)", "file:///x", "http://[::1]:80/", "https://u@evil.com/", "https://2130706433/", "//127.1/", "data:x" };
        for (String l : badLoc) {
            try { SafeUrl.resolve(SafeUrl.parse("https://example.com/"), l); check("resolve rejects " + l + " (" + "returned" + ")", l.startsWith("http://[::1]") ); }
            catch (PolicyViolation v) { check("resolve rejects " + l, true); }
        }
    }

    static String show(String s) { return s.replace("\u0000", "\\0").replace("\n", "\\n"); }

    // ───────────────────────── 3. central destination policy ─────────────────────────

    static void policy() {
        FakeDns dns = new FakeDns()
            .on("good.example.org", PUB).on("v6.example.org", "2606:4700:4700::1111")
            .on("evil.example.org", "127.0.0.1").on("evil6.example.org", "::1").on("mapped.example.org", "::ffff:10.0.0.5")
            .on("mixed.example.org", PUB, "127.0.0.1").on("mixed2.example.org", "127.0.0.1", PUB).on("meta.example.org", "169.254.169.254")
            .on("sslip.example.org", "127.0.0.1").on("cgnat.example.org", "100.64.0.9").on("ula.example.org", "fd00::1")
            .on("multi.example.org", "224.0.0.251").on("zero.example.org", "0.0.0.0").on("ll6.example.org", "fe80::1")
            .on("gfubquamaafpzzshrhzj.supabase.co", PUB).on("api.supabase.co", PUB);
        DestinationPolicy p = DestinationPolicy.production(dns);
        check("production policy carries no test relaxation", !p.relaxedForTesting());
        try {
            Destination d = p.check("https://good.example.org/x");
            check("public host passes and returns the validated address to pin", d.addresses.size() == 1 && d.addresses.get(0).getHostAddress().equals(PUB));
            check("public IPv6 host passes", p.check("https://v6.example.org/").addresses.size() == 1);
            check("public IPv4 literal passes without DNS", p.check("https://8.8.8.8/").addresses.get(0).getHostAddress().equals("8.8.8.8"));
        } catch (PolicyViolation v) { check("public destinations pass: " + v, false); }

        String[][] denied = {
            { "http://good.example.org/", "HTTPS_REQUIRED" }, { "https://good.example.org:8443/", "PORT_NOT_ALLOWED" }, { "https://good.example.org:80/", "PORT_NOT_ALLOWED" },
            { "https://localhost/", "UNSAFE_HOSTNAME" }, { "https://LOCALHOST/", "UNSAFE_HOSTNAME" }, { "https://localhost./", "UNSAFE_HOSTNAME" },
            { "https://foo.localhost/", "UNSAFE_HOSTNAME" }, { "https://printer.local/", "UNSAFE_HOSTNAME" }, { "https://metadata.google.internal/", "UNSAFE_HOSTNAME" },
            { "https://router.lan/", "UNSAFE_HOSTNAME" }, { "https://intranet/", "UNSAFE_HOSTNAME" }, { "https://kubernetes/", "UNSAFE_HOSTNAME" },
            { "https://1.0.0.127.in-addr.arpa/", "UNSAFE_HOSTNAME" },
            { "https://127.0.0.1/", "BLOCKED_ADDRESS" }, { "https://10.1.2.3/", "BLOCKED_ADDRESS" }, { "https://192.168.1.1/", "BLOCKED_ADDRESS" },
            { "https://172.20.0.1/", "BLOCKED_ADDRESS" }, { "https://169.254.169.254/latest/meta-data/", "BLOCKED_ADDRESS" }, { "https://0.0.0.0/", "BLOCKED_ADDRESS" },
            { "https://100.64.1.1/", "BLOCKED_ADDRESS" }, { "https://224.0.0.1/", "BLOCKED_ADDRESS" }, { "https://255.255.255.255/", "BLOCKED_ADDRESS" },
            { "https://[::1]/", "BLOCKED_ADDRESS" }, { "https://[::]/", "BLOCKED_ADDRESS" }, { "https://[::ffff:127.0.0.1]/", "BLOCKED_ADDRESS" },
            { "https://[::ffff:7f00:1]/", "BLOCKED_ADDRESS" }, { "https://[fe80::1]/", "BLOCKED_ADDRESS" }, { "https://[fd00::1]/", "BLOCKED_ADDRESS" }, { "https://[ff02::1]/", "BLOCKED_ADDRESS" },
            { "https://evil.example.org/", "BLOCKED_ADDRESS" }, { "https://evil6.example.org/", "BLOCKED_ADDRESS" }, { "https://mapped.example.org/", "BLOCKED_ADDRESS" },
            { "https://mixed.example.org/", "BLOCKED_ADDRESS" }, { "https://mixed2.example.org/", "BLOCKED_ADDRESS" }, { "https://meta.example.org/", "BLOCKED_ADDRESS" },
            { "https://sslip.example.org/", "BLOCKED_ADDRESS" }, { "https://cgnat.example.org/", "BLOCKED_ADDRESS" }, { "https://ula.example.org/", "BLOCKED_ADDRESS" },
            { "https://multi.example.org/", "BLOCKED_ADDRESS" }, { "https://zero.example.org/", "BLOCKED_ADDRESS" }, { "https://ll6.example.org/", "BLOCKED_ADDRESS" },
            { "https://nxdomain.example.org/", "DNS_FAILURE" },
            { "https://gfubquamaafpzzshrhzj.supabase.co/rest/v1/", "PROTECTED_HOST" }, { "https://api.supabase.co/", "PROTECTED_HOST" },
            { "file:///etc/passwd", "BLOCKED_SCHEME" }, { "ftp://good.example.org/", "BLOCKED_SCHEME" }, { "https://user@good.example.org/", "USERINFO_NOT_ALLOWED" },
        };
        for (String[] d : denied) {
            try { p.check(d[0]); check("policy denies " + d[0], false); }
            catch (PolicyViolation v) { if (!v.reason.equals(d[1])) System.out.println("   got " + v.reason); check("policy denies " + d[0] + " as " + d[1], v.reason.equals(d[1])); }
        }
        check("screen() agrees with check() on a private literal", "BLOCKED_ADDRESS".equals(p.screen("https://10.0.0.1/")));
        check("screen() passes a normal host without DNS", p.screen("https://good.example.org/") == null);
    }

    // ───────────────────────── 4. header policy ─────────────────────────

    static void headerPolicy() throws Exception {
        FakeDns dns = new FakeDns().on("good.example.org", PUB);
        final Scripted t = new Scripted(new Handler() { public Transport.Response handle(Transport.Request r) { return resp(200, "ok"); } });
        BrokerEngine e = engine(DestinationPolicy.production(dns), t, memJar());
        HttpBroker b = e.open("ext.a", 1);

        String[] privileged = { "X-MangaHive-Token", "x-mangahive-session", "X-MH-Auth", "x-supabase-auth", "sb-access-token", "sb-refresh-token", "X-Client-Info", "X-MANGAHIVE" };
        for (final String h : privileged) {
            final BrokerRequest r = get("https://good.example.org/", h, "stolen");
            expect("privileged header rejected: " + h, "PRIVILEGED_HEADER", null, new Thrower() { public void run() throws Exception { b.execute(r, ctx()).close(); } });
        }
        final BrokerRequest crlf = get("https://good.example.org/", "X-Test", "a\r\nX-MangaHive-Token: 1");
        expect("CRLF header injection rejected", "HEADER_REJECTED", null, new Thrower() { public void run() throws Exception { b.execute(crlf, ctx()).close(); } });
        final BrokerRequest badName = get("https://good.example.org/", "Bad Name", "x");
        expect("invalid header name rejected", "HEADER_REJECTED", null, new Thrower() { public void run() throws Exception { b.execute(badName, ctx()).close(); } });
        check("no request reached the wire for any rejected header", t.seen.isEmpty());

        b.execute(get("https://good.example.org/", "Host", "evil.com", "Content-Length", "999", "Transfer-Encoding", "chunked", "Connection", "upgrade",
            "Upgrade", "websocket", "Proxy-Authorization", "x", "X-Custom", "kept", "Referer", "https://good.example.org/"), ctx()).close();
        Seen s = t.seen.get(0);
        check("extension cannot override Host", s.header("Host") == null);
        check("extension cannot set Content-Length/Transfer-Encoding/Connection/Upgrade/Proxy-Authorization",
            s.header("Content-Length") == null && s.header("Transfer-Encoding") == null && s.header("Connection") == null && s.header("Upgrade") == null && s.header("Proxy-Authorization") == null);
        check("ordinary extension headers pass through", "kept".equals(s.header("X-Custom")) && s.header("Referer") != null);
        check("broker injects no credential headers of its own",
            s.header("Authorization") == null && s.header("apikey") == null && s.header("Cookie") == null && s.header("X-Client-Info") == null);
        check("default User-Agent is added only when the Source set none", s.header("User-Agent") != null);
        b.execute(get("https://good.example.org/", "User-Agent", "MHFixture/1.6.1"), ctx()).close();
        check("Source User-Agent is preserved verbatim", "MHFixture/1.6.1".equals(t.seen.get(1).header("User-Agent")));
    }

    // ───────────────────────── 5. redirects (policy decisions, scripted wire) ─────────────────────────

    static void scriptedRedirects() throws Exception {
        final FakeDns dns = new FakeDns().on("a.example.org", PUB).on("b.example.org", "93.184.216.35").on("evil.example.org", "10.0.0.7")
            .on("rebind.example.org", PUB, "127.0.0.1");

        // ---- legitimate chains
        Scripted t = new Scripted(new Handler() { public Transport.Response handle(Transport.Request r) {
            String u = r.url.toString();
            if (u.equals("https://a.example.org/start")) return redirect(302, "/mid/one");
            if (u.equals("https://a.example.org/mid/one")) return redirect(301, "../two?x=1");
            if (u.equals("https://a.example.org/two?x=1")) return redirect(303, "//b.example.org/final");
            if (u.equals("https://b.example.org/final")) return resp(200, "done", "Content-Type", "text/plain; charset=utf-8", "X-Hop", "last");
            return resp(404, "?");
        } });
        BrokerEngine e = engine(DestinationPolicy.production(dns), t, memJar());
        BrokerResponse r = e.open("ext.a", 1).execute(get("https://a.example.org/start"), ctx());
        check("relative, parent-relative and scheme-relative redirects are followed", r.status == 200 && read(r).equals("done"));
        check("final URL is the last hop", r.finalUrl.equals("https://b.example.org/final"));
        check("redirect chain is preserved in order", r.priorHops.size() == 3 && r.priorHops.get(0).status == 302 && r.priorHops.get(2).url.equals("https://a.example.org/two?x=1"));
        check("content type and custom header preserved", "text/plain; charset=utf-8".equals(r.contentType) && HeaderPolicy.first(r.headers, "X-Hop").equals("last"));
        check("every hop was dialled at its own validated address", t.seen.size() == 4 && t.seen.get(3).addrs.get(0).getHostAddress().equals("93.184.216.35") && t.seen.get(0).addrs.get(0).getHostAddress().equals(PUB));
        check("DNS was resolved afresh for each distinct hop", dns.calls.get("a.example.org") >= 3 && dns.calls.get("b.example.org") == 1);

        // ---- method / body semantics (OkHttp-compatible)
        final List<Seen> log = new ArrayList<Seen>();
        Scripted t2 = new Scripted(new Handler() { public Transport.Response handle(Transport.Request r) {
            String u = r.url.path();
            if (u.equals("/p302")) return redirect(302, "/land");
            if (u.equals("/p303")) return redirect(303, "/land");
            if (u.equals("/p307")) return redirect(307, "/land");
            if (u.equals("/p308")) return redirect(308, "/land");
            if (u.equals("/g307")) return redirect(307, "/land");
            if (u.equals("/h302")) return redirect(302, "/land");
            return resp(200, "landed");
        } });
        BrokerEngine e2 = engine(DestinationPolicy.production(dns), t2, memJar());
        HttpBroker b2 = e2.open("ext.a", 1);
        BrokerResponse x = b2.execute(req("POST", "https://a.example.org/p302", true, "k=v".getBytes(UTF8), "Content-Type", "application/x-www-form-urlencoded"), ctx());
        check("302 turns POST into GET and drops the body and content headers", x.finalMethod.equals("GET") && t2.seen.get(1).method.equals("GET") && t2.seen.get(1).body == null && t2.seen.get(1).header("Content-Type") == null);
        x.close();
        BrokerResponse x3 = b2.execute(req("POST", "https://a.example.org/p303", true, "k=v".getBytes(UTF8)), ctx());
        check("303 turns POST into GET", x3.finalMethod.equals("GET") && x3.status == 200);
        x3.close();
        BrokerResponse x7 = b2.execute(req("POST", "https://a.example.org/p307", true, "k=v".getBytes(UTF8)), ctx());
        check("307 on POST is returned untouched (not auto-followed), like OkHttp", x7.status == 307 && x7.priorHops.isEmpty());
        x7.close();
        BrokerResponse x8 = b2.execute(req("POST", "https://a.example.org/p308", true, "k=v".getBytes(UTF8)), ctx());
        check("308 on POST is returned untouched", x8.status == 308);
        x8.close();
        BrokerResponse g7 = b2.execute(get("https://a.example.org/g307"), ctx());
        check("307 on GET is followed", g7.status == 200 && g7.priorHops.size() == 1);
        g7.close();
        BrokerResponse h = b2.execute(req("HEAD", "https://a.example.org/h302", true, null), ctx());
        check("HEAD stays HEAD across a 302", h.finalMethod.equals("HEAD") && h.status == 200);
        h.close();
        BrokerResponse nf = b2.execute(req("GET", "https://a.example.org/p302", false, null), ctx());
        check("followRedirects=false returns the 302 and its Location untouched", nf.status == 302 && HeaderPolicy.first(nf.headers, "Location").equals("/land") && nf.finalUrl.equals("https://a.example.org/p302"));
        nf.close();

        // ---- credentials across origins
        Scripted t3 = new Scripted(new Handler() { public Transport.Response handle(Transport.Request r) {
            if (r.url.path().equals("/same")) return redirect(302, "/same2");
            if (r.url.path().equals("/cross")) return redirect(302, "https://b.example.org/landing");
            return resp(200, "x");
        } });
        HttpBroker b3 = engine(DestinationPolicy.production(dns), t3, memJar()).open("ext.a", 1);
        b3.execute(get("https://a.example.org/same", "Authorization", "Bearer site-token", "Cookie", "sid=1"), ctx()).close();
        check("Authorization and explicit Cookie survive a same-origin redirect", "Bearer site-token".equals(t3.seen.get(1).header("Authorization")) && "sid=1".equals(t3.seen.get(1).header("Cookie")));
        b3.execute(get("https://a.example.org/cross", "Authorization", "Bearer site-token", "Cookie", "sid=1", "X-Keep", "1"), ctx()).close();
        Seen cross = t3.seen.get(t3.seen.size() - 1);
        check("Authorization and explicit Cookie are dropped on a cross-origin redirect", cross.header("Authorization") == null && cross.header("Cookie") == null && "1".equals(cross.header("X-Keep")));

        // ---- unsafe redirect targets
        String[] unsafe = {
            "http://a.example.org/plain", "https://127.0.0.1/x", "https://[::1]/x", "https://10.0.0.1/x", "https://169.254.169.254/latest/meta-data/",
            "https://localhost/x", "https://evil.example.org/dns-private", "file:///etc/passwd", "javascript:alert(1)", "ftp://a.example.org/", "data:text/html,x",
            "//127.0.0.1/x", "https://user@a.example.org/", "https://2130706433/", "https://a.example.org:8443/", "https://metadata.google.internal/",
        };
        for (final String target : unsafe) {
            final Scripted tu = new Scripted(new Handler() { public Transport.Response handle(Transport.Request r) {
                return r.url.path().equals("/go") ? redirect(302, target) : resp(200, "SHOULD NOT BE REACHED"); } });
            final HttpBroker bu = engine(DestinationPolicy.production(dns), tu, memJar()).open("ext.a", 1);
            expect("redirect to " + target + " is refused", "REDIRECT_BLOCKED", null, new Thrower() { public void run() throws Exception { bu.execute(get("https://a.example.org/go"), ctx()).close(); } });
            check("   ...and nothing was dialled for the refused target (" + target + ")", tu.seen.size() == 1);
        }

        // ---- loops and runaway chains
        final Scripted tl = new Scripted(new Handler() { public Transport.Response handle(Transport.Request r) {
            String p = r.url.path();
            if (p.equals("/l1")) return redirect(302, "/l2");
            if (p.equals("/l2")) return redirect(302, "/l1");
            if (p.equals("/self")) return redirect(302, "/self");
            if (p.startsWith("/n/")) return redirect(302, "/n/" + (Integer.parseInt(p.substring(3)) + 1));
            return resp(200, "x");
        } });
        final HttpBroker bl = engine(DestinationPolicy.production(dns), tl, memJar()).open("ext.a", 1);
        expect("A->B->A loop detected", "REDIRECT_LOOP", null, new Thrower() { public void run() throws Exception { bl.execute(get("https://a.example.org/l1"), ctx()).close(); } });
        check("   ...after a handful of requests, not twenty", tl.seen.size() <= 8);
        tl.seen.clear();
        expect("self-redirect detected", "REDIRECT_LOOP", null, new Thrower() { public void run() throws Exception { bl.execute(get("https://a.example.org/self"), ctx()).close(); } });
        tl.seen.clear();
        expect("endless distinct chain stops at the ceiling", "TOO_MANY_REDIRECTS", null, new Thrower() { public void run() throws Exception { bl.execute(get("https://a.example.org/n/0"), ctx()).close(); } });
        check("   ...at exactly 21 requests (20 follow-ups)", tl.seen.size() == 21);
    }

    // ───────────────────────── 6. DNS rebinding ─────────────────────────

    static void scriptedRebinding() throws Exception {
        // A name that answers with a public address first and loopback second. The engine resolves once per hop, validates
        // that answer, and hands the transport exactly that answer; there is no second lookup to be rebound.
        final FakeDns dns = new FakeDns().on("rebind.example.org", PUB).on("rebind.example.org", "127.0.0.1");
        Scripted t = new Scripted(new Handler() { public Transport.Response handle(Transport.Request r) { return resp(200, "ok"); } });
        HttpBroker b = engine(DestinationPolicy.production(dns), t, memJar()).open("ext.a", 1);
        b.execute(get("https://rebind.example.org/one"), ctx()).close();
        check("first answer (public) validated and pinned", t.seen.get(0).addrs.size() == 1 && t.seen.get(0).addrs.get(0).getHostAddress().equals(PUB));
        check("one resolution per hop: the transport was given no address that DNS did not validate in that same lookup", dns.calls.get("rebind.example.org") == 1);
        try { b.execute(get("https://rebind.example.org/two"), ctx()).close(); check("second request (name now answers loopback) is refused", false); }
        catch (BrokerException e) { check("second request (name now answers loopback) is refused", e.code.equals("BLOCKED_ADDRESS")); }
        check("...and was never dialled", t.seen.size() == 1);

        // Rebinding across a redirect: hop 1 public, redirect target name answers private on ITS lookup
        final FakeDns dns2 = new FakeDns().on("front.example.org", PUB).on("back.example.org", "192.168.0.10");
        Scripted t2 = new Scripted(new Handler() { public Transport.Response handle(Transport.Request r) {
            return r.url.host.equals("front.example.org") ? redirect(302, "https://back.example.org/internal") : resp(200, "LEAK"); } });
        final HttpBroker b2 = engine(DestinationPolicy.production(dns2), t2, memJar()).open("ext.a", 1);
        expect("redirect to a name that resolves privately is refused (revalidated after redirect)", "REDIRECT_BLOCKED", "BLOCKED_ADDRESS", new Thrower() { public void run() throws Exception { b2.execute(get("https://front.example.org/"), ctx()).close(); } });
        check("...private target never dialled", t2.seen.size() == 1);

        // Mixed answer: even one bad record poisons the answer
        final FakeDns dns3 = new FakeDns().on("mixed.example.org", PUB, "10.0.0.1");
        final HttpBroker b3 = engine(DestinationPolicy.production(dns3), new Scripted(new Handler() { public Transport.Response handle(Transport.Request r) { return resp(200, "x"); } }), memJar()).open("ext.a", 1);
        expect("answer containing any private address is refused outright", "BLOCKED_ADDRESS", null, new Thrower() { public void run() throws Exception { b3.execute(get("https://mixed.example.org/"), ctx()).close(); } });
    }

    // ───────────────────────── 7. cookies ─────────────────────────

    static void cookies() throws Exception {
        final long[] now = { 1_700_000_000_000L };
        CookieStore.Clock clock = new CookieStore.Clock() { public long nowMs() { return now[0]; } };
        File dir = Files.createTempDirectory("mhck").toFile();
        CookieStore cs = new CookieStore(new FileCookieStorage(dir), clock);
        CookieScope a1 = new CookieScope("ext.a", 1), a2 = new CookieScope("ext.a", 2), b1 = new CookieScope("ext.b", 1);
        SafeUrl site = SafeUrl.parse("https://www.site.example.org/app/page");

        cs.saveFromResponse(a1, site, Arrays.asList("sid=AAA; Path=/; Max-Age=3600", "tmp=session1"));
        check("scope (ext.a,1) sees its cookies", "sid=AAA; tmp=session1".equals(cs.cookieHeader(a1, site)) || "tmp=session1; sid=AAA".equals(cs.cookieHeader(a1, site)));
        check("Extension A cookie != Extension B cookie (same URL, other extension)", cs.cookieHeader(b1, site) == null);
        check("same extension, other source (ext.a,2) is isolated too", cs.cookieHeader(a2, site) == null);
        cs.saveFromResponse(b1, site, Arrays.asList("sid=BBB; Path=/"));
        check("B's cookie does not overwrite A's", cs.cookieHeader(a1, site).contains("sid=AAA") && !cs.cookieHeader(a1, site).contains("BBB") && "sid=BBB".equals(cs.cookieHeader(b1, site)));

        // matching rules
        SafeUrl other = SafeUrl.parse("https://other.example.net/");
        check("cookie is not sent to a different site", cs.cookieHeader(a1, other) == null);
        cs.saveFromResponse(a1, site, Arrays.asList("dom=1; Domain=site.example.org; Path=/"));
        check("Domain cookie goes to the parent's other subdomains", "dom=1".equals(cs.cookieHeader(a1, SafeUrl.parse("https://api.site.example.org/x"))));
        check("host-only cookie does NOT go to a sibling subdomain", cs.cookieHeader(a1, SafeUrl.parse("https://api.site.example.org/x")).indexOf("sid=") < 0);
        cs.saveFromResponse(a1, site, Arrays.asList("p=1; Path=/app/sub"));
        check("Path scoping", cs.cookieHeader(a1, site) != null && cs.cookieHeader(a1, site).indexOf("p=1") < 0 && cs.cookieHeader(a1, SafeUrl.parse("https://www.site.example.org/app/sub/x")).contains("p=1"));
        cs.saveFromResponse(a1, site, Arrays.asList("evil=1; Domain=unrelated.example.com"));
        check("a host cannot set a cookie for an unrelated domain", cs.cookieHeader(a1, SafeUrl.parse("https://unrelated.example.com/")) == null);
        cs.saveFromResponse(a1, SafeUrl.parse("https://www.example.co.uk/"), Arrays.asList("sup=1; Domain=co.uk", "sup2=1; Domain=uk", "sup3=1; Domain=com"));
        check("public-suffix Domain= (co.uk, uk, com) is refused", cs.cookieHeader(a1, SafeUrl.parse("https://other.co.uk/")) == null && cs.cookieHeader(a1, SafeUrl.parse("https://x.com/")) == null);
        cs.saveFromResponse(a1, site, Arrays.asList("__Secure-x=1", "__Host-y=1; Secure; Path=/; Domain=site.example.org", "__Host-z=1; Secure; Path=/"));
        String hh = cs.cookieHeader(a1, site);
        check("__Secure-/__Host- prefix rules enforced", hh.indexOf("__Secure-x") < 0 && hh.indexOf("__Host-y") < 0 && hh.contains("__Host-z=1"));

        // expiry / deletion
        now[0] += 3_601_000;
        check("Max-Age expiry honoured (sid gone, session cookie stays)", cs.cookieHeader(a1, site).indexOf("sid=AAA") < 0 && cs.cookieHeader(a1, site).contains("tmp=session1"));
        cs.saveFromResponse(a1, site, Arrays.asList("tmp=; Max-Age=0"));
        check("Max-Age=0 deletes", cs.cookieHeader(a1, site).indexOf("tmp=") < 0);
        cs.saveFromResponse(a1, site, Arrays.asList("old=1; Expires=Wed, 21 Oct 2015 07:28:00 GMT"));
        check("past Expires does not store", cs.cookieHeader(a1, site).indexOf("old=") < 0);
        cs.saveFromResponse(a1, site, Arrays.asList("fut=1; Expires=Wed, 21 Oct 2037 07:28:00 GMT"));
        check("future Expires stores (RFC 1123 date parsed)", cs.cookieHeader(a1, site).contains("fut=1"));

        // persistence is minimal
        CookieScope p1 = new CookieScope("ext.p", 7);
        cs.saveFromResponse(p1, site, Arrays.asList("keep=1; Max-Age=86400", "sessiononly=secret"));
        File[] files = dir.listFiles();
        String blob = "";
        for (File f : files) blob += new String(Files.readAllBytes(f.toPath()), UTF8);
        check("persistent cookie is written", blob.contains("keep"));
        check("session cookie is NEVER written to disk", blob.indexOf("sessiononly") < 0 && blob.indexOf("secret") < 0);
        check("files are named by hash, not by extension-controlled text", files.length > 0 && files[0].getName().matches("[0-9a-f]{32}\\.ck"));
        CookieStore reborn = new CookieStore(new FileCookieStorage(dir), clock);
        check("a fresh store (process restart) reloads only the persistent cookie", "keep=1".equals(reborn.cookieHeader(p1, site)));

        // uninstall
        int before = dir.listFiles().length;
        cs.clearExtension("ext.p");
        check("uninstall removes the extension's cookie file", dir.listFiles().length == before - 1);
        check("uninstall clears memory", cs.cookieHeader(p1, site) == null);
        check("uninstall leaves other extensions' cookies alone", cs.cookieHeader(b1, site) != null && cs.cookieHeader(a1, site) != null);
        CookieStore after = new CookieStore(new FileCookieStorage(dir), clock);
        check("uninstalled extension's cookies do not come back after restart", after.cookieHeader(p1, site) == null);
        cs.clearExtension("ext.a");
        check("clearExtension covers every source of the extension", cs.cookieHeader(a1, site) == null && cs.cookieHeader(a2, site) == null);

        // limits
        CookieScope big = new CookieScope("ext.big", 1);
        List<String> many = new ArrayList<String>();
        for (int i = 0; i < 400; i++) many.add("c" + i + "=v; Domain=site.example.org");
        cs.saveFromResponse(big, site, many);
        check("per-domain cookie cap enforced", cs.count(big) <= CookieStore.MAX_PER_DOMAIN);
        StringBuilder huge = new StringBuilder("h=");
        for (int i = 0; i < 5000; i++) huge.append('x');
        cs.saveFromResponse(big, site, Arrays.asList(huge.toString()));
        check("oversize cookie refused", cs.cookieHeader(big, site).indexOf("h=") < 0);

        // engine level: jar is consulted per hop and per scope; explicit Cookie header suppresses the jar
        final FakeDns dns = new FakeDns().on("a.example.org", PUB);
        Scripted t = new Scripted(new Handler() { public Transport.Response handle(Transport.Request r) {
            if (r.url.path().equals("/login")) return redirect(302, "/home", "Set-Cookie", "sid=S1; Path=/; Max-Age=600", "Set-Cookie", "csrf=C1; Path=/");
            return resp(200, "home");
        } });
        BrokerEngine eng = engine(DestinationPolicy.production(dns), t, memJar());
        HttpBroker ea = eng.open("ext.a", 1), eb = eng.open("ext.b", 1);
        ea.execute(get("https://a.example.org/login"), ctx()).close();
        check("Set-Cookie on a REDIRECT hop is stored and sent on the next hop", t.seen.get(1).header("Cookie") != null && t.seen.get(1).header("Cookie").contains("sid=S1") && t.seen.get(1).header("Cookie").contains("csrf=C1"));
        eb.execute(get("https://a.example.org/home"), ctx()).close();
        check("other extension's broker sends none of it", t.seen.get(2).header("Cookie") == null);
        ea.execute(get("https://a.example.org/home", "Cookie", "mine=1"), ctx()).close();
        check("a Cookie header set by the Source itself wins over the jar (OkHttp semantics)", "mine=1".equals(t.seen.get(3).header("Cookie")));
        BrokerResponse dl = eng.download(get("https://a.example.org/home"), ctx(), 1024);
        dl.close();
        check("downloads (APK/repository) use no extension cookies", t.seen.get(4).header("Cookie") == null);
        eng.cookies().clearExtension("ext.a");
        ea.execute(get("https://a.example.org/home"), ctx()).close();
        check("after uninstall the extension starts with an empty jar", t.seen.get(5).header("Cookie") == null);
    }

    // ───────────────────────── 8. real TLS server ─────────────────────────

    static HttpsServer server;
    static int port;
    static SSLContext clientCtx;

    static void realTls() throws Exception {
        File dir = Files.createTempDirectory("mhtls").toFile();
        File p12 = new File(dir, "ks.p12"), crt = new File(dir, "s.crt");
        String keytool = new File(System.getProperty("java.home"), "bin/keytool").getPath();
        run(keytool, "-genkeypair", "-alias", "s", "-keyalg", "RSA", "-keysize", "2048", "-validity", "3", "-dname", "CN=localhost",
            "-ext", "san=dns:localhost,ip:127.0.0.1", "-keystore", p12.getPath(), "-storetype", "PKCS12", "-storepass", "changeit", "-keypass", "changeit");
        run(keytool, "-exportcert", "-alias", "s", "-keystore", p12.getPath(), "-storepass", "changeit", "-file", crt.getPath());
        KeyStore ks = KeyStore.getInstance("PKCS12");
        FileInputStream fis = new FileInputStream(p12); ks.load(fis, "changeit".toCharArray()); fis.close();
        KeyManagerFactory kmf = KeyManagerFactory.getInstance("SunX509"); kmf.init(ks, "changeit".toCharArray());
        SSLContext serverCtx = SSLContext.getInstance("TLS"); serverCtx.init(kmf.getKeyManagers(), null, null);
        clientCtx = trusting(crt);

        server = HttpsServer.create(new InetSocketAddress(InetAddress.getByName("127.0.0.1"), 0), 0);
        server.setHttpsConfigurator(new HttpsConfigurator(serverCtx));
        server.setExecutor(Executors.newCachedThreadPool());
        port = server.getAddress().getPort();
        server.createContext("/", new Routes());
        server.start();
        try { realTlsTests(); } finally { server.stop(0); }
    }

    static SSLContext trusting(File pemOrCrt) throws Exception {
        CertificateFactory cf = CertificateFactory.getInstance("X.509");
        FileInputStream in = new FileInputStream(pemOrCrt);
        Certificate c = cf.generateCertificate(in); in.close();
        KeyStore ts = KeyStore.getInstance(KeyStore.getDefaultType()); ts.load(null, null); ts.setCertificateEntry("ca", c);
        TrustManagerFactory tmf = TrustManagerFactory.getInstance(TrustManagerFactory.getDefaultAlgorithm()); tmf.init(ts);
        SSLContext ctx = SSLContext.getInstance("TLS"); ctx.init(null, tmf.getTrustManagers(), null);
        return ctx;
    }

    static void run(String... cmd) throws Exception {
        Process p = new ProcessBuilder(cmd).redirectErrorStream(true).start();
        ByteArrayOutputStream o = new ByteArrayOutputStream();
        InputStream in = p.getInputStream(); byte[] b = new byte[4096]; int n;
        while ((n = in.read(b)) >= 0) o.write(b, 0, n);
        if (p.waitFor() != 0) throw new IllegalStateException(new String(o.toByteArray(), UTF8));
    }

    static final class Routes implements HttpHandler {
        @Override public void handle(HttpExchange x) throws IOException {
            String p = x.getRequestURI().getPath();
            String q = x.getRequestURI().getRawQuery();
            String self = "https://localhost:" + port;
            byte[] reqBody = readAll(x.getRequestBody());
            if (p.equals("/ok")) { send(x, 200, "hello", "Content-Type", "text/plain"); return; }
            if (p.equals("/missing")) { send(x, 404, "nope", "Content-Type", "text/plain"); return; }
            if (p.equals("/boom")) { send(x, 500, "{\"error\":1}", "Content-Type", "application/json"); return; }
            if (p.equals("/r/a")) { redirect(x, "/r/b"); return; }
            if (p.equals("/r/b")) { redirect(x, "../ok"); return; }
            if (p.equals("/to-loopback")) { redirect(x, "https://127.0.0.1:" + port + "/ok"); return; }
            if (p.equals("/to-private")) { redirect(x, "https://10.0.0.5/x"); return; }
            if (p.equals("/to-file")) { redirect(x, "file:///etc/passwd"); return; }
            if (p.equals("/to-http")) { redirect(x, "http://localhost:" + port + "/ok"); return; }
            if (p.equals("/loop1")) { redirect(x, "/loop2"); return; }
            if (p.equals("/loop2")) { redirect(x, "/loop1"); return; }
            if (p.equals("/login")) { x.getResponseHeaders().add("Set-Cookie", "sid=S1; Path=/; Max-Age=600"); x.getResponseHeaders().add("Set-Cookie", "csrf=C1; Path=/"); redirect(x, "/whoami"); return; }
            if (p.equals("/whoami")) { String c = x.getRequestHeaders().getFirst("Cookie"); send(x, 200, "cookie=" + c, "Content-Type", "text/plain"); return; }
            if (p.equals("/echo")) {
                StringBuilder sb = new StringBuilder(x.getRequestMethod()).append(' ').append(p).append(q == null ? "" : "?" + q).append('\n');
                for (Map.Entry<String, List<String>> h : x.getRequestHeaders().entrySet()) for (String v : h.getValue()) sb.append(h.getKey().toLowerCase()).append(": ").append(v).append('\n');
                sb.append("\nBODY:").append(new String(reqBody, UTF8));
                send(x, 200, sb.toString(), "Content-Type", "text/plain");
                return;
            }
            if (p.equals("/post302")) { redirect(x, "/echo"); return; }
            if (p.equals("/post307")) { x.getResponseHeaders().add("Location", "/echo"); x.sendResponseHeaders(307, -1); x.close(); return; }
            if (p.equals("/gzip")) {
                boolean gz = String.valueOf(x.getRequestHeaders().getFirst("Accept-Encoding")).contains("gzip");
                byte[] plain = "{\"gz\":true,\"pad\":\"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa\"}".getBytes(UTF8);
                if (gz) { ByteArrayOutputStream bo = new ByteArrayOutputStream(); GZIPOutputStream g = new GZIPOutputStream(bo); g.write(plain); g.close(); sendBytes(x, 200, bo.toByteArray(), "Content-Encoding", "gzip", "Content-Type", "application/json"); }
                else sendBytes(x, 200, plain, "Content-Type", "application/json");
                return;
            }
            if (p.equals("/big")) { sendBytes(x, 200, new byte[3 * 1024 * 1024], "Content-Type", "application/octet-stream"); return; }
            if (p.equals("/bigchunked")) {
                x.getResponseHeaders().add("Content-Type", "application/octet-stream"); x.sendResponseHeaders(200, 0);
                OutputStream o = x.getResponseBody(); byte[] blk = new byte[65536];
                try { for (int i = 0; i < 48; i++) o.write(blk); } catch (IOException ignored) { }
                try { o.close(); } catch (IOException ignored) { }
                return;
            }
            if (p.equals("/bomb")) {
                ByteArrayOutputStream bo = new ByteArrayOutputStream(); GZIPOutputStream g = new GZIPOutputStream(bo);
                byte[] blk = new byte[1 << 20]; for (int i = 0; i < 40; i++) g.write(blk); g.close();
                sendBytes(x, 200, bo.toByteArray(), "Content-Encoding", "gzip", "Content-Type", "application/octet-stream");
                return;
            }
            if (p.equals("/slow")) { try { Thread.sleep(4000); } catch (InterruptedException ignored) { } send(x, 200, "late", "Content-Type", "text/plain"); return; }
            if (p.equals("/head")) { x.getResponseHeaders().add("Content-Length", "5"); x.getResponseHeaders().add("X-Present", "yes"); x.sendResponseHeaders(200, -1); x.close(); return; }
            if (p.equals("/204")) { x.sendResponseHeaders(204, -1); x.close(); return; }
            if (p.equals("/multi")) { x.getResponseHeaders().add("X-Multi", "one"); x.getResponseHeaders().add("X-Multi", "two"); send(x, 200, "m", "Content-Type", "text/plain"); return; }
            send(x, 404, "not found: " + p, "Content-Type", "text/plain");
        }
    }

    static byte[] readAll(InputStream in) throws IOException {
        ByteArrayOutputStream b = new ByteArrayOutputStream(); byte[] buf = new byte[4096]; int n;
        while ((n = in.read(buf)) >= 0) b.write(buf, 0, n);
        return b.toByteArray();
    }
    static void redirect(HttpExchange x, String loc) throws IOException { x.getResponseHeaders().add("Location", loc); x.sendResponseHeaders(302, -1); x.close(); }
    static void send(HttpExchange x, int code, String body, String... h) throws IOException { sendBytes(x, code, body.getBytes(UTF8), h); }
    static void sendBytes(HttpExchange x, int code, byte[] body, String... h) throws IOException {
        for (int i = 0; i + 1 < h.length; i += 2) x.getResponseHeaders().add(h[i], h[i + 1]);
        x.sendResponseHeaders(code, body.length);
        OutputStream o = x.getResponseBody(); o.write(body); o.close();
    }

    static void realTlsTests() throws Exception {
        PinnedSocketTransport wire = new PinnedSocketTransport(clientCtx);
        DestinationPolicy pol = DestinationPolicy.builder().requireHttps(true).allowPort(443).protect(DestinationPolicy.DEFAULT_PROTECTED_HOST_SUFFIXES)
            .allowLoopbackHostForTestingOnly("localhost", port).build();
        BrokerEngine.Limits lim = new BrokerEngine.Limits();
        lim.maxResponseBytes = 2L * 1024 * 1024;
        BrokerEngine eng = new BrokerEngine(pol, wire, memJar(), lim);
        final HttpBroker b = eng.open("ext.real", 42);
        final String base = "https://localhost:" + port;

        BrokerResponse r = b.execute(get(base + "/ok"), ctx());
        check("real TLS: 200 + body + content type preserved", r.status == 200 && read(r).equals("hello") && "text/plain".equals(r.contentType));
        check("real TLS: dialled loopback because policy pinned exactly that address", wire.dialled.get(0).startsWith("localhost@127.0.0.1:" + port));
        r = b.execute(get(base + "/missing"), ctx());
        check("HTTP 404 is delivered as 404 with its body (not fabricated 200)", r.status == 404 && read(r).equals("nope"));
        r = b.execute(get(base + "/boom"), ctx());
        check("HTTP 500 is delivered as 500 with its JSON body", r.status == 500 && read(r).contains("error") && "application/json".equals(r.contentType));
        r = b.execute(get(base + "/multi"), ctx());
        int multi = 0; for (String[] h : r.headers) if (h[0].equalsIgnoreCase("X-Multi")) multi++;
        check("repeated response headers stay repeated", multi == 2); r.close();
        r = b.execute(get(base + "/r/a"), ctx());
        check("real redirect chain (relative, then ../) followed; final URL and hops visible", r.status == 200 && r.finalUrl.equals(base + "/ok") && r.priorHops.size() == 2); r.close();

        r = b.execute(req("POST", base + "/echo?x=1", true, "a=1&b=2".getBytes(UTF8), "X-Source", "demo"), ctx());
        String echo = read(r);
        check("POST body, method, query, content-type and custom header reach the server intact",
            echo.startsWith("POST /echo?x=1") && echo.contains("BODY:a=1&b=2") && echo.contains("content-type: application/x-www-form-urlencoded") && echo.contains("x-source: demo"));
        check("engine sent Accept-Encoding: gzip because the Source set none", echo.contains("accept-encoding: gzip"));
        r = b.execute(req("POST", base + "/post302", true, "a=1".getBytes(UTF8)), ctx());
        echo = read(r);
        check("real 302 after POST: second request is a GET with no body", echo.startsWith("GET /echo") && echo.endsWith("BODY:") && r.finalMethod.equals("GET"));
        r = b.execute(req("POST", base + "/post307", true, "a=1".getBytes(UTF8)), ctx());
        check("real 307 after POST is returned to the Source", r.status == 307 && HeaderPolicy.first(r.headers, "Location").equals("/echo")); r.close();

        for (String[] c : new String[][] { { "/to-loopback", "PORT_NOT_ALLOWED" }, { "/to-private", "BLOCKED_ADDRESS" }, { "/to-file", "BLOCKED_SCHEME" }, { "/to-http", "HTTPS_REQUIRED" } }) {
            final String path = c[0], why = c[1];
            expect("real server redirects " + path + " -> refused (" + why + ")", "REDIRECT_BLOCKED", why, new Thrower() { public void run() throws Exception { b.execute(get(base + path), ctx()).close(); } });
        }
        expect("real redirect loop refused", "REDIRECT_LOOP", null, new Thrower() { public void run() throws Exception { b.execute(get(base + "/loop1"), ctx()).close(); } });

        // cookies over the wire
        final HttpBroker other = eng.open("ext.other", 42), sameExtOtherSource = eng.open("ext.real", 43);
        r = b.execute(get(base + "/login"), ctx());
        String who = read(r);
        check("real Set-Cookie on redirect hop returned on the follow-up request", who.contains("sid=S1") && who.contains("csrf=C1"));
        r = b.execute(get(base + "/whoami"), ctx());
        check("cookies persist in this scope for later calls", read(r).contains("sid=S1"));
        r = other.execute(get(base + "/whoami"), ctx());
        check("another extension against the same server gets NO cookie", read(r).equals("cookie=null"));
        r = sameExtOtherSource.execute(get(base + "/whoami"), ctx());
        check("another SOURCE of the same extension gets NO cookie", read(r).equals("cookie=null"));

        // compression
        r = b.execute(get(base + "/gzip"), ctx());
        String decoded = read(r);
        check("gzip decoded transparently", decoded.startsWith("{\"gz\":true"));
        check("Content-Encoding and Content-Length removed after decoding (OkHttp semantics)", HeaderPolicy.first(r.headers, "Content-Encoding") == null && HeaderPolicy.first(r.headers, "Content-Length") == null && r.contentLength == -1);
        r = b.execute(get(base + "/gzip", "Accept-Encoding", "identity"), ctx());
        check("Source-chosen Accept-Encoding disables transparent handling; body and headers are untouched", read(r).startsWith("{\"gz\":true") && HeaderPolicy.first(r.headers, "Content-Encoding") == null);
        r = b.execute(get(base + "/gzip", "Accept-Encoding", "gzip"), ctx());
        byte[] raw = readAllBytes(r);
        check("Source asked for gzip itself -> raw gzip bytes and Content-Encoding header preserved", raw.length > 2 && (raw[0] & 0xff) == 0x1f && (raw[1] & 0xff) == 0x8b && "gzip".equals(HeaderPolicy.first(r.headers, "Content-Encoding")));

        // semantics of bodyless responses
        r = b.execute(req("HEAD", base + "/head", true, null), ctx());
        check("HEAD: status/headers delivered, empty body", r.status == 200 && "yes".equals(HeaderPolicy.first(r.headers, "X-Present")) && readAll(r.body()).length == 0);
        r = b.execute(get(base + "/204"), ctx());
        check("204: no body", r.status == 204 && readAll(r.body()).length == 0);

        // limits
        expect("declared oversize body refused before reading (Content-Length 3MB > 2MB cap)", "RESPONSE_TOO_LARGE", null, new Thrower() { public void run() throws Exception { b.execute(get(base + "/big"), ctx()).close(); } });
        expect("streamed oversize body (chunked, no length) stops at the cap", "RESPONSE_TOO_LARGE", null, new Thrower() { public void run() throws Exception { read(b.execute(get(base + "/bigchunked"), ctx())); } });
        expect("gzip bomb stops at the decoded-size cap", "RESPONSE_TOO_LARGE", null, new Thrower() { public void run() throws Exception { read(b.execute(get(base + "/bomb"), ctx())); } });
        final BrokerRequest tooBig = req("POST", base + "/echo", true, new byte[9 * 1024 * 1024]);
        expect("oversize request body refused", "REQUEST_TOO_LARGE", null, new Thrower() { public void run() throws Exception { b.execute(tooBig, ctx()).close(); } });
        expect("CONNECT/TRACE methods refused", "METHOD_NOT_ALLOWED", null, new Thrower() { public void run() throws Exception { b.execute(req("TRACE", base + "/ok", true, null), ctx()).close(); } });

        // timeout
        final BrokerRequest slow = new BrokerRequest("GET", base + "/slow", Collections.<String[]>emptyList(), null, null, true, 0, 1000, 0);
        long t0 = System.nanoTime();
        // exception SHAPES a transport can raise for the same read timeout must all map to TIMEOUT (a user cancel must not)
        {
            CancelScope live = CancelScope.root();
            check("mapIo: SocketTimeoutException -> TIMEOUT", "TIMEOUT".equals(BrokerEngine.mapIo(new java.net.SocketTimeoutException("Read timed out"), live).code));
            check("mapIo: okio-style InterruptedIOException(\"timeout\") -> TIMEOUT", "TIMEOUT".equals(BrokerEngine.mapIo(new java.io.InterruptedIOException("timeout"), live).code));
            check("mapIo: SSLException(\"Read timed out\") -> TIMEOUT", "TIMEOUT".equals(BrokerEngine.mapIo(new javax.net.ssl.SSLException("Read timed out"), live).code));
            check("mapIo: timeout as the CAUSE of a generic IOException -> TIMEOUT", "TIMEOUT".equals(BrokerEngine.mapIo(new IOException("wrapped", new java.net.SocketTimeoutException("timeout")), live).code));
            check("mapIo: ordinary IOException stays IO_ERROR", "IO_ERROR".equals(BrokerEngine.mapIo(new IOException("boom"), live).code));
            check("mapIo: TLS handshake failure stays TLS_FAILURE", "TLS_FAILURE".equals(BrokerEngine.mapIo(new javax.net.ssl.SSLHandshakeException("bad cert"), live).code));
            CancelScope cancelled = CancelScope.root();
            cancelled.cancel(CancelScope.Reason.CANCELLED);
            check("mapIo: user cancel surfacing as InterruptedIOException stays CANCELLED, not TIMEOUT", "CANCELLED".equals(BrokerEngine.mapIo(new java.io.InterruptedIOException("timeout"), cancelled).code));
        }
        expect("read timeout surfaces as TIMEOUT", "TIMEOUT", null, new Thrower() { public void run() throws Exception { b.execute(slow, ctx()).close(); } });
        check("   ...promptly (clamped read timeout 1s)", (System.nanoTime() - t0) / 1_000_000 < 3500);

        // cancel
        CancelScope sc = CancelScope.root();
        BrokerResponse stream = b.execute(get(base + "/ok"), new RequestContext("old-cancel-1", sc));
        sc.cancel(CancelScope.Reason.CANCELLED);
        try { stream.body().read(); check("cancel stops body reads", false); } catch (BrokerException e) { check("cancel stops body reads", e.code.equals("CANCELLED")); }
        final CancelScope pre = CancelScope.root(); pre.cancel(CancelScope.Reason.CANCELLED);
        expect("cancel before dispatch never touches the wire", "CANCELLED", null, new Thrower() { public void run() throws Exception { int n = wire.dialled.size(); try { b.execute(get(base + "/ok"), new RequestContext("old-cancel-2", pre)); } finally { check("   ...no connection was opened", wire.dialled.size() == n); } } });

        // TLS identity: server cert is for localhost; the same server reached under a different NAME must fail verification
        PinnedSocketTransport wire2 = new PinnedSocketTransport(clientCtx);
        FakeDns dns = new FakeDns().on("wrongname.example.org", "127.0.0.1");
        // (production policy would refuse a loopback answer; this checks the TRANSPORT contract by driving it directly)
        try {
            wire2.execute(new Transport.Request("GET", SafeUrl.parse("https://wrongname.example.org:" + port + "/ok"), dns.resolve("wrongname.example.org"),
                Collections.<String[]>emptyList(), null, 3000, 3000, "t-wrongname", CancelSignal.NEVER));
            check("TLS hostname verified against the name, not the pinned IP", false);
        } catch (javax.net.ssl.SSLException e) { check("TLS hostname verified against the name, not the pinned IP", true); }
    }

    static int ctxCounter;
    static synchronized RequestContext ctx() { return new RequestContext("t-" + (++ctxCounter), CancelScope.root()); }

    static byte[] readAllBytes(BrokerResponse r) throws IOException { byte[] b = readAll(r.body()); r.close(); return b; }

    // ───────────────────────── 9. the REAL Stage 2 fixture server ─────────────────────────

    static void realFixture() throws Exception {
        String dir = System.getProperty("fixture.dir");
        if (dir == null) { System.out.println("SKIP: real Stage 2 fixture server (no -Dfixture.dir)"); return; }
        int fport = Integer.getInteger("fixture.port", 8443);
        SSLContext ctx = trusting(new File(dir, "certs/ca.pem"));
        PinnedSocketTransport wire = new PinnedSocketTransport(ctx);
        DestinationPolicy pol = DestinationPolicy.builder().requireHttps(true).allowPort(443).protect(DestinationPolicy.DEFAULT_PROTECTED_HOST_SUFFIXES)
            .allowLoopbackHostForTestingOnly("localhost", fport).build();
        BrokerEngine eng = new BrokerEngine(pol, wire, memJar(), new BrokerEngine.Limits());
        HttpBroker b = eng.open("eu.kanade.tachiyomi.extension.all.mhfixture", 7);
        String base = "https://localhost:" + fport;

        // Exactly the requests FixtureSource issues, with its User-Agent.
        String ua = "MHFixture/1.6.1";
        BrokerResponse r = b.execute(get(base + "/api/search?q=Hive&page=1", "User-Agent", ua), ctx());
        String body = read(r);
        check("Stage 2 fixture: search through the broker -> 200 JSON from the real fixture server", r.status == 200 && body.contains("\"results\"") && body.contains("Hive Alpha") && r.contentType.startsWith("application/json"));
        r = b.execute(get(base + "/api/manga/m1", "User-Agent", ua), ctx());
        check("Stage 2 fixture: manga details", r.status == 200 && read(r).contains("Fixture manga one"));
        r = b.execute(get(base + "/api/manga/m1/chapters", "User-Agent", ua), ctx());
        check("Stage 2 fixture: chapter list", r.status == 200 && read(r).contains("Chapter 3"));
        r = b.execute(get(base + "/api/chapter/m1c1/pages", "User-Agent", ua), ctx());
        check("Stage 2 fixture: page list", r.status == 200 && read(r).contains("/img/m1c1/0.png"));
        r = b.execute(get(base + "/img/m1c1/0.png", "User-Agent", ua), ctx());
        byte[] png = readAllBytes(r);
        check("Stage 2 fixture: image bytes + content type", r.status == 200 && "image/png".equals(r.contentType) && png.length > 20 && png[1] == 'P' && png[2] == 'N' && png[3] == 'G');
        r = b.execute(get(base + "/api/manga/nope", "User-Agent", ua), ctx());
        check("Stage 2 fixture: its own 404 reaches the Source as 404", r.status == 404 && read(r).contains("no manga"));
        r = b.execute(get(base + "/api/search?q=Hive&page=1", "User-Agent", "NotTheFixture/0"), ctx());
        check("Stage 2 fixture rejects other User-Agents (403 delivered faithfully, not masked)", r.status == 403 && read(r).contains("bad user agent"));
        r = b.execute(get(base + "/api/search?q=Hive&page=1"), ctx());
        check("without a Source User-Agent the broker's default is sent (fixture says 403) - the Source's header really is what decides", r.status == 403); r.close();

        r = b.execute(get(base + "/__log", "User-Agent", ua), ctx());
        String log = read(r);
        check("the fixture's own request log shows the Source's User-Agent arrived", log.contains("\"ua\": \"MHFixture/1.6.1\"") && log.contains("/api/search?q=Hive&page=1"));
        check("every dial went to the pinned loopback address the policy validated", !wire.dialled.isEmpty() && wire.dialled.get(0).equals("localhost@127.0.0.1:" + fport) || wire.dialled.get(0).startsWith("localhost@"));

        // the production policy would never have allowed this destination
        try { DestinationPolicy.production().check(base + "/api/search"); check("production policy refuses the fixture's localhost:8443", false); }
        catch (PolicyViolation v) { check("production policy refuses the fixture's localhost:8443 (" + v.reason + ") - only the explicit test relaxation lets it through", true); }
    }
}
