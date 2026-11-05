import { useEffect, useMemo, useRef, useState } from 'react';
import * as api from '../api.ts';
import { dorisTimeToMs } from '../lib/state.ts';
import { bandLow, compareFacets, type Delta, type Selection, selectionSpec } from '../lib/deltas.ts';
import { formatDuration } from './ResultsTable.tsx';

const H = 220, L = 64, B = 20;

/** Clock time, with the date once the range spans more than a day. */
const when = (ms: number, span: number) => (span > 86400_000 ? new Date(ms).toLocaleString(undefined, { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' }) : new Date(ms).toLocaleTimeString());

export function DeltasView({ spec, onFilter }: { spec: api.Spec; onFilter: (field: string, value: string, mode: 'include' | 'exclude') => void }) {
  const [cells, setCells] = useState<{ t: number; b: number; n: number }[] | null>(null);
  const [step, setStep] = useState(60);
  const [sel, setSel] = useState<Selection | null>(null);
  const [drag, setDrag] = useState<{ x0: number; y0: number; x1: number; y1: number } | null>(null);
  const [deltas, setDeltas] = useState<Delta[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const wrap = useRef<HTMLDivElement>(null);
  const [width, setWidth] = useState(800);
  useEffect(() => {
    const ro = new ResizeObserver(([e]) => setWidth(Math.max(300, Math.floor(e!.contentRect.width))));
    ro.observe(wrap.current!);
    return () => ro.disconnect();
  }, []);
  useEffect(() => {
    const ac = new AbortController();
    setCells(null);
    setSel(null);
    setDeltas(null);
    api.heatmap(spec, ac.signal).then((r) => {
      if (ac.signal.aborted) return;
      setStep(r.stepSeconds);
      setCells(r.cells.map((c) => ({ t: dorisTimeToMs(c.t), b: Number(c.b), n: Number(c.n) })));
    }, (e) => !ac.signal.aborted && setError(String(e.message ?? e)));
    return () => ac.abort();
  }, [spec]);

  const bands = useMemo(() => {
    if (!cells?.length) return { lo: 0, hi: 1, max: 1 };
    return { lo: Math.min(...cells.map((c) => c.b)), hi: Math.max(...cells.map((c) => c.b)), max: Math.max(...cells.map((c) => c.n)) };
  }, [cells]);
  const pw = width - L, rows = bands.hi - bands.lo + 1, rowH = (H - B) / rows;
  const span = spec.range.to - spec.range.from;
  const x = (t: number) => L + ((t - spec.range.from) / span) * pw;
  const y = (b: number) => (bands.hi - b) * rowH;
  const tAt = (px: number) => spec.range.from + Math.min(Math.max(px - L, 0), pw) / pw * span;
  const bAt = (py: number) => Math.max(bands.lo, Math.min(bands.hi, bands.hi - Math.floor(py / rowH)));

  useEffect(() => {
    if (!sel) return;
    const ac = new AbortController();
    setDeltas(null);
    Promise.all([api.facets(selectionSpec(spec, sel), ac.signal), api.facets(spec, ac.signal)])
      .then(([a, b]) => !ac.signal.aborted && setDeltas(compareFacets(a, b)), (e) => !ac.signal.aborted && setError(String(e.message ?? e)));
    return () => ac.abort();
  }, [sel, spec]);

  const local = (e: React.MouseEvent) => {
    const r = e.currentTarget.getBoundingClientRect();
    return { px: e.clientX - r.left, py: e.clientY - r.top };
  };
  return (
    <div className="deltas table-wrap">
      {error && <div className="error">{error}</div>}
      <div className="heatmap" ref={wrap}>
        <div className="small muted pad">Span duration over time, darker is more spans. Drag a box around outliers to compare them with all spans.</div>
        {cells === null ? <div className="empty">Loading…</div> : (
          <svg width={width} height={H} role="img" aria-label="Duration heatmap"
            onMouseDown={(e) => { const p = local(e); setDrag({ x0: p.px, y0: p.py, x1: p.px, y1: p.py }); }}
            onMouseMove={(e) => { if (drag) { const p = local(e); setDrag({ ...drag, x1: p.px, y1: p.py }); } }}
            onMouseUp={() => {
              if (drag && Math.abs(drag.x1 - drag.x0) > 4 && Math.abs(drag.y1 - drag.y0) > 4) {
                const [ya, yb] = [Math.min(drag.y0, drag.y1), Math.max(drag.y0, drag.y1)];
                setSel({ from: tAt(Math.min(drag.x0, drag.x1)), to: tAt(Math.max(drag.x0, drag.x1)), bLo: bAt(yb - 1), bHi: bAt(ya) });
              }
              setDrag(null);
            }}>
            {Array.from({ length: rows }, (_, i) => bands.lo + i).filter((b) => (b - bands.lo) % 2 === 0).map((b) => (
              <text key={b} x={L - 6} y={y(b) + rowH - 2} textAnchor="end" className="tick">{formatDuration(bandLow(b))}</text>
            ))}
            {cells.map((c) => (
              <rect key={`${c.t}-${c.b}`} x={x(c.t)} y={y(c.b)} width={Math.max(1, (step * 1000 / span) * pw - 1)} height={rowH - 1}
                fill="var(--accent)" fillOpacity={0.12 + 0.88 * Math.log(1 + c.n) / Math.log(1 + bands.max)}>
                <title>{`${when(c.t, span)} ${formatDuration(bandLow(c.b))}–${formatDuration(bandLow(c.b + 1))}: ${c.n} spans`}</title>
              </rect>
            ))}
            {sel && <rect className="selection" x={x(sel.from)} y={y(sel.bHi)} width={x(sel.to) - x(sel.from)} height={(sel.bHi - sel.bLo + 1) * rowH} />}
            {drag && <rect className="selection" x={Math.min(drag.x0, drag.x1)} y={Math.min(drag.y0, drag.y1)} width={Math.abs(drag.x1 - drag.x0)} height={Math.abs(drag.y1 - drag.y0)} />}
            <line x1={L} x2={width} y1={H - B} y2={H - B} className="axis" />
            <text x={L} y={H - 5} className="tick">{when(spec.range.from, span)}</text>
            <text x={width - 2} y={H - 5} className="tick" textAnchor="end">{when(spec.range.to, span)}</text>
          </svg>
        )}
      </div>
      {!sel && cells !== null && <div className="empty">Select an area on the chart above to enable comparisons</div>}
      {sel && (
        <div className="deltas-head small">
          Selection: {formatDuration(bandLow(sel.bLo))}–{formatDuration(bandLow(sel.bHi + 1))}, {when(sel.from, span)} – {when(sel.to, span)}
          <span className="legend"><span><i style={{ background: 'var(--accent)' }} />Selection</span><span><i style={{ background: 'var(--text-3)' }} />Background (all spans)</span></span>
          <button type="button" className="link small" onClick={() => setSel(null)}>Clear selection</button>
        </div>
      )}
      {sel && !deltas && <div className="empty">Comparing…</div>}
      {deltas && (
        <div className="delta-grid">
          {deltas.slice(0, 12).map((d) => (
            <section key={d.field} className="delta-card" aria-label={`${d.field} comparison`}>
              <strong title={d.field}>{d.field}</strong>
              {d.values.map((v) => (
                <div key={v.v} className="delta-row" title={`selection ${(v.sel * 100).toFixed(1)}% · background ${(v.bg * 100).toFixed(1)}%`}>
                  <span className="mono dv">{v.v || '(empty)'}</span>
                  <span className="bars">
                    <i className="b-sel" style={{ width: `${v.sel * 100}%` }} />
                    <i className="b-bg" style={{ width: `${v.bg * 100}%` }} />
                  </span>
                  <span className="pct mono">{Math.round(v.sel * 100)}% / {Math.round(v.bg * 100)}%</span>
                  <span className="fv-actions">
                    <button type="button" onClick={() => onFilter(d.field, v.v, 'include')}>Filter</button>
                    <button type="button" onClick={() => onFilter(d.field, v.v, 'exclude')}>Exclude</button>
                  </span>
                </div>
              ))}
            </section>
          ))}
          {deltas.length === 0 && <div className="empty">No differences in the sampled fields.</div>}
        </div>
      )}
    </div>
  );
}
