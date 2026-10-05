# Mihon Runtime

MangaHive targets the pinned Mihon/tachiyomix compatibility surface already established in Stage 6.6A.

Supported executable sources use the real `Source` / `HttpSource` API exposed by the pinned compat runtime. Entry classes are inspected before loading and are restricted to the extension package tree.

Network access is supplied through MangaHive's host broker. The extension does not receive direct access to Supabase clients, auth tokens, application storage, or the WebView.

Native installation is Android-only. The PWA displays metadata/repository information on web but does not execute APKs.
