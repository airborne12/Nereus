-- Agent trajectories (docs/superpowers/specs/2026-11-11-agent-sessions-design.md, section 5).
-- Unique-key merge-on-write tables keyed by the capture source, so writing the same capture twice
-- gives the same rows. A session is one branch: a main session, a sub-agent or a fork.

CREATE TABLE IF NOT EXISTS ${DB}.agent_sessions (
    session_id         VARCHAR(128) NOT NULL,
    root_id            VARCHAR(128) NOT NULL,
    parent_id          VARCHAR(128),
    parent_seq         BIGINT,
    kind               VARCHAR(16) NOT NULL COMMENT 'main | subagent | fork',
    title              STRING,
    agent_name         VARCHAR(256),
    runtime            VARCHAR(64),
    runtime_version    VARCHAR(64),
    service_name       VARCHAR(256),
    user_id            VARCHAR(256),
    model              VARCHAR(128),
    config             VARIANT,
    started_at         DATETIME(6) NOT NULL,
    last_event_at      DATETIME(6) NOT NULL,
    last_seq           BIGINT NOT NULL,
    last_msg_seq       BIGINT NOT NULL,
    turns              INT,
    steps              INT,
    tool_calls         INT,
    tool_errors        INT,
    subagents          INT,
    compactions        INT,
    input_tokens       BIGINT,
    output_tokens      BIGINT,
    cache_read_tokens  BIGINT,
    cache_write_tokens BIGINT,
    peak_ctx_tokens    BIGINT,
    active_us          BIGINT,
    first_input        STRING,
    last_output        STRING,
    safety_risks       INT,
    source             VARCHAR(32) NOT NULL,
    source_cursor      STRING,
    INDEX idx_root_id (root_id) USING INVERTED,
    INDEX idx_parent_id (parent_id) USING INVERTED,
    INDEX idx_kind (kind) USING INVERTED,
    INDEX idx_runtime (runtime) USING INVERTED,
    INDEX idx_model (model) USING INVERTED,
    INDEX idx_service_name (service_name) USING INVERTED,
    INDEX idx_user_id (user_id) USING INVERTED,
    INDEX idx_title (title) USING INVERTED PROPERTIES ("parser" = "unicode", "lower_case" = "true", "support_phrase" = "true"),
    INDEX idx_first_input (first_input) USING INVERTED PROPERTIES ("parser" = "unicode", "lower_case" = "true", "support_phrase" = "true"),
    INDEX idx_last_output (last_output) USING INVERTED PROPERTIES ("parser" = "unicode", "lower_case" = "true", "support_phrase" = "true")
)
UNIQUE KEY (session_id)
DISTRIBUTED BY HASH (session_id) BUCKETS AUTO
PROPERTIES (
    "replication_num" = "${REPLICATION_NUM}",
    "enable_unique_key_merge_on_write" = "true",
    "compression" = "zstd"
);

CREATE TABLE IF NOT EXISTS ${DB}.agent_events (
    session_id         VARCHAR(128) NOT NULL,
    seq                BIGINT NOT NULL,
    ts                 DATETIME(6) NOT NULL,
    turn               INT NOT NULL,
    step               INT NOT NULL,
    kind               VARCHAR(24) NOT NULL COMMENT 'user_input | llm_call | tool_call | compaction | error | note',
    parent_seq         BIGINT,
    name               VARCHAR(256),
    status             VARCHAR(16) COMMENT 'ok | error | empty',
    error              STRING,
    end_ts             DATETIME(6),
    duration_us        BIGINT,
    ttft_us            BIGINT,
    gap_us             BIGINT,
    model              VARCHAR(128),
    stop_reason        VARCHAR(64),
    request_id         VARCHAR(128),
    attempt            INT,
    input_tokens       BIGINT,
    output_tokens      BIGINT,
    cache_read_tokens  BIGINT,
    cache_write_tokens BIGINT,
    ctx_msgs           INT,
    ctx_prefix         INT,
    ctx_change         VARCHAR(16) COMMENT 'fresh | append | truncate | compact',
    ctx_exact          BOOLEAN,
    prompt_hash        VARCHAR(64),
    msg_seq            BIGINT,
    result_msg         BIGINT,
    tool_call_id       VARCHAR(128),
    resource           STRING,
    args               VARIANT,
    args_hash          VARCHAR(32),
    repeat_of          BIGINT,
    repeat_visible     BOOLEAN,
    trace_id           VARCHAR(64),
    span_id            VARCHAR(32),
    attrs              VARIANT,
    INDEX idx_kind (kind) USING INVERTED,
    INDEX idx_name (name) USING INVERTED,
    INDEX idx_status (status) USING INVERTED,
    INDEX idx_model (model) USING INVERTED,
    INDEX idx_request_id (request_id) USING INVERTED,
    INDEX idx_trace_id (trace_id) USING INVERTED,
    INDEX idx_resource (resource) USING INVERTED,
    INDEX idx_args (args) USING INVERTED,
    INDEX idx_attrs (attrs) USING INVERTED
)
UNIQUE KEY (session_id, seq, ts)
AUTO PARTITION BY RANGE (date_trunc(ts, 'day')) ()
DISTRIBUTED BY HASH (session_id) BUCKETS AUTO
PROPERTIES (
    "replication_num" = "${REPLICATION_NUM}",
    "enable_unique_key_merge_on_write" = "true",
    "compression" = "zstd",
    "partition.retention_count" = "${AGENT_RETENTION_DAYS}"
);

CREATE TABLE IF NOT EXISTS ${DB}.agent_messages (
    session_id    VARCHAR(128) NOT NULL,
    msg_seq       BIGINT NOT NULL,
    ts            DATETIME(6) NOT NULL,
    content_hash  VARCHAR(64) NOT NULL,
    msg_role      VARCHAR(16) NOT NULL COMMENT 'system | user | assistant | tool',
    kind          VARCHAR(24) NOT NULL COMMENT 'text | tool_use | tool_result | thinking | summary | attachment',
    api_msg       INT NOT NULL,
    event_seq     BIGINT,
    tool_name     VARCHAR(256),
    tool_call_id  VARCHAR(128),
    is_error      BOOLEAN,
    bytes         INT,
    tokens        INT,
    truncated     BOOLEAN,
    text          STRING,
    payload       VARIANT,
    INDEX idx_msg_role (msg_role) USING INVERTED,
    INDEX idx_kind (kind) USING INVERTED,
    INDEX idx_tool_name (tool_name) USING INVERTED,
    INDEX idx_content_hash (content_hash) USING INVERTED,
    INDEX idx_text (text) USING INVERTED PROPERTIES ("parser" = "unicode", "lower_case" = "true", "support_phrase" = "true")
)
UNIQUE KEY (session_id, msg_seq, ts)
AUTO PARTITION BY RANGE (date_trunc(ts, 'day')) ()
DISTRIBUTED BY HASH (session_id) BUCKETS AUTO
PROPERTIES (
    "replication_num" = "${REPLICATION_NUM}",
    "enable_unique_key_merge_on_write" = "true",
    "compression" = "zstd",
    "storage_page_size" = "262144",
    "partition.retention_count" = "${AGENT_RETENTION_DAYS}"
);

CREATE TABLE IF NOT EXISTS ${DB}.agent_contexts (
    session_id  VARCHAR(128) NOT NULL,
    seq         BIGINT NOT NULL,
    rel         VARCHAR(4) NOT NULL COMMENT 'in: the call saw the run. out: the previous call saw it and this one does not',
    pos         INT NOT NULL,
    ts          DATETIME(6) NOT NULL,
    from_msg    BIGINT NOT NULL,
    to_msg      BIGINT NOT NULL
)
UNIQUE KEY (session_id, seq, rel, pos, ts)
AUTO PARTITION BY RANGE (date_trunc(ts, 'day')) ()
DISTRIBUTED BY HASH (session_id) BUCKETS AUTO
PROPERTIES (
    "replication_num" = "${REPLICATION_NUM}",
    "enable_unique_key_merge_on_write" = "true",
    "compression" = "zstd",
    "partition.retention_count" = "${AGENT_RETENTION_DAYS}"
);

CREATE TABLE IF NOT EXISTS ${DB}.agent_prompts (
    prompt_hash  VARCHAR(64) NOT NULL,
    system_text  STRING,
    tools        VARIANT,
    tool_names   ARRAY<STRING>,
    bytes        INT,
    first_seen   DATETIME(6)
)
UNIQUE KEY (prompt_hash)
DISTRIBUTED BY HASH (prompt_hash) BUCKETS AUTO
PROPERTIES (
    "replication_num" = "${REPLICATION_NUM}",
    "enable_unique_key_merge_on_write" = "true",
    "compression" = "zstd"
);

-- Risks the safety rules found (section 5.6): one row per place where a session broke a rule.
-- Written by the rules job, which replaces the rows of a tree each time it runs on it.
CREATE TABLE IF NOT EXISTS ${DB}.agent_risks (
    session_id    VARCHAR(128) NOT NULL,
    rule          VARCHAR(64)  NOT NULL,
    first_seq     BIGINT       NOT NULL,
    rule_version  INT          NOT NULL,
    rule_name     STRING,
    root_id       VARCHAR(128) NOT NULL,
    ts            DATETIME(6),
    turn          INT,
    events        ARRAY<BIGINT>,
    steps         VARIANT,
    what          STRING,
    why           STRING,
    found_at      DATETIME(6),
    INDEX idx_rule (rule) USING INVERTED,
    INDEX idx_root_id (root_id) USING INVERTED,
    INDEX idx_rule_name (rule_name) USING INVERTED PROPERTIES ("parser" = "unicode", "lower_case" = "true", "support_phrase" = "true"),
    INDEX idx_what (what) USING INVERTED PROPERTIES ("parser" = "unicode", "lower_case" = "true", "support_phrase" = "true")
)
UNIQUE KEY (session_id, rule, first_seq)
DISTRIBUTED BY HASH (session_id) BUCKETS AUTO
PROPERTIES (
    "replication_num" = "${REPLICATION_NUM}",
    "enable_unique_key_merge_on_write" = "true",
    "compression" = "zstd"
);

-- Judge versions (section 5.7): one row per version of a judge, never changed. The judge runs
-- write them from the versions kept in PostgreSQL, so verdicts can be joined with what made them.
CREATE TABLE IF NOT EXISTS ${DB}.agent_judges (
    judge       VARCHAR(64)  NOT NULL,
    version     INT          NOT NULL,
    name        STRING,
    form        VARCHAR(8),
    pick        VARIANT,
    reads       VARIANT,
    criterion   STRING,
    model       VARCHAR(128),
    created_at  DATETIME(6),
    created_by  VARCHAR(256)
)
UNIQUE KEY (judge, version)
DISTRIBUTED BY HASH (judge) BUCKETS 1
PROPERTIES (
    "replication_num" = "${REPLICATION_NUM}",
    "enable_unique_key_merge_on_write" = "true",
    "compression" = "zstd"
);

-- Verdicts of map judges and states of fold judges (section 5.8). A rerun adds rows with its
-- judge version; older rows stay, so a step's verdicts can be compared across versions.
CREATE TABLE IF NOT EXISTS ${DB}.agent_judgments (
    judge          VARCHAR(64)  NOT NULL,
    subject        VARCHAR(256) NOT NULL,
    judge_version  INT          NOT NULL,
    version        INT          NOT NULL,
    session_id     VARCHAR(128),
    seq            BIGINT,
    verdict        VARCHAR(16),
    state          VARCHAR(16),
    evidence       VARCHAR(16),
    prev_version   INT,
    reason         STRING,
    input_seqs     ARRAY<BIGINT>,
    input_hash     VARCHAR(64),
    model          VARCHAR(128),
    input_tokens   INT,
    output_tokens  INT,
    judged_at      DATETIME(6)  NOT NULL,
    INDEX idx_judge (judge) USING INVERTED,
    INDEX idx_session_id (session_id) USING INVERTED,
    INDEX idx_verdict (verdict) USING INVERTED
)
UNIQUE KEY (judge, subject, judge_version, version)
DISTRIBUTED BY HASH (subject) BUCKETS AUTO
PROPERTIES (
    "replication_num" = "${REPLICATION_NUM}",
    "enable_unique_key_merge_on_write" = "true",
    "compression" = "zstd"
);
