package app.mangahive.mihon.net;

import app.mangahive.mihon.spi.*;
import java.util.*;
import java.util.concurrent.*;

/** JVM tests for the host-bound identity of Source network use (Stage 6.5). */
public final class IdentityScopeSelfTest {
    static int passed, failed;
    static void check(String name, boolean ok) { if (ok) { passed++; System.out.println("PASS: " + name); } else { failed++; System.out.println("FAIL: " + name); } }

    static final class Rec implements HttpBrokerHost {
        final List<String> opens = Collections.synchronizedList(new ArrayList<String>());
        final List<String> calls = Collections.synchronizedList(new ArrayList<String>());
        @Override public HttpBroker open(final String ext, final long src) {
            opens.add(ext + "/" + src);
            return new HttpBroker() {
                @Override public BrokerResponse execute(BrokerRequest r, RequestContext ctx) { calls.add(ext + "/" + src + "/" + ctx.requestId); return null; }
            };
        }
    }
    static BrokerRequest req() { return new BrokerRequest("GET", "https://example.test/x", Collections.<String[]>emptyList(), null, null, true, 0, 0, 0); }
    static RequestContext rc(String id) { return new RequestContext(id, CancelScope.root()); }
    static String code(Callable<?> c) { try { c.call(); return "none"; } catch (BrokerException e) { return e.code; } catch (Exception e) { return "other:" + e; } }

    public static void main(String[] a) throws Exception {
        final Rec host = new Rec();

        // 1. construction-time client binds the extension; source + request come from the call
        String extA = HostIdentityScope.construction("extA", new Callable<String>() { public String call() throws Exception { return HostIdentityScope.extensionIdForNewClient(); } });
        check("construction scope: client for the extension being loaded is bound to it", "extA".equals(extA));
        check("no scope at all: no client can be obtained (fail closed)", "NO_IDENTITY".equals(code(new Callable<Object>() { public Object call() throws Exception { return HostIdentityScope.extensionIdForNewClient(); } })));
        check("construction scope does not leak after it ends", HostIdentityScope.currentCall() == null && "NO_IDENTITY".equals(code(new Callable<Object>() { public Object call() throws Exception { return HostIdentityScope.extensionIdForNewClient(); } })));

        final HostIdentityScope.ScopedBroker bA = new HostIdentityScope.ScopedBroker("extA", host);
        check("HTTP with no host-established call is refused", "NO_REQUEST_CONTEXT".equals(code(new Callable<Object>() { public Object call() throws Exception { return bA.execute(req(), rc("r0")); } })));
        check("   ...and nothing was opened for it", host.opens.isEmpty());

        // 2. call scope supplies source id + request id; extension id comes from the binding
        HostIdentityScope.call(new HostIdentityScope.Call("extA", 11L, rc("req-1")), new Callable<Object>() { public Object call() throws Exception { bA.execute(req(), rc("req-1")); return null; } });
        HostIdentityScope.call(new HostIdentityScope.Call("extA", 22L, rc("req-2")), new Callable<Object>() { public Object call() throws Exception { bA.execute(req(), rc("req-2")); return null; } });
        check("source 11 and source 22 of extA get separate identity-bound brokers", host.opens.equals(Arrays.asList("extA/11", "extA/22")));
        check("the request id used is the one the host set for that call", host.calls.equals(Arrays.asList("extA/11/req-1", "extA/22/req-2")));
        HostIdentityScope.call(new HostIdentityScope.Call("extA", 11L, rc("req-3")), new Callable<Object>() { public Object call() throws Exception { bA.execute(req(), rc("req-3")); return null; } });
        check("a source's broker is opened once and reused", host.opens.size() == 2);

        // 3. a client of extension A cannot be used under extension B's call (or vice versa)
        final HostIdentityScope.ScopedBroker bB = new HostIdentityScope.ScopedBroker("extB", host);
        String mism = HostIdentityScope.call(new HostIdentityScope.Call("extB", 11L, rc("req-4")), new Callable<String>() { public String call() { return code(new Callable<Object>() { public Object call() throws Exception { return bA.execute(req(), rc("req-4")); } }); } });
        check("extA's client under extB's call -> IDENTITY_MISMATCH", "IDENTITY_MISMATCH".equals(mism));
        check("   ...extB never got a broker for it", !host.opens.contains("extB/11"));
        HostIdentityScope.call(new HostIdentityScope.Call("extB", 11L, rc("req-5")), new Callable<Object>() { public Object call() throws Exception { bB.execute(req(), rc("req-5")); return null; } });
        check("same source id in a different extension is a different broker (extB/11 != extA/11)", host.opens.contains("extB/11") && host.opens.indexOf("extB/11") == 2);

        // 4. scopes nest and restore
        HostIdentityScope.call(new HostIdentityScope.Call("extA", 1L, rc("outer")), new Callable<Object>() { public Object call() throws Exception {
            HostIdentityScope.call(new HostIdentityScope.Call("extA", 2L, rc("inner")), new Callable<Object>() { public Object call() { return null; } });
            check("after a nested call the outer identity is current again", HostIdentityScope.currentCall().sourceId == 1L && "outer".equals(HostIdentityScope.currentCall().request.requestId));
            return null; } });
        check("after the outermost call nothing is current", HostIdentityScope.currentCall() == null);
        try { HostIdentityScope.call(new HostIdentityScope.Call("extA", 1L, rc("boom")), new Callable<Object>() { public Object call() { throw new IllegalStateException("x"); } }); } catch (IllegalStateException expected) { }
        check("an exception inside a call still restores the scope", HostIdentityScope.currentCall() == null);

        // 5. another thread does not inherit the identity unless the host re-installs it (an extension-made thread is unattributed)
        final String[] other = new String[1];
        HostIdentityScope.call(new HostIdentityScope.Call("extA", 11L, rc("req-6")), new Callable<Object>() { public Object call() throws Exception {
            Thread t = new Thread(new Runnable() { public void run() { other[0] = code(new Callable<Object>() { public Object call() throws Exception { return bA.execute(req(), rc("req-6")); } }); } });
            t.start(); t.join(); return null; } });
        check("a thread the extension starts itself has no identity -> refused", "NO_REQUEST_CONTEXT".equals(other[0]));
        final HostIdentityScope.Call c7 = new HostIdentityScope.Call("extA", 11L, rc("req-7"));
        final String[] hop = new String[1];
        Thread t = new Thread(new Runnable() { public void run() { HostIdentityScope.Call p = HostIdentityScope.enter(c7); try { hop[0] = code(new Callable<Object>() { public Object call() throws Exception { return bA.execute(req(), rc("req-7")); } }); } finally { HostIdentityScope.leave(p); } } });
        t.start(); t.join();
        check("a host-managed hop (enter/leave) carries the identity", "none".equals(hop[0]) && host.calls.contains("extA/11/req-7"));

        // 6. identity is not a function of anything the request carries
        final BrokerRequest sneaky = new BrokerRequest("GET", "https://example.test/x", Collections.singletonList(new String[]{"X-Extension-Id", "extB"}), null, null, true, 0, 0, 0);
        HostIdentityScope.call(new HostIdentityScope.Call("extA", 33L, rc("req-8")), new Callable<Object>() { public Object call() throws Exception { bA.execute(sneaky, rc("req-8")); return null; } });
        check("an extension-chosen header naming another extension changes nothing (still extA/33)", host.calls.contains("extA/33/req-8") && !host.opens.contains("extB/33"));
        boolean badCtor = false; try { new HostIdentityScope.ScopedBroker("", host); } catch (IllegalArgumentException e) { badCtor = true; }
        check("a client cannot be created without an extension id", badCtor);

        System.out.println("\n" + passed + " passed, " + failed + " failed");
        System.exit(failed == 0 ? 0 : 1);
    }
}
