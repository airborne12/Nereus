import { useEffect, useState } from 'react';
import * as api from '../api.ts';
import { alertCondition, intervalLabel } from '../pages/AlertsPage.tsx';
import { seriesLabel } from './Chart.tsx';
import { Icon } from './Icon.tsx';
import { Modal, StateChip, timeAgo } from './Modal.tsx';

export type SearchFields = Pick<api.SavedSearch, 'source' | 'where' | 'language' | 'filters' | 'select' | 'orderBy'>;

export function SaveSearchModal({ fields, onSaved, onClose }: { fields: SearchFields; onSaved: (s: api.SavedSearch) => void; onClose: () => void }) {
  const [name, setName] = useState('');
  const [tags, setTags] = useState('');
  const [error, setError] = useState<string | null>(null);
  async function save() {
    try {
      onSaved(await api.content.createSearch({ ...fields, name, tags: tags.split(',').map((t) => t.trim()).filter(Boolean) }));
    } catch (e) {
      setError((e as Error).message);
    }
  }
  return (
    <Modal title="Save search" onClose={onClose}>
      <form className="form" onSubmit={(e) => { e.preventDefault(); save(); }}>
        <label>Name<input id="save-name" required value={name} placeholder="e.g. Checkout errors" onChange={(e) => setName(e.target.value)} /></label>
        <label>Tags<input id="save-tags" value={tags} placeholder="comma separated, e.g. checkout, oncall" onChange={(e) => setTags(e.target.value)} /></label>
        <div className="muted small mono">{fields.source} · {fields.where || '(all events)'}{fields.filters.length ? ` · ${fields.filters.length} filter(s)` : ''}</div>
        {error && <div className="error">{error}</div>}
        <button type="submit" className="btn primary">Save</button>
      </form>
    </Modal>
  );
}

const INTERVALS = [60, 300, 900, 1800, 3600, 21600, 43200, 86400];

export type AlertTarget =
  | { kind: 'search'; search: api.SavedSearch }
  | { kind: 'tile'; dashboard: api.Dashboard; tile: api.Tile };

/** Alerts of one saved search or one dashboard tile: list, add, silence, delete. */
export function AlertsModal({ target, onClose, onChanged }: { target: AlertTarget; onClose: () => void; onChanged: () => void }) {
  const [alerts, setAlerts] = useState<api.Alert[]>([]);
  const [hooks, setHooks] = useState<api.Webhook[] | null>(null);
  const [form, setForm] = useState({ thresholdType: 'above' as 'above' | 'below', threshold: 10, intervalSeconds: 300, webhookId: 0 });
  const [error, setError] = useState<string | null>(null);
  const onTile = target.kind === 'tile';
  const title = onTile ? target.tile.title : target.search.name;
  // A tile alert watches its first series; with a group by, whichever group breaches.
  const metric = onTile ? seriesLabel(target.tile.chart.series[0]!) : 'count';
  const load = () => (onTile ? api.content.alerts(undefined, target.dashboard.id) : api.content.alerts(target.search.id))
    .then((r) => setAlerts(onTile ? r.items.filter((a) => a.tileId === target.tile.id) : r.items), (e) => setError(e.message));
  useEffect(() => {
    load();
    api.content.webhooks().then((r) => { setHooks(r.items); setForm((f) => ({ ...f, webhookId: r.items[0]?.id ?? 0 })); }, () => setHooks([]));
  }, []); // eslint-disable-line react-hooks/exhaustive-deps
  async function add() {
    setError(null);
    try {
      await api.content.createAlert(onTile ? { dashboardId: target.dashboard.id, tileId: target.tile.id, ...form } : { savedSearchId: target.search.id, ...form });
      await load();
      onChanged();
    } catch (e) {
      setError((e as Error).message);
    }
  }
  return (
    <Modal title={`Alerts for "${title}"`} onClose={onClose} wide>
      {alerts.length > 0 && (
        <table className="list">
          <thead><tr><th>State</th><th>Condition</th><th>Notify</th><th>Last check</th><th>{onTile ? 'Value' : 'Matches'}</th><th /></tr></thead>
          <tbody>
            {alerts.map((a) => (
              <tr key={a.id}>
                <td><StateChip state={a.state} />{a.silencedUntil && Date.parse(a.silencedUntil) > Date.now() && <span className="badge">silenced</span>}</td>
                <td>{alertCondition(a)}</td>
                <td>{a.webhookName}</td>
                <td>{timeAgo(a.lastCheckedAt)}</td>
                <td className="mono">{a.lastValue ?? '–'}{a.lastGroup !== null && <span className="muted"> ({a.lastGroup || '(empty)'})</span>}</td>
                <td>
                  <button type="button" className="link small" onClick={() => api.content.silenceAlert(a.id, a.silencedUntil && Date.parse(a.silencedUntil) > Date.now() ? 0 : 60).then(load)}>
                    {a.silencedUntil && Date.parse(a.silencedUntil) > Date.now() ? 'Unsilence' : 'Silence 1h'}</button>{' '}
                  <button type="button" className="link small danger" onClick={() => api.content.deleteAlert(a.id).then(() => { load(); onChanged(); })}>Delete</button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
      <h4>New alert</h4>
      {hooks && hooks.length === 0 ? (
        <p className="muted">No webhooks yet. An admin adds them under Team settings → Webhooks; alerts are sent there.</p>
      ) : (
        <form className="row alert-form" onSubmit={(e) => { e.preventDefault(); add(); }}>
          <span>Alert when {onTile ? <code>{metric}</code> : 'the count'}{onTile && target.tile.chart.groupBy ? ` of any ${target.tile.chart.groupBy}` : ''} is</span>
          <select aria-label="Threshold type" value={form.thresholdType} onChange={(e) => setForm({ ...form, thresholdType: e.target.value as 'above' | 'below' })}>
            <option value="above">above</option><option value="below">below</option>
          </select>
          <input aria-label="Threshold" type="number" min={onTile ? undefined : 0} step="any" value={form.threshold} onChange={(e) => setForm({ ...form, threshold: Number(e.target.value) })} />
          <span>over</span>
          <select aria-label="Interval" value={form.intervalSeconds} onChange={(e) => setForm({ ...form, intervalSeconds: Number(e.target.value) })}>
            {INTERVALS.map((s) => <option key={s} value={s}>{intervalLabel(s)}</option>)}
          </select>
          <span>and notify</span>
          <select aria-label="Webhook" value={form.webhookId} onChange={(e) => setForm({ ...form, webhookId: Number(e.target.value) })}>
            {(hooks ?? []).map((h) => <option key={h.id} value={h.id}>{h.name}</option>)}
          </select>
          <button type="submit" className="btn primary">Create alert</button>
        </form>
      )}
      {error && <div className="error">{error}</div>}
    </Modal>
  );
}

/** Header of a loaded saved search: breadcrumb, editable name, star, tags, and its actions. */
export function SavedSearchBar({ search, dirty, fields, onUpdated, onSavedAs, onDeleted, go }: {
  search: api.SavedSearch; dirty: boolean; fields: SearchFields; onUpdated: (s: api.SavedSearch) => void;
  onSavedAs: () => void; onDeleted: () => void; go: (url: string) => void;
}) {
  const [name, setName] = useState(search.name);
  const [tags, setTags] = useState(search.tags.join(', '));
  const [alerts, setAlerts] = useState(false);
  const [confirm, setConfirm] = useState(false);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => { setName(search.name); setTags(search.tags.join(', ')); }, [search]);
  const update = async (patch: Partial<api.SavedSearch>) => {
    try {
      onUpdated(await api.content.updateSearch(search.id, { ...search, ...patch }));
      setError(null);
    } catch (e) {
      setError((e as Error).message);
    }
  };
  return (
    <div className="saved-bar">
      <button type="button" className="link small" onClick={() => go('/search/list')}>Saved Searches</button><span className="muted">/</span>
      <input className="title-input" aria-label="Saved search name" value={name} placeholder="Untitled search" onChange={(e) => setName(e.target.value)}
        onBlur={() => name.trim() && name !== search.name && update({ name })} onKeyDown={(e) => e.key === 'Enter' && (e.target as HTMLInputElement).blur()} />
      <button type="button" className={`star${search.favorite ? ' on' : ''}`} aria-label={search.favorite ? 'Unstar saved search' : 'Star saved search'}
        onClick={() => api.content.favoriteSearch(search.id, !search.favorite).then(() => onUpdated({ ...search, favorite: !search.favorite }))}>★</button>
      <input className="tags-input" aria-label="Tags" value={tags} placeholder="tags" onChange={(e) => setTags(e.target.value)}
        onBlur={() => tags !== search.tags.join(', ') && update({ tags: tags.split(',').map((t) => t.trim()).filter(Boolean) })} />
      <span className="grow" />
      <span className="muted small">Created by {search.createdBy ?? 'someone'}. Updated {timeAgo(search.updatedAt)}.</span>
      <button type="button" className={`btn small${dirty ? ' primary' : ''}`} disabled={!dirty} onClick={() => update(fields)}>Update</button>
      <button type="button" className="btn small" onClick={onSavedAs}>Save as new</button>
      <button type="button" className="btn small" onClick={() => setAlerts(true)}><Icon name="bell" size={12} /> Alerts <StateChip state={search.alertState} /></button>
      {confirm ? (
        <span className="small">Delete? <button type="button" className="link" onClick={() => api.content.deleteSearch(search.id).then(onDeleted)}>Yes</button>{' '}
          <button type="button" className="link" onClick={() => setConfirm(false)}>No</button></span>
      ) : <button type="button" className="icon-btn" aria-label="Delete saved search" title="Delete saved search" onClick={() => setConfirm(true)}><Icon name="close" size={12} /></button>}
      {error && <span className="error small">{error}</span>}
      {alerts && <AlertsModal target={{ kind: 'search', search }} onClose={() => setAlerts(false)}
        onChanged={() => api.content.search(search.id).then(onUpdated)} />}
    </div>
  );
}
