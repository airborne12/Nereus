import type { Row } from '../lib/rows.ts';
import { isError } from '../lib/rows.ts';
import { dorisTimeToMs, type SourceName } from '../lib/state.ts';

interface Props {
  source: SourceName;
  rows: Row[];
  selected: number | null;
  onSelect: (i: number) => void;
}

export function formatTime(t: unknown): string {
  const ms = dorisTimeToMs(String(t));
  const d = new Date(ms);
  const pad = (n: number, w = 2) => String(n).padStart(w, '0');
  return `${d.toLocaleDateString(undefined, { month: 'short', day: 'numeric' })} ` +
    `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}.${pad(d.getMilliseconds(), 3)}`;
}

function levelClass(level: unknown): string {
  const l = String(level ?? '').toUpperCase();
  if (l.startsWith('ERR') || l === 'FATAL') return 'lvl lvl-error';
  if (l.startsWith('WARN')) return 'lvl lvl-warn';
  if (l.startsWith('DEBUG') || l.startsWith('TRACE')) return 'lvl lvl-debug';
  return 'lvl lvl-info';
}

export function formatDuration(us: unknown): string {
  const n = Number(us);
  if (n < 1000) return `${n} µs`;
  if (n < 1_000_000) return `${(n / 1000).toFixed(n < 10_000 ? 2 : 1)} ms`;
  return `${(n / 1_000_000).toFixed(2)} s`;
}

/** Newest-first result rows. Click a row to open its details. */
export function ResultsTable({ source, rows, selected, onSelect }: Props) {
  if (rows.length === 0) return <div className="empty">No matches in this time range.</div>;
  return (
    <table className="results">
      <thead>
        {source === 'logs' ? (
          <tr><th className="c-time">Time</th><th className="c-svc">Service</th><th className="c-lvl">Level</th><th>Body</th></tr>
        ) : (
          <tr><th className="c-time">Time</th><th className="c-svc">Service</th><th>Span</th><th className="c-dur">Duration</th><th className="c-lvl">Status</th></tr>
        )}
      </thead>
      <tbody>
        {rows.map((r, i) => (
          <tr key={i} className={i === selected ? 'selected' : ''} onClick={() => onSelect(i)} data-row={i}>
            <td className="c-time mono">{formatTime(r.timestamp)}</td>
            <td className="c-svc">{String(r.service_name ?? '')}</td>
            {source === 'logs' ? (
              <>
                <td className="c-lvl"><span className={levelClass(r.severity_text)}>{String(r.severity_text ?? '')}</span></td>
                <td className="c-body mono">{String(r.body ?? '')}</td>
              </>
            ) : (
              <>
                <td className="c-body">{String(r.span_name ?? '')}</td>
                <td className="c-dur mono">{formatDuration(r.duration)}</td>
                <td className="c-lvl">{isError(r.status_code) ? <span className="lvl lvl-error">error</span> : <span className="muted">ok</span>}</td>
              </>
            )}
          </tr>
        ))}
      </tbody>
    </table>
  );
}
