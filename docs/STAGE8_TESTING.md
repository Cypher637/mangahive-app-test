# Stage 8 Testing

## JVM/static checks

Run:

- `node stage8_source_runtime_regression_test.js`
- `node source_registry_regression_test.js`
- `node extension_open_platform_regression_test.js`
- `node extension_hardening_regression_test.js`
- `node mihon_compatibility_regression_test.js`
- `node mihon_yuzono_repo_test.js`
- `node mihon_stage4_isolation_test.js`
- `node mihon_stage5_network_broker_test.js`
- `node mihon_stage6_resource_controls_test.js`
- `node production_security_regression_test.js`

## Android verification

When Gradle 8.5 is available, run the existing Stage 7 verification workflow and `:mihon:connectedDebugAndroidTest` on API 34. A real third-party Mihon APK fixture should be installed, loaded, searched, resolved to chapters, and resolved to pages.

Do not mark device-level verification complete when only source inspection or JVM tests ran.

### Stage 8.1 stabilization coverage
The source-runtime regression suite additionally verifies: native page source-ID routing, collision-resistant web source IDs, persistent source cache wiring, persistent health wiring and typed health IPC fields, and Mihon repository update detection/update action.
