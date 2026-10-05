package app.mangahive.mihon.spi;

import java.io.IOException;

/**
 * A brokered request failed. Extends IOException so the compat layer can rethrow it as the failure type OkHttp
 * callers already handle. Only a stable {@code code} (UPPER_SNAKE) and a short message cross the boundary.
 */
public class BrokerException extends IOException {
    public final String code;
    public BrokerException(String code, String message) { super(code + ": " + message); this.code = code; }
    public BrokerException(String code, String message, Throwable cause) { super(code + ": " + message, cause); this.code = code; }
}
