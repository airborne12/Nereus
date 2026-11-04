#!/usr/bin/env bash
# Load the JSONL files written by `otelgen.py --out-dir` with parallel Stream Loads,
# using the dorisexporter headers, and report rows/s, MB/s and loaded-vs-file row counts.
#
# Usage: bench/load.sh -d <dir> [-H fe_http_host:port] [-j parallel] [-g group_commit_mode] [-D db]
set -euo pipefail

DIR="" HTTP=127.0.0.1:8030 JOBS=8 GROUP_COMMIT="" DB=otel USER_PASS="root:"
while getopts "d:H:j:g:D:u:" opt; do
  case $opt in
    d) DIR=$OPTARG ;; H) HTTP=$OPTARG ;; j) JOBS=$OPTARG ;; g) GROUP_COMMIT=$OPTARG ;;
    D) DB=$OPTARG ;; u) USER_PASS=$OPTARG ;; *) echo "bad option" >&2; exit 2 ;;
  esac
done
[ -n "$DIR" ] || { echo "-d <dir> is required" >&2; exit 2; }

RESULTS=$(mktemp -d)
export HTTP GROUP_COMMIT DB USER_PASS RESULTS

load_one() {
  local f=$1 table hdr=()
  table=$(basename "$f" | cut -d. -f1)
  if [ -n "$GROUP_COMMIT" ]; then hdr=(-H "group_commit: $GROUP_COMMIT"); else hdr=(-H "label: bench_$(basename "$f" .jsonl | tr . _)_$RANDOM$RANDOM"); fi
  curl -s --location-trusted -u "$USER_PASS" -T "$f" -H "format: json" -H "read_json_by_line: true" \
       -H "Expect: 100-continue" "${hdr[@]}" "http://$HTTP/api/$DB/$table/_stream_load" > "$RESULTS/$(basename "$f").json"
}
export -f load_one

FILES=$(find "$DIR" -name '*.jsonl' | sort)
ROWS=$(cat $FILES | wc -l)
BYTES=$(cat $FILES | wc -c)
START=$(date +%s.%N)
echo "$FILES" | xargs -P "$JOBS" -I{} bash -c 'load_one {}'
END=$(date +%s.%N)

python3 -I - "$RESULTS" "$ROWS" "$BYTES" "$START" "$END" <<'EOF'
import json, os, sys
d, rows, nbytes, t0, t1 = sys.argv[1], int(sys.argv[2]), int(sys.argv[3]), float(sys.argv[4]), float(sys.argv[5])
loaded, failed = 0, []
for f in os.listdir(d):
    r = json.load(open(os.path.join(d, f)))
    if r.get("Status") in ("Success", "Publish Timeout"):
        loaded += r.get("NumberLoadedRows", 0)
    else:
        failed.append((f, r.get("Status"), r.get("Message")))
secs = t1 - t0
print(json.dumps({"files": len(os.listdir(d)), "rows_in_files": rows, "rows_loaded": loaded,
                  "failed_loads": failed[:5], "seconds": round(secs, 2),
                  "rows_per_second": round(rows / secs), "mb_per_second": round(nbytes / secs / 1e6, 1)}, indent=2))
sys.exit(0 if loaded == rows and not failed else 1)
EOF
