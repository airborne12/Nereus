import { useEffect, useState } from 'react';
import * as api from '../api.ts';
import { isError, rowFields, waterfall, type Span } from '../lib/rows.ts';
import { dorisTimeToMs } from '../lib/state.ts';
import { formatDuration } from './ResultsTable.tsx';

interface Props {
  traceId: string;
  range: api.Range;
  onClose: () => void;
}

/** Waterfall of one trace: a row per span in tree order, bars placed on the trace's timeline. */
export function TraceView({ traceId, range, onClose }: Props) {
  const [spans, setSpans] = useState<Span[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [picked, setPicked] = useState<Span | null>(null);

  useEffect(() => {
    const ac = new AbortController();
    setSpans(null);
    setError(null);
    // Spans of a trace start within minutes of each other; widen the window by a day each side.
    api.trace(traceId, { from: range.from - 86400_000, to: range.to + 86400_000 }, ac.signal)
      .then((r) => setSpans(r.spans), (e) => !ac.signal.aborted && setError(String(e.message ?? e)));
    return () => ac.abort();
  }, [traceId, range.from, range.to]);

  const { rows, totalMs } = waterfall(spans ?? [], dorisTimeToMs);
  const services = [...new Set(rows.map((r) => r.span.service_name))];
  const color = (svc: string) => `var(--series-${(services.indexOf(svc) % 8) + 1})`;

  return (
    <div className="trace-overlay" role="dialog" aria-label={`Trace ${traceId}`}>
      <div className="trace">
        <div className="detail-head">
          <strong>Trace</strong>
          <code className="muted">{traceId}</code>
          <span className="grow" />
          {spans && <span className="muted">{spans.length} {spans.length === 1 ? 'span' : 'spans'} · {formatDuration(totalMs * 1000)}</span>}
          <button type="button" className="btn" aria-label="Close trace" onClick={onClose}>✕</button>
        </div>
        {error && <div className="error">{error}</div>}
        {!spans && !error && <div className="empty">Loading…</div>}
        {spans && spans.length === 0 && <div className="empty">No spans for this trace in the time window.</div>}
        <div className="waterfall">
          {rows.map((r) => (
            <div key={r.span.span_id} className={`wf-row${picked?.span_id === r.span.span_id ? ' selected' : ''}`}
              onClick={() => setPicked(r.span)} data-span={r.span.span_id}>
              <div className="wf-name" style={{ paddingLeft: 8 + r.depth * 14 }}>
                <span className="wf-svc" style={{ color: color(r.span.service_name) }}>{r.span.service_name}</span>{' '}
                {r.span.span_name}
              </div>
              <div className="wf-track">
                <div className={`wf-bar${isError(r.span.status_code) ? ' err' : ''}`}
                  style={{
                    left: `${(r.offsetMs / (totalMs || 1)) * 100}%`,
                    width: `max(2px, ${(r.durationMs / (totalMs || 1)) * 100}%)`,
                    background: isError(r.span.status_code) ? undefined : color(r.span.service_name),
                  }} />
                <span className="wf-dur mono">{formatDuration(r.span.duration)}</span>
              </div>
            </div>
          ))}
        </div>
        {picked && (
          <section className="span-detail" aria-label="Span details">
            <h3>{picked.service_name} · {picked.span_name}</h3>
            <dl>
              {rowFields(picked as unknown as Record<string, unknown>).map((f) => (
                <div className="kv" key={`${f.group}.${f.field}`}>
                  <dt title={f.field}>{f.field}</dt>
                  <dd className="mono">{f.value}</dd>
                  <span />
                </div>
              ))}
            </dl>
          </section>
        )}
      </div>
    </div>
  );
}
