package app.mangahive.mihon.net;

import java.net.Inet4Address;
import java.net.Inet6Address;
import java.net.InetAddress;

/**
 * Decides whether a RESOLVED address may be contacted. Works on raw bytes so it does not depend on how a particular
 * JVM/ART version classifies ranges (java.net.InetAddress.isSiteLocalAddress etc. miss CGNAT, documentation,
 * benchmarking, 6to4/Teredo/NAT64 embeddings, ULA on some versions, and IPv4-compatible IPv6).
 *
 * Allowlist mindset: anything not provably "global unicast, publicly routable" is blocked.
 * Returns null when the address is acceptable, else a short reason token.
 */
public final class AddressClassifier {
    private AddressClassifier() {}

    public static String classify(InetAddress a) {
        if (a instanceof Inet4Address) return classifyV4(a.getAddress());
        if (a instanceof Inet6Address) return classifyV6(a.getAddress());
        return "unknown-family";
    }

    public static String classify(byte[] b) {
        if (b.length == 4) return classifyV4(b);
        if (b.length == 16) return classifyV6(b);
        return "bad-length";
    }

    static String classifyV4(byte[] b) {
        int a = b[0] & 0xff, c = b[1] & 0xff, d = b[2] & 0xff;
        if (a == 0) return "unspecified-this-network";          // 0.0.0.0/8
        if (a == 10) return "private";                           // 10/8
        if (a == 100 && (c & 0xc0) == 64) return "cgnat";        // 100.64/10
        if (a == 127) return "loopback";                         // 127/8
        if (a == 169 && c == 254) return "link-local";           // 169.254/16 (cloud metadata lives here)
        if (a == 172 && (c & 0xf0) == 16) return "private";      // 172.16/12
        if (a == 192 && c == 0 && d == 0) return "reserved-ietf"; // 192.0.0.0/24
        if (a == 192 && c == 0 && d == 2) return "documentation"; // 192.0.2/24
        if (a == 192 && c == 88 && d == 99) return "reserved-6to4-relay"; // 192.88.99/24
        if (a == 192 && c == 168) return "private";              // 192.168/16
        if (a == 198 && (c & 0xfe) == 18) return "benchmarking"; // 198.18/15
        if (a == 198 && c == 51 && d == 100) return "documentation"; // 198.51.100/24
        if (a == 203 && c == 0 && d == 113) return "documentation";  // 203.0.113/24
        if (a >= 224 && a <= 239) return "multicast";            // 224/4
        if (a >= 240) return "reserved";                         // 240/4 incl. 255.255.255.255
        return null;
    }

    static String classifyV6(byte[] b) {
        boolean first80Zero = true;
        for (int i = 0; i < 10; i++) if (b[i] != 0) { first80Zero = false; break; }
        int b10 = b[10] & 0xff, b11 = b[11] & 0xff;
        if (first80Zero) {
            boolean restZero = true;
            for (int i = 10; i < 15; i++) if (b[i] != 0) { restZero = false; break; }
            if (restZero && b[15] == 0) return "unspecified";   // ::
            if (restZero && b[15] == 1) return "loopback";      // ::1
            if (b10 == 0xff && b11 == 0xff) {                    // ::ffff:a.b.c.d (IPv4-mapped)
                String inner = classifyV4(new byte[] { b[12], b[13], b[14], b[15] });
                return inner == null ? "ipv4-mapped-public-blocked" : "ipv4-mapped-" + inner;
                // Even a "public" mapped address is refused: nothing legitimate resolves to ::ffff:x on the open internet,
                // and some stacks route mapped addresses to the IPv4 stack where host rules differ.
            }
            if (b10 == 0 && b11 == 0) {                          // ::a.b.c.d (IPv4-compatible, deprecated)
                return "ipv4-compatible";
            }
        }
        int g0 = ((b[0] & 0xff) << 8) | (b[1] & 0xff);
        int g1 = ((b[2] & 0xff) << 8) | (b[3] & 0xff);
        if (g0 == 0x0064 && g1 == 0xff9b) {                      // 64:ff9b::/96 NAT64 -> embedded v4 decides
            boolean mid = true;
            for (int i = 4; i < 12; i++) if (b[i] != 0) { mid = false; break; }
            if (mid) {
                String inner = classifyV4(new byte[] { b[12], b[13], b[14], b[15] });
                return inner == null ? null : "nat64-" + inner;
            }
            return "nat64-malformed";
        }
        if (g0 == 0x0100 && g1 == 0 && b[4] == 0 && b[5] == 0 && b[6] == 0 && b[7] == 0) return "discard-only"; // 100::/64
        if (g0 == 0x2001 && (g1 & 0xfe00) == 0) return "reserved-ietf";   // 2001::/23 incl. Teredo 2001::/32
        if (g0 == 0x2001 && g1 == 0x0db8) return "documentation";          // 2001:db8::/32
        if (g0 == 0x2002) {                                                // 2002::/16 6to4 -> embedded v4 decides
            String inner = classifyV4(new byte[] { b[2], b[3], b[4], b[5] });
            return inner == null ? null : "6to4-" + inner;
        }
        if (g0 == 0x3fff && (g1 & 0xf000) == 0) return "documentation";   // 3fff::/20
        if (g0 == 0x5f00) return "reserved-srv6";                          // 5f00::/16
        if ((g0 & 0xfe00) == 0xfc00) return "unique-local";                // fc00::/7
        if ((g0 & 0xffc0) == 0xfe80) return "link-local";                  // fe80::/10
        if ((g0 & 0xffc0) == 0xfec0) return "site-local";                  // fec0::/10 (deprecated)
        if ((g0 & 0xff00) == 0xff00) return "multicast";                   // ff00::/8
        // Only 2000::/3 is global unicast today. Everything else is unassigned/reserved.
        if ((g0 & 0xe000) != 0x2000) return "not-global-unicast";
        return null;
    }
}
