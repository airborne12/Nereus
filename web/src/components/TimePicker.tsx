import { useEffect, useRef, useState } from 'react';
import { parseNaturalRange } from '../lib/nltime.ts';
import { PRESETS, type Preset, type TimeWindow, presetLabel } from '../lib/state.ts';

const pad = (n: number) => String(n).padStart(2, '0');
function fmt(ms: number): string {
  const d = new Date(ms);
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
}
function parseLocal(s: string): number | null {
  const m = /^(\d{4})-(\d{2})-(\d{2})[ T](\d{2}):(\d{2})(?::(\d{2}))?$/.exec(s.trim());
  if (!m) return null;
  return new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]), Number(m[4]), Number(m[5]), Number(m[6] ?? 0)).getTime();
}

const AROUND = [['30s', 30e3], ['1m', 60e3], ['5m', 300e3], ['15m', 900e3], ['30m', 1800e3], ['1h', 3600e3], ['3h', 10800e3], ['12h', 43200e3]] as const;

interface Props {
  window: TimeWindow;
  range: { from: number; to: number };
  onChange: (w: TimeWindow) => void;
}

/** Time range input with ClickStack's presets, a start/end form and an "around a time" form. */
export function TimePicker({ window: w, range, onChange }: Props) {
  const [open, setOpen] = useState(false);
  const [mode, setMode] = useState<'range' | 'around'>('range');
  const [start, setStart] = useState(fmt(range.from));
  const [end, setEnd] = useState(fmt(range.to));
  const [around, setAround] = useState(fmt(range.to));
  const [span, setSpan] = useState(900e3);
  const [error, setError] = useState<string | null>(null);
  const [phrase, setPhrase] = useState('');
  const box = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    setStart(fmt(range.from));
    setEnd(fmt(range.to));
    const close = (e: MouseEvent) => !box.current?.contains(e.target as Node) && setOpen(false);
    document.addEventListener('mousedown', close);
    return () => document.removeEventListener('mousedown', close);
  }, [open]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => {
    const key = (e: KeyboardEvent) => {
      const t = e.target as HTMLElement;
      if (e.key === 'Escape') setOpen(false);
      else if (e.key === 'd' && !/INPUT|TEXTAREA|SELECT/.test(t.tagName)) {
        e.preventDefault();
        setOpen(true);
      }
    };
    document.addEventListener('keydown', key);
    return () => document.removeEventListener('keydown', key);
  }, []);

  const label = 'preset' in w ? presetLabel(w.preset) : `${fmt(w.from)} – ${fmt(w.to)}`;
  function apply() {
    if (mode === 'range') {
      const a = parseLocal(start), b = parseLocal(end);
      if (a === null || b === null) return setError('Use YYYY-MM-DD HH:mm:ss');
      if (b <= a) return setError('End time must be after start time');
      onChange({ from: a, to: b });
    } else {
      const c = parseLocal(around);
      if (c === null) return setError('Use YYYY-MM-DD HH:mm:ss');
      onChange({ from: c - span, to: c + span });
    }
    setError(null);
    setOpen(false);
  }

  return (
    <div className="timepicker" ref={box}>
      <button type="button" className={`tp-input${'preset' in w && w.preset === 'live' ? ' live' : ''}`} aria-label="Time Range"
        aria-expanded={open} onClick={() => setOpen(!open)}>
        {'preset' in w && w.preset === 'live' && <span className="live-dot" />}{label}
      </button>
      {open && (
        <div className="tp-pop" role="dialog" aria-label="Time Range">
          <ul className="tp-presets">
            {PRESETS.map((p: Preset, i) => (
              <li key={p}>
                {i === 1 && <hr />}
                <button type="button" className={'preset' in w && w.preset === p ? 'active' : ''}
                  onClick={() => { onChange({ preset: p }); setOpen(false); }}>{presetLabel(p)}</button>
              </li>
            ))}
          </ul>
          <div className="tp-custom">
            <label>Search time
              <input id="tp-phrase" value={phrase} placeholder="last 2 hours, yesterday, 3h ago" autoFocus
                onChange={(e) => setPhrase(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key !== 'Enter') return;
                  e.preventDefault();
                  const r = parseNaturalRange(phrase, Date.now());
                  if (!r) return setError('Try "last 2 hours", "yesterday", "3h ago" or "2026-11-04 10:00 to 12:00"');
                  setError(null);
                  setPhrase('');
                  onChange(r);
                  setOpen(false);
                }} />
            </label>
            <div className="segmented" role="tablist">
              <button type="button" role="tab" aria-selected={mode === 'range'} onClick={() => setMode('range')}>Time range</button>
              <button type="button" role="tab" aria-selected={mode === 'around'} onClick={() => setMode('around')}>Around a time</button>
            </div>
            {mode === 'range' ? (
              <>
                <label>Start time<input id="tp-start" value={start} placeholder="YYYY-MM-DD HH:mm:ss" onChange={(e) => setStart(e.target.value)}
                  onKeyDown={(e) => e.key === 'Enter' && apply()} /></label>
                <label>End time<input id="tp-end" value={end} placeholder="YYYY-MM-DD HH:mm:ss" onChange={(e) => setEnd(e.target.value)}
                  onKeyDown={(e) => e.key === 'Enter' && apply()} /></label>
              </>
            ) : (
              <>
                <label>Time<input id="tp-around" value={around} placeholder="YYYY-MM-DD HH:mm:ss" onChange={(e) => setAround(e.target.value)}
                  onKeyDown={(e) => e.key === 'Enter' && apply()} /></label>
                <label>±<select id="tp-span" value={span} onChange={(e) => setSpan(Number(e.target.value))}>
                  {AROUND.map(([l, v]) => <option key={l} value={v}>{l}</option>)}
                </select></label>
              </>
            )}
            {error && <div className="tp-error" role="alert">{error}</div>}
            <button type="button" className="btn primary" onClick={apply}>Apply</button>
          </div>
        </div>
      )}
    </div>
  );
}
