import { useCallback, useEffect, useMemo, useState } from 'react';
import * as api from '../../api/agents.ts';
import { ColumnsMenu } from '../../components/agents/ColumnsMenu.tsx';
import { DataTable, PAIR } from '../../components/agents/DataTable.tsx';
import { ExportDialog } from '../../components/agents/ExportDialog.tsx';
import { SqlDialog } from '../../components/agents/SqlDialog.tsx';
import { TableFilters } from '../../components/agents/TableFilters.tsx';
import { openTarget, PAGES, type PageDef, sessionUrl, shownColumns } from '../../lib/agents/pages.ts';
import { parseTableState, queryOf, serializeTableState, sortBy, type TableState } from '../../lib/agents/table.ts';
import type { Go } from '../../Root.tsx';

/** What the table holds: the rows read so far of one filter, resolved at one time. */
interface Loaded { key: string; now: number; rows: api.Row[]; total: number; sql: api.Statement[] }

/** Where a session page or a comparison goes back to. */
export interface From { from: string; label: string }

const here = (): string => window.location.pathname + window.location.search;

/** A table page of the Agent trajectories area: Sessions, Steps or Messages. Its state lives in the address. */
export function TablePage({ def, search, go }: { def: PageDef; search: string; go: Go }) {
  const state = useMemo(() => parseTableState(search, def), [search, def]);
  // The columns shown do not change what is read.
  const key = useMemo(() => serializeTableState({ ...state, columns: null }, def), [state, def]);
  const [data, setData] = useState<Loaded | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loadingMore, setLoadingMore] = useState(false);
  const [dialog, setDialog] = useState<'sql' | 'export' | null>(null);
  const [picked, setPicked] = useState<string[]>([]);
  const closeDialog = useCallback(() => setDialog(null), []);

  useEffect(() => {
    const ac = new AbortController();
    const now = Date.now();
    setError(null);
    api.table(def.name, queryOf(state, now, 0), ac.signal).then(
      (a) => setData({ key, now, rows: a.rows, total: a.total, sql: a.sql }),
      (e: Error) => {
        if (ac.signal.aborted) return;
        setData(null);
        setError(e.message);
      },
    );
    return () => ac.abort();
  }, [def, key]); // eslint-disable-line react-hooks/exhaustive-deps

  const fresh = data?.key === key ? data : null;
  const change = (next: TableState) => go(`/agents/${def.name}${serializeTableState(next, def)}`, { replace: true });
  const more = () => {
    if (!fresh) return;
    setLoadingMore(true);
    api.table(def.name, queryOf(state, fresh.now, fresh.rows.length)).then(
      (a) => setData((d) => (d && d.key === fresh.key ? { ...d, rows: [...d.rows, ...a.rows], total: a.total, sql: a.sql } : d)),
      (e: Error) => setError(e.message),
    ).finally(() => setLoadingMore(false));
  };
  const back: From = { from: here(), label: def.label };
  const open = (row: api.Row) => {
    const t = openTarget(def.name, row);
    go(sessionUrl(t.root, t.sel), { state: back });
  };
  const pick = (id: string) => setPicked((p) => (p.includes(id) ? p.filter((x) => x !== id) : p.length < PAIR ? [...p, id] : p));
  const columns = shownColumns(def, state.columns);
  const rows = data?.rows ?? [];
  const filtered = state.q.trim() !== '' || state.conditions.length > 0;

  return (
    <div className="ag-page">
      <div className="ag-bar">
        <div className="ag-title">
          <h1>{def.label}</h1>
          <span className="ag-pages" role="group" aria-label="Pages">
            {Object.values(PAGES).map((p) => (
              <button type="button" key={p.name} aria-current={p.name === def.name ? 'page' : undefined} onClick={() => go(`/agents/${p.name}`)}>{p.label}</button>
            ))}
          </span>
          <span className="muted">{def.unit}</span>
        </div>
        <div className="ag-tools">
          {def.name === 'sessions' && (
            <button type="button" className={picked.length === PAIR ? 'go' : ''} disabled={picked.length !== PAIR}
              title={picked.length === PAIR ? 'Compare the two ticked sessions' : picked.length ? 'Tick one more session to compare' : 'Tick two sessions in the table to compare them'}
              onClick={() => go(`/agents/compare?a=${encodeURIComponent(picked[0]!)}&b=${encodeURIComponent(picked[1]!)}`, { state: back })}>
              {picked.length ? `Compare ${picked.length}/${PAIR}` : 'Compare'}
            </button>
          )}
          <button type="button" aria-haspopup="dialog" disabled={!fresh} onClick={() => setDialog('export')}>Export</button>
          <ColumnsMenu def={def} shown={columns} onChange={(c) => change({ ...state, columns: c })} />
          <button type="button" aria-haspopup="dialog" onClick={() => setDialog('sql')}>SQL</button>
        </div>
      </div>
      <TableFilters def={def} state={state} total={fresh ? fresh.total : error ? 0 : null} onChange={change} />
      {error && <div className="error" role="alert">{error}</div>}
      <div className={`ag-grid${fresh || !data ? '' : ' stale'}`}>
        <DataTable def={def} columns={columns} rows={rows} sort={state.sort} dir={state.dir} onSort={(c) => change(sortBy(state, c))} onOpen={open}
          more={fresh ? fresh.total - fresh.rows.length : 0} onMore={more} loadingMore={loadingMore}
          empty={!data && !error ? 'Loading…' : filtered || def.name !== 'sessions'
            ? 'Nothing matches. Widen the time range or clear the filter.'
            : 'No sessions in this time range. Widen the range, or import transcripts with the import-transcripts command (see the README).'}
          {...(def.name === 'sessions' ? { picked, onPick: pick, onClearPicked: () => setPicked([]) } : {})} />
      </div>
      {dialog === 'sql' && <SqlDialog statements={data?.sql ?? []} onClose={closeDialog} />}
      {dialog === 'export' && fresh && <ExportDialog def={def} state={state} now={fresh.now} onClose={closeDialog} />}
    </div>
  );
}
