import { useEffect, useState } from 'react';
import * as api from '../api.ts';
import type { Filter, SourceName } from '../lib/state.ts';
import { Icon } from './Icon.tsx';

export type AnalysisTab = 'results' | 'patterns' | 'deltas';

interface Props {
  spec: api.Spec;
  source: SourceName;
  facets: api.Facet[];
  sampled: number;
  loading: boolean;
  filters: Filter[];
  tab: AnalysisTab;
  rootOnly: boolean;
  onTab: (t: AnalysisTab) => void;
  onRootOnly: (v: boolean) => void;
  onToggle: (field: string, value: string, mode: 'include' | 'exclude' | 'only') => void;
  onClearField: (field: string) => void;
  onClearAll: () => void;
  onHide: () => void;
}

function FacetGroup({ spec, facet, filter, sampled, open, onOpen, onToggle, onClear }: {
  spec: api.Spec;
  facet: api.Facet; filter: Filter | undefined; sampled: number; open: boolean; onOpen: () => void;
  onToggle: Props['onToggle']; onClear: () => void;
}) {
  const [q, setQ] = useState('');
  const [more, setMore] = useState(false);
  const [remote, setRemote] = useState<api.Facet | null>(null);
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);
  useEffect(() => {
    setRemote(null);
    setError('');
    setLoading(false);
    if (!open || !q.trim()) return;
    const ac = new AbortController();
    setLoading(true);
    const timer = setTimeout(() => {
      api.facetValues(spec, facet.field, q, ac.signal).then((r) => {
        if (!ac.signal.aborted) { setRemote(r.facets[0] ?? { field: facet.field, values: [] }); setLoading(false); }
      }, (e) => {
        if (!ac.signal.aborted) { setError(e.message); setLoading(false); }
      });
    }, 200);
    return () => { clearTimeout(timer); ac.abort(); };
  }, [spec, facet.field, q, open]);
  // Selected values stay listed even when they are no longer among the top values.
  const current = remote ?? facet;
  const listed = [...current.values];
  for (const v of filter?.values ?? []) if (!listed.some((x) => x.v === v)) listed.push({ v, n: 0 });
  const shown = listed.filter((x) => x.v.toLowerCase().includes(q.toLowerCase()));
  const visible = more ? shown : shown.slice(0, 10);
  const active = Boolean(filter);
  return (
    <section className={`facet${active ? ' has-filter' : ''}`} aria-label={facet.field}>
      <div className="facet-head">
        <button type="button" className="facet-title" aria-expanded={open} onClick={onOpen}>
          <Icon name={open ? 'chevron-down' : 'chevron-right'} size={12} />
          <span title={facet.field}>{facet.field}</span>
        </button>
        {active && <button type="button" className="icon-btn" title="Clear Filters" aria-label={`Clear ${facet.field} filters`} onClick={onClear}><Icon name="close" size={12} /></button>}
      </div>
      {open && (
        <div className="facet-body">
          <input className="facet-search" placeholder="Search values..." aria-label={`Search ${facet.field} values`} value={q}
            onChange={(e) => { setQ(e.target.value); setMore(false); }} />
          {loading && <div className="muted small" role="status">Searching values…</div>}
          {error && <div className="error small" role="alert">{error}</div>}
          {visible.map((x) => {
            const included = Boolean(filter && !filter.exclude && filter.values.includes(x.v));
            const excluded = Boolean(filter?.exclude && filter.values.includes(x.v));
            const base = current.sampled ?? sampled;
            const pct = base ? Math.round((x.n / base) * 100) : 0;
            return (
              <div key={x.v} className={`facet-value${excluded ? ' excluded' : ''}`}>
                <label>
                  <input type="checkbox" checked={included || excluded} ref={(el) => { if (el) el.indeterminate = excluded; }}
                    onChange={() => onToggle(facet.field, x.v, excluded ? 'exclude' : 'include')}
                    aria-label={`${facet.field} = ${x.v}`} />
                  <span className="fv-label" title={x.v}>{x.v === '' ? '(empty)' : x.v}</span>
                </label>
                <span className="fv-actions">
                  <button type="button" onClick={() => onToggle(facet.field, x.v, 'only')}>Only</button>
                  <button type="button" onClick={() => onToggle(facet.field, x.v, 'exclude')}>Exclude</button>
                </span>
                <span className="fv-count" title={`${x.n.toLocaleString()} of ${base.toLocaleString()} sampled rows`}>
                  {x.n ? `${pct}%` : ''}
                </span>
                <span className="fv-bar" style={{ width: `${pct}%` }} />
              </div>
            );
          })}
          {shown.length > 10 && (
            <button type="button" className="link small" onClick={() => setMore(!more)}>{more ? 'Less' : `Show more (${shown.length - 10})`}</button>
          )}
          {visible.length === 0 && <div className="muted small">No values</div>}
        </div>
      )}
    </section>
  );
}

/** Left panel: analysis mode, quick toggles and the per-field filters. */
export function FilterPanel(p: Props) {
  const [opened, setOpened] = useState<Record<string, boolean>>({});
  const isOpen = (f: string, i: number) => opened[f] ?? (i < 6 || p.filters.some((x) => x.field === f));
  // Fields with active filters first, then by how many distinct values the sample has.
  const order = [...p.facets].sort((a, b) => Number(p.filters.some((f) => f.field === b.field)) - Number(p.filters.some((f) => f.field === a.field)));
  return (
    <aside className="filters" aria-label="Filters">
      <div className="filters-head">
        <strong>Analysis Mode</strong>
        <span className="grow" />
        <button type="button" className="icon-btn" title="Hide filters" aria-label="Hide filters" onClick={p.onHide}><Icon name="collapse" size={14} /></button>
      </div>
      <div className="mode-tabs" role="tablist" aria-label="Analysis Mode">
        <button type="button" role="tab" aria-selected={p.tab === 'results'} onClick={() => p.onTab('results')}>Results Table</button>
        {p.source === 'logs' && (
          <button type="button" role="tab" aria-selected={p.tab === 'patterns'} onClick={() => p.onTab('patterns')}>Event Patterns</button>
        )}
        {p.source === 'traces' && (
          <button type="button" role="tab" aria-selected={p.tab === 'deltas'} onClick={() => p.onTab('deltas')}>Event Deltas</button>
        )}
      </div>
      <div className="filters-title">
        <span>Filters{p.loading && <span className="pulse"> ···</span>}</span>
        {p.filters.length > 0 && <button type="button" className="link small" onClick={p.onClearAll}>Clear Filters</button>}
      </div>
      {p.source === 'traces' && (
        <label className="check" title="Only show root spans (spans with no parent span).">
          <input type="checkbox" checked={p.rootOnly} onChange={(e) => p.onRootOnly(e.target.checked)} /> Root Spans Only
        </label>
      )}
      <div className="facet-list">
        {order.map((f, i) => (
          <FacetGroup key={f.field} spec={p.spec} facet={f} filter={p.filters.find((x) => x.field === f.field)} sampled={p.sampled}
            open={isOpen(f.field, i)} onOpen={() => setOpened({ ...opened, [f.field]: !isOpen(f.field, i) })}
            onToggle={p.onToggle} onClear={() => p.onClearField(f.field)} />
        ))}
        {!p.loading && p.facets.length === 0 && <div className="muted small">No string fields in the results.</div>}
        <p className="muted small hint">Not seeing a filter? Try searching instead (e.g. column:foo)</p>
      </div>
    </aside>
  );
}
