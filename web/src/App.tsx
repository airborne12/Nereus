import { type ReactNode, useCallback, useEffect, useMemo, useState } from 'react';
import * as api from './api.ts';
import { DetailPanel } from './components/DetailPanel.tsx';
import { Histogram } from './components/Histogram.tsx';
import { QueryInput } from './components/QueryInput.tsx';
import { ResultsTable } from './components/ResultsTable.tsx';
import { TraceView } from './components/TraceView.tsx';
import { addFilter } from './lib/filters.ts';
import type { Row } from './lib/rows.ts';
import { PRESETS, type SearchState, parseState, resolveWindow, serializeState } from './lib/state.ts';

const LOG_SERIES = [
  { name: 'DEBUG', color: 'var(--lvl-debug)' },
  { name: 'INFO', color: 'var(--lvl-info)' },
  { name: 'WARN', color: 'var(--lvl-warn)' },
  { name: 'ERROR', color: 'var(--lvl-error)' },
];
const TRACE_SERIES = [
  { name: 'STATUS_CODE_UNSET', label: 'unset', color: 'var(--lvl-info)' },
  { name: 'STATUS_CODE_OK', label: 'ok', color: 'var(--lvl-debug)' },
  { name: 'STATUS_CODE_ERROR', label: 'error', color: 'var(--lvl-error)' },
];

function useUrlState(): [SearchState, (s: SearchState) => void] {
  const [state, setState] = useState(() => parseState(window.location.search));
  useEffect(() => {
    const onPop = () => setState(parseState(window.location.search));
    window.addEventListener('popstate', onPop);
    return () => window.removeEventListener('popstate', onPop);
  }, []);
  const update = useCallback((s: SearchState) => {
    window.history.pushState(null, '', serializeState(s));
    setState(s);
  }, []);
  return [state, update];
}

export function App({ userMenu }: { userMenu?: ReactNode }) {
  const [state, setState] = useUrlState();
  // "now" for relative windows; moves on every new search and on Refresh.
  const [now, setNow] = useState(() => Date.now());
  const range = useMemo(() => resolveWindow(state.window, now), [state.window, now]);
  const [rows, setRows] = useState<Row[]>([]);
  const [hist, setHist] = useState<{ stepSeconds: number; buckets: api.Bucket[] }>({ stepSeconds: 60, buckets: [] });
  const [elapsed, setElapsed] = useState<number | null>(null);
  const [error, setError] = useState<string | null>(null);
  // The search the rows on screen answer; it differs from the current one while loading.
  const searchKey = JSON.stringify([state.source, state.q, range.from, range.to]);
  const [shownKey, setShownKey] = useState<string | null>(null);
  const loading = shownKey !== searchKey;
  const [selected, setSelected] = useState<number | null>(null);

  const go = (patch: Partial<SearchState>) => {
    setNow(Date.now());
    setSelected(null);
    setState({ ...state, ...patch });
  };

  useEffect(() => {
    const ac = new AbortController();
    setError(null);
    const groupBy = state.source === 'logs' ? 'severity_text' : 'status_code';
    Promise.all([
      api.search(state.source, state.q, range, 200, ac.signal),
      api.histogram(state.source, state.q, range, groupBy, ac.signal),
    ]).then(([s, h]) => {
      setRows(s.rows);
      setElapsed(s.elapsedMs);
      setHist(h);
      setShownKey(searchKey);
    }, (e) => {
      if (ac.signal.aborted) return;
      setError(String(e.message ?? e));
      setRows([]);
      setHist({ stepSeconds: 60, buckets: [] });
      setShownKey(searchKey);
    });
    return () => ac.abort();
  }, [state.source, state.q, range, searchKey]);

  const selectedRow = selected === null ? null : rows[selected] ?? null;

  return (
    <div className="app">
      <header className="topbar">
        <span className="brand">DorisStack</span>
        <nav className="tabs" aria-label="Source">
          {(['logs', 'traces'] as const).map((s) => (
            <button type="button" key={s} className={state.source === s ? 'tab active' : 'tab'}
              onClick={() => go({ source: s, q: '' })}>{s === 'logs' ? 'Logs' : 'Traces'}</button>
          ))}
        </nav>
        <QueryInput source={state.source} value={state.q} range={range} onSubmit={(q) => go({ q })} />
        <select aria-label="Time range" className="range"
          value={'preset' in state.window ? state.window.preset : 'custom'}
          onChange={(e) => go({ window: { preset: e.target.value as (typeof PRESETS)[number] } })}>
          {PRESETS.map((p) => <option key={p} value={p}>Last {p}</option>)}
          {!('preset' in state.window) && <option value="custom">Custom</option>}
        </select>
        <button type="button" className="btn" onClick={() => go({})}>Refresh</button>
        {userMenu}
      </header>
      {!('preset' in state.window) && (
        <div className="range-note">
          {new Date(range.from).toLocaleString()} – {new Date(range.to).toLocaleString()}
        </div>
      )}
      {error && <div className="error" role="alert">{error}</div>}
      <Histogram buckets={hist.buckets} stepSeconds={hist.stepSeconds} range={range}
        series={state.source === 'logs' ? LOG_SERIES : TRACE_SERIES}
        onSelect={(r) => go({ window: r })} />
      <div className="status muted">
        {loading ? 'Searching…' : `Showing ${rows.length} newest${elapsed !== null ? ` · ${elapsed} ms` : ''}`}
      </div>
      <main className={selectedRow ? 'body with-detail' : 'body'}>
        <div className="table-wrap">
          <ResultsTable source={state.source} rows={rows} selected={selected} onSelect={setSelected} />
        </div>
        {selectedRow && (
          <DetailPanel row={selectedRow}
            onFilter={(field, value, exclude) => go({ q: addFilter(state.q, field, value, exclude) })}
            onTrace={(trace) => setState({ ...state, trace })}
            onClose={() => setSelected(null)} />
        )}
      </main>
      {state.trace && (
        <TraceView traceId={state.trace} range={range} onClose={() => setState({ ...state, trace: null })} />
      )}
    </div>
  );
}
