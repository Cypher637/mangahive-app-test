package app.mangahive.mihon.net;

import java.net.InetAddress;
import java.net.UnknownHostException;
import java.util.ArrayList;
import java.util.Collections;
import java.util.HashMap;
import java.util.HashSet;
import java.util.List;
import java.util.Locale;
import java.util.Map;
import java.util.Set;
import java.util.concurrent.Callable;
import java.util.concurrent.ExecutionException;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import java.util.concurrent.Future;
import java.util.concurrent.ThreadFactory;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.TimeoutException;

/**
 * THE destination policy. One definition, used by every outbound path in the runtime:
 * extension HTTP, repository index downloads, APK downloads and every redirect hop of each.
 * Nothing else in the code base may decide whether a destination is acceptable.
 *
 * check(url) = strict parse -> scheme/https -> port -> hostname rules -> protected hosts -> resolve ONCE ->
 * classify EVERY returned address -> return the validated address list for pinning.
 * If any one address of an answer is not publicly routable the whole answer is refused (an attacker-controlled name
 * that returns {public, 127.0.0.1} must not get to "try the other one").
 */
public final class DestinationPolicy {

    /** Name -> addresses. Injected so tests can simulate rebinding; production uses {@link SystemResolver}. */
    public interface Resolver {
        List<InetAddress> resolve(String host) throws UnknownHostException;
    }

    /** InetAddress.getAllByName with a hard timeout (the JDK call has none). */
    public static final class SystemResolver implements Resolver {
        private static final ExecutorService POOL = Executors.newCachedThreadPool(new ThreadFactory() {
            @Override public Thread newThread(Runnable r) { Thread t = new Thread(r, "mh-dns"); t.setDaemon(true); return t; }
        });
        private final long timeoutMs;
        public SystemResolver(long timeoutMs) { this.timeoutMs = timeoutMs; }
        @Override public List<InetAddress> resolve(final String host) throws UnknownHostException {
            Future<InetAddress[]> f = POOL.submit(new Callable<InetAddress[]>() {
                @Override public InetAddress[] call() throws Exception { return InetAddress.getAllByName(host); }
            });
            try {
                InetAddress[] all = f.get(timeoutMs, TimeUnit.MILLISECONDS);
                List<InetAddress> out = new ArrayList<InetAddress>();
                Collections.addAll(out, all);
                return out;
            } catch (TimeoutException e) {
                f.cancel(true);
                throw new UnknownHostException("dns timeout: " + host);
            } catch (InterruptedException e) {
                Thread.currentThread().interrupt();
                throw new UnknownHostException("dns interrupted: " + host);
            } catch (ExecutionException e) {
                if (e.getCause() instanceof UnknownHostException) throw (UnknownHostException) e.getCause();
                throw new UnknownHostException("dns failure: " + host);
            }
        }
    }

    /** Hosts (exact or any subdomain) that extension traffic may never reach: MangaHive's own backend. */
    public static final List<String> DEFAULT_PROTECTED_HOST_SUFFIXES = Collections.unmodifiableList(java.util.Arrays.asList(
        "supabase.co", "supabase.in", "supabase.net", "supabase.com"));

    private static final String[] UNSAFE_SUFFIXES = {
        "localhost", "local", "localdomain", "internal", "intranet", "lan", "home", "corp", "private", "home.arpa",
        "in-addr.arpa", "ip6.arpa", "onion", "invalid", "test", "example", "invalid",
    };

    private final boolean requireHttps;
    private final Set<Integer> allowedPorts;          // empty = any
    private final List<String> protectedSuffixes;
    private final Resolver resolver;
    private final Map<String, Set<Integer>> testAllowedLoopback;   // host -> ports; EMPTY in production

    private DestinationPolicy(Builder b) {
        this.requireHttps = b.requireHttps;
        this.allowedPorts = Collections.unmodifiableSet(new HashSet<Integer>(b.allowedPorts));
        this.protectedSuffixes = Collections.unmodifiableList(new ArrayList<String>(b.protectedSuffixes));
        this.resolver = b.resolver;
        this.testAllowedLoopback = Collections.unmodifiableMap(new HashMap<String, Set<Integer>>(b.testLoopback));
    }

    /** The production policy: HTTPS only, port 443 only, MangaHive backend protected, system DNS (10 s), NO relaxations. */
    public static DestinationPolicy production() { return production(new SystemResolver(10_000)); }

    public static DestinationPolicy production(Resolver r) {
        return new Builder().requireHttps(true).allowPort(443).protect(DEFAULT_PROTECTED_HOST_SUFFIXES).resolver(r).build();
    }

    public boolean relaxedForTesting() { return !testAllowedLoopback.isEmpty() || !requireHttps; }

    public static Builder builder() { return new Builder(); }

    public static final class Builder {
        private boolean requireHttps = true;
        private final Set<Integer> allowedPorts = new HashSet<Integer>();
        private final List<String> protectedSuffixes = new ArrayList<String>();
        private Resolver resolver = new SystemResolver(10_000);
        private final Map<String, Set<Integer>> testLoopback = new HashMap<String, Set<Integer>>();

        public Builder requireHttps(boolean v) { this.requireHttps = v; return this; }
        public Builder allowPort(int p) { allowedPorts.add(p); return this; }
        public Builder protect(List<String> suffixes) { protectedSuffixes.addAll(suffixes); return this; }
        public Builder resolver(Resolver r) { this.resolver = r; return this; }
        /**
         * TEST ONLY. Lets ONE named host:port resolve to loopback (the Stage 2 fixture serves https://localhost:8443).
         * Production code must never call this; mihon_stage5_network_broker_test.js fails the build if any main-source file
         * other than this one mentions it.
         */
        public Builder allowLoopbackHostForTestingOnly(String host, int port) {
            Set<Integer> s = testLoopback.get(host.toLowerCase(Locale.ROOT));
            if (s == null) { s = new HashSet<Integer>(); testLoopback.put(host.toLowerCase(Locale.ROOT), s); }
            s.add(port);
            return this;
        }
        public DestinationPolicy build() { return new DestinationPolicy(this); }
    }

    /** Full check: syntax, rules, DNS, address classification. */
    public Destination check(String url) throws PolicyViolation {
        return check(SafeUrl.parse(url));
    }

    public Destination check(SafeUrl u) throws PolicyViolation {
        if (requireHttps && !u.isHttps()) throw new PolicyViolation("HTTPS_REQUIRED", u.scheme);
        if (!allowedPorts.isEmpty() && !allowedPorts.contains(u.port) && !testPortAllowed(u)) {
            throw new PolicyViolation("PORT_NOT_ALLOWED", Integer.toString(u.port));
        }
        // Test-only loopback exception: exact host+port, nothing else about the checks changes.
        if (testPortAllowed(u)) {
            try {
                List<InetAddress> addrs = new ArrayList<InetAddress>();
                for (InetAddress a : resolver.resolve(u.host)) if (a.isLoopbackAddress()) addrs.add(a);
                if (addrs.isEmpty()) throw new PolicyViolation("DNS_FAILURE", "test host did not resolve to loopback");
                return new Destination(u, addrs);
            } catch (UnknownHostException e) {
                throw new PolicyViolation("DNS_FAILURE", e.getMessage());
            }
        }
        if (u.ipLiteral != null) {
            String why = AddressClassifier.classify(u.ipLiteral);
            if (why != null) throw new PolicyViolation("BLOCKED_ADDRESS", why);
            try {
                return new Destination(u, Collections.singletonList(InetAddress.getByAddress(u.ipLiteral)));
            } catch (UnknownHostException e) { throw new PolicyViolation("MALFORMED_URL", "bad ip literal"); }
        }
        String host = u.host;
        if (host.indexOf('.') < 0) throw new PolicyViolation("UNSAFE_HOSTNAME", "single-label host");
        for (String s : UNSAFE_SUFFIXES) {
            if (host.equals(s) || host.endsWith("." + s)) throw new PolicyViolation("UNSAFE_HOSTNAME", s);
        }
        for (String p : protectedSuffixes) {
            if (host.equals(p) || host.endsWith("." + p)) throw new PolicyViolation("PROTECTED_HOST", p);
        }
        List<InetAddress> answer;
        try {
            answer = resolver.resolve(host);
        } catch (UnknownHostException e) {
            throw new PolicyViolation("DNS_FAILURE", e.getMessage());
        }
        if (answer == null || answer.isEmpty()) throw new PolicyViolation("DNS_FAILURE", "no addresses");
        if (answer.size() > 16) answer = answer.subList(0, 16);
        for (InetAddress a : answer) {
            String why = AddressClassifier.classify(a);
            if (why != null) throw new PolicyViolation("BLOCKED_ADDRESS", why + " via " + host);
        }
        return new Destination(u, new ArrayList<InetAddress>(answer));
    }

    private boolean testPortAllowed(SafeUrl u) {
        Set<Integer> ports = testAllowedLoopback.get(u.host);
        return ports != null && ports.contains(u.port);
    }

    /**
     * Cheap, DNS-free screen for places that only need a yes/no on a string (e.g. refusing an install request before
     * any work). Same rules as {@link #check}, minus resolution; never use it as the sole gate for a connection.
     */
    public String screen(String url) {
        try {
            SafeUrl u = SafeUrl.parse(url);
            if (requireHttps && !u.isHttps()) return "HTTPS_REQUIRED";
            if (!allowedPorts.isEmpty() && !allowedPorts.contains(u.port) && !testPortAllowed(u)) return "PORT_NOT_ALLOWED";
            if (testPortAllowed(u)) return null;
            if (u.ipLiteral != null) return AddressClassifier.classify(u.ipLiteral) == null ? null : "BLOCKED_ADDRESS";
            if (u.host.indexOf('.') < 0) return "UNSAFE_HOSTNAME";
            for (String s : UNSAFE_SUFFIXES) if (u.host.equals(s) || u.host.endsWith("." + s)) return "UNSAFE_HOSTNAME";
            for (String p : protectedSuffixes) if (u.host.equals(p) || u.host.endsWith("." + p)) return "PROTECTED_HOST";
            return null;
        } catch (PolicyViolation v) {
            return v.reason;
        }
    }
}
