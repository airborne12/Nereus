import { useEffect, useMemo, useRef, useState } from 'react';
import * as api from '../api.ts';
import { dorisTimeToMs } from '../lib/state.ts';

/** Label of one series: "count", "p99(duration)". */
export function seriesLabel(s: api.ChartDef['series'][number]): string {
  return s.agg === 'count' ? 'count' : `${s.agg}(${s.field ?? ''})`;
}

export function formatValue(v: unknown): string {
  const n = Number(v);
  if (v === null || v === undefined || Number.isNaN(n)) return '–';
  if (Math.abs(n) >= 1e6) return `${(n / 1e6).toFixed(2)}M`;
  if (Math.abs(n) >= 1e3) return `${(n / 1e3).toFixed(1)}k`;
  return Number.isInteger(n) ? n.toLocaleString() : n.toLocaleString(undefined, { maximumFractionDigits: 3 });
}

/** What a result's rows look like: rows of another shape cannot be drawn as this chart. */
const shapeOf = (def: api.ChartDef | null) => JSON.stringify(def && [def.display, def.groupBy ?? '', def.series]);

export function useChart(def: api.ChartDef | null, range: api.Range) {
  const [state, setState] = useState<{ data: api.ChartResult | null; shape: string; error: string | null; loading: boolean }>(
    { data: null, shape: '', error: null, loading: false });
  const key = JSON.stringify([def, range.from, range.to]);
  useEffect(() => {
    if (!def) return;
    const ac = new AbortController();
    const shape = shapeOf(def);
    setState((s) => ({ ...s, loading: true, error: null }));
    api.chart(def, range, ac.signal).then(
      (data) => !ac.signal.aborted && setState({ data, shape, error: null, loading: false }),
      (e) => !ac.signal.aborted && setState({ data: null, shape, error: String(e.message ?? e), loading: false }),
    );
    return () => ac.abort();
  }, [key]); // eslint-disable-line react-hooks/exhaustive-deps
  // While a new result loads, the previous one stays up (no flicker on refresh) only if it has the
  // same shape; a line result shown as a table would list every group once per time bucket.
  return state.shape === shapeOf(def) ? state : { ...state, data: null };
}

interface Line {
  name: string;
  color: string;
  points: [number, number][];
}

const MAX_LINES = 10;

/** Lines from chart rows: one per series, or per series x group (top 10 groups by total). */
export function toLines(def: api.ChartDef, rows: Record<string, unknown>[]): Line[] {
  const byKey = new Map<string, Line>();
  const totals = new Map<string, number>();
  def.series.forEach((s, i) => {
    for (const r of rows) {
      const g = def.groupBy ? String(r.g ?? '(empty)') : null;
      const name = g === null ? seriesLabel(s) : def.series.length > 1 ? `${g} · ${seriesLabel(s)}` : g;
      let line = byKey.get(name);
      if (!line) byKey.set(name, (line = { name, color: '', points: [] }));
      const v = Number(r[`v${i}`]);
      line.points.push([dorisTimeToMs(String(r.t)), Number.isFinite(v) ? v : 0]);
      totals.set(name, (totals.get(name) ?? 0) + (Number.isFinite(v) ? v : 0));
    }
  });
  return [...byKey.values()]
    .sort((a, b) => (totals.get(b.name) ?? 0) - (totals.get(a.name) ?? 0))
    .slice(0, MAX_LINES)
    .map((l, i) => ({ ...l, color: `var(--series-${(i % 8) + 1})`, points: l.points.sort((a, b) => a[0] - b[0]) }));
}

function niceMax(v: number): number {
  if (v <= 0) return 1;
  const p = 10 ** Math.floor(Math.log10(v));
  return [1, 2, 2.5, 5, 10].map((m) => m * p).find((m) => m >= v) ?? 10 * p;
}

/** Time series with a value axis, time ticks, a legend and a hover readout. */
export function LineChart({ lines, range, height = 220 }: { lines: Line[]; range: api.Range; height?: number }) {
  const wrap = useRef<HTMLDivElement>(null);
  const [width, setWidth] = useState(600);
  const [hover, setHover] = useState<number | null>(null);
  useEffect(() => {
    const ro = new ResizeObserver(([e]) => setWidth(Math.max(200, Math.floor(e!.contentRect.width))));
    ro.observe(wrap.current!);
    return () => ro.disconnect();
  }, []);
  const L = 48, R = 8, T = 8, B = 20;
  const pw = width - L - R, ph = height - T - B;
  const max = useMemo(() => niceMax(Math.max(0, ...lines.flatMap((l) => l.points.map((p) => p[1])))), [lines]);
  const x = (t: number) => L + ((t - range.from) / (range.to - range.from)) * pw;
  const y = (v: number) => T + ph - (v / max) * ph;
  const times = [...new Set(lines.flatMap((l) => l.points.map((p) => p[0])))].sort((a, b) => a - b);
  const span = range.to - range.from;
  const tick = (t: number) => new Date(t).toLocaleString(undefined, span > 2 * 86400_000 ? { month: 'short', day: 'numeric' } : { hour: '2-digit', minute: '2-digit' });
  const nTicks = Math.min(6, Math.max(2, Math.floor(pw / 120)));
  const hoverT = hover === null ? null : times.reduce((best, t) => (Math.abs(x(t) - hover) < Math.abs(x(best) - hover) ? t : best), times[0]!);
  return (
    <div className="linechart" ref={wrap}>
      <svg width={width} height={height} role="img" aria-label={`Chart of ${lines.map((l) => l.name).join(', ')}`}
        onMouseMove={(e) => setHover(e.clientX - e.currentTarget.getBoundingClientRect().left)} onMouseLeave={() => setHover(null)}>
        {[0, 0.25, 0.5, 0.75, 1].map((f) => (
          <g key={f}>
            <line x1={L} x2={width - R} y1={y(max * f)} y2={y(max * f)} className="grid" />
            <text x={L - 6} y={y(max * f) + 3} textAnchor="end" className="tick">{formatValue(max * f)}</text>
          </g>
        ))}
        {Array.from({ length: nTicks }, (_, i) => range.from + (span * i) / (nTicks - 1)).map((t, i) => (
          <text key={t} x={x(t)} y={height - 5} className="tick" textAnchor={i === 0 ? 'start' : i === nTicks - 1 ? 'end' : 'middle'}>{tick(t)}</text>
        ))}
        {lines.map((l) => (
          <polyline key={l.name} fill="none" stroke={l.color} strokeWidth="1.6"
            points={l.points.map(([t, v]) => `${x(t)},${y(v)}`).join(' ')} />
        ))}
        {hoverT !== null && hoverT !== undefined && <line x1={x(hoverT)} x2={x(hoverT)} y1={T} y2={T + ph} className="cursor" />}
      </svg>
      {hoverT !== null && hoverT !== undefined && (
        <div className="chart-tip" style={{ left: Math.min(x(hoverT) + 12, width - 200) }}>
          <div className="muted">{new Date(hoverT).toLocaleString()}</div>
          {lines.map((l) => {
            const p = l.points.find((q) => q[0] === hoverT);
            return p ? <div key={l.name}><i style={{ background: l.color }} />{l.name}: <strong>{formatValue(p[1])}</strong></div> : null;
          })}
        </div>
      )}
      <div className="chart-legend">
        {lines.map((l) => <span key={l.name}><i style={{ background: l.color }} />{l.name}</span>)}
      </div>
    </div>
  );
}

/** A chart's result as a time series, a table or a single number. */
export function ChartView({ def, range, height }: { def: api.ChartDef; range: api.Range; height?: number }) {
  const { data, error, loading } = useChart(def, range);
  if (error) return <div className="error small">{error}</div>;
  if (!data) return <div className="empty small">{loading ? 'Loading…' : ''}</div>;
  if (def.display === 'number') {
    return (
      <div className="chart-number">
        {def.series.map((s, i) => (
          <div key={i}><strong>{formatValue(data.rows[0]?.[`v${i}`])}</strong><span className="muted">{seriesLabel(s)}</span></div>
        ))}
      </div>
    );
  }
  if (def.display === 'table') {
    return (
      <div className="chart-table">
        <table className="results">
          <thead><tr>{def.groupBy && <th>{def.groupBy}</th>}{def.series.map((s, i) => <th key={i} className="num">{seriesLabel(s)}</th>)}</tr></thead>
          <tbody>
            {data.rows.map((r, j) => (
              <tr key={j}>{def.groupBy && <td className="mono">{String(r.g ?? '(empty)')}</td>}
                {def.series.map((_, i) => <td key={i} className="num mono">{formatValue(r[`v${i}`])}</td>)}</tr>
            ))}
          </tbody>
        </table>
      </div>
    );
  }
  const lines = toLines(def, data.rows);
  if (lines.length === 0) return <div className="empty small">No data in this time range.</div>;
  return <LineChart lines={lines} range={range} height={height} />;
}
