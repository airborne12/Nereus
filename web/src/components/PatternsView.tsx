import { useEffect, useState } from 'react';
import * as api from '../api.ts';
import { minePatterns, type Pattern } from '../lib/patterns.ts';
import type { Row } from '../lib/rows.ts';
import { dorisTimeToMs } from '../lib/state.ts';
import { formatTime, levelClass } from './ResultsTable.tsx';

const SAMPLE = 2000;

function Sparkline({ values }: { values: number[] }) {
  const max = Math.max(1, ...values);
  const w = 120, h = 22;
  const pts = values.map((v, i) => `${(i / (values.length - 1)) * w},${h - (v / max) * (h - 2) - 1}`).join(' ');
  return (
    <svg width={w} height={h} viewBox={`0 0 ${w} ${h}`} className="spark" aria-hidden="true">
      <polyline points={pts} fill="none" stroke="var(--accent)" strokeWidth="1.5" />
    </svg>
  );
}

/** Log lines grouped by template, mined from a sample of the newest matching rows. */
export function PatternsView({ spec, total, onOpen }: { spec: api.Spec; total: number; onOpen: (r: Row) => void }) {
  const [patterns, setPatterns] = useState<Pattern[] | null>(null);
  const [sampled, setSampled] = useState(0);
  const [open, setOpen] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    const ac = new AbortController();
    setPatterns(null);
    setError(null);
    api.search(spec, { limit: SAMPLE }, ac.signal).then((r) => {
      setSampled(r.rows.length);
      // Trends span the sample's own time range: the newest rows may cover only part of the window.
      const times = r.rows.map((x) => dorisTimeToMs(String(x.timestamp)));
      const from = times.length ? Math.min(...times) : spec.range.from;
      const to = times.length ? Math.max(...times) + 1 : spec.range.to;
      setPatterns(minePatterns(r.rows, 'body', 'severity_text', from, to, 24, (x) => dorisTimeToMs(String(x.timestamp))));
    }, (e) => !ac.signal.aborted && setError(String(e.message ?? e)));
    return () => ac.abort();
  }, [spec]);
  if (error) return <div className="error">{error}</div>;
  if (!patterns) return <div className="empty">Mining patterns from up to {SAMPLE.toLocaleString()} events…</div>;
  const scale = sampled ? Math.max(1, total / sampled) : 1;
  return (
    <div className="table-wrap">
      <div className="muted small pad">{patterns.length} patterns in a sample of {sampled.toLocaleString()} of {total.toLocaleString()} events; counts are scaled to all events.</div>
      <table className="results patterns">
        <thead><tr><th className="c-trend">Trend</th><th className="c-count">Count</th><th className="c-lvl">Level</th><th>Pattern</th></tr></thead>
        <tbody>
          {patterns.map((p) => [
            <tr key={p.pattern} onClick={() => setOpen(open === p.pattern ? null : p.pattern)} className={open === p.pattern ? 'selected' : ''}>
              <td className="c-trend"><Sparkline values={p.trend} /></td>
              <td className="c-count mono">~{Math.round(p.count * scale).toLocaleString()}</td>
              <td className="c-lvl"><span className={levelClass(p.level)}>{p.level}</span></td>
              <td className="c-body mono">{p.pattern}</td>
            </tr>,
            open === p.pattern && (
              <tr key={`${p.pattern}-samples`} className="samples">
                <td colSpan={4}>
                  <table className="results inner">
                    <tbody>
                      {p.samples.slice(0, 20).map((s, i) => (
                        <tr key={i} onClick={() => onOpen(s)}>
                          <td className="c-time mono">{formatTime(s.timestamp)}</td>
                          <td className="c-svc">{String(s.service_name ?? '')}</td>
                          <td className="c-body mono">{String(s.body ?? '')}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </td>
              </tr>
            ),
          ])}
        </tbody>
      </table>
    </div>
  );
}
