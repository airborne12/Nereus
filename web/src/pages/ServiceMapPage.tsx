import { useEffect, useMemo, useState } from 'react';
import * as api from '../api.ts';
import { formatValue } from '../components/Chart.tsx';
import { formatDuration } from '../components/ResultsTable.tsx';
import { TimePicker } from '../components/TimePicker.tsx';
import { layers } from '../lib/graph.ts';
import { type TimeWindow, resolveWindow, serializeState, DEFAULT_STATE } from '../lib/state.ts';

const NODE_W = 240, NODE_H = 58, COL_GAP = 110, ROW_GAP = 26, PAD = 24;

/** Services and the calls between them, from traces in the time range. */
export function ServiceMapPage({ go }: { go: (url: string) => void }) {
  const [win, setWin] = useState<TimeWindow>({ preset: '1h' });
  const [now, setNow] = useState(Date.now());
  const range = useMemo(() => resolveWindow(win, now), [win, now]);
  const [where, setWhere] = useState('');
  const [applied, setApplied] = useState('');
  const [data, setData] = useState<{ edges: api.MapEdge[]; nodes: api.MapNode[] } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [hover, setHover] = useState<string | null>(null);

  useEffect(() => {
    const ac = new AbortController();
    setError(null);
    api.serviceMap({ where: applied, language: 'lucene', filters: [], range }, ac.signal)
      .then((d) => !ac.signal.aborted && setData(d), (e) => !ac.signal.aborted && setError(String(e.message ?? e)));
    return () => ac.abort();
  }, [applied, range]);

  const layout = useMemo(() => {
    if (!data) return null;
    const names = [...new Set([...data.nodes.map((n) => n.service), ...data.edges.flatMap((e) => [e.src, e.dst])])];
    const cols = layers(names, data.edges);
    const pos = new Map<string, { x: number; y: number }>();
    const tallest = Math.max(1, ...cols.map((c) => c.length));
    cols.forEach((col, c) => col.forEach((n, r) => {
      const offset = ((tallest - col.length) * (NODE_H + ROW_GAP)) / 2;
      pos.set(n, { x: PAD + c * (NODE_W + COL_GAP), y: PAD + offset + r * (NODE_H + ROW_GAP) });
    }));
    return { pos, width: PAD * 2 + cols.length * NODE_W + (cols.length - 1) * COL_GAP, height: PAD * 2 + tallest * NODE_H + (tallest - 1) * ROW_GAP };
  }, [data]);

  const node = (s: string) => data?.nodes.find((n) => n.service === s);
  const maxCalls = Math.max(1, ...(data?.edges ?? []).map((e) => Number(e.calls)));
  const openTraces = (service: string) => go(`/search${serializeState({ ...DEFAULT_STATE, source: 'traces', window: win,
    filters: [{ field: 'service_name', values: [service] }] })}`);

  return (
    <div className="chart-page">
      <div className="chart-page-head">
        <h1>Service map</h1>
        <span className="grow" />
        <form className="sql-field map-where" onSubmit={(e) => { e.preventDefault(); setNow(Date.now()); setApplied(where); }}>
          <span className="sql-kw">WHERE</span>
          <input aria-label="Service map filter" className="mono" value={where} placeholder="Lucene, e.g. status:error" onChange={(e) => setWhere(e.target.value)} />
        </form>
        <TimePicker window={win} range={range} onChange={(w) => { setWin(w); setNow(Date.now()); }} />
      </div>
      {error && <div className="error">{error}</div>}
      {data && data.edges.length === 0 && <div className="empty">No calls between services in this time range.</div>}
      {layout && data && data.edges.length > 0 && (
        <div className="map-wrap">
          <svg width={layout.width} height={layout.height} role="img" aria-label="Service map">
            <defs>
              <marker id="map-arrow" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="9" markerHeight="9" markerUnits="userSpaceOnUse" orient="auto-start-reverse">
                <path d="M0 0L10 5L0 10z" fill="var(--text-3)" />
              </marker>
            </defs>
            {data.edges.map((e) => {
              const a = layout.pos.get(e.src)!, b = layout.pos.get(e.dst)!;
              const x1 = a.x + NODE_W, y1 = a.y + NODE_H / 2, x2 = b.x, y2 = b.y + NODE_H / 2;
              const back = x2 <= x1;
              const d = back
                ? `M${a.x + NODE_W / 2} ${a.y + NODE_H} C${a.x + NODE_W / 2} ${a.y + NODE_H + 60}, ${b.x + NODE_W / 2} ${b.y + NODE_H + 60}, ${b.x + NODE_W / 2} ${b.y + NODE_H}`
                : `M${x1} ${y1} C${x1 + COL_GAP / 2} ${y1}, ${x2 - COL_GAP / 2} ${y2}, ${x2} ${y2}`;
              const errs = Number(e.errors);
              const active = hover === e.src || hover === e.dst;
              return (
                <g key={`${e.src}->${e.dst}`} className={`map-edge${errs ? ' has-errors' : ''}${active ? ' active' : ''}`} data-edge={`${e.src}->${e.dst}`}>
                  <path d={d} fill="none" strokeWidth={1 + 3 * (Number(e.calls) / maxCalls)} markerEnd="url(#map-arrow)" />
                  <title>{`${e.src} → ${e.dst}: ${formatValue(e.calls)} calls, ${formatValue(errs)} errors, p50 ${formatDuration(e.p50)}, p99 ${formatDuration(e.p99)}`}</title>
                  {!back && (
                    <text x={(x1 + x2) / 2} y={(y1 + y2) / 2 - 6} textAnchor="middle" className="map-edge-label">
                      {formatValue(e.calls)}{errs ? ` · ${formatValue(errs)} err` : ''}
                    </text>
                  )}
                </g>
              );
            })}
            {[...layout.pos.entries()].map(([s, p]) => {
              const n = node(s);
              const errRate = n && Number(n.requests) ? Number(n.errors) / Number(n.requests) : 0;
              return (
                <g key={s} className={`map-node${errRate > 0.05 ? ' bad' : errRate > 0 ? ' warn' : ''}`} transform={`translate(${p.x},${p.y})`}
                  onMouseEnter={() => setHover(s)} onMouseLeave={() => setHover(null)} onClick={() => openTraces(s)} role="button"
                  aria-label={`${s}: open its traces`} data-service={s}>
                  <rect width={NODE_W} height={NODE_H} rx="6" />
                  <text x="12" y="22" className="map-name">{s}</text>
                  <text x="12" y="42" className="map-stats">
                    {n ? `${formatValue(n.requests)} req · ${(errRate * 100).toFixed(1)}% err · p99 ${formatDuration(n.p99)}` : 'no entry spans'}
                  </text>
                </g>
              );
            })}
          </svg>
        </div>
      )}
      <p className="muted small">An arrow is a call: a span whose parent span belongs to another service. Requests, errors and p99 count each service's entry spans (roots and server spans). Click a service to see its traces.</p>
    </div>
  );
}
