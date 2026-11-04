# DorisStack

An open-source observability stack (logs, traces, metrics in one place) on Apache Doris:
OpenTelemetry Collector for ingestion, Doris for storage and search, and a self-built
API service and web UI. "DorisStack" is a working code name.

Design: <https://claude.ai/artifact/RUahRwDXWZPii2gSTZCU67>

Status: **M0 (foundation)**. Tables, collector configuration, a single-host compose file and
ingestion/search checks are here. The API service and UI start in M1.

## Layout

| Path | What |
| --- | --- |
| `schema/` | Doris DDL for logs, traces and the five metric tables; `apply.sh` creates them |
| `collector/config.yaml` | OTel Collector (contrib) config: OTLP in, `doris` exporter out |
| `deploy/docker-compose.yaml` | Doris FE + BE, schema init, collector, telemetrygen |
| `bench/otelgen.py` | Synthetic OTel data in the exact JSON the `doris` exporter sends |
| `bench/load.sh` | Parallel Stream Load of generated files; rows/s and loss check |
| `bench/verify_search.sh` | `search()` vs plain SQL row-count checks for the query compiler |

## Quick start (docker)

```bash
cd deploy
DORIS_VERSION=4.0.1 docker compose up -d     # any Doris release that has search()
mysql -h127.0.0.1 -P9030 -uroot -e 'select count(*) from otel.otel_traces'
```

Send OTLP to `localhost:4317` (gRPC) or `localhost:4318` (HTTP).
The compose file has not been run yet: the development machine has no docker. Check the
`apache/doris` image tags for your version.

## Against an existing Doris

```bash
schema/apply.sh -h <fe> -P 9030 -d otel -r 30          # 30 days retention
DORIS_HTTP=http://<fe>:8030 otelcol-contrib --config collector/config.yaml
```

Or load synthetic data without a collector:

```bash
bench/otelgen.py --http <fe>:8030 --traces 10000        # direct Stream Load
bench/otelgen.py --traces 50000 --out-dir /tmp/gen      # files, then:
bench/load.sh -d /tmp/gen -H <fe>:8030 -j 8
bench/verify_search.sh -h <fe> -P 9030 -D otel
```

## Schema notes

- Column names and types follow the `doris` exporter's JSON (`exporter_logs.go`,
  `exporter_traces.go`, `exporter_metrics.go`), so the exporter runs with
  `create_schema: false`. The exporter's record shape is fixed: it has no `trace_flags`,
  `event_name` or `scope_attributes`, and extra columns would stay NULL.
- `otel_traces.duration` is in **microseconds**.
- Daily `AUTO PARTITION`; `partition.retention_count` is the TTL in days. The partition
  column must be `NOT NULL`.
- Attributes are `VARIANT`. Frequent paths become columnar subcolumns on their own, so
  there are no materialized `k8s.*` columns as in ClickStack's ClickHouse schema.
- All seven tables must exist: the exporter writes exponential histograms and summaries
  to their own tables.

## M0 results (2026-11-04)

Private cluster from a Doris master build (`379f6481`, ASAN, BE limited to 8 cores), so
throughput is far below a release build and only shows the pipeline works.

| Check | Result |
| --- | --- |
| Stream Load, 343,665 rows / 226 MB JSON, 43 files, 8 parallel | 31.5 s, 10.9k rows/s, 7.2 MB/s, 0 rows lost |
| Size on disk (with inverted indexes, before compaction) | about 7x smaller than the JSON |
| `search()` vs SQL: phrase, term, VARIANT path, wildcard, AND/OR/NOT, trace_id | identical counts |
| `search()` ranges `[a TO b]` | 0 rows (Doris gap 1) |

## Doris gaps found

1. **`search()` ranges return nothing.** `RANGE` and `LIST` clauses fall back to a TERM
   query on the literal text (`be/src/exprs/function/function_search.cpp`), so
   `duration:[10000 TO 20000]` silently matches 0 rows. Workaround: the compiler emits
   ranges as SQL predicates, which use the BKD index anyway.
2. **`search()` fails on non-selective numeric terms.** With the default
   `inverted_index_skip_threshold = 50`, a BKD clause that hits more than half of a
   segment skips the index, and `search()` reports that as
   `SEARCH cannot fall back to row execution`. The query fails or succeeds depending on data
   distribution. Workaround: `SET inverted_index_skip_threshold = 0` for search queries.
3. **Every `search()` field needs an inverted index**, or the query fails. The compiler
   sends only indexed fields to `search()` and the rest to SQL.
4. No `count_if` / `sum_if`; the compiler writes `sum(if(cond, 1, 0))`.
