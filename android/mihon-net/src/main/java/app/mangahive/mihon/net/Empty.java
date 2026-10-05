package app.mangahive.mihon.net;

import java.io.InputStream;

/** Body of a HEAD/204/304/1xx response. */
final class Empty extends InputStream {
    @Override public int read() { return -1; }
}
