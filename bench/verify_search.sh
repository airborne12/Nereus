#!/usr/bin/env bash
# Check that each search() expression the query compiler relies on returns the same
# row count as its plain-SQL equivalent, on data loaded by otelgen.py.
# Pairs marked KNOWN_BROKEN document Doris gaps the compiler works around; they are
# reported but do not fail the run.
#
# Usage: bench/verify_search.sh [-h host] [-P port] [-D db]
set -uo pipefail
HOST=127.0.0.1 PORT=9030 DB=otel
while getopts "h:P:D:" opt; do
  case $opt in h) HOST=$OPTARG ;; P) PORT=$OPTARG ;; D) DB=$OPTARG ;; *) exit 2 ;; esac
done
# inverted_index_skip_threshold=0: by default a BKD clause hitting more than 50% of a
# segment skips the index, and search() turns that skip into a query error ("SEARCH cannot
# fall back to row execution"). The API service sets the same variable for search queries.
q() { mysql -h"$HOST" -P"$PORT" -uroot -D"$DB" -N -e "set inverted_index_skip_threshold = 0; $1" 2>&1 | tail -1; }

fail=0
check() {  # name, status (OK|KNOWN_BROKEN), search where-clause, sql where-clause, table
  local a b
  a=$(q "select count(*) from $5 where $3")
  b=$(q "select count(*) from $5 where $4")
  if [ "$a" = "$b" ]; then
    printf '%-28s ok        search=%s sql=%s\n' "$1" "$a" "$b"
  elif [ "$2" = KNOWN_BROKEN ]; then
    printf '%-28s KNOWN     search=%s sql=%s\n' "$1" "$a" "$b"
  else
    printf '%-28s MISMATCH  search=%s sql=%s\n' "$1" "$a" "$b"; fail=1
  fi
}

check phrase+term OK "search('severity_text:ERROR AND body:\"timeout after\"')" \
  "severity_text = 'ERROR' and body match_phrase 'timeout after'" otel_logs
check variant-path-term OK "search('resource_attributes.k8s.pod.name:payment-2')" \
  "cast(resource_attributes['k8s.pod.name'] as string) = 'payment-2'" otel_logs
check variant-numeric-term OK "search('log_attributes.thread.id:7')" \
  "cast(log_attributes['thread.id'] as int) = 7" otel_logs
check prefix-wildcard OK "search('service_name:checkout AND body:redis*')" \
  "service_name = 'checkout' and lower(body) regexp '(^|[^a-z0-9])redis[a-z0-9]*'" otel_logs
check or-not OK "search('(severity_text:WARN OR severity_text:ERROR) AND NOT service_name:frontend')" \
  "severity_text in ('WARN','ERROR') and service_name <> 'frontend'" otel_logs
tid=$(q "select trace_id from otel_traces where is_root = 1 order by trace_id limit 1")
check trace-id OK "search('trace_id:$tid')" "trace_id = '$tid'" otel_traces
# search() RANGE falls back to a TERM query on the literal "[a TO b]" (function_search.cpp),
# so it matches nothing. The compiler emits ranges as SQL predicates instead.
check range-bigint KNOWN_BROKEN "search('duration:[10000 TO 20000]')" "duration between 10000 and 20000" otel_traces
check range-variant KNOWN_BROKEN "search('span_attributes.http.status_code:[500 TO 599]')" \
  "cast(span_attributes['http.status_code'] as int) between 500 and 599" otel_traces
exit $fail
