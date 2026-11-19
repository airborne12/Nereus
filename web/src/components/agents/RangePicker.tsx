import { type FormEvent, useState } from 'react';
import { stamp, timeZone } from '../../lib/agents/format.ts';
import { PRESET_LABEL, RANGE_PRESETS, type RangePreset, resolveRange, type TableRange } from '../../lib/agents/table.ts';
import { parseLocalTime } from '../../lib/time.ts';

/** The custom range: a start and an end typed in the form the tables write times in. */
function CustomRange({ range, onChange }: { range: TableRange; onChange: (next: TableRange) => void }) {
  const shown = resolveRange(range, Date.now());
  const [from, setFrom] = useState(stamp(shown.from));
  const [to, setTo] = useState(stamp(shown.to));
  const [bad, setBad] = useState(false);
  const apply = (e: FormEvent) => {
    e.preventDefault();
    const a = parseLocalTime(from);
    const b = parseLocalTime(to);
    if (a === null || b === null || b <= a) return setBad(true);
    setBad(false);
    onChange({ from: a, to: b });
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

/** The time range of a page: a stretch that ends now, or a custom one. The time zone stands beside it. */
export function RangePicker({ range, onChange }: { range: TableRange; onChange: (next: TableRange) => void }) {
  const [custom, setCustom] = useState(!('preset' in range));
  const pick = (value: string) => {
    if (value === 'custom') return setCustom(true);
    setCustom(false);
    onChange({ preset: value as RangePreset });
  };
  return (
    <>
      <select aria-label="Time range" value={custom ? 'custom' : 'preset' in range ? range.preset : 'custom'} onChange={(e) => pick(e.target.value)}>
        {RANGE_PRESETS.map((p) => <option key={p} value={p}>{PRESET_LABEL[p]}</option>)}
        <option value="custom">Custom range</option>
      </select>
      {custom && <CustomRange key={JSON.stringify(range)} range={range} onChange={onChange} />}
      <span className="ag-tz" title="All times are shown in this time zone">{timeZone()}</span>
    </>
  );
}
