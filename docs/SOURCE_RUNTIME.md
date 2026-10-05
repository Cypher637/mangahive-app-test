# Source Runtime

`RuntimeEngine` is the single production execution coordinator.

## Request lifecycle

1. IPC/WebView validates the closed request contract.
2. `RuntimeEngine` checks extension state and lazily/at startup loads the APK through `ExtensionLoader`.
3. `MihonSourceRegistry` resolves `extensionId + sourceId`.
4. `MangaHiveSourceAdapter` invokes only the JDK-typed `SourceGateway`.
5. The gateway executes the real Mihon `Source` through the compat runtime and host broker.
6. JSON-shaped source output is validated and normalized to MangaHive DTOs.

## Failure isolation

Transport/gateway failures are converted to stable IPC error codes. Source health is tracked independently. Cooldown prevents immediate repeated failures from consuming the runtime while still allowing later recovery.

No source error text, stack trace, filesystem path, cookie or credential crosses IPC.
