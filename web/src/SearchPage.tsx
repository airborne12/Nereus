import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import * as api from './api.ts';
import { DeltasView } from './components/DeltasView.tsx';
import { FilterPanel, type AnalysisTab } from './components/FilterPanel.tsx';
import { Histogram } from './components/Histogram.tsx';
import { Icon } from './components/Icon.tsx';
import { PatternsView } from './components/PatternsView.tsx';
import { QueryInput } from './components/QueryInput.tsx';
import { ResultsTable } from './components/ResultsTable.tsx';
import { RowSidePanel } from './components/RowSidePanel.tsx';
import { SaveSearchModal, SavedSearchBar, type SearchFields } from './components/SavedSearchBar.tsx';
import { TimePicker } from './components/TimePicker.tsx';
import { toCsv } from './lib/csv.ts';
import { quoteValue, replaceField } from './lib/filters.ts';
import { loadHistory, rememberQuery } from './lib/history.ts';
import { noisyTemplates, template } from './lib/patterns.ts';
import { splitSelect } from './lib/select.ts';
import type { Row } from './lib/rows.ts';
import {
  DEFAULT_SELECT, type Filter, type Language, type SearchState, type SourceName, parseState, resolveWindow, serializeState,
  toggleFilter,
} from './lib/state.ts';

const PAGE = 200;
const DENOISE_SAMPLE = 2000;
const MAX_GROUPS = 10;
const LIVE_INTERVALS = [1, 2, 4, 10, 30];

const LOG_SERIES = [
  { name: 'DEBUG', color: 'var(--lvl-debug)' }, { name: 'INFO', color: 'var(--lvl-info)' },
  { name: 'WARN', color: 'var(--lvl-warn)' }, { name: 'ERROR', color: 'var(--lvl-error)' },
];
const TRACE_SERIES = [
  { name: 'STATUS_CODE_UNSET', label: 'Unset', color: 'var(--lvl-info)' },
  { name: 'STATUS_CODE_OK', label: 'Ok', color: 'var(--lvl-debug)' },
  { name: 'STATUS_CODE_ERROR', label: 'Error', color: 'var(--lvl-error)' },
];

function useUrlState(): [SearchState, (s: SearchState, replace?: boolean) => void] {
  const [state, setState] = useState(() => parseState(window.location.search));
  useEffect(() => {
    const onPop = () => setState(parseState(window.location.search));
    window.addEventListener('popstate', onPop);
    return () => window.removeEventListener('popstate', onPop);
  }, []);
  const update = useCallback((s: SearchState, replace = false) => {
    window.history[replace ? 'replaceState' : 'pushState'](null, '', serializeState(s));
    setState(s);
  }, []);
  return [state, update];
}

function FilterPills({ filters, onChange }: { filters: Filter[]; onChange: (f: Filter[]) => void }) {
  const [confirm, setConfirm] = useState(false);
  if (filters.length === 0) return null;
  return (
    <div className="pills" aria-label="Active filters">
      {filters.map((f) => (
        <span key={f.field} className={`pill${f.exclude ? ' exclude' : ''}`}>
          <button type="button" className="pill-body" title={f.exclude ? 'Click to include instead' : 'Click to exclude instead'}
            onClick={() => onChange(filters.map((x) => (x === f ? { ...x, exclude: !x.exclude || undefined } : x)))}>
            <span className="pill-field">{f.field}</span> {f.exclude ? '≠' : '='} {f.values.join(', ')}
          </button>
          <button type="button" className="pill-x" aria-label={`Remove filter ${f.field}`} onClick={() => onChange(filters.filter((x) => x !== f))}>
            <Icon name="close" size={10} />
          </button>
        </span>
      ))}
      {confirm ? (
        <span className="small">Confirm clear all? <button type="button" className="link" onClick={() => { onChange([]); setConfirm(false); }}>Yes</button>{' '}
          <button type="button" className="link" onClick={() => setConfirm(false)}>No</button></span>
      ) : <button type="button" className="link small" onClick={() => setConfirm(true)}>Clear all</button>}
    </div>
  );
}

/** Field the timeline is split by; empty means the source's default. */
function GroupByInput({ value, placeholder, onChange }: { value: string; placeholder: string; onChange: (v: string) => void }) {
  const [text, setText] = useState(value);
  useEffect(() => setText(value), [value]);
  return (
    <form className="groupby" onSubmit={(e) => { e.preventDefault(); onChange(text.trim()); }}>
      <label><span className="muted small">Group by</span>
        <input aria-label="Group by" className="mono" value={text} placeholder={placeholder} onChange={(e) => setText(e.target.value)}
          onBlur={() => text.trim() !== value && onChange(text.trim())} />
      </label>
    </form>
  );
}

export function SearchPage({ go: navigate, onChanged }: { go: (url: string) => void; onChanged: () => void }) {
  const [state, setState] = useUrlState();
  const [now, setNow] = useState(() => Date.now());
  const range = useMemo(() => resolveWindow(state.window, now), [state.window, now]);
  const live = 'preset' in state.window && state.window.preset === 'live';
  const [paused, setPaused] = useState(false);
  const [liveEvery, setLiveEvery] = useState(10);

  // The form: edited freely, applied with Run or Enter.
  const [draft, setDraft] = useState({ where: state.where, language: state.language, select: state.select, orderBy: state.orderBy });
  useEffect(() => setDraft({ where: state.where, language: state.language, select: state.select, orderBy: state.orderBy }),
    [state.where, state.language, state.select, state.orderBy]);
  const dirty = draft.where !== state.where || draft.language !== state.language || draft.select !== state.select || draft.orderBy !== state.orderBy;

  const [rows, setRows] = useState<Row[]>([]);
  const [columns, setColumns] = useState<api.Column[]>([]);
  const [sql, setSql] = useState<{ search: string; histogram: string }>({ search: '', histogram: '' });
  const [hist, setHist] = useState<{ stepSeconds: number; buckets: api.Bucket[] }>({ stepSeconds: 60, buckets: [] });
  const [facets, setFacets] = useState<{ sampled: number; facets: api.Facet[]; loading: boolean }>({ sampled: 0, facets: [], loading: true });
  const [warnings, setWarnings] = useState<api.Warning[]>([]);
  const [elapsed, setElapsed] = useState<number | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState(false);
  const [loadingMore, setLoadingMore] = useState(false);
  const [selected, setSelected] = useState<Row | null>(null);
  const [tab, setTab] = useState<AnalysisTab>('results');
  const [showFilters, setShowFilters] = useState(true);
  const [wrap, setWrap] = useState(false);
  const [showSql, setShowSql] = useState(false);
  const whereBox = useRef<HTMLDivElement>(null);
  const [saved, setSaved] = useState<api.SavedSearch | null>(null);
  const [saving, setSaving] = useState(false);

  // Opening ?saved=<id> loads that search; a URL that already carries a query keeps it.
  useEffect(() => {
    if (state.saved === null) return setSaved(null);
    const ac = new AbortController();
    api.content.search(state.saved).then((s) => {
      setSaved(s);
      const p = new URLSearchParams(window.location.search);
      if (!['where', 'q', 'filters', 'select', 'orderBy', 'lang'].some((k) => p.has(k))) {
        setState({ ...state, source: s.source, where: s.where, language: s.language, filters: s.filters, select: s.select, orderBy: s.orderBy }, true);
      }
    }, () => setSaved(null));
    return () => ac.abort();
  }, [state.saved]); // eslint-disable-line react-hooks/exhaustive-deps

  const spec: api.Spec = useMemo(() => ({ source: state.source, where: state.where, language: state.language, filters: state.filters, range }),
    [state.source, state.where, state.language, state.filters, range]);
  const searchKey = JSON.stringify([spec, state.select, state.orderBy, state.groupBy]);
  const [shownKey, setShownKey] = useState<string | null>(null);
  const loading = shownKey !== searchKey;

  const go = (patch: Partial<SearchState>) => {
    setNow(Date.now());
    setPaused(false);
    setState({ ...state, ...patch });
  };
  const run = () => go({ where: draft.where, language: draft.language, select: draft.select, orderBy: draft.orderBy });

  useEffect(() => {
    const ac = new AbortController();
    setError(null);
    Promise.all([
      api.search(spec, { select: state.select, orderBy: state.orderBy, limit: PAGE }, ac.signal),
      api.histogram(spec, state.groupBy || (state.source === 'logs' ? 'severity_text' : 'status_code'), ac.signal,
        state.groupBy ? MAX_GROUPS : undefined),
    ]).then(([s, h]) => {
      if (ac.signal.aborted) return;
      setRows(s.rows);
      setColumns(s.columns);
      setElapsed(s.elapsedMs);
      setWarnings(s.warnings ?? []);
      setHist(h);
      setSql({ search: s.sql, histogram: h.sql });
      setDone(s.rows.length < PAGE);
      setShownKey(searchKey);
    }, (e) => {
      if (ac.signal.aborted) return;
      setError(String(e.message ?? e));
      setRows([]);
      setWarnings([]);
      setHist({ stepSeconds: 60, buckets: [] });
      setShownKey(searchKey);
    });
    return () => ac.abort();
  }, [searchKey]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    const ac = new AbortController();
    setFacets((f) => ({ ...f, loading: true }));
    api.facets(spec, ac.signal).then((r) => !ac.signal.aborted && setFacets({ ...r, loading: false }), () => !ac.signal.aborted && setFacets({ sampled: 0, facets: [], loading: false }));
    return () => ac.abort();
  }, [spec]);

  // Denoise: hide rows whose pattern is common in a sample of the newest matching events.
  const denoising = state.denoise && state.source === 'logs';
  const [noisy, setNoisy] = useState<Set<string> | null>(null);
  useEffect(() => {
    if (!denoising) return setNoisy(null);
    const ac = new AbortController();
    setNoisy(null);
    api.search(spec, { select: 'timestamp, body', limit: DENOISE_SAMPLE }, ac.signal)
      .then((r) => !ac.signal.aborted && setNoisy(noisyTemplates(r.rows, 'body')), () => !ac.signal.aborted && setNoisy(new Set()));
    return () => ac.abort();
  }, [spec, denoising]);
  const shownRows = useMemo(() => (noisy && noisy.size ? rows.filter((r) => !noisy.has(template(String(r.body ?? '')))) : rows), [rows, noisy]);

  // Query history: every query that ran, per source and language.
  useEffect(() => rememberQuery(state.source, state.language, state.where), [state.source, state.language, state.where]);
  const history = useMemo(() => loadHistory(state.source, draft.language), [state.source, state.where, draft.language]); // eslint-disable-line react-hooks/exhaustive-deps

  // Live tail: move the window forward on an interval until the user scrolls, zooms or opens a row.
  useEffect(() => {
    if (!live || paused) return;
    const t = setInterval(() => setNow(Date.now()), liveEvery * 1000);
    return () => clearInterval(t);
  }, [live, paused, liveEvery]);

  // Keyboard: / focuses the search, j/k step through events while one is open.
  useEffect(() => {
    const key = (e: KeyboardEvent) => {
      const t = e.target as HTMLElement;
      if (/INPUT|TEXTAREA|SELECT/.test(t.tagName)) return;
      if (e.key === '/' || e.key === 's') {
        e.preventDefault();
        whereBox.current?.querySelector('input')?.focus();
      } else if (selected && (e.key === 'j' || e.key === 'k' || e.key === 'ArrowDown' || e.key === 'ArrowUp')) {
        const i = shownRows.indexOf(selected);
        const next = shownRows[i + (e.key === 'j' || e.key === 'ArrowDown' ? 1 : -1)];
        if (next) setSelected(next);
      }
    };
    document.addEventListener('keydown', key);
    return () => document.removeEventListener('keydown', key);
  }, [shownRows, selected]);

  async function loadMore() {
    setLoadingMore(true);
    setPaused(true);
    try {
      const s = await api.search(spec, { select: state.select, orderBy: state.orderBy, limit: PAGE, offset: rows.length });
      setRows((r) => [...r, ...s.rows]);
      setDone(s.rows.length < PAGE);
    } finally {
      setLoadingMore(false);
    }
  }

  const total = hist.buckets.reduce((s, b) => s + Number(b.n), 0);
  const series = useMemo(() => {
    if (!state.groupBy) return state.source === 'logs' ? LOG_SERIES : TRACE_SERIES;
    const sums = new Map<string, number>();
    for (const b of hist.buckets) sums.set(b.g ?? '', (sums.get(b.g ?? '') ?? 0) + Number(b.n));
    // Biggest at the bottom; "(other)" last, in grey.
    const names = [...sums].filter(([g]) => g !== '(other)').sort((a, b) => b[1] - a[1]).map(([g]) => g);
    return [...names.map((g, i) => ({ name: g, label: g || '(empty)', color: `var(--series-${(i % 8) + 1})` })),
      ...(sums.has('(other)') ? [{ name: '(other)', color: 'var(--text-3)' }] : [])];
  }, [hist.buckets, state.groupBy, state.source]);
  const downloadCsv = () => {
    const url = URL.createObjectURL(new Blob([toCsv(columns, shownRows)], { type: 'text/csv' }));
    const a = Object.assign(document.createElement('a'), { href: url, download: `${state.source}-${new Date(range.from).toISOString().slice(0, 19)}.csv` });
    a.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  };
  const currentSelect = state.select || DEFAULT_SELECT[state.source];
  const actions = {
    onFilter: (field: string, value: string, mode: 'include' | 'exclude' | 'only') => go({ filters: toggleFilter(state.filters, field, value, mode) }),
    onSearchValue: (field: string, value: string) => go({ where: `${field}:${quoteValue(value)}`, language: 'lucene' as Language }),
    onAddColumn: (field: string) => {
      const cols = splitSelect(currentSelect);
      if (!cols.includes(field)) go({ select: [...cols, field].join(', ') });
    },
  };

  const fields: SearchFields = { source: state.source, where: state.where, language: state.language, filters: state.filters, select: state.select, orderBy: state.orderBy };
  const savedDirty = saved !== null && (['source', 'where', 'language', 'select', 'orderBy'] as const).some((k) => saved[k] !== fields[k])
    || (saved !== null && JSON.stringify(saved.filters) !== JSON.stringify(fields.filters));

  return (
    <div className="search-page">
      {saved && (
        <SavedSearchBar search={saved} dirty={savedDirty} fields={fields} go={navigate}
          onUpdated={(s) => { setSaved(s); onChanged(); }}
          onSavedAs={() => setSaving(true)}
          onDeleted={() => { onChanged(); go({ saved: null }); }} />
      )}
      {saving && (
        <SaveSearchModal fields={fields} onClose={() => setSaving(false)}
          onSaved={(s) => { setSaving(false); setSaved(s); onChanged(); go({ saved: s.id }); }} />
      )}
      <form className="search-head" onSubmit={(e) => { e.preventDefault(); run(); }}>
        <div className="row">
          <select className="source" aria-label="Source" value={state.source}
            onChange={(e) => go({ source: e.target.value as SourceName, where: '', filters: [], select: '', orderBy: '', groupBy: '' })}>
            <option value="logs">Logs</option>
            <option value="traces">Traces</option>
          </select>
          <label className="sql-field grow">
            <span className="sql-kw">SELECT</span>
            <input aria-label="SELECT" className="mono" value={draft.select} placeholder={DEFAULT_SELECT[state.source]}
              onChange={(e) => setDraft({ ...draft, select: e.target.value })} />
          </label>
          <label className="sql-field order">
            <span className="sql-kw">ORDER BY</span>
            <input aria-label="ORDER BY" className="mono" value={draft.orderBy} placeholder="timestamp DESC"
              onChange={(e) => setDraft({ ...draft, orderBy: e.target.value })} />
          </label>
          {!saved && <button type="button" className="btn" onClick={() => setSaving(true)}><Icon name="floppy" size={12} /> Save</button>}
        </div>
        <div className="row">
          <div className="where grow" ref={whereBox}>
            <select className="lang" aria-label="Query language" value={draft.language}
              onChange={(e) => setDraft({ ...draft, language: e.target.value as Language })}>
              <option value="lucene">Lucene</option>
              <option value="sql">SQL</option>
            </select>
            <QueryInput source={state.source} value={draft.where} range={range} language={draft.language}
              onChange={(where) => setDraft((d) => ({ ...d, where }))}
              history={history}
              onSubmit={(where) => go({ where, language: draft.language, select: draft.select, orderBy: draft.orderBy })} />
          </div>
          <TimePicker window={state.window} range={range} onChange={(w) => go({ window: w })} />
          {live && (
            <select className="live-every" aria-label="Live tail refresh interval" title="Live tail refresh interval" value={liveEvery}
              onChange={(e) => setLiveEvery(Number(e.target.value))}>
              {LIVE_INTERVALS.map((s) => <option key={s} value={s}>{s}s</option>)}
            </select>
          )}
          <button type="submit" className={`btn run${dirty ? ' primary' : ''}`}><Icon name="play" size={12} /> Run</button>
        </div>
        <FilterPills filters={state.filters} onChange={(filters) => go({ filters })} />
      </form>

      <div className="search-body">
        {showFilters && (
          <FilterPanel source={state.source} facets={facets.facets} sampled={facets.sampled} loading={facets.loading}
            filters={state.filters} tab={tab} rootOnly={state.filters.some((f) => f.field === 'is_root')}
            onTab={setTab} onHide={() => setShowFilters(false)}
            onRootOnly={(v) => go({ filters: v ? [...state.filters.filter((f) => f.field !== 'is_root'), { field: 'is_root', values: ['1'] }] : state.filters.filter((f) => f.field !== 'is_root') })}
            onToggle={actions.onFilter}
            onClearField={(field) => go({ filters: state.filters.filter((f) => f.field !== field) })}
            onClearAll={() => go({ filters: [] })} />
        )}
        <main className="results-area">
          <div className="stats">
            {!showFilters && <button type="button" className="icon-btn" title="Show filters" aria-label="Show filters" onClick={() => setShowFilters(true)}><Icon name="filter" size={14} /></button>}
            <strong className="count">{loading ? 'Searching…' : `${total.toLocaleString()} results`}</strong>
            <span className="grow" />
            {live && paused && <button type="button" className="btn small" onClick={() => setPaused(false)}><Icon name="bolt" size={12} /> Resume Live Tail</button>}
            {live && !paused && <span className="live-on"><span className="live-dot" /> Live</span>}
            {elapsed !== null && <span className="muted small">Elapsed Time: {elapsed} ms</span>}
            <GroupByInput value={state.groupBy} placeholder={state.source === 'logs' ? 'severity_text' : 'status_code'} onChange={(groupBy) => go({ groupBy })} />
            {state.source === 'logs' && (
              <button type="button" className={`btn small${state.denoise ? ' on' : ''}`} aria-pressed={state.denoise}
                title="Hide the most common log patterns" onClick={() => go({ denoise: !state.denoise })}>Denoise</button>
            )}
            <button type="button" className="icon-btn" title="Download CSV" aria-label="Download CSV" disabled={shownRows.length === 0} onClick={downloadCsv}><Icon name="download" size={14} /></button>
            <button type="button" className={`icon-btn${wrap ? ' on' : ''}`} title={wrap ? 'Disable Wrap Lines' : 'Enable Wrap Lines'} aria-pressed={wrap} onClick={() => setWrap(!wrap)}><Icon name="wrap" size={14} /></button>
            <button type="button" className="icon-btn" title="Show Generated SQL" aria-label="Show Generated SQL" onClick={() => setShowSql(true)}><Icon name="code" size={14} /></button>
          </div>
          {error && <div className="error" role="alert">{error}</div>}
          {!error && warnings.map((w) => (
            <div className="warning" role="status" key={w.field}>
              No data has a field <code>{w.field}</code>, so it matches nothing.
              {w.suggestion && <> Did you mean <button type="button" className="link" onClick={() => go({ where: replaceField(state.where, w.field, w.suggestion!) })}>{w.suggestion}</button>?</>}
            </div>
          ))}
          <Histogram buckets={hist.buckets} stepSeconds={hist.stepSeconds} range={range}
            series={series} onSelect={(r) => go({ window: r })} />
          {denoising && (
            <div className="denoise-note small muted" role="status">
              {noisy === null ? 'Denoise: finding common patterns…'
                : !columns.some((c) => c.key === 'body') ? 'Denoise needs the body column in SELECT.'
                : `Denoise: ${noisy.size} common pattern${noisy.size === 1 ? '' : 's'} hidden, ${(rows.length - shownRows.length).toLocaleString()} of ${rows.length.toLocaleString()} loaded rows.`}
            </div>
          )}
          {tab === 'patterns' && state.source === 'logs' ? (
            <PatternsView spec={spec} total={total} onOpen={setSelected} />
          ) : tab === 'deltas' && state.source === 'traces' ? (
            <DeltasView spec={spec} onFilter={(f, v, mode) => actions.onFilter(f, v, mode)} />
          ) : (
            <ResultsTable columns={columns} rows={shownRows} selected={selected ? shownRows.indexOf(selected) : null} wrap={wrap}
              loadingMore={loadingMore} done={done} onSelect={(i) => setSelected(shownRows[i]!)}
              onRemoveColumn={(label) => go({ select: splitSelect(currentSelect).filter((c) => c !== label).join(', ') || DEFAULT_SELECT[state.source] })}
              onNearEnd={loadMore} onScrollTop={(top) => top > 40 && live && setPaused(true)} />
          )}
        </main>
      </div>

      {selected && (
        <RowSidePanel source={state.source} row={selected} actions={actions} onClose={() => setSelected(null)} onOpenRow={setSelected} />
      )}
      {showSql && (
        <div className="modal-back" onClick={() => setShowSql(false)}>
          <div className="modal" role="dialog" aria-label="Generated SQL" onClick={(e) => e.stopPropagation()}>
            <div className="modal-head"><strong>Generated SQL</strong><span className="grow" />
              <button type="button" className="icon-btn" aria-label="Close" onClick={() => setShowSql(false)}><Icon name="close" size={14} /></button></div>
            <h4>Results</h4><pre className="sql">{sql.search}</pre>
            <h4>Timeline</h4><pre className="sql">{sql.histogram}</pre>
          </div>
        </div>
      )}
    </div>
  );
}
