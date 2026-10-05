package app.mangahive.mihon.spi;

/** Handle for a registered hook/timer. {@link #close()} is idempotent, never throws, and removes the hook (no stale callbacks). */
public interface Registration extends java.io.Closeable {
    @Override void close();
    Registration NONE = new Registration() { @Override public void close() { } };
}
