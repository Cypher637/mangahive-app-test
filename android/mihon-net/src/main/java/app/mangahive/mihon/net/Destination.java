package app.mangahive.mihon.net;

import java.net.InetAddress;
import java.util.Collections;
import java.util.List;

/**
 * A URL that passed the policy, together with the ONLY addresses the transport may connect to. The transport must
 * connect to {@link #addresses} and must not resolve the host again: that is what closes DNS rebinding (the name is
 * resolved once, the answer is validated, and the validated answer is the one that is used).
 */
public final class Destination {
    public final SafeUrl url;
    public final List<InetAddress> addresses;
    Destination(SafeUrl url, List<InetAddress> addresses) {
        this.url = url;
        this.addresses = Collections.unmodifiableList(addresses);
    }
}
