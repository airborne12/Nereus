# Client ingestion integration tests

These tests send telemetry from official OpenTelemetry Python SDKs through the
production Collector configuration and Doris exporter, then check Doris and the
Nereus API. The optional compatibility suite uses a native Jaeger OpenTracing
client over Thrift/UDP.

## Run

Requirements: Bash, Docker Engine with Compose (`up --wait --wait-timeout`), internet access for
the pinned images and packages, and enough Docker memory for Doris. The FE has a
2 GiB Java heap and the BE has a 4 GiB memory limit; allow at least 8 GiB of Docker
memory. The image tags and all Python dependency versions are pinned in this
directory.

From the repository root:

```sh
./tests/ingestion/run.sh
./tests/ingestion/run.sh --jaeger
```

The default run executes five tests. `--jaeger` adds a sixth test and installs the
Jaeger client dependencies in a separate image. Host Python, Node, MySQL and
existing Nereus services are not required.

Each invocation creates a unique Compose project with a private Docker network,
fresh Doris tables, fresh PostgreSQL metadata and its own generated administrator
password. No host ports, fixed subnets or existing account credentials are used.
The suite builds the current Nereus application and uses service names for
internal connections. It resolves the Doris node addresses inside the containers.

The runner removes only its own containers, network and volumes on success,
failure or an interrupt. Built images remain available for Docker build caching.
If the host or Docker daemon stops during a run, remove the printed project with:

```sh
bash /path/to/the/printed/artifact-directory/cleanup-command.sh
```

That script records the run's project, environment variables and Compose profiles.

## Coverage

- A real HTTP client and server propagate the original trace and span IDs through
  W3C `traceparent`, or Jaeger's `uber-trace-id` in the compatibility suite.
- Twenty failed checkout requests per protocol produce exactly forty spans and,
  for OpenTelemetry, forty correlated error logs. Both spans retain their kinds,
  root flags, error status, duration, attributes and recorded exceptions.
  Jaeger span log records are checked as span events; that client does not export
  separate log records or metric points.
- The OpenTelemetry clients export gauge, counter and histogram points. Checks
  cover values, dimensions, histogram buckets and exemplars that reference the
  exported server spans.
- Both HTTP and gRPC fidelity clients capture the protobuf request serialized by
  the official exporter. The tests compare event names, attributes, span links,
  log bodies and exception stack traces with the stored data and API responses.
  Fixtures include newlines, tabs, carriage returns, backslashes, quotes, Unicode
  and NUL inside nested event, link and exemplar attributes.
- API checks cover trace lookup, log correlation, service-map edge counts and
  metric charts. PostgreSQL migrations and first-run account setup run against
  the newly built production application.

The gRPC payload capture overrides the pinned exporter's `_translate_data` hook
and returns the original protobuf unchanged. HTTP capture inspects the request
body in a `requests.Session` before sending it. Neither transport is mocked.

The direct Stream Load and existing-table migration regressions remain in
`server/test/telemetry-schema.doris.test.ts`. Browser interaction tests remain in
`web/e2e`; this suite checks the production API without requiring Chromium.

## Results and troubleshooting

The runner prints the artifact directory, which defaults to
`test-results/ingestion/<unique-run>/` and is ignored by Git. Set
`INGEST_TEST_OUTPUT=/absolute/path` to choose another output root.

Artifacts include:

- Client manifests with the expected trace IDs, counts and captured protobuf.
- `results.tap` and `verification.json` with the validation results.
- `compose.log` with service logs and `cleanup.log` with teardown results.
- `cleanup-command.sh` to remove an interrupted run's isolated environment.

A nonzero exit means a build, service startup, client export, assertion or cleanup
failed. The tests wait for asynchronous Collector batches and Doris commits up to
90 seconds per row group; they fail on missing, extra or corrupted rows.
Inspect the logs before changing timeouts. Do not point the cleanup command at an
unrelated Compose project.
