# Nereus at scale: 103M logs, 69M spans

Every query the UI sends, built by the server's own SQL builders (`server/bench/ui-queries.ts`), on
7 days of data: **103,193,950 log rows and 68,982,800 spans** (13.5 GB in Doris), measured on
2026-11-06.

**Result: median 31 ms, 90th percentile 153 ms, slowest 2.3 s** (the service map over 7 days)
across 122 queries. Search rows, timelines, facets and value lists stay under 260 ms at every time
range, 7 days included.

## Setup

- One FE and one BE on a shared 92-core host (load average about 40 from other work). The BE has
  `num_cores = 32`, 48 scanner threads, 32 GB `mem_limit`. Doris master: FE 379f6481, BE 27adda9f71
  (RELEASE build).
- Data: `otel_bench` (2 hours from `bench/otelgen.py`: 175k logs, 117k spans, 6 services) copied
  588 times into `otel_scale` over the last 7 days, each copy with its own trace ids (so traces
  and log-trace links stay intact) and its own time offset; generated inside Doris with
  `INSERT … SELECT … CROSS JOIN numbers()`. Schema as `schema/001_otel_tables.sql`
  (AUTO PARTITION by day, inverted indexes, VARIANT attributes).
- Each query ran 4 times on one connection with the SQL cache off; the table shows the median of
  runs 2-4 in ms. The first runs are in `bench/results/scale-2026-11-06.json` (close to the
  medians: the data fits in the page cache).

## Results (median ms)

| Query | 15m | 1h | 24h | 7d |
|---|---:|---:|---:|---:|
| logs all · rows | 24 | 26 | 32 | 30 |
| logs all · histogram | 22 | 20 | 69 | 202 |
| logs all · facets | 79 | 95 | 116 | 209 |
| logs level:error service:checkout · rows | 30 | 27 | 30 | 28 |
| logs level:error service:checkout · histogram | 20 | 20 | 20 | 19 |
| logs level:error service:checkout · facets | 22 | 28 | 30 | 58 |
| logs text "slow query" · rows | 27 | 29 | 29 | 30 |
| logs text "slow query" · histogram | 20 | 21 | 29 | 57 |
| logs text "slow query" · facets | 40 | 73 | 114 | 114 |
| logs attribute · rows | 23 | 28 | 24 | 25 |
| logs attribute · histogram | 20 | 18 | 22 | 31 |
| logs attribute · facets | 28 | 43 | 74 | 77 |
| traces all · rows | 28 | 28 | 33 | 36 |
| traces all · histogram | 19 | 20 | 46 | 125 |
| traces all · facets | 89 | 153 | 142 | 249 |
| traces duration:>50ms · rows | 45 | 34 | 29 | 32 |
| traces duration:>50ms · histogram | 18 | 22 | 17 | 19 |
| traces duration:>50ms · facets | 28 | 33 | 42 | 71 |
| traces status:error service:payment · rows | 32 | 52 | 42 | 38 |
| traces status:error service:payment · histogram | 18 | 25 | 18 | 19 |
| traces status:error service:payment · facets | 25 | 31 | 31 | 50 |
| logs · group by service (top 10) | 31 | 30 | 70 | 180 |
| traces · order by duration desc | 32 | 97 | 126 | 567 |
| values service_name | 17 | 22 | 46 | 154 |
| patterns sample 2000 | 85 | 116 | 95 | 104 |
| service map edges | 101 | 141 | 467 | 2313 |
| service map nodes | 30 | 44 | 184 | 486 |
| heatmap | 19 | 27 | 49 | 129 |
| chart p99 by service | 23 | 29 | 134 | 720 |
| chart count by level table | 16 | 20 | 47 | 174 |
| trace waterfall · ±1d | | | | 16 (±1d) |
| logs of a trace · ±1d | | | | 16 (±1d) |

`rows` is the newest 200 matching rows (the results table), `histogram` the timeline (90 buckets,
split by level or status), `facets` the filter panel (top 10 values of 40 fields from the newest
20,000 matching rows), `values` the query box's value completion, `patterns sample` the 2,000
events Event Patterns and Denoise mine.

## What changed because of this

- **Facets read only what they count** (`facetsSql`): the 20,000-row sample selected `*`, so it
  read every column, whole VARIANT and ARRAY columns included. It now selects only the 40 faceted
  expressions: 1.7-2.7x faster with identical results (`server/bench/facets-compare.ts`):

  | | SELECT * | faceted only |
  |---|---:|---:|
  | logs, 1h | 231 | 88 |
  | logs, 7d | 360 | 210 |
  | logs, 7d, service:checkout | 207 | 121 |
  | traces, 1h | 365 | 137 |
  | traces, 7d | 471 | 278 |
  | traces, 7d, service:checkout | 296 | 165 |

- **Group by with the top-10 cap is one scan** (`searchHistogramSql` with `maxGroups`): it joined
  the (bucket, group) counts with a second top-N pass over the table; groups are now ranked with
  window functions over the counts. 7 days: 1,569 -> 180 ms; 24 hours: 209 -> 70 ms; same rows.

## Bugs the faster backend exposed

The browser tests had passed against the slow ASAN backend because answers arrived late; with
the release backend two real bugs showed:

- **A ticked filter value hid the field's other values.** Facets were counted with every filter,
  the field's own included, so after ticking `service_name = payment` only `payment` was left to
  tick. A filtered field is now counted without its own filter (its values are ORed), every other
  filter still applies, and each facet reports its own sample size (one extra facet query per
  filtered field).
- **A chart could briefly draw another chart's rows.** While a new result loaded, the previous
  one stayed on screen; after switching a grouped time series to a table, every level was listed
  once per time bucket. The previous result now stays only when it has the same shape (display,
  series, group by), so refreshing a dashboard still does not flicker.

## Not changed

- **Service map, 7 days: 2.3 s.** It joins child spans to their parent spans (69M x 49M rows).
  Under 0.5 s up to 24 hours. A pre-aggregated call table (a materialized view keyed by trace and
  span) would make it range-independent; not needed yet.
- **p99 by service over 7 days: 0.7 s, traces by duration over 7 days: 0.6 s.** percentile over
  69M values and a top-N sort over all spans.

## Pitfalls met on the way

- **An ASAN build of Doris is not a benchmark.** The first run used the dev cluster's ASAN BE
  (also capped at `num_cores = 8`): the 7-day timeline took 33 s, 10 s with 32 cores, and 0.2 s on
  a RELEASE build with the same 32 cores. Check `nm -D doris_be | grep __asan_init` first.
- **Load speed is bounded by memtable flush threads**, which build the inverted indexes:
  `flush_thread_num_per_store = 2` held the load to about 2 cores and 1 MB/s; with 16 threads and
  four parallel INSERT streams it reached about 54k rows/s (40 copies, 11.7M rows, in 217 s) on
  the ASAN build.

## Reproduce

```bash
schema/apply.sh -P 9930 -d otel_scale -r 30
# copy otel_bench into otel_scale: see the INSERT ... CROSS JOIN numbers() statements above
cd server
PATH=/opt/doris/node/bin:$PATH DORIS_PORT=9930 DORIS_DB=otel_scale node bench/ui-queries.ts > results.json
PATH=/opt/doris/node/bin:$PATH DORIS_PORT=9930 DORIS_DB=otel_scale node bench/facets-compare.ts
```
