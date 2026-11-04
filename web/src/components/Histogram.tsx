import { useEffect, useMemo, useRef, useState } from 'react';
import type { Bucket, Range } from '../api.ts';
import { dorisTimeToMs } from '../lib/state.ts';

interface Props {
  buckets: Bucket[];
  stepSeconds: number;
  range: Range;
  /** Series order and colours, bottom first; values not listed share the last colour. */
  series: { name: string; label?: string; color: string }[];
  onSelect: (r: Range) => void;
}

const H = 120;
const PAD_LEFT = 44;
const PAD_BOTTOM = 20;

function tickLabel(ms: number, spanMs: number): string {
  const d = new Date(ms);
  const day = d.toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
  const time = d.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' });
  // Past half a day the same clock time repeats, so ticks carry the date too.
  if (spanMs > 2 * 86400_000) return day;
  return spanMs > 12 * 3600_000 ? `${day} ${time}` : time;
}

/** Stacked counts per time bucket. Drag across it to zoom into that time range. */
export function Histogram({ buckets, stepSeconds, range, series, onSelect }: Props) {
  const box = useRef<SVGSVGElement>(null);
  const wrap = useRef<HTMLDivElement>(null);
  const [drag, setDrag] = useState<{ a: number; b: number } | null>(null);
  const [width, setWidth] = useState(1000);
  useEffect(() => {
    const el = wrap.current!;
    // contentRect excludes the padding, so the svg never overflows its box.
    const ro = new ResizeObserver(([e]) => setWidth(Math.max(200, Math.floor(e!.contentRect.width))));
    ro.observe(el);
    return () => ro.disconnect();
  }, []);
  const plotW = width - PAD_LEFT;
  const span = range.to - range.from;
  const x = (ms: number) => PAD_LEFT + ((ms - range.from) / span) * plotW;
  const msAt = (clientX: number) => {
    const r = box.current!.getBoundingClientRect();
    const px = ((clientX - r.left) / r.width) * width;
    return range.from + Math.min(Math.max(px - PAD_LEFT, 0), plotW) / plotW * span;
  };

  const { stacks, max } = useMemo(() => {
    const byT = new Map<number, Map<string, number>>();
    for (const b of buckets) {
      const t = dorisTimeToMs(b.t);
      const m = byT.get(t) ?? new Map<string, number>();
      m.set(b.g ?? '', (m.get(b.g ?? '') ?? 0) + Number(b.n));
      byT.set(t, m);
    }
    let max = 0;
    for (const m of byT.values()) max = Math.max(max, [...m.values()].reduce((a, b) => a + b, 0));
    return { stacks: [...byT.entries()], max };
  }, [buckets]);

  const colorOf = (g: string) => (series.find((s) => s.name === g) ?? series.at(-1)!).color;
  const order = (g: string) => {
    const i = series.findIndex((s) => s.name === g);
    return i < 0 ? series.length : i;
  };
  const barW = Math.max(1, (stepSeconds * 1000 / span) * plotW - 1);
  const yMax = max || 1;
  // About one label per 130 px, between 2 and 6.
  const nTicks = Math.min(6, Math.max(2, Math.floor(plotW / 130)));
  const ticks = Array.from({ length: nTicks }, (_, i) => range.from + (span * i) / (nTicks - 1));
  const total = stacks.reduce((s, [, m]) => s + [...m.values()].reduce((a, b) => a + b, 0), 0);

  return (
    <div className="histogram" ref={wrap}>
      <div className="histogram-head">
        <span>{total.toLocaleString()} matches</span>
        <span className="legend">
          {series.map((s) => (
            <span key={s.name}><i style={{ background: s.color }} />{s.label ?? s.name}</span>
          ))}
        </span>
      </div>
      <svg
        ref={box}
        width={width}
        height={H + PAD_BOTTOM}
        viewBox={`0 0 ${width} ${H + PAD_BOTTOM}`}
        role="img"
        aria-label={`${total} matches over time`}
        onMouseDown={(e) => setDrag({ a: msAt(e.clientX), b: msAt(e.clientX) })}
        onMouseMove={(e) => drag && setDrag({ ...drag, b: msAt(e.clientX) })}
        onMouseUp={() => {
          if (drag && Math.abs(drag.b - drag.a) > span / 200) {
            onSelect({ from: Math.min(drag.a, drag.b), to: Math.max(drag.a, drag.b) });
          }
          setDrag(null);
        }}
        onMouseLeave={() => setDrag(null)}
      >
        <line x1={PAD_LEFT} x2={width} y1={H} y2={H} className="axis" />
        <text x={PAD_LEFT - 6} y={10} className="tick" textAnchor="end">{yMax.toLocaleString()}</text>
        {stacks.map(([t, m]) => {
          let y = H;
          return [...m.entries()]
            .sort((a, b) => order(a[0]) - order(b[0]))
            .map(([g, n]) => {
              const h = (n / yMax) * (H - 4);
              y -= h;
              return <rect key={`${t}-${g}`} x={x(t)} y={y} width={barW} height={h} fill={colorOf(g)}><title>{`${new Date(t).toLocaleString()} ${g}: ${n}`}</title></rect>;
            });
        })}
        {ticks.map((t, i) => (
          <text key={t} x={x(t)} y={H + 15} className="tick"
            textAnchor={i === 0 ? 'start' : i === ticks.length - 1 ? 'end' : 'middle'}>{tickLabel(t, span)}</text>
        ))}
        {drag && (
          <rect className="selection" x={x(Math.min(drag.a, drag.b))} y={0}
            width={Math.abs(x(drag.b) - x(drag.a))} height={H} />
        )}
      </svg>
    </div>
  );
}
