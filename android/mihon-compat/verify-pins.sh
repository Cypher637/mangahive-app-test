#!/usr/bin/env bash
# Run on a machine WITH network access, JDK 17+, and the Android SDK (platform 37). Produces the evidence that
# the authoring environment could not: tag->commit mapping, resolvability, and artifact checksums.
set -euo pipefail
cd "$(dirname "$0")"

echo "== 1. Upstream tags and the commit each points to (fills MIHON_1_6 / MIHON_1_4 releaseCommit)"
git ls-remote --tags https://github.com/mihonapp/tachiyomix 'refs/tags/*'

echo "== 2. Does JitPack serve coordinate 'com.github.mihonapp:tachiyomix:1.6' (tag is '1.6.0' in CHANGELOG)?"
curl -fsSI "https://jitpack.io/com/github/mihonapp/tachiyomix/1.6/tachiyomix-1.6.pom" | head -1 || echo "NOT RESOLVABLE as 1.6 - try 1.6.0"

echo "== 3. Compile the shapes (this IS the Stage 1 compile gate)"
./gradlew --no-daemon :shapes-1_6:assembleDebug

echo "== 4. Checksums of resolved upstream artifacts (record these in MIHON_API_PROFILES.md)"
find "${GRADLE_USER_HOME:-$HOME/.gradle}/caches/modules-2/files-2.1/com.github.mihonapp" \
     \( -name '*.aar' -o -name '*.jar' -o -name '*.pom' \) -exec sha256sum {} \;
