# Offline Reader

Reader resolution prefers a completed local download, then the persistent source-data/page cache, then network resolution when online.

When offline, no hidden retry loop is started against a source. If a chapter has no complete local pages, MangaHive reports that the chapter is not available offline.

Downloaded pages remain readable after extension disable/quarantine/uninstall because the reader consumes validated data rather than executing the extension.
