package app.mangahive.mihon.spi;

/**
 * Cancellation as seen by anything that blocks: the broker, transports, body streams.
 *
 * Polling alone is NOT cancellation: a thread parked in a socket read never polls. So every signal must also be able
 * to call back ({@link #onCancel}) so the owner of the blocking resource (call, socket, stream) can tear it down from
 * the cancelling thread. {@link CancelScope} is the real implementation; there is deliberately no SAM shortcut.
 */
public interface CancelSignal {
    boolean isCancelled();

    /**
     * Runs {@code abort} exactly once when this signal is cancelled, on the cancelling thread (immediately, on the
     * caller's thread, if it already is). {@code abort} must be quick and must not throw. Close the returned
     * registration when the guarded resource is released.
     */
    Registration onCancel(Runnable abort);

    /** Never cancelled. Hooks are dropped. */
    CancelSignal NEVER = new CancelSignal() {
        @Override public boolean isCancelled() { return false; }
        @Override public Registration onCancel(Runnable abort) { return Registration.NONE; }
    };
}
