# DorisStack

An open-source observability stack (logs, traces, metrics in one place) on Apache Doris:
OpenTelemetry Collector for ingestion, Doris for storage and search, and a self-built
API service and web UI. "DorisStack" is a working code name.

Design: <https://claude.ai/artifact/RUahRwDXWZPii2gSTZCU67>

Status: **M0 done, M1 in progress**. Tables, collector configuration, a single-host compose
file and ingestion checks (M0); the search compiler, the API, the search page, and users, login
and API keys with metadata in PostgreSQL (M1). Configurable data sources come next.

## Layout

| Path | What |
| --- | --- |
| `schema/` | Doris DDL for logs, traces and the five metric tables; `apply.sh` creates them |
| `collector/config.yaml` | OTel Collector (contrib) config: OTLP in, `doris` exporter out |
| `deploy/docker-compose.yaml` | Doris FE + BE, schema init, collector, telemetrygen |
| `bench/otelgen.py` | Synthetic OTel data in the exact JSON the `doris` exporter sends |
| `bench/load.sh` | Parallel Stream Load of generated files; rows/s and loss check |
| `bench/verify_search.sh` | `search()` vs plain SQL row-count checks for the query compiler |
| `bench/otlp_send.py` | The same synthetic data sent as real OTLP/HTTP to a collector |
| `server/` | API service (TypeScript, Node 24): search compiler, SQL builder, HTTP API, auth |
| `server/migrations/` | PostgreSQL schema for metadata, applied at start-up |
| `Dockerfile` | API service and built web UI in one image |
| `web/` | Search page (React + Vite): query bar with completion, histogram, results, details, trace waterfall |

## API service

```bash
cd server && npm install
DORIS_HOST=<fe> DORIS_PORT=9030 DORIS_DB=otel PORT=8090 \
  META_DATABASE_URL=postgres://user:pass@<pg>:5432/dorisstack node src/server.ts
curl -G localhost:8090/api/search --data-urlencode source=logs \
  --data-urlencode 'q=level:ERROR "timeout after" k8s.pod.name:checkout-*' \
  --data-urlencode from=2026-11-04T00:00:00Z --data-urlencode to=2026-11-05T00:00:00Z
```

| Variable | Meaning |
| --- | --- |
| `DORIS_HOST`, `DORIS_PORT`, `DORIS_USER`, `DORIS_PASSWORD`, `DORIS_DB` | Doris FE (MySQL protocol) and the telemetry database |
| `META_DATABASE_URL` | PostgreSQL for users, sessions and API keys; migrations run at start-up |
| `COOKIE_SECURE=1` | mark the session cookie Secure (behind HTTPS) |
| `PORT`, `WEB_DIST` | listen port (8090), built UI directory (`web/dist`) |

Every `/api/*` call except `/api/auth/*` needs a login: the browser's session cookie, or
`Authorization: Bearer <API key>` from scripts (keys are created under Settings).

| Endpoint | Returns |
| --- | --- |
| `GET /api/search?source=logs\|traces&where=&language=lucene\|sql&filters=<json>&select=&orderBy=&from=&to=&limit=&offset=` | rows (every column, plus SELECT expressions as `__e<n>`), the table's columns, the SQL that ran |
| `GET /api/histogram?source=&where=&language=&filters=&from=&to=&buckets=&groupBy=` | counts per time bucket, optionally per field value |
| `GET /api/facets?source=&where=&language=&filters=&from=&to=&fields=` | top values of string fields in a sample, for the filter panel |
| `GET /api/trace/<id>?from=&to=` | all spans of a trace |
| `GET /api/fields?source=` | search bar fields: columns, aliases, VARIANT paths with types |
| `GET /api/values?source=&field=&q=&from=&to=&limit=` | most frequent values of a field among matching rows |
| `GET /api/auth/status`, `POST /api/auth/setup`, `/login`, `/logout` | session state, first admin, sign in and out |
| `GET`/`POST /api/keys`, `DELETE /api/keys/<id>` | your API keys (the key itself is returned once) |
| `GET`/`POST /api/users`, `POST /api/users/<id>/disabled` | user management (admins) |

Users, sessions and keys: passwords are scrypt hashes, session and API key tokens are 256-bit
random values stored as SHA-256 hashes, sessions last 7 days, 10 failed logins per address and
email in 5 minutes are throttled, and disabling a user ends their sessions and stops their keys.
`language=sql`, `select` and `orderBy` are the user's own SQL, run as given (one statement; `;` is
refused), as in ClickStack. **Give the API service a Doris account that can only read the telemetry
database**: then such SQL can do no more than read telemetry, which every signed-in user may do anyway.

State-changing requests must be JSON or DELETE, which a browser only sends cross-site after a CORS
preflight this server never answers; the cookie is HttpOnly and SameSite=Lax.

## Search page

The layout and interactions follow ClickStack's search (HyperDX v2); names, logo and colours are our own.

- **Navigation** on the left: Search, Saved searches, Chart explorer, Alerts, Client sessions, Service
  map, Dashboards, Team settings, user menu. Only Search and Team settings are built; the others say
  which milestone they belong to.
- **Header**, three rows: source, `SELECT` and `ORDER BY`; the `WHERE` input with a Lucene / SQL switch
  (completion in Lucene), the time picker (Live Tail and ClickStack's presets, a start/end form and
  "around a time"), the Live Tail refresh interval and Run; then the active filters as pills (click
  flips include/exclude, x removes, Clear all).
- **Filter panel**: Analysis Mode (Results Table, Event Patterns), Root Spans Only for traces, and a
  group per string field and attribute path with its top values, the share of a 20,000-row sample, a
  value search, and Only / Exclude on hover. Filters are kept apart from the WHERE text.
- **Results**: count, Live / Resume Live Tail, elapsed time, wrap lines, Show Generated SQL; the
  histogram (stacked by level or status, drag to zoom); the table with the SELECT columns (remove a
  column from its header), scrolling loads the next 200 rows.
- **Side panel** from the right (80% wide, drag its edge, expand, Esc closes): Overview (attributes
  grouped, each value can be added to the filters, excluded, searched alone, added as a column or
  copied), Column Values (search by key or value), Trace (waterfall with each span's log lines under
  it, span details), Surrounding Context (±100 ms to ±15 min, scoped to anything, service, host or pod,
  centred on This Event).
- **Event Patterns**: log lines grouped by template from a 2,000-row sample, with trend, scaled count,
  level and samples.
- Keyboard: `/` focuses the search, `d` opens the time picker, `j`/`k` step through events, Esc closes.
- State lives in the URL (`where`, `lang`, `filters`, `select`, `orderBy`, `t` or `from`/`to`).

```bash
cd web && npm install && npm run build      # web/dist, served by the API service at /
cd ../server && DORIS_HOST=<fe> DORIS_PORT=9030 META_DATABASE_URL=... node src/server.ts   # :8090
```

`npm run build:demo` builds the same UI as an offline demo whose /api is answered in the browser from
`web/demo/demo-data.json` (a snapshot exported from `/api/search` and `/api/fields`; not committed).

Browser tests (Playwright + Chromium) drive the built page against a live Doris and PostgreSQL:
`npm run build && DORIS_PORT=9030 DORIS_DB=otel_bench npm run e2e`.

## Schema notes

- Column names and types follow the `doris` exporter's JSON (`exporter_logs.go`,
  `exporter_traces.go`, `exporter_metrics.go`), so the exporter runs with
  `create_schema: false`. The exporter's record shape is fixed: it has no `trace_flags`,
  `event_name` or `scope_attributes`, and extra columns would stay NULL.
- `otel_traces.duration` is in **microseconds**.
- `span_name` has a tokenized index (like ClickStack's index on `lower(SpanName)`), so a word of a
  span name finds it. Tables created before this change: run `schema/upgrades/001_span_name_fulltext.sql`.
- `span_kind` and `status_code` hold the OTLP enum names: `SPAN_KIND_SERVER`,
  `STATUS_CODE_ERROR`, not `Server` / `Error`.
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
| Real collector (otelcol-contrib 0.164.0, doris exporter 0.164.1), OTLP/HTTP | 4,718 spans, 7,057 logs, 3 x 1,440 metric points sent, all rows in Doris, 0 exporter errors |
| Search compiler on live Doris (M1) | 20 queries equal to reference SQL, 7 hostile inputs stay literals |

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
