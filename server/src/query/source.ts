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
 * otel_sessions (schema/002_sessions.sql): the events of browser sessions, searched to find
 * sessions. Replay payloads are never selected through the search language.
 */
export function sessionsSource(db = 'otel'): Source {
  return {
    name: 'sessions',
    table: `${db}.otel_sessions`,
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
