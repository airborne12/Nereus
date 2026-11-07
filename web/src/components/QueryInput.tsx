import { useEffect, useMemo, useRef, useState } from 'react';
import * as api from '../api.ts';
import { quoteValue, tokenAt } from '../lib/filters.ts';
import type { SourceName } from '../lib/state.ts';

interface Props {
  source: SourceName;
  value: string;
  range: api.Range;
  /** SQL mode: no field/value completion, SQL placeholder. */
  language?: 'lucene' | 'sql';
  onChange?: (q: string) => void;
  onSubmit: (q: string) => void;
  /** Recent queries, offered while the box is empty. */
  history?: string[];
}

interface Suggestion {
  label: string;
  detail: string;
  insert: string;
}

/** Search bar with field-name and value completion (Tab / Enter to accept, Esc to close). */
export function QueryInput({ source, value, range, language = 'lucene', history = [], onChange, onSubmit }: Props) {
  const [text, setText] = useState(value);
  const [cursor, setCursor] = useState(value.length);
  const [fields, setFields] = useState<{ name: string; type: string }[]>([]);
  const [valueHints, setValueHints] = useState<{ v: string; n: string | number }[]>([]);
  const [open, setOpen] = useState(false);
  const [active, setActive] = useState(0);
  const input = useRef<HTMLInputElement>(null);
  // The list closes a moment after the box loses focus (so a click on a suggestion still lands);
  // focusing again within that moment must cancel the close, or the list shuts as it opens.
  const blurTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => () => {
    if (blurTimer.current) clearTimeout(blurTimer.current);
  }, []);

  useEffect(() => setText(value), [value]);
  const update = (t: string) => {
    setText(t);
    onChange?.(t);
  };
  useEffect(() => {
    const ac = new AbortController();
    api.fields(source, ac.signal).then((r) => setFields(r.fields), () => setFields([]));
    return () => ac.abort();
  }, [source]);

  const tok = tokenAt(text, cursor);
  const fieldKnown = tok.field !== null && fields.some((f) => f.name === tok.field);

  useEffect(() => {
    if (!open || !fieldKnown || tok.field === null) {
      setValueHints([]);
      return;
    }
    const ac = new AbortController();
    const timer = setTimeout(() => {
      // Values seen among the rows the rest of the query matches.
      const rest = `${text.slice(0, tok.start)} ${text.slice(tok.end)}`.replace(/-\s*$/, '').trim();
      api.values(source, tok.field!, rest, range, ac.signal).then((r) => setValueHints(r.values), () => setValueHints([]));
    }, 150);
    return () => {
      clearTimeout(timer);
      ac.abort();
    };
  }, [open, fieldKnown, tok.field, source, range.from, range.to]); // eslint-disable-line react-hooks/exhaustive-deps

  const suggestions: Suggestion[] = useMemo(() => {
    if (text.trim() === '') return history.map((q) => ({ label: q, detail: 'recent', insert: q }));
    if (tok.field === null) {
      if (tok.value.length === 0) return [];
      const lower = tok.value.toLowerCase();
      return fields
        .filter((f) => f.name.toLowerCase().includes(lower))
        .sort((a, b) => Number(!a.name.toLowerCase().startsWith(lower)) - Number(!b.name.toLowerCase().startsWith(lower)))
        .slice(0, 8)
        .map((f) => ({ label: f.name, detail: f.type, insert: `${f.name}:` }));
    }
    const lower = tok.value.toLowerCase();
    return valueHints
      .filter((h) => String(h.v).toLowerCase().includes(lower))
      .map((h) => ({ label: String(h.v), detail: Number(h.n).toLocaleString(), insert: `${tok.field}:${quoteValue(String(h.v))} ` }));
  }, [text, history, tok.field, tok.value, fields, valueHints]);

  // Recent queries are offered, not preselected: Enter on an empty box still runs it.
  const recent = text.trim() === '';
  useEffect(() => setActive(recent ? -1 : 0), [suggestions.length, tok.start, recent]);

  function accept(s: Suggestion) {
    const next = text.slice(0, tok.start) + s.insert + text.slice(tok.end);
    const pos = tok.start + s.insert.length;
    update(next);
    setCursor(pos);
    requestAnimationFrame(() => input.current?.setSelectionRange(pos, pos));
    if (!s.insert.endsWith(':')) setOpen(false);
  }

  const showList = open && (language === 'lucene' || recent) && suggestions.length > 0;
  return (
    <div className="query">
      <input
        ref={input}
        className="query-input"
        aria-label="Search query"
        placeholder={language === 'sql' ? "SQL WHERE clause (ex. severity_text = 'ERROR')"
          : source === 'logs' ? 'Search your events w/ Lucene ex. level:error "timeout after"' : 'Search your events w/ Lucene ex. checkout status:error duration:>50ms'}
        value={text}
        spellCheck={false}
        onChange={(e) => {
          update(e.target.value);
          setCursor(e.target.selectionStart ?? e.target.value.length);
          setOpen(true);
        }}
        onSelect={(e) => setCursor(e.currentTarget.selectionStart ?? 0)}
        onFocus={() => {
          if (blurTimer.current) clearTimeout(blurTimer.current);
          setOpen(true);
        }}
        onBlur={() => { blurTimer.current = setTimeout(() => setOpen(false), 120); }}
        onKeyDown={(e) => {
          if (showList && (e.key === 'ArrowDown' || e.key === 'ArrowUp')) {
            e.preventDefault();
            setActive((a) => (Math.max(a, e.key === 'ArrowDown' ? -1 : 0) + (e.key === 'ArrowDown' ? 1 : suggestions.length - 1)) % suggestions.length);
          } else if (showList && e.key === 'Tab') {
            e.preventDefault();
            accept(suggestions[Math.max(active, 0)]!);
          } else if (e.key === 'Enter') {
            if (showList && suggestions[active] && tok.value !== suggestions[active].label) {
              e.preventDefault();
              accept(suggestions[active]);
            } else {
              setOpen(false);
              onSubmit(text);
            }
          } else if (e.key === 'Escape') {
            setOpen(false);
          }
        }}
      />
      {showList && (
        <ul className="suggestions" role="listbox">
          {suggestions.map((s, i) => (
            <li
              key={s.label}
              role="option"
              aria-selected={i === active}
              className={i === active ? 'active' : ''}
              onMouseDown={(e) => {
                e.preventDefault();
                accept(s);
              }}
            >
              <span>{s.label}</span>
              <span className="muted">{s.detail}</span>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
