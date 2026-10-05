package app.mangahive.mihon.net;

import java.util.ArrayList;
import java.util.HashSet;
import java.util.List;
import java.util.Locale;
import java.util.Set;

/**
 * What an extension may put on a request.
 *
 *  - CONTROLLED: framing/connection headers the transport owns (Host, Content-Length, ...). Silently dropped, exactly
 *    what OkHttp's BridgeInterceptor does by overwriting them anyway.
 *  - PRIVILEGED: names that identify MangaHive or its backend (x-mangahive-*, x-mh-*, x-supabase-*, sb-*, x-client-info,
 *    apikey-style Supabase headers are only dangerous toward MangaHive's own hosts, which the destination policy refuses,
 *    but the explicit MangaHive/Supabase prefixes are refused everywhere). A request that sets one FAILS (a deliberate
 *    attempt must be visible, not quietly repaired).
 *  - Everything else passes, after syntax validation (no CR/LF/NUL, token names, size caps).
 *
 * The broker itself never ADDS credentials: there is no code path from MangaHive's session, Supabase keys, refresh tokens
 * or the WebView's cookie store into a brokered request.
 */
public final class HeaderPolicy {
    private HeaderPolicy() {}

    public static final int MAX_HEADERS = 96;
    public static final int MAX_HEADER_BYTES = 32 * 1024;

    private static final Set<String> CONTROLLED = new HashSet<String>(java.util.Arrays.asList(
        "host", "content-length", "transfer-encoding", "connection", "keep-alive", "upgrade", "te", "trailer",
        "proxy-connection", "proxy-authorization", "proxy-authenticate", "expect", "http2-settings", "cookie2"));

    private static final String[] PRIVILEGED_PREFIXES = { "x-mangahive-", "x-mh-", "x-supabase-", "sb-", "x-mangahive", "x-mh" };
    private static final Set<String> PRIVILEGED_EXACT = new HashSet<String>(java.util.Arrays.asList(
        "x-client-info", "x-mangahive", "x-mh"));

    public static final class Result {
        public final List<String[]> headers;
        public Result(List<String[]> h) { this.headers = h; }
    }

    public static Result sanitize(List<String[]> in) throws PolicyViolation {
        if (in.size() > MAX_HEADERS) throw new PolicyViolation("HEADER_REJECTED", "too many headers");
        List<String[]> out = new ArrayList<String[]>();
        int bytes = 0;
        for (String[] h : in) {
            String name = h[0], value = h[1];
            if (name == null || value == null || name.isEmpty()) throw new PolicyViolation("HEADER_REJECTED", "empty header");
            if (!isToken(name)) throw new PolicyViolation("HEADER_REJECTED", "invalid header name");
            for (int i = 0; i < value.length(); i++) {
                char c = value.charAt(i);
                if (c == '\r' || c == '\n' || c == 0) throw new PolicyViolation("HEADER_REJECTED", "control character in value of " + name);
            }
            bytes += name.length() + value.length() + 4;
            if (bytes > MAX_HEADER_BYTES) throw new PolicyViolation("HEADER_REJECTED", "headers too large");
            String lower = name.toLowerCase(Locale.ROOT);
            if (isPrivileged(lower)) throw new PolicyViolation("PRIVILEGED_HEADER", lower);
            if (CONTROLLED.contains(lower)) continue;
            out.add(new String[] { name, value });
        }
        return new Result(out);
    }

    public static boolean isPrivileged(String lowerName) {
        if (PRIVILEGED_EXACT.contains(lowerName)) return true;
        for (String p : PRIVILEGED_PREFIXES) if (lowerName.startsWith(p)) return true;
        return false;
    }

    static boolean isToken(String s) {
        for (int i = 0; i < s.length(); i++) {
            char c = s.charAt(i);
            boolean ok = (c >= 'a' && c <= 'z') || (c >= 'A' && c <= 'Z') || (c >= '0' && c <= '9') || "!#$%&'*+-.^_`|~".indexOf(c) >= 0;
            if (!ok) return false;
        }
        return true;
    }

    public static String first(List<String[]> h, String name) {
        for (String[] e : h) if (e[0].equalsIgnoreCase(name)) return e[1];
        return null;
    }

    public static boolean has(List<String[]> h, String name) { return first(h, name) != null; }

    public static List<String[]> without(List<String[]> h, String... names) {
        List<String[]> out = new ArrayList<String[]>();
        outer:
        for (String[] e : h) {
            for (String n : names) if (e[0].equalsIgnoreCase(n)) continue outer;
            out.add(e);
        }
        return out;
    }
}
