import { type FormEvent, Fragment, useState } from 'react';
import { added, EXAMPLES, KIND_LABEL, LINK_LABEL, MAX_STEPS, type Step, type StepKind, withStep, without, words } from '../../lib/agents/sequences.ts';

interface FormProps {
  pattern: Step[];
  i: number;
  /** Tool names the range holds, most called first. */
  tools: string[];
  onApply: (step: Step) => void;
  onRemove: (() => void) | null;
  onCancel: () => void;
}

/** The form of the step being changed. Tool and status are asked only of a tool call. */
function StepForm({ pattern, i, tools, onApply, onRemove, onCancel }: FormProps) {
  const step = pattern[i]!;
  const [kind, setKind] = useState<StepKind>(step.kind);
  const [link, setLink] = useState(step.link ?? 'next');
  const [tool, setTool] = useState(step.tool ?? '');
  const [status, setStatus] = useState<string>(step.status ?? '');
  const [has, setHas] = useState(step.has ?? '');
  const [same, setSame] = useState(step.same ?? 0);
  const call = kind === 'call';
  const worded = kind !== 'compaction';
  const noun = call ? 'target' : 'text';
  // Each control is named on its own: a label that wraps a list would be read with the list's choice.
  // A step can share the text of an earlier step that has one.
  const earlier = pattern.slice(0, i).map((s, n) => ({ n: n + 1, s })).filter((x) => x.s.kind !== 'compaction');
  const offered = tool && !tools.includes(tool) ? [tool, ...tools] : tools;
  const submit = (e: FormEvent) => {
    e.preventDefault();
    onApply({
      kind,
      ...(call && tool ? { tool } : {}),
      ...(call && (status === 'ok' || status === 'failed') ? { status } : {}),
      ...(worded && has.trim() ? { has: has.trim() } : {}),
      ...(worded && step.any ? { any: step.any } : {}),
      ...(worded && same > 0 && earlier.some((x) => x.n === same) ? { same } : {}),
      ...(i > 0 ? { link } : {}),
    });
  };
  return (
    <form className="ag-fform" aria-label={`Step ${i + 1}`} onSubmit={submit}>
      <span>Step {i + 1}</span>
      {i > 0 && (
        <label>follows step {i} <select aria-label={`follows step ${i}`} value={link} onChange={(e) => setLink(e.target.value as 'next' | 'later')}>
          <option value="next">as the next event</option><option value="later">as any later event</option>
        </select></label>
      )}
      <label>Event <select aria-label="Event" value={kind} onChange={(e) => setKind(e.target.value as StepKind)}>
        {(Object.keys(KIND_LABEL) as StepKind[]).map((k) => <option key={k} value={k}>{KIND_LABEL[k]}</option>)}
      </select></label>
      {call && (
        <>
          <label>Tool <select aria-label="Tool" value={tool} onChange={(e) => setTool(e.target.value)}>
            <option value="">any</option>{offered.map((t) => <option key={t} value={t}>{t}</option>)}
          </select></label>
          <label>Status <select aria-label="Status" value={status} onChange={(e) => setStatus(e.target.value)}>
            <option value="">any</option><option value="ok">ok</option><option value="failed">failed</option>
          </select></label>
        </>
      )}
      {worded && <label>{call ? 'Target' : 'Text'} has <input aria-label={`${call ? 'Target' : 'Text'} has`} size={12} autoComplete="off" placeholder="text" value={has} onChange={(e) => setHas(e.target.value)} /></label>}
      {worded && earlier.length > 0 && (
        <label>Same {noun} as <select aria-label={`Same ${noun} as`} value={same} onChange={(e) => setSame(Number(e.target.value))}>
          <option value={0}>no step</option>{earlier.map((x) => <option key={x.n} value={x.n}>step {x.n}</option>)}
        </select></label>
      )}
      <button type="submit" className="go">Apply</button>
      {onRemove && <button type="button" onClick={onRemove}>Remove</button>}
      <button type="button" onClick={onCancel}>Cancel</button>
    </form>
  );
}

/** A pattern as a row of numbered steps joined by arrows; a step opens the form that changes it. */
export function PatternBar({ pattern, tools, onChange }: { pattern: Step[]; tools: string[]; onChange: (next: Step[]) => void }) {
  const [edit, setEdit] = useState<number | null>(null);
  const change = (next: Step[]) => {
    setEdit(null);
    onChange(next);
  };
  return (
    <>
      <div className="ag-pbar" role="group" aria-label="The steps of the pattern">
        {pattern.map((s, i) => (
          <Fragment key={i}>
            {i > 0 && <span className="ag-plink" title={LINK_LABEL[s.link ?? 'next']}><i>{s.link === 'later' ? '⇢' : '→'}</i>{s.link ?? 'next'}</span>}
            <button type="button" className={`ag-pel${edit === i ? ' on' : ''}${s.kind === 'call' ? '' : ' ev'}`} aria-expanded={edit === i} title="Change this step"
              onClick={() => setEdit(edit === i ? null : i)}>
              <b>{i + 1}</b>{words(s).map((w, n) => (n ? <span key={n}>{w}</span> : <code key={n}>{w}</code>))}
            </button>
          </Fragment>
        ))}
        {pattern.length < MAX_STEPS && (
          <button type="button" className="ag-chip" onClick={() => { onChange(added(pattern)); setEdit(pattern.length); }}>+ Add step</button>
        )}
        <label className="ag-pex">Examples <select aria-label="Examples" value="" onChange={(e) => { if (e.target.value) change(EXAMPLES[Number(e.target.value)]!.steps); }}>
          <option value="">from the paper</option>{EXAMPLES.map((x, i) => <option key={x.name} value={i}>{x.name}</option>)}
        </select></label>
      </div>
      {edit !== null && pattern[edit] && (
        <StepForm key={`${edit}:${JSON.stringify(pattern[edit])}`} pattern={pattern} i={edit} tools={tools}
          onApply={(step) => change(withStep(pattern, edit, step))}
          onRemove={pattern.length > 1 ? () => change(without(pattern, edit)) : null}
          onCancel={() => setEdit(null)} />
      )}
    </>
  );
}
