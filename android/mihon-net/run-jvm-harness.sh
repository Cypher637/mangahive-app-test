#!/bin/sh
# Stage 5 + Stage 6 JVM harness. Needs a JDK 11+ (javac or the jdk.compiler module) and python3 for the real Stage 2 fixture server.
# Usage: run-jvm-harness.sh [path/to/mihon-test-extension]   (fixture part is skipped when the path is omitted)
set -e
cd "$(dirname "$0")/.."
OUT=$(mktemp -d)
JAVAC="javac"; command -v javac >/dev/null 2>&1 || JAVAC="java -m jdk.compiler/com.sun.tools.javac.Main"
$JAVAC -source 8 -target 8 -Xlint:-options,-serial -d "$OUT" mihon-spi/src/main/java/app/mangahive/mihon/spi/*.java \
  mihon-net/src/main/java/app/mangahive/mihon/net/*.java mihon-net/src/test/java/app/mangahive/mihon/net/*.java
if [ -n "$1" ]; then
  (cd "$1/server" && PORT=8443 python3 fixture_server.py >/dev/null 2>&1 & echo $! > "$OUT/pid"); sleep 2
  java -Dfixture.dir="$1/server" -Dfixture.port=8443 -cp "$OUT" app.mangahive.mihon.net.NetSelfTest; rc=$?
  kill "$(cat "$OUT/pid")" 2>/dev/null || true
  [ $rc -eq 0 ] || exit $rc
else
  java -cp "$OUT" app.mangahive.mihon.net.NetSelfTest || exit $?
fi
# Stage 6: streaming limits, real cancellation, timeouts, rate/concurrency limits, job registry (scripted real-TLS server)
java -cp "$OUT" app.mangahive.mihon.net.Stage6SelfTest
# Stage 6.5: host-bound identity (extensionId/sourceId/requestId) for Source network use
java -cp "$OUT" app.mangahive.mihon.net.IdentityScopeSelfTest
