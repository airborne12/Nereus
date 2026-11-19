import { type FormEvent, useEffect, useRef, useState } from 'react';
import { plural, stamp, timeZone } from '../../lib/agents/format.ts';
import type { PageDef } from '../../lib/agents/pages.ts';
import {
  conditionFrom, conditionLabel, type Op, OP_SIGN, opsOf, PRESET_LABEL, RANGE_PRESETS, type RangePreset, resolveRange, syncDraft, type TableState, unitOf,
} from '../../lib/agents/table.ts';
import { parseLocalTime } from '../../lib/time.ts';

interface Props {
  def: PageDef;
  state: TableState;
  /** Rows that match; null while the first page is being read. */
  total: number | null;
  onChange: (next: TableState) => void;
}

/** The custom range: a start and an end typed in the form the tables write times in. */
function CustomRange({ state, onChange }: { state: TableState; onChange: (next: TableState) => void }) {
  const shown = resolveRange(state.range, Date.now());
  const [from, setFrom] = useState(stamp(shown.from));
  const [to, setTo] = useState(stamp(shown.to));
  const [bad, setBad] = useState(false);
  const apply = (e: FormEvent) => {
    e.preventDefault();
    const a = parseLocalTime(from);
    const b = parseLocalTime(to);
    if (a === null || b === null || b <= a) return setBad(true);
    setBad(false);
    onChange({ ...state, range: { from: a, to: b } });
  };
  return (
    <form className="ag-custom" onSubmit={apply}>
      <input aria-label="From" size={19} autoComplete="off" placeholder="YYYY-MM-DD HH:MM:SS" value={from} aria-invalid={bad} onChange={(e) => setFrom(e.target.value)} />
      <span>to</span>
      <input aria-label="To" size={19} autoComplete="off" placeholder="YYYY-MM-DD HH:MM:SS" value={to} aria-invalid={bad} onChange={(e) => setTo(e.target.value)} />
      <button type="submit">Apply</button>
      {bad && <span className="ag-bad" role="alert">Use YYYY-MM-DD HH:MM:SS, the end after the start.</span>}
    </form>
  );
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
  const [custom, setCustom] = useState(!('preset' in state.range));
  useEffect(() => setDraft((d) => syncDraft(d, state.q)), [state.q]);
  // The search runs a moment after the typing stops, on the state the page has by then.
  const latest = useRef({ state, onChange });
  latest.current = { state, onChange };
  useEffect(() => {
    if (draft.trim() === state.q.trim()) return;
    const timer = setTimeout(() => latest.current.onChange({ ...latest.current.state, q: draft }), 400);
    return () => clearTimeout(timer);
  }, [draft]); // eslint-disable-line react-hooks/exhaustive-deps

  const pickRange = (value: string) => {
    if (value === 'custom') return setCustom(true);
    setCustom(false);
    onChange({ ...state, range: { preset: value as RangePreset } });
  };
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
        <select aria-label="Time range" value={custom ? 'custom' : 'preset' in state.range ? state.range.preset : 'custom'} onChange={(e) => pickRange(e.target.value)}>
          {RANGE_PRESETS.map((p) => <option key={p} value={p}>{PRESET_LABEL[p]}</option>)}
          <option value="custom">Custom range</option>
        </select>
        {custom && <CustomRange key={JSON.stringify(state.range)} state={state} onChange={onChange} />}
        <span className="ag-tz" title="All times are shown in this time zone">{timeZone()}</span>
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
