#!/usr/bin/env bash
# Stage 6.6A: diffs MangaHive's host eu.kanade.tachiyomi.* classes against the published tachiyomix 1.6.0 AAR (the ABI
# reference). Every public/protected member of every upstream class must exist in the host class with the same JVM
# signature. Extra host members/classes are listed and must appear in abi-allowlist.txt (with a reason) or the check fails.
# Usage: ./verify-abi.sh   (after ./gradlew :gateway:compileDebugKotlin)
set -euo pipefail
cd "$(dirname "$0")"
VER=$(sed -n 's/^tachiyomix16 = "\([^"]*\)".*/\1/p' gradle/libs.versions.toml)
AAR=$(find ~/.gradle/caches/modules-2 -path "*com.github.mihonapp/tachiyomix/$VER/*" -name "*.aar" | head -1)
HOST=gateway/build/intermediates/built_in_kotlinc/debug/compileDebugKotlin/classes
[ -n "$AAR" ] && [ -d "$HOST/eu" ] || { echo "missing AAR ($VER) or compiled host classes"; exit 2; }
W=$(mktemp -d); trap 'rm -rf "$W"' EXIT
unzip -q -o "$AAR" classes.jar -d "$W" && mkdir -p "$W/up" && unzip -q -o "$W/classes.jar" 'eu/*' -d "$W/up"
sig() { javap -protected -s -cp "$1" "$2" 2>/dev/null | awk '/^ *descriptor:/{print prev" "$2; next} {gsub(/^ +/,""); prev=$0}' | grep -v '^Compiled from' | sort -u; }
fail=0; extra=""
ALLOW=$(grep -v '^#' abi-allowlist.txt 2>/dev/null | cut -d'|' -f1 | sed 's/ *$//' || true)
for f in $(cd "$W/up" && find eu -name '*.class' | sort); do
  c=${f%.class}; c=${c//\//.}
  if [ ! -f "$HOST/$f" ]; then echo "MISSING CLASS  $c"; fail=1; continue; fi
  comm -23 <(sig "$W/up" "$c") <(sig "$HOST" "$c") | sed "s|^|MISSING MEMBER $c :: |" | tee -a "$W/miss"
  while IFS= read -r m; do [ -n "$m" ] && extra+="$c :: $m"$'\n'; done < <(comm -13 <(sig "$W/up" "$c") <(sig "$HOST" "$c"))
done
[ -s "$W/miss" ] && fail=1
for f in $(cd "$HOST" && find eu -name '*.class' | sort); do
  [ -f "$W/up/$f" ] || { c=${f%.class}; extra+="${c//\//.} :: (class not in upstream)"$'\n'; }
done
n=$(cd "$W/up" && find eu -name '*.class' | wc -l)
while IFS= read -r e; do
  [ -z "$e" ] && continue
  if printf '%s\n' "$ALLOW" | grep -qxF -- "$e"; then echo "EXTRA (allowed) $e"; else echo "EXTRA (NOT allowed) $e"; fail=1; fi
done <<< "$extra"
[ $fail = 0 ] && echo "ABI OK: $n upstream classes, every public/protected member present with identical JVM signature" || { echo "ABI MISMATCH"; exit 1; }
