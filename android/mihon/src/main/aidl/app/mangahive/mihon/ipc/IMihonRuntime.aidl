package app.mangahive.mihon.ipc;

import app.mangahive.mihon.ipc.IMihonRuntimeCallback;

/**
 * The ONLY Binder surface of the :mihon runtime process.
 *
 * Deliberately two methods and nothing else. Both carry plain Strings, so neither side ever unparcels an
 * attacker-shaped Parcelable/Bundle. The String is a versioned JSON document that is validated field by field by
 * app.mangahive.mihon.ipc.contract.IpcCodec on both ends. There is no method that takes a class or method name.
 */
interface IMihonRuntime {
    /** Wire protocol version this runtime speaks. */
    int protocolVersion();

    /** Asynchronous. The single reply for [requestJson] arrives on [callback].onResponse. */
    oneway void submit(String requestJson, IMihonRuntimeCallback callback);
}
