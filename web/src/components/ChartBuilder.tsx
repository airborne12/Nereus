import { useEffect, useState } from 'react';
import * as api from '../api.ts';
import { Icon } from './Icon.tsx';

export const DEFAULT_CHART: api.ChartDef = {
  source: 'logs', display: 'line', series: [{ agg: 'count' }], where: '', language: 'lucene', filters: [], groupBy: 'severity_text',
};

const DISPLAYS: [api.ChartDef['display'], string][] = [['line', 'Time Series'], ['table', 'Table'], ['number', 'Number']];

/** The chart form shared by Chart explorer and dashboard tiles. Changes apply on Run. */
export function ChartBuilder({ value, onRun }: { value: api.ChartDef; onRun: (d: api.ChartDef) => void }) {
  const [d, setD] = useState(value);
  const [fields, setFields] = useState<{ name: string; type: string }[]>([]);
  useEffect(() => setD(value), [JSON.stringify(value)]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => {
    const ac = new AbortController();
    api.fields(d.source as never, ac.signal).then((r) => setFields(r.fields), () => setFields([]));
    return () => ac.abort();
  }, [d.source]);
  const numeric = fields.filter((f) => /int|double|float|decimal|bigint/i.test(f.type)).map((f) => f.name);
  const strings = fields.filter((f) => /char|text|string/i.test(f.type)).map((f) => f.name);
  const setSeries = (i: number, patch: Partial<api.ChartDef['series'][number]>) =>
    setD({ ...d, series: d.series.map((s, j) => (j === i ? { ...s, ...patch } : s)) });

  return (
    <form className="chart-builder" onSubmit={(e) => { e.preventDefault(); onRun(d); }}>
      <datalist id="numeric-fields">{numeric.map((f) => <option key={f} value={f} />)}</datalist>
      <datalist id="string-fields">{strings.map((f) => <option key={f} value={f} />)}</datalist>
      <div className="row">
        <div className="segmented" role="tablist" aria-label="Chart type">
          {DISPLAYS.map(([k, l]) => <button key={k} type="button" role="tab" aria-selected={d.display === k} onClick={() => setD({ ...d, display: k })}>{l}</button>)}
        </div>
        <select aria-label="Chart source" className="source" value={d.source}
          onChange={(e) => setD({ ...d, source: e.target.value as api.ChartSourceName, series: [{ agg: 'count' }], groupBy: undefined, where: '' })}>
          <option value="logs">Logs</option>
          <option value="traces">Traces</option>
          <option value="metrics">Metrics</option>
        </select>
      </div>
      {d.series.map((s, i) => (
        <div className="row series" key={i}>
          <span className="sql-kw">{i === 0 ? 'Series' : ''}</span>
          <select aria-label={`Aggregate ${i + 1}`} value={s.agg} onChange={(e) => setSeries(i, { agg: e.target.value as api.Aggregate })}>
            {api.AGGREGATES.map((a) => <option key={a} value={a}>{a === 'count_distinct' ? 'count distinct' : a}</option>)}
          </select>
          {s.agg !== 'count' && (
            <input aria-label={`Field ${i + 1}`} className="mono" list={s.agg === 'count_distinct' ? 'string-fields' : 'numeric-fields'}
              placeholder={d.source === 'metrics' ? 'value' : s.agg === 'count_distinct' ? 'e.g. trace_id' : 'e.g. duration'}
              value={s.field ?? ''} onChange={(e) => setSeries(i, { field: e.target.value })} />
          )}
          {d.series.length > 1 && (
            <button type="button" className="icon-btn" aria-label={`Remove series ${i + 1}`} onClick={() => setD({ ...d, series: d.series.filter((_, j) => j !== i) })}>
              <Icon name="close" size={12} />
            </button>
          )}
        </div>
      ))}
      <div className="row">
        <button type="button" className="link small" disabled={d.series.length >= 10}
          onClick={() => setD({ ...d, series: [...d.series, { agg: 'count' }] })}>+ Add series</button>
      </div>
      <div className="row">
        <label className="sql-field grow"><span className="sql-kw">WHERE</span>
          <input aria-label="Chart where" className="mono" value={d.where} placeholder={d.source === 'metrics' ? 'metric:process.cpu.utilization' : 'Lucene, e.g. service:checkout'}
            onChange={(e) => setD({ ...d, where: e.target.value })} /></label>
        <label className="sql-field group"><span className="sql-kw">GROUP BY</span>
          <input aria-label="Group by" className="mono" list="string-fields" value={d.groupBy ?? ''} placeholder="none"
            onChange={(e) => setD({ ...d, groupBy: e.target.value || undefined })} /></label>
        <button type="submit" className="btn primary"><Icon name="play" size={12} /> Run</button>
      </div>
    </form>
  );
}
