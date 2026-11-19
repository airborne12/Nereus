import { useEffect, useMemo, useState } from 'react';
import * as api from '../../api/agents.ts';
import { saveBlob } from '../../lib/browser.ts';
import { countsText, formatsOf, previewText, recordsOf } from '../../lib/agents/export.ts';
import { stamp } from '../../lib/agents/format.ts';
import type { PageDef } from '../../lib/agents/pages.ts';
import { filterText, queryOf, type TableState } from '../../lib/agents/table.ts';
import { Modal } from '../Modal.tsx';
import { SqlSection } from './SqlDialog.tsx';

type Sized = { size: api.ExportSize } | { error: string };

interface Props {
  def: PageDef;
  state: TableState;
  /** The time the page's range was resolved at, so the file holds what the table shows. */
  now: number;
  onClose: () => void;
}

/** Export: every row that matches the page's filter, in one of the page's formats, with a preview and its SQL. */
export function ExportDialog({ def, state, now, onClose }: Props) {
  const formats = formatsOf(def.name);
  const [format, setFormat] = useState<api.ExportFormat>(formats[0]!.id);
  const [sized, setSized] = useState<Partial<Record<api.ExportFormat, Sized>>>({});
  const [showSql, setShowSql] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const query = useMemo(() => queryOf(state, now, 0), [state, now]);

  useEffect(() => {
    const ac = new AbortController();
    for (const f of formatsOf(def.name)) {
      api.exportSize(def.name, query, f.id, ac.signal).then(
        (size) => setSized((prev) => ({ ...prev, [f.id]: { size } })),
        (e: Error) => { if (!ac.signal.aborted) setSized((prev) => ({ ...prev, [f.id]: { error: e.message } })); },
      );
    }
    return () => ac.abort();
  }, [def, query]);

  const chosen = sized[format];
  const size = chosen && 'size' in chosen ? chosen.size : null;
  const records = size ? recordsOf(format, size.size) : 0;
  const download = async () => {
    setSaving(true);
    setError(null);
    try {
      const file = await api.exportFile(def.name, query, format);
      saveBlob(file.blob, file.name);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setSaving(false);
    }
  };

  return (
    <Modal title="Export" onClose={onClose} wide>
      <p className="muted small ag-dialog-note">Every {def.noun} that matches: {filterText(def, state, stamp)}</p>
      <div className="ag-fmts" role="radiogroup" aria-label="Format">
        {formats.map((f) => {
          const s = sized[f.id];
          return (
            <label className="ag-fmt" key={f.id}>
              <input type="radio" name="ag-format" value={f.id} checked={format === f.id} onChange={() => { setFormat(f.id); setError(null); }} />
              <b>{f.name}</b><code>{f.type}</code><span>{f.about}</span>
              <em>{!s ? 'Counting…' : 'error' in s ? 'Not counted' : countsText(f.id, s.size.size)}</em>
            </label>
          );
        })}
      </div>
      {chosen && 'error' in chosen && <div className="error">{chosen.error}</div>}
      {size && records === 0 && <p className="ag-empty">No {def.noun} matches the filter, so there is nothing to export.</p>}
      {size && records > 0 && (
        <>
          <section className="ag-stmt" aria-label="Preview">
            <h4><span>Preview</span><span className="muted">the start of the file; long values are cut here only</span></h4>
            <pre className="sql ag-preview" tabIndex={0}>{previewText(size.preview)}</pre>
          </section>
          <button type="button" className="ag-fold" aria-expanded={showSql} onClick={() => setShowSql(!showSql)}>
            {showSql ? 'Hide the SQL' : 'Show the SQL that reads this file'}
          </button>
          {showSql && size.sql.map((s, i) => <SqlSection key={`${i}:${s.title}`} statement={s} />)}
        </>
      )}
      {error && <div className="error" role="alert">{error}</div>}
      <div className="ag-dialog-foot">
        <button type="button" className="btn" onClick={onClose}>Close</button>
        <button type="button" className="btn primary" disabled={saving || !size || records === 0} onClick={download}>{saving ? 'Writing…' : 'Download'}</button>
      </div>
    </Modal>
  );
}
