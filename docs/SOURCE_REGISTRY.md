# Source Registry

The canonical source key is:

`mihon:<extension-package-id>:<numeric-mihon-source-id>`

The extension package/signers own the source namespace. Two extensions may expose the same numeric Mihon source ID because their stable keys differ.

`MihonSourceRegistry` is process-local executable state. Persistent authority lives in the Stage 7 extension registry: APK path, package, signer set, version, enabled state and discovered source IDs. On runtime startup the valid enabled records are reloaded before Binder requests are served.

The registry never falls back to an unowned adapter when an owned source is disabled.
