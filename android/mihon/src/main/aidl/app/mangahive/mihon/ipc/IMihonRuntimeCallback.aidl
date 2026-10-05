package app.mangahive.mihon.ipc;

interface IMihonRuntimeCallback {
    oneway void onResponse(String responseJson);
}
