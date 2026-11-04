import type * as api from '../api.ts';
import type { Row } from '../lib/rows.ts';
import { isError } from '../lib/rows.ts';
import { dorisTimeToMs } from '../lib/state.ts';
import { Icon } from './Icon.tsx';

export function formatTime(t: unknown): string {
  const ms = dorisTimeToMs(String(t));
  const d = new Date(ms);
  const pad = (n: number, w = 2) => String(n).padStart(w, '0');
  return `${d.toLocaleDateString(undefined, { month: 'short', day: 'numeric' })} ` +
    `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}.${pad(d.getMilliseconds(), 3)}`;
}

export function formatDuration(us: unknown): string {
  const n = Number(us);
  if (n < 1000) return `${n} µs`;
  if (n < 1_000_000) return `${(n / 1000).toFixed(n < 10_000 ? 2 : 1)} ms`;
  return `${(n / 1_000_000).toFixed(2)} s`;
}

export function levelClass(level: unknown): string {
  const l = String(level ?? '').toUpperCase();
  if (l.startsWith('ERR') || l === 'FATAL') return 'lvl lvl-error';
  if (l.startsWith('WARN')) return 'lvl lvl-warn';
  if (l.startsWith('DEBUG') || l.startsWith('TRACE')) return 'lvl lvl-debug';
  return 'lvl lvl-info';
}

/** Fixed widths for the usual columns; the rest share what is left. */
const COL_CLASS: Record<string, string> = {
  timestamp: 'c-time', severity_text: 'c-lvl', status_code: 'c-lvl', service_name: 'c-svc', duration: 'c-dur',
};

function Cell({ col, row }: { col: api.Column; row: Row }) {
  const v = row[col.key];
  if (col.key === 'timestamp') {
    const text = formatTime(v);
    const cut = text.lastIndexOf(' ');
    return <td className="c-time mono"><span className="date">{text.slice(0, cut + 1)}</span>{text.slice(cut + 1)}</td>;
  }
  if (col.key === 'severity_text') return <td className="c-lvl"><span className={levelClass(v)}>{String(v ?? '')}</span></td>;
  if (col.key === 'status_code') {
    return (
      <td className="c-lvl">
        {isError(v) ? <span className="lvl lvl-error">Error</span>
          : <span className="muted">{String(v ?? '').replace('STATUS_CODE_', '').toLowerCase()}</span>}
      </td>
    );
  }
  const text = v === null || v === undefined ? '' : typeof v === 'object' ? JSON.stringify(v) : String(v);
  // Same class as the header cell, so narrow-screen rules hide or size both alike.
  return <td className={`${COL_CLASS[col.key] ?? ''} ${col.key === 'body' || col.key === 'span_name' ? 'c-body ' : ''}mono`}>{text}</td>;
}

interface Props {
  columns: api.Column[];
  rows: Row[];
  selected: number | null;
  wrap: boolean;
  loadingMore: boolean;
  done: boolean;
  onSelect: (i: number) => void;
  onRemoveColumn: (label: string) => void;
  onNearEnd: () => void;
  onScrollTop: (top: number) => void;
}

/** Result rows; the columns follow SELECT. Scrolling near the end loads the next page. */
export function ResultsTable(p: Props) {
  const tz = Intl.DateTimeFormat().resolvedOptions().timeZone.split('/').at(-1);
  return (
    <div className={`table-wrap${p.wrap ? ' wrap' : ''}`} onScroll={(e) => {
      const el = e.currentTarget;
      p.onScrollTop(el.scrollTop);
      if (el.scrollHeight - el.scrollTop - el.clientHeight < 500 && !p.done && !p.loadingMore) p.onNearEnd();
    }}>
      {p.rows.length === 0 ? <div className="empty">No results found in this time range.</div> : (
        <table className="results">
          <thead>
            <tr>
              {p.columns.map((c) => (
                <th key={c.key} className={COL_CLASS[c.key] ?? ''}>
                  <span className="th">{c.key === 'timestamp' ? `timestamp (${tz})` : c.label}</span>
                  <button type="button" className="th-remove" title="Remove column" aria-label={`Remove column ${c.label}`}
                    onClick={() => p.onRemoveColumn(c.label)}><Icon name="close" size={10} /></button>
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {p.rows.map((r, i) => (
              <tr key={i} className={i === p.selected ? 'selected' : ''} onClick={() => p.onSelect(i)} data-row={i}>
                {p.columns.map((c) => <Cell key={c.key} col={c} row={r} />)}
              </tr>
            ))}
          </tbody>
        </table>
      )}
      {p.rows.length > 0 && <div className="table-foot muted">{p.loadingMore ? 'Loading results' : p.done ? 'End of Results' : ''}</div>}
    </div>
  );
}
