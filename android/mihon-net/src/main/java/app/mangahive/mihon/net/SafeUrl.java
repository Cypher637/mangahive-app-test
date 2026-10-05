package app.mangahive.mihon.net;

import java.util.ArrayList;
import java.util.List;
import java.util.Locale;

/**
 * Strict absolute http(s) URL parser. Deliberately NOT java.net.URI/URL: those accept inputs (backslashes, userinfo
 * confusion, decimal/octal/hex IPv4 forms, zone ids, odd percent-escapes) that different layers read differently,
 * which is how SSRF filters get bypassed. Anything ambiguous is rejected, not "fixed up".
 *
 * Accepts only: ASCII, scheme http/https, no userinfo, host = DNS name | dotted-quad | bracketed IPv6, port 1..65535.
 */
public final class SafeUrl {
    public final String scheme;
    /** Lowercase; IPv6 without brackets; no trailing dot. */
    public final String host;
    /** Non-null when {@link #host} is an IP literal (already parsed, never sent to DNS). */
    public final byte[] ipLiteral;
    public final int port;
    /** Path + query, starts with '/', fragment removed. */
    public final String pathAndQuery;

    private SafeUrl(String scheme, String host, byte[] ip, int port, String pq) {
        this.scheme = scheme; this.host = host; this.ipLiteral = ip; this.port = port; this.pathAndQuery = pq;
    }

    public boolean isHttps() { return "https".equals(scheme); }
    public int defaultPort() { return isHttps() ? 443 : 80; }
    public String path() { int q = pathAndQuery.indexOf('?'); return q < 0 ? pathAndQuery : pathAndQuery.substring(0, q); }

    /** "host" or "[v6]" with ":port" only if non-default. */
    public String authority() {
        String h = ipLiteral != null && ipLiteral.length == 16 ? "[" + host + "]" : host;
        return port == defaultPort() ? h : h + ":" + port;
    }

    @Override public String toString() { return scheme + "://" + authority() + pathAndQuery; }

    public boolean sameOrigin(SafeUrl o) { return scheme.equals(o.scheme) && host.equals(o.host) && port == o.port; }

    // ───────────────────────────── parsing ─────────────────────────────

    public static SafeUrl parse(String url) throws PolicyViolation {
        if (url == null || url.isEmpty()) throw new PolicyViolation("MALFORMED_URL", "empty");
        if (url.length() > 8192) throw new PolicyViolation("MALFORMED_URL", "too long");
        for (int i = 0; i < url.length(); i++) {
            char c = url.charAt(i);
            if (c <= 0x20 || c >= 0x7f) throw new PolicyViolation("MALFORMED_URL", "control, space or non-ASCII character");
            if (c == '\\') throw new PolicyViolation("MALFORMED_URL", "backslash");
        }
        int colon = url.indexOf(':');
        if (colon <= 0) throw new PolicyViolation("MALFORMED_URL", "no scheme");
        String scheme = url.substring(0, colon).toLowerCase(Locale.ROOT);
        for (int i = 0; i < scheme.length(); i++) {
            char c = scheme.charAt(i);
            boolean ok = (c >= 'a' && c <= 'z') || (i > 0 && ((c >= '0' && c <= '9') || c == '+' || c == '-' || c == '.'));
            if (!ok) throw new PolicyViolation("MALFORMED_URL", "bad scheme");
        }
        if (!scheme.equals("http") && !scheme.equals("https")) throw new PolicyViolation("BLOCKED_SCHEME", scheme);
        if (!url.startsWith("//", colon + 1)) throw new PolicyViolation("MALFORMED_URL", "missing //");

        int authStart = colon + 3;
        int authEnd = url.length();
        for (int i = authStart; i < url.length(); i++) {
            char c = url.charAt(i);
            if (c == '/' || c == '?' || c == '#') { authEnd = i; break; }
        }
        String authority = url.substring(authStart, authEnd);
        String rest = url.substring(authEnd);
        int hash = rest.indexOf('#');
        if (hash >= 0) rest = rest.substring(0, hash);
        String pq = rest.isEmpty() ? "/" : (rest.charAt(0) == '?' ? "/" + rest : rest);

        if (authority.isEmpty()) throw new PolicyViolation("MISSING_HOST", "");
        if (authority.indexOf('@') >= 0) throw new PolicyViolation("USERINFO_NOT_ALLOWED", "");
        if (authority.indexOf('%') >= 0) throw new PolicyViolation("MALFORMED_URL", "percent-escape in authority");

        String hostPart;
        String portPart = null;
        if (authority.charAt(0) == '[') {
            int close = authority.indexOf(']');
            if (close < 0) throw new PolicyViolation("MALFORMED_URL", "unterminated IPv6 literal");
            hostPart = authority.substring(1, close);
            String after = authority.substring(close + 1);
            if (!after.isEmpty()) {
                if (after.charAt(0) != ':') throw new PolicyViolation("MALFORMED_URL", "junk after IPv6 literal");
                portPart = after.substring(1);
            }
            byte[] v6 = parseIpv6(hostPart);
            if (v6 == null) throw new PolicyViolation("MALFORMED_URL", "bad IPv6 literal");
            return new SafeUrl(scheme, canonicalV6(v6), v6, parsePort(portPart, scheme), pq);
        }
        int pc = authority.lastIndexOf(':');
        if (pc >= 0) { hostPart = authority.substring(0, pc); portPart = authority.substring(pc + 1); }
        else hostPart = authority;
        if (hostPart.indexOf(':') >= 0) throw new PolicyViolation("MALFORMED_URL", "unbracketed colon in host");
        if (hostPart.isEmpty()) throw new PolicyViolation("MISSING_HOST", "");
        String host = hostPart.toLowerCase(Locale.ROOT);
        if (host.endsWith(".")) host = host.substring(0, host.length() - 1);   // "localhost." == "localhost"
        if (host.isEmpty() || host.length() > 253) throw new PolicyViolation("MALFORMED_URL", "bad host length");
        List<String> labels = split(host);
        for (String l : labels) {
            if (l.isEmpty() || l.length() > 63) throw new PolicyViolation("MALFORMED_URL", "bad host label");
            for (int i = 0; i < l.length(); i++) {
                char c = l.charAt(i);
                boolean ok = (c >= 'a' && c <= 'z') || (c >= '0' && c <= '9') || c == '-' || c == '_';
                if (!ok) throw new PolicyViolation("MALFORMED_URL", "bad host character");
            }
        }
        // WHATWG "ends in a number": every spelling that a lenient resolver (inet_aton) would read as an IPv4 address
        // (127.1, 2130706433, 0x7f.0.0.1, 0177.0.0.1) must be rejected, because a different layer may read it differently.
        if (endsInNumber(labels)) {
            byte[] v4 = parseStrictIpv4(labels);
            if (v4 == null) throw new PolicyViolation("AMBIGUOUS_IP_LITERAL", host);
            return new SafeUrl(scheme, host, v4, parsePort(portPart, scheme), pq);
        }
        return new SafeUrl(scheme, host, null, parsePort(portPart, scheme), pq);
    }

    private static List<String> split(String host) {
        List<String> out = new ArrayList<String>();
        int s = 0;
        for (int i = 0; i <= host.length(); i++) {
            if (i == host.length() || host.charAt(i) == '.') { out.add(host.substring(s, i)); s = i + 1; }
        }
        return out;
    }

    private static boolean endsInNumber(List<String> labels) {
        String last = labels.get(labels.size() - 1);
        if (last.isEmpty()) return false;
        boolean digits = true;
        for (int i = 0; i < last.length(); i++) if (last.charAt(i) < '0' || last.charAt(i) > '9') { digits = false; break; }
        if (digits) return true;
        if (last.length() >= 2 && last.charAt(0) == '0' && last.charAt(1) == 'x') {
            for (int i = 2; i < last.length(); i++) if (Character.digit(last.charAt(i), 16) < 0) return false;
            return true;
        }
        return false;
    }

    private static byte[] parseStrictIpv4(List<String> parts) {
        if (parts.size() != 4) return null;
        byte[] out = new byte[4];
        for (int i = 0; i < 4; i++) {
            String p = parts.get(i);
            if (p.isEmpty() || p.length() > 3) return null;
            if (p.length() > 1 && p.charAt(0) == '0') return null;           // leading zero = octal ambiguity
            int v = 0;
            for (int k = 0; k < p.length(); k++) {
                char c = p.charAt(k);
                if (c < '0' || c > '9') return null;
                v = v * 10 + (c - '0');
            }
            if (v > 255) return null;
            out[i] = (byte) v;
        }
        return out;
    }

    private static int parsePort(String p, String scheme) throws PolicyViolation {
        if (p == null || p.isEmpty()) return scheme.equals("https") ? 443 : 80;
        if (p.length() > 5) throw new PolicyViolation("MALFORMED_URL", "bad port");
        int v = 0;
        for (int i = 0; i < p.length(); i++) {
            char c = p.charAt(i);
            if (c < '0' || c > '9') throw new PolicyViolation("MALFORMED_URL", "bad port");
            v = v * 10 + (c - '0');
        }
        if (v < 1 || v > 65535) throw new PolicyViolation("MALFORMED_URL", "port out of range");
        return v;
    }

    /** Strict RFC 4291 text parser: no zone id, no DNS, optional dotted-quad tail. Returns null if malformed. */
    static byte[] parseIpv6(String s) {
        if (s.isEmpty() || s.indexOf('%') >= 0) return null;
        int dbl = s.indexOf("::");
        if (dbl >= 0 && s.indexOf("::", dbl + 1) >= 0) return null;
        String head = dbl >= 0 ? s.substring(0, dbl) : s;
        String tail = dbl >= 0 ? s.substring(dbl + 2) : "";
        List<Integer> h = groups(head), t = groups(tail);
        if (h == null || t == null) return null;
        int total = h.size() + t.size();
        if (dbl < 0 && total != 8) return null;
        if (dbl >= 0 && total > 7) return null;
        int[] g = new int[8];
        for (int i = 0; i < h.size(); i++) g[i] = h.get(i);
        for (int i = 0; i < t.size(); i++) g[8 - t.size() + i] = t.get(i);
        byte[] out = new byte[16];
        for (int i = 0; i < 8; i++) { out[2 * i] = (byte) (g[i] >> 8); out[2 * i + 1] = (byte) g[i]; }
        return out;
    }

    private static List<Integer> groups(String part) {
        List<Integer> out = new ArrayList<Integer>();
        if (part.isEmpty()) return out;
        String[] items = part.split(":", -1);
        for (int i = 0; i < items.length; i++) {
            String it = items[i];
            if (it.isEmpty()) return null;
            if (it.indexOf('.') >= 0) {
                if (i != items.length - 1) return null;
                byte[] v4 = parseStrictIpv4(split(it));
                if (v4 == null) return null;
                out.add(((v4[0] & 0xff) << 8) | (v4[1] & 0xff));
                out.add(((v4[2] & 0xff) << 8) | (v4[3] & 0xff));
            } else {
                if (it.length() > 4) return null;
                int v = 0;
                for (int k = 0; k < it.length(); k++) {
                    int d = Character.digit(it.charAt(k), 16);
                    if (d < 0) return null;
                    v = v * 16 + d;
                }
                out.add(v);
            }
        }
        return out;
    }

    private static String canonicalV6(byte[] b) {
        StringBuilder sb = new StringBuilder();
        for (int i = 0; i < 8; i++) {
            if (i > 0) sb.append(':');
            sb.append(Integer.toHexString(((b[2 * i] & 0xff) << 8) | (b[2 * i + 1] & 0xff)));
        }
        return sb.toString();
    }

    // ───────────────────────────── redirect resolution ─────────────────────────────

    /**
     * Resolves a Location header value against the URL that produced it (RFC 3986 §5.2) and re-parses the result with the
     * strict parser, so a redirect target gets exactly the same scrutiny as a first request.
     */
    public static SafeUrl resolve(SafeUrl base, String location) throws PolicyViolation {
        if (location == null) throw new PolicyViolation("MALFORMED_URL", "no location");
        String loc = location.trim();
        if (loc.isEmpty()) throw new PolicyViolation("MALFORMED_URL", "empty location");
        loc = encodeUnsafe(loc);
        if (loc.indexOf('\\') >= 0) throw new PolicyViolation("MALFORMED_URL", "backslash in location");
        int c = loc.indexOf(':');
        int firstSlash = indexOfAny(loc, "/?#");
        boolean hasScheme = c > 0 && (firstSlash < 0 || c < firstSlash);
        if (hasScheme) return parse(loc);                                    // absolute (scheme checked by parse)
        if (loc.startsWith("//")) return parse(base.scheme + ":" + loc);     // scheme-relative
        String origin = base.scheme + "://" + base.authority();
        int hash = loc.indexOf('#');
        if (hash >= 0) loc = loc.substring(0, hash);
        if (loc.isEmpty()) return parse(origin + base.pathAndQuery);
        if (loc.charAt(0) == '/') return parse(origin + removeDotSegments(loc));
        if (loc.charAt(0) == '?') return parse(origin + base.path() + loc);
        String basePath = base.path();
        String merged = basePath.substring(0, basePath.lastIndexOf('/') + 1) + loc;
        return parse(origin + removeDotSegments(merged));
    }

    private static int indexOfAny(String s, String chars) {
        for (int i = 0; i < s.length(); i++) if (chars.indexOf(s.charAt(i)) >= 0) return i;
        return -1;
    }

    /** Servers do send raw spaces / UTF-8 in Location. Encode them (never decode anything). */
    private static String encodeUnsafe(String s) {
        StringBuilder sb = null;
        byte[] utf8 = s.getBytes(java.nio.charset.Charset.forName("UTF-8"));
        for (int i = 0; i < utf8.length; i++) {
            int b = utf8[i] & 0xff;
            boolean bad = b <= 0x20 || b >= 0x7f || b == '"' || b == '<' || b == '>' || b == '`' || b == '{' || b == '}' || b == '|';
            if (bad) {
                if (sb == null) { sb = new StringBuilder(); for (int k = 0; k < i; k++) sb.append((char) (utf8[k] & 0xff)); }
                sb.append('%').append(Character.toUpperCase(Character.forDigit(b >> 4, 16))).append(Character.toUpperCase(Character.forDigit(b & 15, 16)));
            } else if (sb != null) sb.append((char) b);
        }
        return sb == null ? s : sb.toString();
    }

    private static String removeDotSegments(String path) {
        String query = "";
        int q = path.indexOf('?');
        if (q >= 0) { query = path.substring(q); path = path.substring(0, q); }
        List<String> out = new ArrayList<String>();
        String[] segs = path.split("/", -1);
        for (int i = 1; i < segs.length; i++) {
            String s = segs[i];
            boolean last = i == segs.length - 1;
            if (s.equals(".")) { if (last) out.add(""); }
            else if (s.equals("..")) { if (!out.isEmpty()) out.remove(out.size() - 1); if (last) out.add(""); }
            else out.add(s);
        }
        StringBuilder sb = new StringBuilder();
        for (String s : out) sb.append('/').append(s);
        if (sb.length() == 0) sb.append('/');
        return sb + query;
    }
}
