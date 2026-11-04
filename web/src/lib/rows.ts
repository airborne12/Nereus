// Turning API rows into what the table, the detail panel and the trace view show.

export type Row = Record<string, unknown>;

/** Columns whose JSON holds attributes; their paths are filtered by the path alone. */
export const ATTRIBUTE_COLUMNS = ['log_attributes', 'span_attributes', 'resource_attributes'];

export interface FieldValue {
  /** Search bar field to filter on. */
  field: string;
  value: string;
  /** Group shown in the detail panel. */
  group: string;
}

function flatten(prefix: string, v: unknown, out: [string, string][]): void {
  if (v !== null && typeof v === 'object' && !Array.isArray(v)) {
    for (const [k, child] of Object.entries(v as Record<string, unknown>)) {
      flatten(prefix ? `${prefix}.${k}` : k, child, out);
    }
  } else if (v !== null && v !== undefined) {
    out.push([prefix, typeof v === 'string' ? v : JSON.stringify(v)]);
  }
}

function parseJson(v: unknown): unknown {
  if (typeof v !== 'string') return v;
  try {
    return JSON.parse(v);
  } catch {
    return v;
  }
}

/** Every field of a row as filterable field/value pairs, attributes flattened to dotted paths. */
export function rowFields(row: Row): FieldValue[] {
  const out: FieldValue[] = [];
  for (const [col, raw] of Object.entries(row)) {
    if (ATTRIBUTE_COLUMNS.includes(col)) {
      const pairs: [string, string][] = [];
      flatten('', parseJson(raw), pairs);
      for (const [path, value] of pairs) out.push({ field: path, value, group: col });
    } else if (col === 'events' || col === 'links' || col === 'exemplars') {
      continue;
    } else if (raw !== null && raw !== undefined && raw !== '') {
      out.push({ field: col, value: String(raw), group: 'fields' });
    }
  }
  return out;
}

export interface Span {
  span_id: string;
  parent_span_id: string;
  service_name: string;
  span_name: string;
  timestamp: string;
  /** microseconds */
  duration: number;
  status_code: string;
}

export interface WaterfallRow {
  span: Span;
  depth: number;
  /** ms after the trace start */
  offsetMs: number;
  durationMs: number;
}

/**
 * Spans in tree order (each parent before its children, siblings by start time) with their
 * depth and offsets. Spans whose parent is missing from the trace are shown as roots.
 */
export function waterfall(spans: Span[], toMs: (t: string) => number): { rows: WaterfallRow[]; totalMs: number } {
  if (spans.length === 0) return { rows: [], totalMs: 0 };
  const ids = new Set(spans.map((s) => s.span_id));
  const children = new Map<string, Span[]>();
  const roots: Span[] = [];
  for (const s of spans) {
    if (s.parent_span_id && ids.has(s.parent_span_id)) {
      const list = children.get(s.parent_span_id) ?? [];
      list.push(s);
      children.set(s.parent_span_id, list);
    } else {
      roots.push(s);
    }
  }
  const start = Math.min(...spans.map((s) => toMs(s.timestamp)));
  const end = Math.max(...spans.map((s) => toMs(s.timestamp) + Number(s.duration) / 1000));
  const byStart = (a: Span, b: Span) => toMs(a.timestamp) - toMs(b.timestamp);
  const rows: WaterfallRow[] = [];
  const visit = (s: Span, depth: number) => {
    rows.push({ span: s, depth, offsetMs: toMs(s.timestamp) - start, durationMs: Number(s.duration) / 1000 });
    for (const c of (children.get(s.span_id) ?? []).sort(byStart)) visit(c, depth + 1);
  };
  for (const r of roots.sort(byStart)) visit(r, 0);
  return { rows, totalMs: end - start };
}

export function isError(status: unknown): boolean {
  return status === 'STATUS_CODE_ERROR' || status === 'ERROR';
}
