import { type ReactNode, useEffect, useState } from 'react';
import * as api from '../../api/memories.ts';
import { SqlDialog } from '../../components/agents/SqlDialog.tsx';
import { stamp, text, timeOf } from '../../lib/agents/format.ts';
import { type Kept, memoryUrl, sourceOf, stateLabel, stateNote, stateTone, whereKept } from '../../lib/agents/memories.ts';
import { sessionUrl } from '../../lib/agents/pages.ts';
import { stepKey } from '../../lib/agents/select.ts';
import type { Go } from '../../Root.tsx';
import type { From } from './TablePage.tsx';

const when = (v: unknown): string => { const ms = timeOf(v); return ms === null ? '' : stamp(ms); };

/** The value of a field of the memory, as the page shows it. */
function valueOf(field: Kept['field'], m: api.MemoryAnswer['memory'], openSource: () => void): ReactNode {
  if (field === 'name') return <b>{m.name}</b>;
  if (field === 'description') return m.description ?? <span className="ag-dim">None</span>;
  if (field === 'kind') return m.kind ?? <span className="ag-dim">None</span>;
  if (field === 'updated_at') return <span className="ag-time">{when(m.updated_at)}</span>;
  if (field === 'content') return <span className="ag-dim">Below, by its sections</span>;
  const s = sourceOf(m as unknown as Record<string, unknown>);
  const said = s.inferred ? `${s.text}: ${m.source_title ?? m.source_session_id}` : s.session ? `${m.source_title ?? s.text} (${s.session})` : s.text;
  return s.root ? <button type="button" className="jg-link" onClick={openSource}>{said}</button> : <span className={s.session ? '' : 'ag-dim'}>{said}</span>;
}

/** A memory's page (spec 8.8): its fields and where its agent keeps them, whether it still holds, its content, its versions. */
export function MemoryPage({ memoryRef: r, go }: { memoryRef: api.MemoryRef; go: Go }) {
  const [data, setData] = useState<api.MemoryAnswer | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [showSql, setShowSql] = useState(false);

  useEffect(() => {
    const ac = new AbortController();
    api.memory(r, ac.signal).then(setData, (e: Error) => { if (!ac.signal.aborted) setError(e.message); });
    return () => ac.abort();
  }, [r.agent, r.scope, r.name]); // eslint-disable-line react-hooks/exhaustive-deps

  const back: From = { from: memoryUrl(r), label: r.name };
  const m = data?.memory;
  const tone = stateTone(data?.state);
  const openSource = () => { if (m?.source_root_id) go(sessionUrl(m.source_root_id, null), { state: back }); };

  return (
    <div className="ag-page">
      <div className="ag-bar">
        <div className="ag-title">
          <button type="button" className="ag-back" onClick={() => go('/agents/memories')}>← Memories</button>
          <h1>{r.name}</h1>
          <span className="muted">{r.agent} · {r.scope}</span>
        </div>
        <div className="ag-tools"><button type="button" aria-haspopup="dialog" onClick={() => setShowSql(true)}>SQL</button></div>
      </div>
      {error && <div className="error" role="alert">{error}</div>}
      {!data && !error && <p className="muted jg-hint">Loading…</p>}
      {m && (
        <div className="mem-body">
          <table className="ag-table mem-fields" aria-label="Fields">
            <thead><tr><th><span className="jg-th">Field</span></th><th><span className="jg-th">Value</span></th><th><span className="jg-th">Where {r.agent} keeps it</span></th></tr></thead>
            <tbody>{whereKept(m.format ?? '').map((k) => (
              <tr key={k.field}><td>{k.field === 'updated_at' ? 'Updated' : k.field[0]!.toUpperCase() + k.field.slice(1)}</td><td>{valueOf(k.field, m, openSource)}</td><td className="ag-dim">{k.where}</td></tr>
            ))}</tbody>
          </table>
          <section className="mem-valid" aria-label="Still valid?">
            <h2>Still valid?</h2>
            <div className={`mem-state ${tone}`}><b>{stateLabel(data.state)}</b><p>{stateNote(data.state, r.agent)}</p></div>
            {data.uses.length > 0 && (
              <table className="ag-table mem-uses" aria-label="Sessions that read or wrote it">
                <thead><tr><th><span className="jg-th">Time</span></th><th><span className="jg-th">Session</span></th><th><span className="jg-th">Call</span></th></tr></thead>
                <tbody>{data.uses.map((u) => (
                  <tr key={`${text(u.session_id)}:${text(u.seq)}`} onClick={() => go(sessionUrl(text(u.root_id) || text(u.session_id), stepKey(text(u.session_id), Number(u.parent_seq))), { state: back })}>
                    <td className="ag-time">{when(u.ts)}</td><td>{text(u.title) || text(u.session_id)}</td><td><code>{text(u.name)}</code> · step {text(u.step)}</td>
                  </tr>
                ))}</tbody>
              </table>
            )}
            <p className="muted">Nereus judges whether a memory still holds; the agent or a person revises it.</p>
          </section>
          <section className="mem-content" aria-label="Content">
            <h2>Content</h2>
            {m.content === null && <p className="ag-dim">Removed from its store.</p>}
            {m.content !== null && (m.sections.length ? m.sections : [{ heading: null, text: m.content }]).map((s, i) => (
              <div key={i} className="mem-section">{s.heading && <h3>{s.heading}</h3>}<p className="mem-text">{s.text}</p></div>
            ))}
          </section>
          <section aria-label="Versions">
            <h2>Versions</h2>
            <table className="ag-table mem-versions" aria-label="Versions">
              <thead><tr><th><span className="jg-th">Captured</span></th><th><span className="jg-th">Updated</span></th><th><span className="jg-th">Source</span></th></tr></thead>
              <tbody>{data.versions.map((v) => (
                <tr key={v.captured_at}><td className="ag-time">{when(v.captured_at)}</td><td className="ag-time">{v.content_hash === 'removed' ? 'Removed' : when(v.updated_at)}</td><td>{sourceOf(v as unknown as Record<string, unknown>).text}</td></tr>
              ))}</tbody>
            </table>
          </section>
        </div>
      )}
      {showSql && <SqlDialog statements={data?.sql ?? []} onClose={() => setShowSql(false)} />}
    </div>
  );
}
