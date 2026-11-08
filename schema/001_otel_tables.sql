-- Nereus telemetry tables.
--
-- Column names and types match the JSON lines that the OpenTelemetry Collector
-- `dorisexporter` sends through Stream Load (exporter_logs.go / exporter_traces.go /
-- exporter_metrics.go), so the exporter runs with `create_schema: false` against
-- these tables. Differences from the exporter's own DDL:
--   * AUTO PARTITION by day with `partition.retention_count` as the TTL, instead of
--     dynamic partitions created by the exporter.
--   * Inverted indexes only where the search page filters: body (tokenized), ids,
--     severity, service, attribute VARIANTs. No index on columns that are only read.
--   * VARIANT for events, links and exemplars to preserve JSON string escapes.
--   * time_series compaction.
--   * `traces.duration` is in MICROSECONDS (the exporter computes
--     EndTimestamp - StartTimestamp in microseconds).
--
-- ${DB} and ${RETENTION_DAYS} are substituted by schema/apply.sh.

CREATE DATABASE IF NOT EXISTS ${DB};

CREATE TABLE IF NOT EXISTS ${DB}.otel_logs (
    service_name          VARCHAR(256),
    timestamp             DATETIME(6) NOT NULL,
    service_instance_id   VARCHAR(256),
    trace_id              VARCHAR(64),
    span_id               VARCHAR(32),
    severity_number       INT,
    severity_text         VARCHAR(32),
    body                  STRING,
    resource_attributes   VARIANT,
    log_attributes        VARIANT,
    scope_name            VARCHAR(256),
    scope_version         VARCHAR(64),
    INDEX idx_service_name (service_name) USING INVERTED,
    INDEX idx_trace_id (trace_id) USING INVERTED,
    INDEX idx_span_id (span_id) USING INVERTED,
    INDEX idx_severity_text (severity_text) USING INVERTED,
    INDEX idx_body (body) USING INVERTED
        PROPERTIES ("parser" = "unicode", "lower_case" = "true", "support_phrase" = "true"),
    INDEX idx_resource_attributes (resource_attributes) USING INVERTED,
    INDEX idx_log_attributes (log_attributes) USING INVERTED
)
DUPLICATE KEY (service_name, timestamp)
AUTO PARTITION BY RANGE (date_trunc(timestamp, 'day')) ()
DISTRIBUTED BY RANDOM BUCKETS AUTO
PROPERTIES (
    "replication_num" = "${REPLICATION_NUM}",
    "compaction_policy" = "time_series",
    "partition.retention_count" = "${RETENTION_DAYS}"
);

CREATE TABLE IF NOT EXISTS ${DB}.otel_traces (
    service_name          VARCHAR(256),
    timestamp             DATETIME(6) NOT NULL,
    service_instance_id   VARCHAR(256),
    trace_id              VARCHAR(64),
    span_id               VARCHAR(32),
    trace_state           STRING,
    parent_span_id        VARCHAR(32),
    span_name             VARCHAR(1024),
    span_kind             VARCHAR(32),
    end_time              DATETIME(6),
    duration              BIGINT COMMENT 'microseconds',
    span_attributes       VARIANT,
    events                VARIANT,
    links                 VARIANT,
    status_message        STRING,
    status_code           VARCHAR(32),
    resource_attributes   VARIANT,
    scope_name            VARCHAR(256),
    scope_version         VARCHAR(64),
    is_root               TINYINT,
    INDEX idx_service_name (service_name) USING INVERTED,
    INDEX idx_trace_id (trace_id) USING INVERTED,
    INDEX idx_span_id (span_id) USING INVERTED,
    INDEX idx_parent_span_id (parent_span_id) USING INVERTED,
    -- Tokenized like ClickStack's lower(SpanName) index: a bare word finds "GET /checkout".
    INDEX idx_span_name (span_name) USING INVERTED
        PROPERTIES ("parser" = "unicode", "lower_case" = "true", "support_phrase" = "true"),
    INDEX idx_span_kind (span_kind) USING INVERTED,
    INDEX idx_status_code (status_code) USING INVERTED,
    INDEX idx_duration (duration) USING INVERTED,
    INDEX idx_span_attributes (span_attributes) USING INVERTED,
    INDEX idx_resource_attributes (resource_attributes) USING INVERTED
)
DUPLICATE KEY (service_name, timestamp)
AUTO PARTITION BY RANGE (date_trunc(timestamp, 'day')) ()
DISTRIBUTED BY RANDOM BUCKETS AUTO
PROPERTIES (
    "replication_num" = "${REPLICATION_NUM}",
    "compaction_policy" = "time_series",
    "partition.retention_count" = "${RETENTION_DAYS}"
);

CREATE TABLE IF NOT EXISTS ${DB}.otel_metrics_gauge (
    service_name          VARCHAR(256),
    timestamp             DATETIME(6) NOT NULL,
    service_instance_id   VARCHAR(256),
    metric_name           VARCHAR(256),
    metric_description    STRING,
    metric_unit           VARCHAR(64),
    attributes            VARIANT,
    start_time            DATETIME(6),
    value                 DOUBLE,
    exemplars             VARIANT,
    resource_attributes   VARIANT,
    scope_name            VARCHAR(256),
    scope_version         VARCHAR(64),
    INDEX idx_metric_name (metric_name) USING INVERTED,
    INDEX idx_attributes (attributes) USING INVERTED
)
DUPLICATE KEY (service_name, timestamp)
AUTO PARTITION BY RANGE (date_trunc(timestamp, 'day')) ()
DISTRIBUTED BY RANDOM BUCKETS AUTO
PROPERTIES (
    "replication_num" = "${REPLICATION_NUM}",
    "compaction_policy" = "time_series",
    "partition.retention_count" = "${RETENTION_DAYS}"
);

CREATE TABLE IF NOT EXISTS ${DB}.otel_metrics_sum (
    service_name            VARCHAR(256),
    timestamp               DATETIME(6) NOT NULL,
    service_instance_id     VARCHAR(256),
    metric_name             VARCHAR(256),
    metric_description      STRING,
    metric_unit             VARCHAR(64),
    attributes              VARIANT,
    start_time              DATETIME(6),
    value                   DOUBLE,
    exemplars               VARIANT,
    aggregation_temporality VARCHAR(32),
    is_monotonic            BOOLEAN,
    resource_attributes     VARIANT,
    scope_name              VARCHAR(256),
    scope_version           VARCHAR(64),
    INDEX idx_metric_name (metric_name) USING INVERTED,
    INDEX idx_attributes (attributes) USING INVERTED
)
DUPLICATE KEY (service_name, timestamp)
AUTO PARTITION BY RANGE (date_trunc(timestamp, 'day')) ()
DISTRIBUTED BY RANDOM BUCKETS AUTO
PROPERTIES (
    "replication_num" = "${REPLICATION_NUM}",
    "compaction_policy" = "time_series",
    "partition.retention_count" = "${RETENTION_DAYS}"
);

CREATE TABLE IF NOT EXISTS ${DB}.otel_metrics_histogram (
    service_name            VARCHAR(256),
    timestamp               DATETIME(6) NOT NULL,
    service_instance_id     VARCHAR(256),
    metric_name             VARCHAR(256),
    metric_description      STRING,
    metric_unit             VARCHAR(64),
    attributes              VARIANT,
    start_time              DATETIME(6),
    count                   BIGINT,
    sum                     DOUBLE,
    bucket_counts           ARRAY<BIGINT>,
    explicit_bounds         ARRAY<DOUBLE>,
    exemplars               VARIANT,
    min                     DOUBLE,
    max                     DOUBLE,
    aggregation_temporality VARCHAR(32),
    resource_attributes     VARIANT,
    scope_name              VARCHAR(256),
    scope_version           VARCHAR(64),
    INDEX idx_metric_name (metric_name) USING INVERTED,
    INDEX idx_attributes (attributes) USING INVERTED
)
DUPLICATE KEY (service_name, timestamp)
AUTO PARTITION BY RANGE (date_trunc(timestamp, 'day')) ()
DISTRIBUTED BY RANDOM BUCKETS AUTO
PROPERTIES (
    "replication_num" = "${REPLICATION_NUM}",
    "compaction_policy" = "time_series",
    "partition.retention_count" = "${RETENTION_DAYS}"
);

-- The exporter writes these two metric kinds to their own tables; without them
-- every exponential-histogram or summary point would fail to load.
CREATE TABLE IF NOT EXISTS ${DB}.otel_metrics_exponential_histogram (
    service_name            VARCHAR(256),
    timestamp               DATETIME(6) NOT NULL,
    service_instance_id     VARCHAR(256),
    metric_name             VARCHAR(256),
    metric_description      STRING,
    metric_unit             VARCHAR(64),
    attributes              VARIANT,
    start_time              DATETIME(6),
    count                   BIGINT,
    sum                     DOUBLE,
    scale                   INT,
    zero_count              BIGINT,
    positive_offset         INT,
    positive_bucket_counts  ARRAY<BIGINT>,
    negative_offset         INT,
    negative_bucket_counts  ARRAY<BIGINT>,
    exemplars               VARIANT,
    min                     DOUBLE,
    max                     DOUBLE,
    zero_threshold          DOUBLE,
    aggregation_temporality VARCHAR(32),
    resource_attributes     VARIANT,
    scope_name              VARCHAR(256),
    scope_version           VARCHAR(64),
    INDEX idx_metric_name (metric_name) USING INVERTED,
    INDEX idx_attributes (attributes) USING INVERTED
)
DUPLICATE KEY (service_name, timestamp)
AUTO PARTITION BY RANGE (date_trunc(timestamp, 'day')) ()
DISTRIBUTED BY RANDOM BUCKETS AUTO
PROPERTIES (
    "replication_num" = "${REPLICATION_NUM}",
    "compaction_policy" = "time_series",
    "partition.retention_count" = "${RETENTION_DAYS}"
);

CREATE TABLE IF NOT EXISTS ${DB}.otel_metrics_summary (
    service_name          VARCHAR(256),
    timestamp             DATETIME(6) NOT NULL,
    service_instance_id   VARCHAR(256),
    metric_name           VARCHAR(256),
    metric_description    STRING,
    metric_unit           VARCHAR(64),
    attributes            VARIANT,
    start_time            DATETIME(6),
    count                 BIGINT,
    sum                   DOUBLE,
    quantile_values       ARRAY<STRUCT<quantile:DOUBLE, value:DOUBLE>>,
    resource_attributes   VARIANT,
    scope_name            VARCHAR(256),
    scope_version         VARCHAR(64),
    INDEX idx_metric_name (metric_name) USING INVERTED,
    INDEX idx_attributes (attributes) USING INVERTED
)
DUPLICATE KEY (service_name, timestamp)
AUTO PARTITION BY RANGE (date_trunc(timestamp, 'day')) ()
DISTRIBUTED BY RANDOM BUCKETS AUTO
PROPERTIES (
    "replication_num" = "${REPLICATION_NUM}",
    "compaction_policy" = "time_series",
    "partition.retention_count" = "${RETENTION_DAYS}"
);
