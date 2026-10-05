# Download Security

Downloaded manga pages are treated strictly as data.

Controls include:

- source-aware download identity
- extension/source ownership metadata
- bounded page count and page size
- image-content validation
- SHA-256 manifest records
- atomic staging/finalization
- root-confined Android paths
- no arbitrary extension filesystem writes
- no service-worker global caching of remote chapter pages
- current content-policy enforcement before offline viewing
- extension removal does not execute or resurrect downloaded APKs
