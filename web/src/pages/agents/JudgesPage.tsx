import { useEffect, useState } from 'react';
import * as api from '../../api/judges.ts';
import { SqlDialog } from '../../components/agents/SqlDialog.tsx';
import { stamp, timeOf } from '../../lib/agents/format.ts';
import { ADMIN_ONLY, runsOnText } from '../../lib/agents/judges.ts';
import type { Go } from '../../Root.tsx';

const HEAD: [string, string][] = [
  ['Last verdict', ''], ['Judge', ''], ['Judges', ''], ['Model', ''], ['Version', 'num'], ['Runs on', ''],
  ['Steps judged', 'num'], ['Violations', 'num'], ['Sessions', 'num'], ['Out of date', 'num'],
];

/** The last run of a judge in a few words, when it is not done. */
function runNote(r: api.Run | null): string {
  if (!r || r.status === 'done') return '';
  if (r.status === 'queued') return 'run queued';
  if (r.status === 'running') return `running, ${r.judged}${r.steps === null ? '' : ` of ${r.steps}`}`;
  return `last run ${r.status}`;
}

/** The Judges page: every judge with what it judges and the counts of its latest verdicts. */
export function JudgesPage({ go, admin }: { go: Go; admin: boolean }) {
  const [data, setData] = useState<api.ListAnswer | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [showSql, setShowSql] = useState(false);

  useEffect(() => {
    const ac = new AbortController();
    api.list(ac.signal).then(setData, (e: Error) => { if (!ac.signal.aborted) setError(e.message); });
    return () => ac.abort();
  }, []);

  const open = (id: string) => go(`/agents/judges/${encodeURIComponent(id)}`);
  return (
    <div className="ag-page">
      <div className="ag-bar">
        <div className="ag-title">
          <h1>Judges</h1>
          <span className="muted">A model judges what steps mean; the steps it reads and what is done with its verdicts are queries in Doris.</span>
        </div>
        <div className="ag-tools">
          <button type="button" className="go" disabled={!admin} title={admin ? undefined : ADMIN_ONLY} onClick={() => go('/agents/judges/new')}>New judge</button>
          <button type="button" aria-haspopup="dialog" onClick={() => setShowSql(true)}>SQL</button>
        </div>
      </div>
      {error && <div className="error" role="alert">{error}</div>}
      <div className="ag-grid">
        <table className="ag-table" aria-label="Judges">
          <thead><tr>{HEAD.map(([h, c]) => <th key={h} className={c}><span className="jg-th">{h}</span></th>)}</tr></thead>
          <tbody>
            {(data?.rows ?? []).map((j) => {
              const at = timeOf(j.lastJudged);
              const note = runNote(j.lastRun);
              return (
                <tr key={j.id} tabIndex={0} className="jg-row" onClick={() => open(j.id)} onKeyDown={(e) => { if (e.key === 'Enter') open(j.id); }}>
                  <td className="ag-time">{at === null ? '-' : stamp(at)}</td>
                  <td><b>{j.name}</b>{note && <span className="jg-note">{note}</span>}</td>
                  <td>{j.pickText}</td>
                  <td><code>{j.model}</code></td>
                  <td className="num">{j.version}</td>
                  <td>{runsOnText(j.runsOnNew)}</td>
                  <td className="num">{j.judged}</td>
                  <td className="num">{j.violations ? <b className="bad">{j.violations}</b> : 0}</td>
                  <td className="num">{j.sessions}</td>
                  <td className="num">{j.stale ? <span className="jg-stale">{j.stale}</span> : <span className="muted">0</span>}</td>
                </tr>
              );
            })}
            {data && data.rows.length === 0 && (
              <tr className="ag-none"><td colSpan={HEAD.length}>No judge yet. Make one with New judge; it judges the steps it picks when run-judges runs (see the README).</td></tr>
            )}
            {!data && !error && <tr className="ag-none"><td colSpan={HEAD.length}>Loading…</td></tr>}
          </tbody>
        </table>
      </div>
      {showSql && <SqlDialog statements={data?.sql ?? []} onClose={() => setShowSql(false)} />}
    </div>
  );
}
