# Nereus

Observability on [Apache Doris](https://doris.apache.org): logs, traces, metrics and browser
sessions in one place. The OpenTelemetry Collector writes into Doris; Nereus is the API service and
web UI on top: search in Lucene or SQL with live tail, event patterns and event deltas, a service
map, saved searches, charts, dashboards and alerts, and session replay linked to backend traces. Its
layout and interactions follow ClickStack (HyperDX).

In Greek myth Nereus is the Old Man of the Sea, husband of Doris. He knows everything, and whoever
holds on to him gets the truth out of him: what observability is for.

Status: the ClickStack feature set is built and measured at 103M logs / 69M spans
([bench/SCALE.md](bench/SCALE.md)). Not yet: data sources configured in the UI (the tables are
the ones in `schema/`), and metrics other than gauges in Chart explorer.

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

The Compose stack defaults to Doris **4.1.5**. If you override `DORIS_VERSION`, use a release
that supports both `search()` and the schema's `partition.retention_count` property.

Existing installations with ARRAY/STRUCT span events, links or metric exemplars must run
the [nested attribute migration](schema/upgrades/README.md) to preserve JSON string escapes.

## API service

```bash
cd server && npm install
DORIS_HOST=<fe> DORIS_PORT=9030 DORIS_DB=otel PORT=8090 \
  META_DATABASE_URL=postgres://user:pass@<pg>:5432/nereus node src/server.ts
curl -G localhost:8090/api/search --data-urlencode source=logs \
  --data-urlencode 'q=level:ERROR "timeout after" k8s.pod.name:checkout-*' \
  --data-urlencode from=2026-11-04T00:00:00Z --data-urlencode to=2026-11-05T00:00:00Z
```

| Variable | Meaning |
| --- | --- |
| `DORIS_HOST`, `DORIS_PORT`, `DORIS_USER`, `DORIS_PASSWORD`, `DORIS_DB` | Doris FE (MySQL protocol) and the telemetry database |
| `META_DATABASE_URL` | PostgreSQL for users, sessions, API keys, saved searches, dashboards and alerts; migrations run at start-up |
| `PUBLIC_URL` | address of the UI, for links in alert messages |
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
| `GET`/`POST /api/saved-searches`, `GET`/`PUT`/`DELETE …/<id>`, `POST …/<id>/favorite` | saved searches (team), stars (yours) |
| `GET`/`POST /api/dashboards`, `GET`/`PUT`/`DELETE …/<id>`, `POST …/<id>/favorite` | dashboards and their tiles |
| `GET /api/webhooks`; `POST`, `DELETE …/<id>`, `POST …/<id>/test` (admins) | alert destinations; URLs are shown to admins only |
| `GET`/`POST /api/alerts[?savedSearchId=\|?dashboardId=]`, `DELETE …/<id>`, `POST …/<id>/silence`, `GET …/<id>/history` | alerts on saved searches and dashboard tiles |
| `POST /api/chart {source, display, series, where, language, filters, groupBy, from, to}` | chart data for Chart explorer and tiles |
| `GET /api/service-map?where=&language=&filters=&from=&to=` | calls between services and per-service requests, errors, p99 |
| `GET /api/heatmap?where=&language=&filters=&from=&to=&buckets=` | trace durations per time bucket and duration band (Event Deltas) |
| `POST /api/ingest/sessions` (ingestion key; CORS) | browser SDK: replay chunks and session events |
| `GET /api/sessions?where=&language=&filters=&from=&to=`, `GET /api/sessions/<id>?from=&to=` | sessions with a matching event; one session's events and replay |
| `GET /api/sessions/by-trace/<trace id>?from=&to=` | the session whose request started a trace |
| `GET`/`POST /api/ingest-keys`, `DELETE …/<id>` (admins) | ingestion keys for the browser SDK |

Users, sessions and keys: passwords are scrypt hashes, session and API key tokens are 256-bit
random values stored as SHA-256 hashes, sessions last 7 days, 10 failed logins per address and
email in 5 minutes are throttled, and disabling a user ends their sessions and stops their keys.
`language=sql`, `select` and `orderBy` are the user's own SQL, as in ClickStack. Each is checked
before use (`sqlFragment`): one expression over the source's columns, with no subquery (so no table
functions such as `http()` or `s3()`, which reach other hosts), no `INTO OUTFILE`, no `LIMIT`, no
comments and no backslashes. Run the service as a Doris user that can only read the telemetry
database (see [Security](#security)): every signed-in user may read all telemetry, and nothing else.

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
The tests select their browser time zones explicitly and cover UTC, Asia/Shanghai, and phone layouts.
HTTP compatibility tests bind an ephemeral port and use a local non-loopback IPv4 address;
set `BROWSER_HTTP_HOST` to choose the address. They verify the actual system clipboard too.
For schema Stream Load tests, set `DORIS_TEST=1` and `DORIS_BE_HTTP_URL` to the BE HTTP endpoint.

For a self-contained test of real client ingestion, run `./tests/ingestion/run.sh`.
It builds the application, starts isolated Doris/PostgreSQL/Collector services,
and validates official OpenTelemetry HTTP/gRPC exporters and string fidelity.
Add `--jaeger` for native Jaeger Thrift/UDP compatibility checks.
See [client ingestion integration tests](tests/ingestion/README.md) for requirements,
coverage, cleanup and result artifacts.

## Saved searches, alerts, charts and dashboards

- **Saved searches** keep the query (source, WHERE and language, filters, SELECT, ORDER BY) and tags,
  not the time range, as in ClickStack. They are shared by the team; stars are per user and appear
  under Saved searches in the navigation (a red dot when an alert on it is firing).
- **Alerts** watch a saved search (its match count) or a dashboard tile (its first series, e.g. p99
  latency; with a group by, whichever group breaches first: the highest value for "above", the
  lowest for "below", among the 100 largest groups). Alert when the value over the last 1m-24h is
  above or below a threshold. A tile's alerts are deleted with the tile; no data does not breach. The server checks due alerts every 15 s (`FOR UPDATE SKIP LOCKED`, so several servers
  share the work) and posts to the webhook when the state changes, with Slack-compatible `text`, the
  numbers and a link (`PUBLIC_URL`). Silencing keeps checking but sends nothing. Every check is kept
  as history.
- **Webhooks** are added by admins under Team settings. Members choose one by name and never see its
  URL. This is the only request the server makes to an outside address, it goes only to addresses an
  admin entered, and redirects are not followed.
- **Chart explorer**: logs, traces or metrics (`otel_metrics_gauge`), Time Series / Table / Number, up
  to 10 series of count, count distinct, sum, avg, min, max, p50, p90, p95, p99 of any number field or
  attribute path, a WHERE and a Group by. Save to dashboard adds it as a tile.
- **Dashboards**: tiles in a 12-column grid (widths 3-12) with one time range, Live (30 s) and Refresh;
  New Tile, Edit, Duplicate, Move, Delete, Open in Chart explorer. Every change is saved.

## Service map, Event Deltas and search tools

- **Service map** joins each span to its parent span (same trace, `parent_span_id = span_id`, parents
  looked up a minute either side of the window). A parent in another service is one call from that
  service. Edges show calls, errors, p50/p99; nodes count each service's entry spans (roots and
  server spans). The WHERE filters the calls. Click a service to search its traces.
- **Event Deltas** (traces, Analysis Mode): a heatmap of span duration over time, 4 bands per power
  of ten. Drag a box around outliers; every field's value shares in the selection are compared with
  all matching spans (the facet sample of each), biggest differences first, with Filter / Exclude.
- **Group by** splits the timeline by any field or attribute path; the 10 most frequent values keep
  their own series and the rest add up as `(other)` (`groups=10` on `/api/histogram`).
- **Denoise** (logs) mines patterns in the newest 2,000 matching events and hides the rows of
  patterns that make up 5% or more of them.
- **Download CSV** saves the loaded rows as shown; columns resize from their header edge
  (double-click restores); the query box offers your last 10 queries per source and language
  (this browser only); the time picker understands "last 2 hours", "yesterday", "3h ago",
  "this week", "2026-11-04 10:00 to 12:00".

## Client sessions

The browser SDK (`web/src/sdk`, served as `/sdk/nereus-rum.js`, 61 kB gzipped) records a
session with [rrweb](https://github.com/rrweb-io/rrweb) and its clicks, page views, errors,
console errors and network requests (method, URL, status, duration):

```html
<script src="https://nereus.example.com/sdk/nereus-rum.js"></script>
<script>
  NereusRUM.init({ url: 'https://nereus.example.com', apiKey: 'nereus_ingest_…', service: 'shop-web' });
  NereusRUM.setUser({ id: 'u42', email: 'ada@example.com', name: 'Ada' });
  // NereusRUM.track('checkout', { total: 42 }) adds a custom event
</script>
```

A session ends after 30 minutes without activity or 4 hours. Rows go to `otel_sessions`
(`schema/002_sessions.sql`, zstd, keyed by session); a replay chunk bigger than a Doris STRING
value is split into parts and joined back on read. **Client sessions** lists the sessions with an
event matching the WHERE (`type:error`, `email:ada@example.com`, `url:checkout`, `"text"`) and
replays one, with a timeline of its events that seeks the player. `web/sdk-example/shop.html` is
a small site that uses the SDK; `web/demo/record-sessions.ts` records sessions on it.

**Sessions and traces.** The SDK adds a W3C `traceparent` header to the page's own requests (and
to other origins listed in `tracePropagationTargets`, whose CORS must allow the header) and keeps
the trace id on the network event; a `traceparent` the page sets itself is kept and recorded. A
backend instrumented with OpenTelemetry continues that trace, so a request in the replay opens
its backend trace (Open trace), and a trace's side panel offers the session replay, opened at the
request.

Privacy and security:

- Every input value is masked by default (`maskAllInputs`); `maskAllText: true` masks all text,
  class `nereus-mask` masks an element's text and `nereus-block` leaves it out. Request and response
  bodies are never recorded; a clicked form field is described without its text.
- Ingestion keys (`nereus_ingest_…`, Team settings, admins) are meant to sit in public pages: they only
  write session data and are refused by every other endpoint (own table and prefix). Anyone with
  the key can send data, as with ClickStack; revoke a leaked key. The endpoint answers CORS for any
  origin without credentials, takes up to 10 MB a request and rejects events more than a day from
  the server clock. It is rate limited per client address (`INGEST_RATE_PER_CLIENT`, 5/s, burst
  30; checked before the key, so guessing keys costs no database lookups) and per key
  (`INGEST_RATE_PER_KEY`, 100/s, burst 400: a site's visitors share one key), answering 429 with
  `Retry-After`. Behind proxies, set `TRUST_PROXY` to their number (usually `1`): the client is then
  the `X-Forwarded-For` entry they added, counted from the right; entries a client writes itself
  are ignored. Key lookups are
  cached for 10 s, so a revoked key stops working within 10 s.
- Replays render the recorded DOM in rrweb's iframe sandbox without `allow-scripts`, so recorded
  scripts do not run. The viewer's browser does load the recorded page's images and styles.

## Scale

On 103M logs and 69M spans (7 days, one BE with 32 cores) the UI's queries take a median of 31 ms
and at most 2.3 s (the 7-day service map); search, timelines and facets stay under 260 ms at every
range. Setup, all numbers and how to reproduce: [bench/SCALE.md](bench/SCALE.md).

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

## Security

Deployment checklist:

- **A Doris user for the service that can only read telemetry.** The service also writes session
  rows. The server test suite passes with exactly these privileges:

  ```sql
  CREATE USER 'nereus'@'%' IDENTIFIED BY '<password>';
  GRANT SELECT_PRIV ON otel.* TO 'nereus'@'%';
  GRANT LOAD_PRIV ON otel.otel_sessions TO 'nereus'@'%';
  -- Optional second layer: refuse table functions that reach other hosts, and exports.
  CREATE SQL_BLOCK_RULE nereus_no_external PROPERTIES (
    'sql' = '(?i)\\b(http|s3|hdfs|local)\\s*\\(|\\binto\\s+outfile\\b', 'global' = 'false', 'enable' = 'true');
  SET PROPERTY FOR 'nereus' 'sql_block_rules' = 'nereus_no_external';
  ```

  Then start the service with `DORIS_USER=nereus DORIS_PASSWORD=...`. The block rule looks at the
  SQL text, so a search for the literal words `http(` or `into outfile` is refused as well. Give the
  collector its own Doris user with `LOAD_PRIV` on `otel.*`.
- **HTTPS** in front of the service, with `COOKIE_SECURE=1`; `TRUST_PROXY` as above; `PUBLIC_URL`
  for the links in alert messages.
- **Webhooks** are added by admins only and members never see their URLs: they are the one place
  the service sends requests to an address someone typed.
- **Ingestion keys** are public by design (they sit in web pages) and can only write session rows;
  see [Client sessions](#client-sessions) for the limits.

Report vulnerabilities privately through GitHub's security advisories for this repository.

## License

Apache License 2.0, see [LICENSE](LICENSE). The built UI (`third-party-licenses.txt`) and the
browser SDK (its header comment) carry the licenses of the open-source packages bundled into them.

## Acknowledgements

- [ClickStack / HyperDX](https://github.com/hyperdxio/hyperdx) (MIT): Nereus follows its layout,
  features and interactions; the code here is our own.
- [rrweb](https://github.com/rrweb-io/rrweb) (MIT) records and replays browser sessions.
- [OpenTelemetry](https://opentelemetry.io) and its Collector's Doris exporter carry the data in.

Apache Doris, Doris and the Doris logo are trademarks of the Apache Software Foundation. Nereus is
an independent project, not affiliated with or endorsed by the ASF. ClickStack, HyperDX and
ClickHouse are trademarks of ClickHouse, Inc.
