# Offline Storage

Explicit downloads are separated from transient source/page cache.

The PWA stores download jobs, manifests, staging data, and completed chapter blobs in the versioned IndexedDB download database.

The native Android implementation stores downloads beneath a root-confined directory whose chapter path is derived from SHA-256 of the complete download identity. Titles, URLs, remote IDs, and user-controlled strings never become raw path components.
