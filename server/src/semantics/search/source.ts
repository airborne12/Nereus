// Data sources: which Doris table a search runs on and what the compiler may know about it.
// Column names in compiled SQL come only from here, never from the user's query text.

export type ColumnType = 'string' | 'number' | 'datetime' | 'variant';

/**
 * keyword  = untokenized inverted index (exact terms)
 * fulltext = tokenized inverted index with phrase support (lower-cased)
 * none     = no inverted index: search() refuses the column, so it is compiled to SQL
 */
export type IndexKind = 'none' | 'keyword' | 'fulltext';

export interface Column {
  name: string;
  type: ColumnType;
  index: IndexKind;
  /**
   * Values are matched in their upper-case, lower-case and capitalised forms (ERROR, error,
   * Error), for keyword-indexed fields whose writers disagree on case, such as log levels.
   */
  caseInsensitive?: boolean;
  /** Short values users type -> stored values, matched case-insensitively (error -> STATUS_CODE_ERROR). */
  valueAliases?: Record<string, string>;
  /** Unit of a number column; values may then carry a unit suffix (50ms, 1.5s). */
  unit?: 'us';
}

export interface Source {
  name: string;
  table: string;
  timestampColumn: string;
  /** Columns a bare term (no field) searches, ORed. */
  defaultFields: string[];
  /** Variant columns an unknown dotted field is looked up in, ORed (e.g. k8s.pod.name). */
  attributeColumns: string[];
  /** Search bar field name -> column name (or column.path). */
  aliases: Record<string, string>;
  /** A bare term that looks like an id also matches this column (pasted trace or span ids). */
  idColumns?: { pattern: RegExp; column: string }[];
  columns: Column[];
  /** The SELECT list of a search with none; the log columns when absent. */
  defaultSelect?: string;
}

const col = (name: string, type: ColumnType, index: IndexKind = 'none', extra: Partial<Column> = {}): Column =>
  ({ name, type, index, ...extra });

const ID_COLUMNS = [
  { pattern: /^[0-9a-fA-F]{32}$/, column: 'trace_id' },
  { pattern: /^[0-9a-fA-F]{16}$/, column: 'span_id' },
];

/** otel_logs as created by schema/001_otel_tables.sql. */
export function logsSource(db = 'otel'): Source {
  return {
    name: 'logs',
    table: `${db}.otel_logs`,
    timestampColumn: 'timestamp',
    defaultFields: ['body'],
    attributeColumns: ['log_attributes', 'resource_attributes'],
    aliases: {
      service: 'service_name',
      level: 'severity_text',
      severity: 'severity_text',
      message: 'body',
      msg: 'body',
      trace: 'trace_id',
      span: 'span_id',
    },
    idColumns: ID_COLUMNS,
    columns: [
      col('service_name', 'string', 'keyword'),
      col('timestamp', 'datetime'),
      col('service_instance_id', 'string'),
      col('trace_id', 'string', 'keyword'),
      col('span_id', 'string', 'keyword'),
      col('severity_number', 'number'),
      col('severity_text', 'string', 'keyword', { caseInsensitive: true, valueAliases: { warning: 'WARN', err: 'ERROR' } }),
      col('body', 'string', 'fulltext'),
      col('resource_attributes', 'variant', 'keyword'),
      col('log_attributes', 'variant', 'keyword'),
      col('scope_name', 'string'),
      col('scope_version', 'string'),
    ],
  };
}

/** otel_traces as created by schema/001_otel_tables.sql. */
export function tracesSource(db = 'otel'): Source {
  return {
    name: 'traces',
    table: `${db}.otel_traces`,
    timestampColumn: 'timestamp',
    defaultFields: ['span_name', 'service_name'],
    attributeColumns: ['span_attributes', 'resource_attributes'],
    aliases: {
      service: 'service_name',
      name: 'span_name',
      kind: 'span_kind',
      status: 'status_code',
      trace: 'trace_id',
      span: 'span_id',
      parent: 'parent_span_id',
    },
    idColumns: ID_COLUMNS,
    columns: [
      col('service_name', 'string', 'keyword'),
      col('timestamp', 'datetime'),
      col('service_instance_id', 'string'),
      col('trace_id', 'string', 'keyword'),
      col('span_id', 'string', 'keyword'),
      col('trace_state', 'string'),
      col('parent_span_id', 'string', 'keyword'),
      col('span_name', 'string', 'fulltext'),
      col('span_kind', 'string', 'keyword', {
        caseInsensitive: true,
        valueAliases: {
          server: 'SPAN_KIND_SERVER', client: 'SPAN_KIND_CLIENT', internal: 'SPAN_KIND_INTERNAL',
          producer: 'SPAN_KIND_PRODUCER', consumer: 'SPAN_KIND_CONSUMER',
        },
      }),
      col('end_time', 'datetime'),
      col('duration', 'number', 'keyword', { unit: 'us' }),
      col('span_attributes', 'variant', 'keyword'),
      col('status_message', 'string'),
      col('status_code', 'string', 'keyword', {
        caseInsensitive: true,
        valueAliases: { error: 'STATUS_CODE_ERROR', ok: 'STATUS_CODE_OK', unset: 'STATUS_CODE_UNSET' },
      }),
      col('resource_attributes', 'variant', 'keyword'),
      col('scope_name', 'string'),
      col('scope_version', 'string'),
      col('is_root', 'number'),
    ],
  };
}

/** otel_metrics_gauge: one row per data point; charted by aggregating `value`. */
export function metricsSource(db = 'otel'): Source {
  return {
    name: 'metrics',
    table: `${db}.otel_metrics_gauge`,
    timestampColumn: 'timestamp',
    defaultFields: ['metric_name'],
    attributeColumns: ['attributes', 'resource_attributes'],
    aliases: { service: 'service_name', metric: 'metric_name', name: 'metric_name' },
    idColumns: [],
    columns: [
      col('service_name', 'string'),
      col('timestamp', 'datetime'),
      col('service_instance_id', 'string'),
      col('metric_name', 'string', 'keyword'),
      col('metric_description', 'string'),
      col('metric_unit', 'string'),
      col('attributes', 'variant', 'keyword'),
      col('start_time', 'datetime'),
      col('value', 'number'),
      col('resource_attributes', 'variant'),
      col('scope_name', 'string'),
      col('scope_version', 'string'),
    ],
  };
}

/**
 * rum_sessions (schema/002_rum_sessions.sql): the events of browser sessions, searched to find
 * sessions. Replay payloads are never selected through the search language.
 */
export function rumSource(db = 'otel'): Source {
  return {
    name: 'rum',
    table: `${db}.rum_sessions`,
    timestampColumn: 'timestamp',
    defaultFields: ['message', 'url'],
    attributeColumns: ['attributes'],
    aliases: { service: 'service_name', type: 'event_type', email: 'user_email', user: 'user_email', session: 'session_id' },
    idColumns: [],
    columns: [
      col('session_id', 'string', 'keyword'),
      col('timestamp', 'datetime'),
      col('kind', 'string'),
      col('event_type', 'string', 'keyword'),
      col('service_name', 'string', 'keyword'),
      col('url', 'string', 'fulltext'),
      col('user_id', 'string', 'keyword'),
      col('user_email', 'string', 'keyword'),
      col('user_name', 'string'),
      col('user_agent', 'string'),
      col('message', 'string', 'fulltext'),
      col('attributes', 'variant', 'keyword'),
    ],
  };
}

/**
 * agent_sessions (schema/003_agent_tables.sql): one row per branch of an agent session; a main
 * row's counts cover its tree. Its time is the last activity.
 */
export function agentSessionsSource(db = 'otel'): Source {
  return {
    name: 'agent_sessions',
    defaultSelect: 'last_event_at, title, steps, tool_errors, first_input',
    table: `${db}.agent_sessions`,
    timestampColumn: 'last_event_at',
    defaultFields: ['title', 'first_input', 'last_output'],
    attributeColumns: ['config'],
    aliases: { session: 'session_id', root: 'root_id', parent: 'parent_id', agent: 'agent_name', user: 'user_id', service: 'service_name' },
    idColumns: [],
    columns: [
      col('session_id', 'string'),
      col('root_id', 'string', 'keyword'),
      col('parent_id', 'string', 'keyword'),
      col('parent_seq', 'number'),
      col('kind', 'string', 'keyword'),
      col('title', 'string', 'fulltext'),
      col('agent_name', 'string'),
      col('runtime', 'string', 'keyword'),
      col('runtime_version', 'string'),
      col('service_name', 'string', 'keyword'),
      col('user_id', 'string', 'keyword'),
      col('model', 'string', 'keyword'),
      col('config', 'variant'),
      col('started_at', 'datetime'),
      col('last_event_at', 'datetime'),
      ...['last_seq', 'last_msg_seq', 'turns', 'steps', 'tool_calls', 'tool_errors', 'subagents', 'compactions', 'input_tokens',
        'output_tokens', 'cache_read_tokens', 'cache_write_tokens', 'peak_ctx_tokens', 'safety_risks'].map((n) => col(n, 'number')),
      col('active_us', 'number', 'none', { unit: 'us' }),
      col('first_input', 'string', 'fulltext'),
      col('last_output', 'string', 'fulltext'),
      col('source', 'string'),
    ],
  };
}

/** agent_events: user inputs, model calls, tool calls, compactions and errors of agent sessions. */
export function agentEventsSource(db = 'otel'): Source {
  return {
    name: 'agent_events',
    defaultSelect: 'ts, session_id, kind, name, status, resource',
    table: `${db}.agent_events`,
    timestampColumn: 'ts',
    defaultFields: ['name', 'resource'],
    attributeColumns: ['args', 'attrs'],
    aliases: { session: 'session_id', tool: 'name', trace: 'trace_id', span: 'span_id' },
    idColumns: [{ pattern: /^[0-9a-fA-F]{32}$/, column: 'trace_id' }],
    columns: [
      col('session_id', 'string'),
      col('seq', 'number'),
      col('ts', 'datetime'),
      col('turn', 'number'),
      col('step', 'number'),
      col('kind', 'string', 'keyword'),
      col('parent_seq', 'number'),
      col('name', 'string', 'keyword'),
      col('status', 'string', 'keyword'),
      col('error', 'string'),
      col('end_ts', 'datetime'),
      col('duration_us', 'number', 'none', { unit: 'us' }),
      col('ttft_us', 'number', 'none', { unit: 'us' }),
      col('gap_us', 'number', 'none', { unit: 'us' }),
      col('model', 'string', 'keyword'),
      col('stop_reason', 'string'),
      col('request_id', 'string', 'keyword'),
      ...['attempt', 'input_tokens', 'output_tokens', 'cache_read_tokens', 'cache_write_tokens', 'ctx_msgs', 'ctx_prefix', 'msg_seq',
        'result_msg', 'repeat_of'].map((n) => col(n, 'number')),
      col('ctx_change', 'string'),
      col('prompt_hash', 'string'),
      col('tool_call_id', 'string'),
      col('resource', 'string', 'keyword'),
      col('args', 'variant', 'keyword'),
      col('args_hash', 'string'),
      col('trace_id', 'string', 'keyword'),
      col('span_id', 'string'),
      col('attrs', 'variant', 'keyword'),
    ],
  };
}

/** agent_risks: the places where a session broke a safety rule, written by the rules job. */
export function agentRisksSource(db = 'otel'): Source {
  return {
    name: 'agent_risks',
    defaultSelect: 'ts, session_id, rule_name, what, why',
    table: `${db}.agent_risks`,
    timestampColumn: 'ts',
    defaultFields: ['what', 'rule_name'],
    attributeColumns: [],
    aliases: { session: 'session_id', root: 'root_id' },
    idColumns: [],
    columns: [
      col('session_id', 'string'),
      col('rule', 'string', 'keyword'),
      col('first_seq', 'number'),
      col('rule_version', 'number'),
      col('rule_name', 'string', 'fulltext'),
      col('root_id', 'string', 'keyword'),
      col('ts', 'datetime'),
      col('turn', 'number'),
      col('what', 'string', 'fulltext'),
      col('why', 'string'),
      col('found_at', 'datetime'),
    ],
  };
}

/** agent_messages: the content blocks of agent sessions, each stored once. */
export function agentMessagesSource(db = 'otel'): Source {
  return {
    name: 'agent_messages',
    defaultSelect: 'ts, session_id, msg_role, kind, tool_name, text',
    table: `${db}.agent_messages`,
    timestampColumn: 'ts',
    defaultFields: ['text'],
    attributeColumns: ['payload'],
    aliases: { session: 'session_id', role: 'msg_role', tool: 'tool_name' },
    idColumns: [],
    columns: [
      col('session_id', 'string'),
      col('msg_seq', 'number'),
      col('ts', 'datetime'),
      col('content_hash', 'string', 'keyword'),
      col('msg_role', 'string', 'keyword'),
      col('kind', 'string', 'keyword'),
      col('api_msg', 'number'),
      col('event_seq', 'number'),
      col('tool_name', 'string', 'keyword'),
      col('tool_call_id', 'string'),
      col('bytes', 'number'),
      col('tokens', 'number'),
      col('text', 'string', 'fulltext'),
      col('payload', 'variant'),
    ],
  };
}
