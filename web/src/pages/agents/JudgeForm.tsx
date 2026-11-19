import { type ReactNode, useEffect, useMemo, useState } from 'react';
import * as api from '../../api/judges.ts';
import { ReadRecord, Stage, VerdictTag } from '../../components/agents/JudgePlan.tsx';
import { SqlDialog } from '../../components/agents/SqlDialog.tsx';
import { plural } from '../../lib/agents/format.ts';
import { canRun, type Draft, draftBody, draftFrom, editDraft, MAX_BEFORE, RESULTS, TOOLS, TRY } from '../../lib/agents/judges.ts';
import type { Go } from '../../Root.tsx';

/** How long the form waits after a change before it counts the picked steps again. */
const QUIET_MS = 400;

/** A sample of the picked steps, judged when tried. */
function Samples({ sample, tried }: { sample: api.Sample[]; tried: boolean }) {
  if (!tried) return <p className="muted">Runs the criterion on {TRY} of the picked steps, so that you can read the verdicts before judging them all. Nothing is stored.</p>;
  if (!sample.length) return <p className="muted">No step is picked, so there is nothing to try.</p>;
  return (
    <>{sample.map((s) => (
      <div key={`${s.session_id}:${s.seq}`} className="jg-try">
        <ReadRecord text={s.text} />
        {s.verdict && <p className="jg-why"><VerdictTag verdict={s.verdict} /> {s.reason}</p>}
      </div>
    ))}</>
  );
}

/** The form of a new judge: what it picks, what the model reads, the criterion, a try, the run. */
export function JudgeForm({ go }: { go: Go }) {
  const [setup, setSetup] = useState<api.TemplatesAnswer | null>(null);
  const [draft, setDraft] = useState<Draft | null>(null);
  const [look, setLook] = useState<api.PreviewAnswer | null>(null);
  const [tried, setTried] = useState<api.PreviewAnswer | null>(null);
  const [busy, setBusy] = useState<'try' | 'run' | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [showSql, setShowSql] = useState(false);

  useEffect(() => {
    const ac = new AbortController();
    api.templates(ac.signal).then((a) => { setSetup(a); setDraft(draftFrom(Object.keys(a.templates)[0]!, a.templates)); }, (e: Error) => { if (!ac.signal.aborted) setError(e.message); });
    return () => ac.abort();
  }, []);

  // The picked steps and what the model would read are counted again shortly after a change.
  const asked = useMemo(() => (draft ? JSON.stringify({ pick: draft.pick, reads: draftBody(draft).reads }) : ''), [draft]);
  useEffect(() => {
    if (!draft) return undefined;
    const ac = new AbortController();
    const t = setTimeout(() => {
      const { name: _n, runsOnNew: _r, ...body } = draftBody(draft);
      api.preview(body, ac.signal).then((a) => { setLook(a); setError(null); }, (e: Error) => { if (!ac.signal.aborted) setError(e.message); });
    }, QUIET_MS);
    return () => { clearTimeout(t); ac.abort(); };
  }, [asked]); // eslint-disable-line react-hooks/exhaustive-deps

  if (!setup || !draft) return <div className="ag-page">{error ? <div className="error" role="alert">{error}</div> : <p className="muted jg-hint">Loading…</p>}</div>;
  const edit = (field: string, value: string | boolean) => { setDraft(editDraft(draft, field, value, setup.templates)); setTried(null); };
  const steps = look?.steps ?? 0;
  const tryIt = () => {
    const { name: _n, runsOnNew: _r, ...body } = draftBody(draft);
    setBusy('try');
    api.preview({ ...body, try: true }).then((a) => { setTried(a); setError(null); }, (e: Error) => setError(e.message)).finally(() => setBusy(null));
  };
  const run = () => {
    setBusy('run');
    api.create(draftBody(draft)).then((a) => go(`/agents/judges/${encodeURIComponent(a.judge.id)}`), (e: Error) => { setError(e.message); setBusy(null); });
  };
  const option = ([value, label]: [string, string]) => <option key={value} value={value}>{label}</option>;
  const radio = (kind: Draft['reads']['kind'], label: ReactNode) => (
    <label className="jg-radio"><input type="radio" name="reads" checked={draft.reads.kind === kind} onChange={() => edit('reads', kind)} /> {label}</label>
  );

  return (
    <div className="ag-page">
      <div className="ag-bar">
        <div className="ag-title">
          <button type="button" className="ag-back" onClick={() => go('/agents/judges')}>← Judges</button>
          <h1>New judge</h1>
        </div>
        <div className="ag-tools"><button type="button" aria-haspopup="dialog" onClick={() => setShowSql(true)}>SQL</button></div>
      </div>
      {error && <div className="error" role="alert">{error}</div>}
      <div className="jg-body">
        <ol className="jg-plan jg-form">
          <Stage no={1} where="doris" title="Pick the steps to judge">
            <div className="jg-row">
              <label>Tool<select aria-label="Tool" value={draft.pick.tool} onChange={(e) => edit('tool', e.target.value)}>{TOOLS.map(option)}</select></label>
              <label>Target contains<input aria-label="Target contains" value={draft.pick.has} placeholder="any; a | b for either" size={30} onChange={(e) => edit('has', e.target.value)} /></label>
              <label>Result<select aria-label="Result" value={draft.pick.status} onChange={(e) => edit('status', e.target.value)}>{RESULTS.map(option)}</select></label>
              <span className="jg-count" role="status">{look ? `${plural(look.steps, 'step')} in ${plural(look.sessions, 'session')}` : 'Counting…'}</span>
            </div>
          </Stage>
          <Stage no={2} where="doris" title="Choose what the model reads">
            <div className="jg-row">
              {radio('step', 'The step alone')}
              {radio('before', <>The step and <input type="number" aria-label="Steps before" min={1} max={MAX_BEFORE} value={draft.reads.n} onChange={(e) => edit('n', e.target.value)} /> steps before it</>)}
              {radio('turn', 'The whole turn up to the step')}
            </div>
            <p className="muted">The user's request of the turn is always included.</p>
          </Stage>
          <Stage no={3} where="model" title="Write the criterion">
            <div className="jg-row">
              <label>Start from<select aria-label="Start from" value={draft.template} onChange={(e) => edit('template', e.target.value)}>
                {Object.entries(setup.templates).map(([k, t]) => option([k, t.name]))}{option(['own', 'My own criterion'])}
              </select></label>
              <label>Model<select aria-label="Model" value={draft.model} onChange={(e) => edit('model', e.target.value)}>{setup.models.map((m) => option([m, m]))}</select></label>
            </div>
            <label className="jg-full">Name<input aria-label="Name" value={draft.name} onChange={(e) => edit('name', e.target.value)} /></label>
            <label className="jg-full">Criterion, a question the model answers with violates or does not<textarea aria-label="Criterion" rows={3} value={draft.criterion} onChange={(e) => edit('criterion', e.target.value)} /></label>
          </Stage>
          <Stage no={4} where="model" title={`Try it on ${TRY} steps`}>
            <button type="button" disabled={!steps || !draft.criterion.trim() || busy !== null} onClick={tryIt}>{busy === 'try' ? 'Trying…' : tried ? 'Try again' : `Try on ${TRY} steps`}</button>
            <Samples sample={tried?.sample ?? []} tried={tried !== null} />
          </Stage>
          <Stage no={5} where="doris" title="Run">
            <p className="muted">{plural(steps, 'model call')}, about {(look?.estimate ?? 0).toLocaleString('en-US')} input tokens. The run-judges command takes the run (see the README).</p>
            <label className="jg-radio"><input type="checkbox" checked={draft.runsOnNew} onChange={(e) => edit('runsOnNew', e.target.checked)} /> Also judge new sessions as they arrive</label>
            <div className="jg-row">
              <button type="button" className="go" disabled={!canRun(draft, steps) || busy !== null} onClick={run}>{busy === 'run' ? 'Saving…' : `Run on ${plural(steps, 'step')}`}</button>
              <button type="button" onClick={() => go('/agents/judges')}>Cancel</button>
            </div>
          </Stage>
        </ol>
      </div>
      {showSql && <SqlDialog statements={(tried ?? look)?.sql ?? []} onClose={() => setShowSql(false)} />}
    </div>
  );
}
