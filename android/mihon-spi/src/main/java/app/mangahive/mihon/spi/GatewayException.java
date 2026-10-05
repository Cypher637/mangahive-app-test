package app.mangahive.mihon.spi;

/** Failure reported across the host/compat boundary. Only a code and a message cross; no foreign types. */
public class GatewayException extends Exception {
    public final String code;
    public GatewayException(String code, String message, Throwable cause) { super(message, cause); this.code = code; }
    public GatewayException(String code, String message) { this(code, message, null); }
}
