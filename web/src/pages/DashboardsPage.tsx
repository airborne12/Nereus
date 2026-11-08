import { useEffect, useMemo, useState } from 'react';
import * as api from '../api.ts';
import { newId } from '../lib/browser.ts';
import { ChartView } from '../components/Chart.tsx';
import { ChartBuilder, DEFAULT_CHART } from '../components/ChartBuilder.tsx';
import { Icon } from '../components/Icon.tsx';
import { Modal, timeAgo } from '../components/Modal.tsx';
import { AlertsModal } from '../components/SavedSearchBar.tsx';
import { TimePicker } from '../components/TimePicker.tsx';
import { type TimeWindow, resolveWindow } from '../lib/state.ts';

/** All dashboards: create, search, star. */
export function DashboardsPage({ go, onChanged }: { go: (url: string) => void; onChanged: () => void }) {
  const [items, setItems] = useState<api.Dashboard[] | null>(null);
  const [q, setQ] = useState('');
  const [error, setError] = useState<string | null>(null);
  const load = () => api.content.dashboards().then((r) => setItems(r.items), (e) => setError(e.message));
  useEffect(() => { load(); }, []);
  const shown = (items ?? []).filter((d) => d.name.toLowerCase().includes(q.toLowerCase()));
  return (
    <div className="list-page">
      <div className="list-head">
        <h1>Dashboards</h1>
        <span className="grow" />
        <input aria-label="Search by name" placeholder="Search by name" value={q} onChange={(e) => setQ(e.target.value)} />
        <button type="button" className="btn primary" onClick={() => api.content.createDashboard({ name: 'Untitled dashboard', tiles: [] })
          .then((d) => go(`/dashboards/${d.id}`), (e) => setError(e.message))}><Icon name="plus" size={12} /> New Dashboard</button>
      </div>
      {error && <div className="error">{error}</div>}
      {items && items.length === 0 && <div className="empty">No dashboards yet. Create one, or save a chart from Chart explorer.</div>}
      {shown.length > 0 && (
        <table className="list">
          <thead><tr><th className="c-star" /><th>Name</th><th>Tiles</th><th>Tags</th><th>Created By</th><th>Last Updated</th></tr></thead>
          <tbody>
            {shown.map((d) => (
              <tr key={d.id} className="clickable" onClick={() => go(`/dashboards/${d.id}`)}>
                <td className="c-star"><button type="button" className={`star${d.favorite ? ' on' : ''}`} aria-label={d.favorite ? `Unstar ${d.name}` : `Star ${d.name}`}
                  onClick={(e) => { e.stopPropagation(); api.content.favoriteDashboard(d.id, !d.favorite).then(() => { load(); onChanged(); }); }}>★</button></td>
                <td><strong>{d.name}</strong></td>
                <td>{d.tiles.length}</td>
                <td>{d.tags.map((t) => <span key={t} className="badge">{t}</span>)}</td>
                <td>{d.createdBy ?? '–'}</td>
                <td>{timeAgo(d.updatedAt)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </div>
  );
}

function TileEditor({ tile, range, onSave, onClose }: { tile: api.Tile | null; range: api.Range; onSave: (t: api.Tile) => void; onClose: () => void }) {
  const [title, setTitle] = useState(tile?.title ?? '');
  const [w, setW] = useState(tile?.w ?? 6);
  const [def, setDef] = useState<api.ChartDef>(tile?.chart ?? DEFAULT_CHART);
  return (
    <Modal title={tile ? 'Edit tile' : 'New tile'} onClose={onClose} wide>
      <div className="form">
        <div className="row">
          <label className="grow">Title<input id="tile-name" value={title} placeholder="e.g. Errors by service" onChange={(e) => setTitle(e.target.value)} /></label>
          <label>Width<select id="tile-width" value={w} onChange={(e) => setW(Number(e.target.value))}>
            {[3, 4, 6, 8, 12].map((n) => <option key={n} value={n}>{n} / 12</option>)}
          </select></label>
        </div>
        <ChartBuilder value={def} onRun={setDef} />
        <div className="chart-panel"><ChartView def={def} range={range} height={200} /></div>
        <button type="button" className="btn primary" onClick={() => onSave({ id: tile?.id ?? newId(), title: title || 'Untitled chart', chart: def, w })}>
          {tile ? 'Save tile' : 'Add tile'}
        </button>
      </div>
    </Modal>
  );
}

/** One dashboard: tiles in a 12-column grid with a shared time range; every change is saved. */
export function DashboardPage({ id, go, onChanged }: { id: number; go: (url: string) => void; onChanged: () => void }) {
  const [d, setD] = useState<api.Dashboard | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState<'saved' | 'saving' | 'error'>('saved');
  const [win, setWin] = useState<TimeWindow>({ preset: '1h' });
  const [now, setNow] = useState(Date.now());
  const [live, setLive] = useState(false);
  const [editing, setEditing] = useState<api.Tile | 'new' | null>(null);
  const [menu, setMenu] = useState<string | null>(null);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [alertsFor, setAlertsFor] = useState<api.Tile | null>(null);
  const [alerts, setAlerts] = useState<api.Alert[]>([]);
  const range = useMemo(() => resolveWindow(win, now), [win, now]);
  useEffect(() => { api.content.dashboard(id).then(setD, (e) => setError(e.message)); }, [id]);
  const loadAlerts = () => api.content.alerts(undefined, id).then((r) => setAlerts(r.items), () => setAlerts([]));
  useEffect(() => {
    loadAlerts();
    const t = setInterval(loadAlerts, 15_000);
    return () => clearInterval(t);
  }, [id]); // eslint-disable-line react-hooks/exhaustive-deps
  // Worst state among a tile's alerts, for the bell in its header.
  const tileAlert = (tileId: string) => {
    const as = alerts.filter((a) => a.tileId === tileId);
    return as.length === 0 ? null : as.some((a) => a.state === 'ALERT') ? 'ALERT' : as.some((a) => a.state === 'ERROR') ? 'ERROR' : 'OK';
  };
  useEffect(() => {
    if (!live) return;
    const t = setInterval(() => setNow(Date.now()), 30_000);
    return () => clearInterval(t);
  }, [live]);

  async function save(next: api.Dashboard) {
    setD(next);
    setSaved('saving');
    try {
      await api.content.updateDashboard(next.id, next);
      setSaved('saved');
      // Removing a tile removes its alerts on the server.
      loadAlerts();
      onChanged();
    } catch (e) {
      setSaved('error');
      setError((e as Error).message);
    }
  }
  if (error && !d) return <div className="error">{error}</div>;
  if (!d) return <div className="empty">Loading…</div>;
  const tiles = d.tiles;
  const move = (i: number, by: number) => {
    const t = [...tiles];
    const [x] = t.splice(i, 1);
    t.splice(Math.max(0, Math.min(t.length, i + by)), 0, x!);
    save({ ...d, tiles: t });
  };

  return (
    <div className="dashboard-page">
      <div className="dashboard-head">
        <button type="button" className="link small" onClick={() => go('/dashboards/list')}>Dashboards</button><span className="muted">/</span>
        <input className="title-input" aria-label="Dashboard name" value={d.name} onChange={(e) => setD({ ...d, name: e.target.value })}
          onBlur={() => save(d)} onKeyDown={(e) => e.key === 'Enter' && (e.target as HTMLInputElement).blur()} />
        <button type="button" className={`star${d.favorite ? ' on' : ''}`} aria-label={d.favorite ? 'Unstar dashboard' : 'Star dashboard'}
          onClick={() => api.content.favoriteDashboard(d.id, !d.favorite).then(() => { setD({ ...d, favorite: !d.favorite }); onChanged(); })}>★</button>
        <span className="muted small">{saved === 'saving' ? 'Saving…' : saved === 'error' ? 'Not saved' : 'Saved'}</span>
        <span className="grow" />
        <TimePicker window={win} range={range} onChange={(w) => { setWin(w); setNow(Date.now()); }} />
        <button type="button" className={`btn${live ? ' primary' : ''}`} aria-pressed={live} onClick={() => setLive(!live)} title="Refresh every 30 seconds">
          {live && <span className="live-dot" />} Live</button>
        <button type="button" className="btn" onClick={() => setNow(Date.now())}>Refresh dashboard</button>
        <button type="button" className="btn primary" onClick={() => setEditing('new')}><Icon name="plus" size={12} /> New Tile</button>
        {confirmDelete ? (
          <span className="small">Delete this dashboard?{' '}
            <button type="button" className="link" onClick={() => api.content.deleteDashboard(d.id).then(() => { onChanged(); go('/dashboards/list'); })}>Yes</button>{' '}
            <button type="button" className="link" onClick={() => setConfirmDelete(false)}>No</button></span>
        ) : <button type="button" className="btn" onClick={() => setConfirmDelete(true)}>Delete Dashboard</button>}
      </div>
      {error && <div className="error">{error}</div>}
      {tiles.length === 0 && <div className="empty">This dashboard has no tiles. Press New Tile to add a chart.</div>}
      <div className="tiles">
        {tiles.map((t, i) => (
          <section key={t.id} className="tile" style={{ gridColumn: `span ${t.w}` }} aria-label={t.title}>
            <div className="tile-head">
              <strong title={t.title}>{t.title}</strong>
              <span className="grow" />
              {tileAlert(t.id) && (
                <button type="button" className={`icon-btn tile-bell ${tileAlert(t.id)!.toLowerCase()}`} aria-label={`Alerts for ${t.title}: ${tileAlert(t.id)}`}
                  title={`Alerts: ${tileAlert(t.id)}`} onClick={() => setAlertsFor(t)}><Icon name="bell" size={13} /></button>
              )}
              <button type="button" className="icon-btn" aria-label={`Tile menu ${t.title}`} aria-expanded={menu === t.id} onClick={() => setMenu(menu === t.id ? null : t.id)}>⋯</button>
              {menu === t.id && (
                <div className="menu tile-menu" role="menu" onMouseLeave={() => setMenu(null)}>
                  <button type="button" role="menuitem" onClick={() => { setMenu(null); setEditing(t); }}>Edit</button>
                  <button type="button" role="menuitem" onClick={() => { setMenu(null); save({ ...d, tiles: [...tiles.slice(0, i + 1), { ...t, id: newId(), title: `${t.title} (copy)` }, ...tiles.slice(i + 1)] }); }}>Duplicate</button>
                  <button type="button" role="menuitem" disabled={i === 0} onClick={() => { setMenu(null); move(i, -1); }}>Move left</button>
                  <button type="button" role="menuitem" disabled={i === tiles.length - 1} onClick={() => { setMenu(null); move(i, 1); }}>Move right</button>
                  <button type="button" role="menuitem" onClick={() => { setMenu(null); go(`/chart?chart=${encodeURIComponent(JSON.stringify(t.chart))}`); }}>Open in Chart explorer</button>
                  <button type="button" role="menuitem" onClick={() => { setMenu(null); setAlertsFor(t); }}>Alerts…</button>
                  <hr />
                  <button type="button" role="menuitem" className="danger" onClick={() => { setMenu(null); save({ ...d, tiles: tiles.filter((x) => x.id !== t.id) }); }}>Delete</button>
                </div>
              )}
            </div>
            <ChartView def={t.chart} range={range} height={180} />
          </section>
        ))}
      </div>
      {alertsFor && d && <AlertsModal target={{ kind: 'tile', dashboard: d, tile: alertsFor }} onClose={() => setAlertsFor(null)} onChanged={loadAlerts} />}
      {editing && (
        <TileEditor tile={editing === 'new' ? null : editing} range={range} onClose={() => setEditing(null)}
          onSave={(t) => { setEditing(null); save({ ...d, tiles: editing === 'new' ? [...tiles, t] : tiles.map((x) => (x.id === t.id ? t : x)) }); }} />
      )}
    </div>
  );
}
