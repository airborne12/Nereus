import { type Row, rowFields } from '../lib/rows.ts';

interface Props {
  row: Row;
  onFilter: (field: string, value: string, exclude: boolean) => void;
  onTrace: (traceId: string) => void;
  onClose: () => void;
}

const GROUP_TITLES: Record<string, string> = {
  fields: 'Fields',
  log_attributes: 'Log attributes',
  span_attributes: 'Span attributes',
  resource_attributes: 'Resource',
};

/** Every field of the selected row; each value can be added to the query as a filter. */
export function DetailPanel({ row, onFilter, onTrace, onClose }: Props) {
  const fields = rowFields(row);
  const groups = [...new Set(fields.map((f) => f.group))];
  const traceId = typeof row.trace_id === 'string' && /^[0-9a-f]{32}$/.test(row.trace_id) ? row.trace_id : null;
  return (
    <aside className="detail" aria-label="Event details">
      <div className="detail-head">
        <strong>Event</strong>
        <span className="grow" />
        {traceId && <button type="button" className="btn primary" onClick={() => onTrace(traceId)}>View trace</button>}
        <button type="button" className="btn" aria-label="Close details" onClick={onClose}>✕</button>
      </div>
      {typeof row.body === 'string' && <pre className="detail-body">{row.body}</pre>}
      {groups.map((g) => (
        <section key={g}>
          <h3>{GROUP_TITLES[g] ?? g}</h3>
          <dl>
            {fields.filter((f) => f.group === g && f.field !== 'body').map((f) => (
              <div className="kv" key={`${g}.${f.field}`}>
                <dt title={f.field}>{f.field}</dt>
                <dd className="mono">{f.value}</dd>
                <span className="kv-actions">
                  <button type="button" title={`Filter ${f.field} = ${f.value}`} aria-label={`Filter ${f.field}`}
                    onClick={() => onFilter(f.field, f.value, false)}>+</button>
                  <button type="button" title={`Exclude ${f.field} = ${f.value}`} aria-label={`Exclude ${f.field}`}
                    onClick={() => onFilter(f.field, f.value, true)}>−</button>
                </span>
              </div>
            ))}
          </dl>
        </section>
      ))}
    </aside>
  );
}
