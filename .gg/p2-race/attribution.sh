#!/usr/bin/env bash
# ABBA interleave: A C C A A C C A. A = pnpm test:native wrapper; C = original direct cargo command.
set -u
ROOT=/e/Projects/supa-video-produzah
OUT=$ROOT/.gg/p2-race
i=0
for mode in A C C A A C C A; do
  i=$((i+1))
  log=$OUT/attr$i-$mode.log
  export TMP_RACE_TIMING_LOG="$(cygpath -w "$OUT/attr$i-$mode.timing.txt")"
  start=$(date +%s)
  echo "=== run $i mode $mode start $(date -u +%FT%TZ)" > "$log"
  if [ "$mode" = A ]; then
    (cd "$ROOT" && pnpm --dir apps/desktop test:native) >> "$log" 2>&1
  else
    (cd "$ROOT/apps/desktop/src-tauri" && cargo test --locked --all-features -- --show-output) >> "$log" 2>&1
  fi
  code=$?
  echo "=== run $i mode $mode exit $code wall_s $(( $(date +%s) - start )) end $(date -u +%FT%TZ)" >> "$log"
  echo "run $i $mode exit $code"
done
echo ALL-DONE
