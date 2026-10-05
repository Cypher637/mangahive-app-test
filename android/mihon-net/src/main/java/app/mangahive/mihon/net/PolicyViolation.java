package app.mangahive.mihon.net;

/** A destination was refused. {@code reason} is a stable UPPER_SNAKE token; {@code detail} is for logs only. */
public final class PolicyViolation extends Exception {
    public final String reason;
    public final String detail;
    public PolicyViolation(String reason, String detail) {
        super(reason + (detail == null || detail.isEmpty() ? "" : " (" + detail + ")"));
        this.reason = reason;
        this.detail = detail == null ? "" : detail;
    }
}
