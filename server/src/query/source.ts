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
  columns: Column[];
}

const col = (name: string, type: ColumnType, index: IndexKind = 'none'): Column => ({ name, type, index });

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
    columns: [
      col('service_name', 'string', 'keyword'),
      col('timestamp', 'datetime'),
      col('service_instance_id', 'string'),
      col('trace_id', 'string', 'keyword'),
      col('span_id', 'string', 'keyword'),
      col('severity_number', 'number'),
      col('severity_text', 'string', 'keyword'),
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
    defaultFields: ['span_name'],
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
    columns: [
      col('service_name', 'string', 'keyword'),
      col('timestamp', 'datetime'),
      col('service_instance_id', 'string'),
      col('trace_id', 'string', 'keyword'),
      col('span_id', 'string', 'keyword'),
      col('trace_state', 'string'),
      col('parent_span_id', 'string', 'keyword'),
      col('span_name', 'string', 'keyword'),
      col('span_kind', 'string', 'keyword'),
      col('end_time', 'datetime'),
      col('duration', 'number', 'keyword'),
      col('span_attributes', 'variant', 'keyword'),
      col('status_message', 'string'),
      col('status_code', 'string', 'keyword'),
      col('resource_attributes', 'variant', 'keyword'),
      col('scope_name', 'string'),
      col('scope_version', 'string'),
      col('is_root', 'number'),
    ],
  };
}
