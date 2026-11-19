import { type FormEvent, useEffect, useRef, useState } from 'react';
import { plural } from '../../lib/agents/format.ts';
import type { PageDef } from '../../lib/agents/pages.ts';
import {
  conditionFrom, conditionLabel, type Op, OP_SIGN, opsOf, syncDraft, type TableState, unitOf,
} from '../../lib/agents/table.ts';
import { RangePicker } from './RangePicker.tsx';

interface Props {
  def: PageDef;
  state: TableState;
  /** Rows that match; null while the first page is being read. */
  total: number | null;
  onChange: (next: TableState) => void;
}

/** "Keep rows where": one condition on a column of the row. */
function AddCondition({ def, onAdd, onCancel }: { def: PageDef; onAdd: (column: string, op: Op, value: string) => string | null; onCancel: () => void }) {
  const offered = def.columns.filter((c) => opsOf(c.kind).length > 0);
  const [column, setColumn] = useState(offered[0]!.name);
  const picked = offered.find((c) => c.name === column) ?? offered[0]!;
  const ops = opsOf(picked.kind);
  const [op, setOp] = useState<Op>(ops[0]!);
  const [value, setValue] = useState('');
  const [error, setError] = useState<string | null>(null);
  const pick = (name: string) => {
    setColumn(name);
    setOp(opsOf(offered.find((c) => c.name === name)!.kind)[0]!);
    setError(null);
  };
  const submit = (e: FormEvent) => {
    e.preventDefault();
    setError(onAdd(column, ops.includes(op) ? op : ops[0]!, value));
  };
  return (
    <form className="ag-fform" onSubmit={submit}>
      <span>Keep rows where</span>
      <select aria-label="Column" value={column} onChange={(e) => pick(e.target.value)}>
        {offered.map((c) => <option key={c.name} value={c.name}>{c.label}</option>)}
      </select>
      <select aria-label="Comparison" value={ops.includes(op) ? op : ops[0]} onChange={(e) => setOp(e.target.value as Op)}>
        {ops.map((o) => <option key={o} value={o}>{OP_SIGN[o]}</option>)}
      </select>
      <input aria-label="Value" autoFocus autoComplete="off" list="ag-values" value={value} onChange={(e) => setValue(e.target.value)} />
      <datalist id="ag-values">{(picked.values ?? []).map((v) => <option key={v} value={v} />)}</datalist>
      {unitOf(picked.kind) && <span>{unitOf(picked.kind)}</span>}
      <button type="submit" className="go">Add</button>
      <button type="button" onClick={onCancel}>Cancel</button>
      {error && <span className="ag-bad" role="alert">{error}</span>}
    </form>
  );
}

/** One time range, one search over the row's own text and one "Add filter" per page. */
export function TableFilters({ def, state, total, onChange }: Props) {
  const [draft, setDraft] = useState(state.q);
  const [adding, setAdding] = useState(false);
  useEffect(() => setDraft((d) => syncDraft(d, state.q)), [state.q]);
  // The search runs a moment after the typing stops, on the state the page has by then.
  const latest = useRef({ state, onChange });
  latest.current = { state, onChange };
  useEffect(() => {
    if (draft.trim() === state.q.trim()) return;
    const timer = setTimeout(() => latest.current.onChange({ ...latest.current.state, q: draft }), 400);
    return () => clearTimeout(timer);
  }, [draft]); // eslint-disable-line react-hooks/exhaustive-deps

  const add = (column: string, op: Op, value: string): string | null => {
    const c = conditionFrom(def, column, op, value);
    if (typeof c === 'string') return c;
    setAdding(false);
    onChange({ ...state, conditions: [...state.conditions, c] });
    return null;
  };

  return (
    <>
      <div className="ag-filters">
        <RangePicker range={state.range} onChange={(range) => onChange({ ...state, range })} />
        <input className="ag-q" type="search" placeholder={def.search} aria-label={def.search} value={draft} onChange={(e) => setDraft(e.target.value)}
          onKeyDown={(e) => { if (e.key === 'Enter') onChange({ ...state, q: draft }); }} />
        <div className="ag-chips">
          {state.conditions.map((c, i) => (
            <span className="ag-cond" key={`${i}:${c.column}`}>{conditionLabel(def, c)}
              <button type="button" aria-label="Remove this condition" onClick={() => onChange({ ...state, conditions: state.conditions.filter((_, j) => j !== i) })}>×</button>
            </span>
          ))}
          <button type="button" className="ag-chip" aria-expanded={adding} onClick={() => setAdding(!adding)}>+ Add filter</button>
        </div>
        <span className="ag-total" role="status">{total === null ? 'Loading…' : plural(total, def.noun)}</span>
      </div>
      {adding && <AddCondition def={def} onAdd={add} onCancel={() => setAdding(false)} />}
    </>
  );
}
