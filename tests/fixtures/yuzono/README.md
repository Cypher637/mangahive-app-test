# yuzono-index.min.json — SYNTHETIC fixture

This is NOT a captured copy of https://raw.githubusercontent.com/yuzono/manga-repo/repo/index.min.json.
It was written without network access, in the same shape (flat array of `{name,pkg,apk,lang,code,version,nsfw}`),
with two shutdown-notice entries, because that is what `mihon_yuzono_repo_test.js` asserts the parser handles.
APK hosts use `example.invalid` so nothing here can be fetched or installed.

To replace it with a real capture (recommended once you have network):
    curl -fsSL https://raw.githubusercontent.com/yuzono/manga-repo/repo/index.min.json -o tests/fixtures/yuzono/yuzono-index.min.json
then record the date and sha256 here, and update the "two notice entries" assertion if the real index differs.
