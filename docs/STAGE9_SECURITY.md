# Phase 9 Security

Security-critical source identity remains extension-aware. Runtime calls continue through the Stage 8 typed bridge and broker. Web code never executes APK code. Cached source data is non-executable data only.

The persistent native cache is source-namespaced and bounded. Extension cleanup removes cache entries using their stored namespace key.
