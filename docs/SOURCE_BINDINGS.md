# Source Bindings

Source binding identity is `extensionId + sourceId + remoteId`. Built-in sources use a namespaced `builtin:<source>` owner; installed Mihon sources use their authoritative extension owner.

Bindings are validated before reader page requests and cache use. A binding from one extension/source cannot be substituted for another extension/source merely because the remote ID is equal.
