import { useEffect, useState } from 'react';
import * as api from '../api.ts';
import { Icon } from '../components/Icon.tsx';
import { StateChip, timeAgo } from '../components/Modal.tsx';

/** Saved searches of the team: search by name, filter by tag, star, open. */
export function SavedSearchesPage({ go, onChanged }: { go: (url: string) => void; onChanged: () => void }) {
  const [items, setItems] = useState<api.SavedSearch[] | null>(null);
  const [q, setQ] = useState('');
  const [tag, setTag] = useState('');
  const [error, setError] = useState<string | null>(null);
  const load = () => api.content.searches().then((r) => setItems(r.items), (e) => setError(e.message));
  useEffect(() => { load(); }, []);
  const tags = [...new Set((items ?? []).flatMap((s) => s.tags))].sort();
  const shown = (items ?? []).filter((s) => s.name.toLowerCase().includes(q.toLowerCase()) && (!tag || s.tags.includes(tag)));
  return (
    <div className="list-page">
      <div className="list-head">
        <h1>Saved searches</h1>
        <span className="grow" />
        <input aria-label="Search by name" placeholder="Search by name" value={q} onChange={(e) => setQ(e.target.value)} />
        <select aria-label="Filter by tag" value={tag} onChange={(e) => setTag(e.target.value)}>
          <option value="">All tags</option>
          {tags.map((t) => <option key={t} value={t}>{t}</option>)}
        </select>
      </div>
      {error && <div className="error">{error}</div>}
      {items && items.length === 0 && <div className="empty">No saved searches yet. On the search page, press Save to keep a search here.</div>}
      {shown.length > 0 && (
        <table className="list">
          <thead><tr><th className="c-star" /><th>Name</th><th>Source</th><th>Tags</th><th>Alerts</th><th>Created By</th><th>Last Updated</th></tr></thead>
          <tbody>
            {shown.map((s) => (
              <tr key={s.id} className="clickable" onClick={() => go(`/search?saved=${s.id}`)}>
                <td className="c-star">
                  <button type="button" className={`star${s.favorite ? ' on' : ''}`} aria-label={s.favorite ? `Unstar ${s.name}` : `Star ${s.name}`}
                    onClick={(e) => { e.stopPropagation(); api.content.favoriteSearch(s.id, !s.favorite).then(() => { load(); onChanged(); }); }}>★</button>
                </td>
                <td><strong>{s.name}</strong><div className="muted mono small">{s.where || '(all events)'}</div></td>
                <td>{s.source}</td>
                <td>{s.tags.map((t) => <span key={t} className="badge">{t}</span>)}</td>
                <td><StateChip state={s.alertState} /></td>
                <td>{s.createdBy ?? '–'}</td>
                <td title={s.updatedAt}>{timeAgo(s.updatedAt)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
      <p className="muted small"><Icon name="floppy" size={12} /> Saved searches are shared with the team; stars are yours.</p>
    </div>
  );
}
