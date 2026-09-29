#!/usr/bin/env bash
# Exactly 10 sequential `pnpm --dir apps/desktop test:native` runs; no reruns.
set -u
ROOT=/e/Projects/supa-video-produzah
OUT=$ROOT/.gg/p2-race
unset TMP_RACE_TIMING_LOG
for i in 1 2 3 4 5 6 7 8 9 10; do
  log=$OUT/fix$i.log
  start=$(date +%s)
  echo "=== fix run $i start $(date -u +%FT%TZ)" > "$log"
  (cd "$ROOT" && pnpm --dir apps/desktop test:native) >> "$log" 2>&1
  code=$?
  echo "=== fix run $i exit $code wall_s $(( $(date +%s) - start )) end $(date -u +%FT%TZ)" >> "$log"
  echo "fix $i exit $code"
done
echo ALL-DONE
