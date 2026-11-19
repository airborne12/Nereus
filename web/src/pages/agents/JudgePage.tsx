import { Fragment, useEffect, useState } from 'react';
import * as api from '../../api/judges.ts';
import { ReadRecord, Stage, VerdictTag } from '../../components/agents/JudgePlan.tsx';
import { SqlDialog } from '../../components/agents/SqlDialog.tsx';
import { plural, stamp, timeOf } from '../../lib/agents/format.ts';
import { ADMIN_ONLY, leftOver, parseJudgeState, serializeJudgeState, type StepRef, stepText, versionChange, VIEWS } from '../../lib/agents/judges.ts';
import { sessionUrl } from '../../lib/agents/pages.ts';
import type { Go } from '../../Root.tsx';
import type { From } from './TablePage.tsx';

const HEADS: Record<api.View, string[]> = {
  first: ['Time', 'Session', 'First violating step', 'Why', 'Violations'],
  all: ['Time', 'Session', 'Step', 'Verdict', 'Version', 'Why'],
  changed: ['Time', 'Session', 'Step', 'Was', 'Now', 'Why now'],
};
const when = (v: string | null) => { const ms = timeOf(v); return ms === null ? '' : stamp(ms); };
const stale = (r: api.VerdictRow) => r.stale === true || Number(r.stale) === 1;
const Made = ({ r }: { r: api.VerdictRow }) => <span className={`jg-ver${stale(r) ? ' stale' : ''}`}>v{r.made_by}{stale(r) ? ', out of date' : ''}</span>;

/** Stage 3: the criterion and model of the current version, a form to change them, and the versions. */
function Criterion({ data, admin, onSave }: { data: api.JudgeAnswer; admin: boolean; onSave: (criterion: string, model: string) => Promise<void> }) {
  const cur = data.versions.find((v) => v.version === data.judge.currentVersion)!;
  const [editing, setEditing] = useState(false);
  const [criterion, setCriterion] = useState(cur.criterion);
  const [model, setModel] = useState(cur.model);
  const [models, setModels] = useState<string[]>([cur.model]);
  const [problem, setProblem] = useState<string | null>(null);
  // The models offered are the server's, with the judge's own model kept among them.
  const start = () => {
    setCriterion(cur.criterion);
    setModel(cur.model);
    setProblem(null);
    setEditing(true);
    api.templates().then((a) => setModels([...new Set([...a.models, cur.model])]), (e: Error) => setProblem(`The models could not be read: ${e.message}`));
  };
  return (
    <>
      {editing ? (
        <div className="jg-form">
          <label className="jg-full">Criterion<textarea rows={3} value={criterion} onChange={(e) => setCriterion(e.target.value)} /></label>
          <div className="jg-row">
            <label>Model<select value={model} onChange={(e) => setModel(e.target.value)}>{models.map((m) => <option key={m}>{m}</option>)}</select></label>
            {problem && <span className="error" role="alert">{problem}</span>}
            <button type="button" className="go" onClick={() => { onSave(criterion, model).then(() => setEditing(false), () => {}); }}>Save as v{cur.version + 1}</button>
            <button type="button" onClick={() => setEditing(false)}>Cancel</button>
          </div>
          <p className="muted">Saving does not judge anything again. The verdicts stay as they are, marked out of date, until you rerun them.</p>
        </div>
      ) : (
        <>
          <p className="jg-criterion">{cur.criterion}</p>
          <p className="muted"><code>{cur.model}</code> · criterion v{cur.version} · {data.judge.runsOnNew ? 'new sessions are judged as they arrive' : 'run once'} ·{' '}
            <button type="button" className="jg-link" disabled={!admin} title={admin ? undefined : ADMIN_ONLY} onClick={start}>Change criterion or model</button></p>
        </>
      )}
      {data.versions.length > 1 && (
        <table className="ag-table jg-versions" aria-label="Versions">
          <thead><tr><th><span className="jg-th">Time</span></th><th className="num"><span className="jg-th">Version</span></th><th><span className="jg-th">Changed</span></th><th><span className="jg-th">Model</span></th><th><span className="jg-th">By</span></th></tr></thead>
          <tbody>{[...data.versions].reverse().map((v) => {
            const prev = data.versions.find((p) => p.version === v.version - 1);
            return <tr key={v.version}><td className="ag-time">{when(v.createdAt)}</td><td className="num">{v.version}</td><td>{prev ? versionChange(prev, v) : ''}</td><td><code>{v.model}</code></td><td>{v.createdBy}</td></tr>;
          })}</tbody>
        </table>
      )}
    </>
  );
}

/** Stage 4: what is stored, the last run, and the reruns that bring out-of-date verdicts up to date. */
function Store({ data, admin, onRerun }: { data: api.JudgeAnswer; admin: boolean; onRerun: (only: api.Rerun) => void }) {
  const c = data.counts;
  const may = { disabled: !admin, title: admin ? undefined : ADMIN_ONLY };
  const last = data.runs.at(-1);
  const about = (n: number) => `about ${(n * c.tokensPerStep).toLocaleString('en-US')} input tokens`;
  const partial = c.staleViolating > 0 && c.staleViolating < c.stale;
  return (
    <>
      <p className="muted">{plural(c.judged, 'verdict')}, {c.violations} violating, in <code>agent_judgments</code>, each with the steps it read and the judge version that made it. A rerun adds rows; older verdicts are kept.</p>
      {last && (
        <p className="muted jg-run">Last run: <b>{last.status}</b> · {last.judged}{last.steps === null ? '' : ` of ${last.steps}`} steps · {last.inputTokens.toLocaleString('en-US')} input tokens
          {last.error ? ` · ${last.error}` : ''}{last.status === 'queued' ? ' · runs are taken by the run-judges command (see the README)' : ''}</p>
      )}
      {c.stale > 0 && (
        <div className="jg-staled">
          <p><b>{plural(c.stale, 'verdict')} out of date.</b> An older version made them; the judge is now v{data.judge.currentVersion}.
            {data.judge.runsOnNew ? ` New sessions are already judged with v${data.judge.currentVersion}.` : ''} Until they are rerun, the tables below still count them.</p>
          <div className="jg-row">
            <span className="jg-opt"><button type="button" className="go" {...may} onClick={() => onRerun('all')}>Rerun all {c.stale}</button><span className="muted">{about(c.stale)}</span></span>
            {partial && <span className="jg-opt"><button type="button" {...may} onClick={() => onRerun('violates')}>Rerun the {c.staleViolating} violating only</button><span className="muted">{about(c.staleViolating)}</span></span>}
          </div>
          {partial && <p className="muted">Rerunning only the violating verdicts finds those that no longer hold, but not steps that now violate.</p>}
        </div>
      )}
      {(leftOver(last) || c.failed > 0) && (
        <div className="jg-row">
          {leftOver(last) && <span className="jg-opt"><button type="button" {...may} onClick={() => onRerun('unjudged')}>Judge the steps the last run left</button><span className="muted">with the judge's budget of {data.judge.budget.toLocaleString('en-US')} input tokens</span></span>}
          {c.failed > 0 && <span className="jg-opt"><button type="button" {...may} onClick={() => onRerun('failed')}>Judge again the {c.failed} whose model call failed</button><span className="muted">{about(c.failed)}</span></span>}
        </div>
      )}
    </>
  );
}

/** What the model read for one step, its verdicts, and the way to the step in its session. */
function Detail({ id, row, onOpen, onSql }: { id: string; row: api.VerdictRow; onOpen: () => void; onSql: (s: api.StepAnswer['sql']) => void }) {
  const [data, setData] = useState<api.StepAnswer | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    const ac = new AbortController();
    api.step(id, row.session_id, Number(row.seq), ac.signal).then((a) => { setData(a); onSql(a.sql); }, (e: Error) => { if (!ac.signal.aborted) setError(e.message); });
    return () => ac.abort();
  }, [id, row.session_id, row.seq]); // eslint-disable-line react-hooks/exhaustive-deps
  return (
    <section className="jg-detail" aria-label="What the model read">
      <h3>What the model read for {stepText(row)} of {row.title ?? row.session_id}</h3>
      {error && <div className="error" role="alert">{error}</div>}
      {!data && !error && <p className="muted">Loading…</p>}
      {data?.read ? <ReadRecord text={data.read} /> : data && <p className="muted">The step is no longer in the data.</p>}
      {data?.verdicts.map((v) => (
        <p key={v.judge_version} className="jg-why"><VerdictTag verdict={v.verdict} /> {v.reason}<span className="muted"> · <code>{v.model}</code> · v{v.judge_version} · {when(v.judged_at)}</span></p>
      ))}
      <button type="button" className="jg-link" onClick={onOpen}>Open the step in its session</button>
    </section>
  );
}

/** A judge's page: its plan as five stages, then its verdicts in one of three views. */
export function JudgePage({ id, search, go, admin }: { id: string; search: string; go: Go; admin: boolean }) {
  const state = parseJudgeState(search);
  const [data, setData] = useState<api.JudgeAnswer | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [note, setNote] = useState<string | null>(null);
  const [tick, setTick] = useState(0);
  const [showSql, setShowSql] = useState(false);
  const [stepSql, setStepSql] = useState<api.StepAnswer['sql']>([]);

  useEffect(() => {
    const ac = new AbortController();
    setError(null);
    api.judge(id, state.view, ac.signal).then(setData, (e: Error) => { if (!ac.signal.aborted) setError(e.message); });
    return () => ac.abort();
  }, [id, state.view, tick]);

  const here = `/agents/judges/${encodeURIComponent(id)}`;
  const change = (next: typeof state) => go(`${here}${serializeJudgeState(next)}`, { replace: true });
  const act = (work: Promise<unknown>, done: string) => work.then(() => { setNote(done); setTick((t) => t + 1); }, (e: Error) => { setError(e.message); throw e; });
  // Until the answer of the view asked for comes, the table says it is loading.
  const loading = data?.view !== state.view;
  const rows = loading ? [] : data!.rows;
  const chosen = state.row ? rows.find((r) => r.session_id === state.row!.session_id && Number(r.seq) === state.row!.seq) : undefined;
  const pickRow = (r: api.VerdictRow) => change({ ...state, row: { session_id: r.session_id, seq: Number(r.seq) } as StepRef });
  const back: From = { from: `${here}${search}`, label: data?.judge.name ?? 'Judge' };

  return (
    <div className="ag-page">
      <div className="ag-bar">
        <div className="ag-title">
          <button type="button" className="ag-back" onClick={() => go('/agents/judges')}>← Judges</button>
          <h1>{data?.judge.name ?? 'Judge'}</h1>
        </div>
        <div className="ag-tools"><button type="button" aria-haspopup="dialog" onClick={() => setShowSql(true)}>SQL</button></div>
      </div>
      {error && <div className="error" role="alert">{error}</div>}
      {note && <div className="jg-note-bar" role="status">{note}</div>}
      {!data && !error && <p className="muted jg-hint">Loading…</p>}
      {data && (
        <div className="jg-body">
          <ol className="jg-plan">
            <Stage no={1} where="doris" title="Pick the steps to judge"><p className="muted">{data.pickText}: {plural(data.counts.judged, 'step')} judged.</p></Stage>
            <Stage no={2} where="doris" title="Put together what the model reads"><p className="muted">For each step: {data.readsText}.</p></Stage>
            <Stage no={3} where="model" title="Judge each step">
              <Criterion key={data.judge.currentVersion} data={data} admin={admin} onSave={(c, m) => act(api.addVersion(id, c, m), `Saved version ${data.judge.currentVersion + 1}. Nothing was judged again.`)} />
            </Stage>
            <Stage no={4} where="doris" title="Store the verdicts">
              <Store data={data} admin={admin} onRerun={(only) => { act(api.rerun(id, only), 'Rerun queued. The run-judges command takes it.').catch(() => {}); }} />
            </Stage>
            <Stage no={5} where="doris" title="Query the verdicts">
              <div className="jg-seg" role="group" aria-label="Query">
                {(Object.keys(VIEWS) as api.View[]).map((v) => (
                  <button type="button" key={v} aria-pressed={v === state.view} onClick={() => change({ view: v, row: null })}>{VIEWS[v]}</button>
                ))}
              </div>
            </Stage>
          </ol>
          <table className="ag-table jg-verdicts" aria-label={VIEWS[state.view]}>
            <thead><tr>{HEADS[state.view].map((h) => <th key={h} className={h === 'Violations' ? 'num' : ''}><span className="jg-th">{h}</span></th>)}</tr></thead>
            <tbody>
              {rows.map((r) => (
                <Fragment key={`${r.session_id}:${r.seq}`}>
                <tr tabIndex={0} className={`jg-row${chosen === r ? ' sel' : ''}`} onClick={() => pickRow(r)} onKeyDown={(e) => { if (e.key === 'Enter') pickRow(r); }}>
                  <td className="ag-time">{when(r.ts)}</td>
                  <td>{r.title ?? r.session_id}</td>
                  <td className="jg-step"><code>{stepText(r)}</code></td>
                  {state.view === 'first' && <><td className="jg-reason">{r.reason} {stale(r) && <Made r={r} />}</td><td className="num">{r.violations}</td></>}
                  {state.view === 'all' && <><td><VerdictTag verdict={r.verdict} /></td><td><Made r={r} /></td><td className="jg-reason">{r.reason}</td></>}
                  {state.view === 'changed' && <><td><VerdictTag verdict={r.was ?? ''} /> <span className="muted">v{r.was_version}</span></td><td><VerdictTag verdict={r.verdict} /> <span className="muted">v{r.made_by}</span></td><td className="jg-reason">{r.reason}</td></>}
                </tr>
                {chosen === r && (
                  <tr className="jg-open">
                    <td colSpan={HEADS[state.view].length}>
                      <Detail key={`${r.session_id}:${r.seq}`} id={id} row={r} onSql={setStepSql} onOpen={() => go(sessionUrl(r.root_id ?? r.session_id, `s:${r.session_id}:${r.seq}`), { state: back })} />
                    </td>
                  </tr>
                )}
                </Fragment>
              ))}
              {loading && <tr className="ag-none"><td colSpan={HEADS[state.view].length}>Loading…</td></tr>}
              {!loading && rows.length === 0 && (
                <tr className="ag-none"><td colSpan={HEADS[state.view].length}>{state.view === 'changed' ? 'No rerun has changed a verdict.' : state.view === 'first' ? 'No step was judged as violating.' : 'No step has been judged yet.'}</td></tr>
              )}
            </tbody>
          </table>
          {!loading && data.cut && <p className="muted jg-hint">Only the {rows.length.toLocaleString('en-US')} newest are shown. The statement behind the SQL button reads them all.</p>}
          {!chosen && !loading && rows.length > 0 && <p className="muted jg-hint">Click a row to see what the model read and why it decided.</p>}
        </div>
      )}
      {showSql && <SqlDialog statements={[...(data?.sql ?? []), ...(chosen ? stepSql : [])]} onClose={() => setShowSql(false)} />}
    </div>
  );
}
