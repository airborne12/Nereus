import { useEffect, useRef, useState } from 'react';
import type { PageDef } from '../../lib/agents/pages.ts';

interface Props {
  def: PageDef;
  /** Names of the columns shown. */
  shown: string[];
  /** The new choice in the page's order; null when it equals the page's default. */
  onChange: (columns: string[] | null) => void;
}

/** The Columns menu: which columns of the page are shown. One column always stays. */
export function ColumnsMenu({ def, shown, onChange }: Props) {
  const [open, setOpen] = useState(false);
  const box = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const away = (e: MouseEvent) => { if (!box.current?.contains(e.target as Node)) setOpen(false); };
    const key = (e: KeyboardEvent) => { if (e.key === 'Escape') setOpen(false); };
    document.addEventListener('mousedown', away);
    document.addEventListener('keydown', key);
    return () => {
      document.removeEventListener('mousedown', away);
      document.removeEventListener('keydown', key);
    };
  }, [open]);

  const toggle = (name: string) => {
    const next = def.columns.map((c) => c.name).filter((n) => (n === name ? !shown.includes(n) : shown.includes(n)));
    const same = def.columns.every((c) => c.shown === next.includes(c.name));
    onChange(same ? null : next);
  };

  return (
    <div className="ag-menu-wrap" ref={box}>
      <button type="button" aria-expanded={open} aria-haspopup="true" onClick={() => setOpen(!open)}>Columns</button>
      {open && (
        <div className="ag-menu" role="group" aria-label="Columns">
          {def.columns.map((c) => (
            <label key={c.name}>
              <input type="checkbox" checked={shown.includes(c.name)} disabled={shown.length === 1 && shown[0] === c.name} onChange={() => toggle(c.name)} /> {c.label}
            </label>
          ))}
        </div>
      )}
    </div>
  );
}
