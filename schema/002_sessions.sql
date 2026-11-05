-- Client sessions recorded by the browser SDK (web/sdk): rrweb replay chunks and the events of
-- the session (clicks, page views, errors, console errors, network requests). One session's rows
-- sit together (session_id leads the key). A replay chunk too big for one STRING value is split
-- into parts (seq, part) that the reader joins back.
CREATE TABLE IF NOT EXISTS ${DB}.otel_sessions (
    session_id   VARCHAR(64) NOT NULL,
    timestamp    DATETIME(6) NOT NULL,
    seq          INT NOT NULL,
    part         INT NOT NULL DEFAULT "0",
    kind         VARCHAR(16) NOT NULL COMMENT 'replay | event',
    event_type   VARCHAR(32) NOT NULL DEFAULT "" COMMENT 'click, navigation, error, console, network, custom',
    service_name VARCHAR(256) NOT NULL DEFAULT "",
    url          STRING,
    user_id      VARCHAR(256),
    user_email   VARCHAR(320),
    user_name    VARCHAR(256),
    user_agent   STRING,
    message      STRING,
    attributes   VARIANT,
    payload      STRING COMMENT 'rrweb events (JSON) of a replay chunk, or one part of it',
    INDEX idx_session_id (session_id) USING INVERTED,
    INDEX idx_event_type (event_type) USING INVERTED,
    INDEX idx_service_name (service_name) USING INVERTED,
    INDEX idx_user_email (user_email) USING INVERTED,
    INDEX idx_user_id (user_id) USING INVERTED,
    INDEX idx_url (url) USING INVERTED PROPERTIES ("parser" = "unicode", "lower_case" = "true", "support_phrase" = "true"),
    INDEX idx_message (message) USING INVERTED PROPERTIES ("parser" = "unicode", "lower_case" = "true", "support_phrase" = "true"),
    INDEX idx_attributes (attributes) USING INVERTED
)
DUPLICATE KEY (session_id, timestamp)
AUTO PARTITION BY RANGE (date_trunc(timestamp, 'day')) ()
DISTRIBUTED BY HASH (session_id) BUCKETS AUTO
PROPERTIES (
    "replication_num" = "${REPLICATION_NUM}",
    "compression" = "zstd",
    "partition.retention_count" = "${RETENTION_DAYS}"
);
