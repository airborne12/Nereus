import { useEffect, useMemo, useState } from 'react';
import type { Statement } from '../../api/agents.ts';
import * as api from '../../api/sequences.ts';
import { MatchTable } from '../../components/agents/MatchTable.tsx';
import { PathDrawing } from '../../components/agents/PathDrawing.tsx';
import { PatternBar } from '../../components/agents/PatternBar.tsx';
import { RangePicker } from '../../components/agents/RangePicker.tsx';
import { SqlDialog } from '../../components/agents/SqlDialog.tsx';
import { plural } from '../../lib/agents/format.ts';
import { sessionUrl } from '../../lib/agents/pages.ts';
import { drawPaths } from '../../lib/agents/path-draw.ts';
import { parseMarks } from '../../lib/agents/select.ts';
import { matchMarks, parseSeqState, patternOfPath, type SeqState, serializeSeqState, sortOf, type Step } from '../../lib/agents/sequences.ts';
import { PAGE_ROWS, resolveRange } from '../../lib/agents/table.ts';
import type { Go } from '../../Root.tsx';
import type { From } from './TablePage.tsx';

/** What the page holds: the answer for one state of the address, resolved at one time. */
type Loaded = { key: string; now: number } & (
  | { view: 'paths'; answer: api.NextAnswer }
  | { view: 'pattern'; rows: api.Match[]; matches: number; sessions: number; sql: Statement[] });

const PATH = '/agents/sequences';

/**
 * The Sequences page. It opens on a drawing: from one kind of event, the paths the sessions took
 * next. A path opens as a pattern, with the places in the sessions where it occurs.
 */
export function SequencesPage({ search, go }: { search: string; go: Go }) {
  const state = useMemo(() => parseSeqState(search), [search]);
  const key = serializeSeqState(state);
  const rangeKey = JSON.stringify(state.range);
  const [data, setData] = useState<Loaded | null>(null);
  const [tools, setTools] = useState<{ list: api.Tool[]; sql: Statement[] }>({ list: [], sql: [] });
  const [error, setError] = useState<string | null>(null);
  const [loadingMore, setLoadingMore] = useState(false);
  const [showSql, setShowSql] = useState(false);

  useEffect(() => {
    const ac = new AbortController();
    const now = Date.now();
    const range = resolveRange(state.range, now);
    setError(null);
    const fail = (e: Error) => {
      if (ac.signal.aborted) return;
      setData(null);
      setError(e.message);
    };
    if (state.pattern) {
      api.match({ ...range, pattern: state.pattern, sort: state.sort, dir: state.dir, limit: PAGE_ROWS, offset: 0 }, ac.signal)
        .then((a) => setData({ key, now, view: 'pattern', rows: a.rows, matches: a.matches, sessions: a.sessions, sql: a.sql }), fail);
    } else api.next(range, state.start, ac.signal).then((answer) => setData({ key, now, view: 'paths', answer }), fail);
    return () => ac.abort();
  }, [key]); // eslint-disable-line react-hooks/exhaustive-deps

  // The tools of the range: where a drawing can start, and what a step of a pattern can ask for.
  useEffect(() => {
    const ac = new AbortController();
    api.tools(resolveRange(state.range, Date.now()), ac.signal).then((a) => setTools({ list: a.tools, sql: a.sql }), (e: Error) => { if (!ac.signal.aborted) setError(e.message); });
    return () => ac.abort();
  }, [rangeKey]); // eslint-disable-line react-hooks/exhaustive-deps

  const fresh = data?.key === key ? data : null;
  const change = (next: SeqState, opts: { push?: boolean } = {}) => go(`${PATH}${serializeSeqState(next)}`, { replace: !opts.push });
  const openPattern = (pattern: Step[]) => change({ ...state, pattern, sort: 'time', dir: 'desc' }, { push: true });
  const setPattern = (pattern: Step[]) => change({ ...state, pattern, sort: sortOf(state.sort, pattern.length) });
  const sortBy = (column: string) => change({ ...state, sort: column, dir: state.sort === column && state.dir === 'desc' ? 'asc' : 'desc' });
  const more = () => {
    if (fresh?.view !== 'pattern' || !state.pattern) return;
    setLoadingMore(true);
    api.match({ ...resolveRange(state.range, fresh.now), pattern: state.pattern, sort: state.sort, dir: state.dir, limit: PAGE_ROWS, offset: fresh.rows.length }).then(
      (a) => setData((d) => (d && d.key === fresh.key && d.view === 'pattern' ? { ...d, rows: [...d.rows, ...a.rows], matches: a.matches, sessions: a.sessions, sql: a.sql } : d)),
      (e: Error) => setError(e.message),
    ).finally(() => setLoadingMore(false));
  };
  const openMatch = (m: api.Match) => {
    const marks = matchMarks(m);
    const back: From = { from: window.location.pathname + window.location.search, label: 'Pattern' };
    go(sessionUrl(m.root_id, parseMarks(marks)[0]?.key ?? null, marks), { state: back });
  };
  const sql = <button type="button" aria-haspopup="dialog" onClick={() => setShowSql(true)}>SQL</button>;
  const names = tools.list.map((t) => t.name);

  if (state.pattern) {
    const shown = data?.view === 'pattern' ? data : null;
    const found = fresh?.view === 'pattern' ? fresh : null;
    return (
      <div className="ag-page">
        <div className="ag-bar">
          <div className="ag-title">
            <button type="button" className="ag-back" onClick={() => change({ ...state, pattern: null }, { push: true })}>← Sequences</button>
            <h1>Pattern</h1><span className="muted">Where its steps follow one another in a session.</span>
          </div>
          <div className="ag-tools">{sql}</div>
        </div>
        <div className="ag-filters">
          <RangePicker range={state.range} onChange={(range) => change({ ...state, range })} />
          <span className="ag-total" role="status">{found ? `${plural(found.matches, 'match')} in ${plural(found.sessions, 'session')}` : error ? '' : 'Loading…'}</span>
        </div>
        <PatternBar pattern={state.pattern} tools={names} onChange={setPattern} />
        {error && <div className="error" role="alert">{error}</div>}
        <div className={`ag-grid${found || !shown ? '' : ' stale'}`}>
          {/* Rows of the pattern shown before stay while the new ones are read, unless they have other columns. */}
          <MatchTable pattern={state.pattern} rows={shown && shown.rows[0]?.steps.length === state.pattern.length ? shown.rows : []} sort={state.sort} dir={state.dir} onSort={sortBy} onOpen={openMatch}
            more={found ? found.matches - found.rows.length : 0} onMore={more} loadingMore={loadingMore}
            empty={found ? 'No events follow one another this way in the time range.' : error ? '' : 'Loading…'} />
        </div>
        {showSql && <SqlDialog statements={[...(shown?.sql ?? []), ...tools.sql]} onClose={() => setShowSql(false)} />}
      </div>
    );
  }

  const shown = data?.view === 'paths' ? data.answer : null;
  const drawn = fresh?.view === 'paths' ? fresh.answer : null;
  const starts = [['failed', 'a failed call'], ['user', 'a user input'], ...names.map((t) => [`tool:${t}`, `a call of ${t}`])];
  return (
    <div className="ag-page">
      <div className="ag-bar">
        <div className="ag-title"><h1>Sequences</h1><span className="muted">What happens next: start from an event and follow the events that came after it.</span></div>
        <div className="ag-tools">
          <button type="button" onClick={() => openPattern(patternOfPath(state.start, []))}>Write a pattern</button>
          {sql}
        </div>
      </div>
      <div className="ag-filters">
        <RangePicker range={state.range} onChange={(range) => change({ ...state, range })} />
        <label className="ag-start">Start from <select aria-label="Start from" value={state.start} onChange={(e) => change({ ...state, start: e.target.value })}>
          {(starts.some(([v]) => v === state.start) ? starts : [...starts, [state.start, `a call of ${state.start.replace(/^tool:/, '')}`]]).map(([v, label]) => <option key={v} value={v}>{label}</option>)}
        </select></label>
        <span className="ag-pkey"><i className="k1" />thicker line: more common<i className="k2" />failed call<i className="k3" />user input, reply, compaction</span>
        <span className="ag-total" role="status">{drawn ? plural(drawn.total, 'time') : error ? '' : 'Loading…'}</span>
      </div>
      {error && <div className="error" role="alert">{error}</div>}
      <div className={`ag-grid ag-pathbox${drawn || !shown ? '' : ' stale'}`}>
        {shown && shown.total > 0 && <PathDrawing drawing={drawPaths(shown, shown.start)} onOpen={openPattern} />}
        {shown && shown.total === 0 && <p className="empty">No such event in the time range.</p>}
        {!shown && !error && <p className="empty">Loading…</p>}
      </div>
      {showSql && <SqlDialog statements={[...(shown?.sql ?? []), ...tools.sql]} onClose={() => setShowSql(false)} />}
    </div>
  );
}
