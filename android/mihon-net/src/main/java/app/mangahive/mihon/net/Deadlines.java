package app.mangahive.mihon.net;

import app.mangahive.mihon.spi.Registration;

import java.util.concurrent.ScheduledFuture;
import java.util.concurrent.ScheduledThreadPoolExecutor;
import java.util.concurrent.ThreadFactory;
import java.util.concurrent.TimeUnit;

/**
 * One daemon timer thread for every deadline in the network core (per HTTP call, per runtime job). A deadline is a
 * callback that CANCELS the work (closes the socket, interrupts the worker); it is not a flag somebody has to poll.
 * Cancelled timers are removed from the queue immediately, so finished work leaves nothing behind.
 */
public final class Deadlines {
    private static final Deadlines SHARED = new Deadlines("mihon-deadlines");
    public static Deadlines shared() { return SHARED; }

    private final ScheduledThreadPoolExecutor timer;

    public Deadlines(final String threadName) {
        timer = new ScheduledThreadPoolExecutor(1, new ThreadFactory() {
            @Override public Thread newThread(Runnable r) { Thread t = new Thread(r, threadName); t.setDaemon(true); return t; }
        });
        timer.setRemoveOnCancelPolicy(true);
    }

    /** Runs {@code action} once after {@code delayMs} unless the returned registration is closed first. */
    public Registration after(long delayMs, final Runnable action) {
        final ScheduledFuture<?> f = timer.schedule(new Runnable() {
            @Override public void run() { try { action.run(); } catch (Throwable ignored) { } }
        }, Math.max(0, delayMs), TimeUnit.MILLISECONDS);
        return new Registration() { @Override public void close() { f.cancel(false); } };
    }

    /** Timers still waiting to fire (tests: 0 once all work finished). */
    public int pending() { return timer.getQueue().size(); }
}
