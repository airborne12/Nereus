import { useEffect, useState } from 'react';
import * as api from '../api.ts';
import { StateChip, timeAgo } from '../components/Modal.tsx';

export function intervalLabel(s: number): string {
  return s % 3600 === 0 ? `${s / 3600}h` : `${s / 60}m`;
}

/** "count > 5 per 5m", "p99(duration) > 50000 per 1h". */
export function alertCondition(a: api.Alert): string {
  return `${a.tileId !== null ? a.tileMetric ?? 'value' : 'count'} ${a.thresholdType === 'above' ? '>' : '<'} ${a.threshold} per ${intervalLabel(a.intervalSeconds)}`;
}

function History({ alertId }: { alertId: number }) {
  const [items, setItems] = useState<api.AlertCheck[] | null>(null);
  useEffect(() => { api.content.alertHistory(alertId).then((r) => setItems(r.items), () => setItems([])); }, [alertId]);
  if (!items) return <div className="muted small">Loading…</div>;
  if (items.length === 0) return <div className="muted small">Not checked yet.</div>;
  return (
    <table className="list inner">
      <thead><tr><th>Checked</th><th>Value</th><th>State</th><th>Notified</th><th /></tr></thead>
      <tbody>
        {items.slice(0, 20).map((h, i) => (
          <tr key={i}>
            <td title={h.checkedAt}>{new Date(h.checkedAt).toLocaleString()}</td>
            <td className="mono">{h.value ?? '–'}{h.group !== null && <span className="muted"> ({h.group || '(empty)'})</span>}</td>
            <td><StateChip state={h.state} /></td>
            <td>{h.notified ? 'yes' : ''}</td>
            <td className="muted small">{h.error ?? ''}</td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

/** Every alert of the team with its state, condition and recent checks. */
export function AlertsPage({ go }: { go: (url: string) => void }) {
  const [items, setItems] = useState<api.Alert[] | null>(null);
  const [open, setOpen] = useState<number | null>(null);
  const [error, setError] = useState<string | null>(null);
  const load = () => api.content.alerts().then((r) => setItems(r.items), (e) => setError(e.message));
  useEffect(() => {
    load();
    const t = setInterval(load, 15_000);
    return () => clearInterval(t);
  }, []);
  return (
    <div className="list-page">
      <div className="list-head"><h1>Alerts</h1></div>
      {error && <div className="error">{error}</div>}
      {items && items.length === 0 && <div className="empty">No alerts created yet. Open a saved search and press Alerts, or use a dashboard tile's menu, to add one.</div>}
      {items && items.length > 0 && (
        <table className="list">
          <thead><tr><th>State</th><th>Watches</th><th>Condition</th><th>Notify</th><th>Last check</th><th>Value</th><th /></tr></thead>
          <tbody>
            {items.map((a) => [
              <tr key={a.id} className="clickable" onClick={() => setOpen(open === a.id ? null : a.id)}>
                <td><StateChip state={a.state} />{a.silencedUntil && Date.parse(a.silencedUntil) > Date.now() && <span className="badge">silenced</span>}</td>
                <td>{a.tileId !== null
                  ? <button type="button" className="link" onClick={(e) => { e.stopPropagation(); go(`/dashboards/${a.dashboardId}`); }}>{a.dashboardName} / {a.tileTitle ?? '(removed tile)'}</button>
                  : <button type="button" className="link" onClick={(e) => { e.stopPropagation(); go(`/search?saved=${a.savedSearchId}`); }}>{a.savedSearchName}</button>}</td>
                <td>{alertCondition(a)}</td>
                <td>{a.webhookName}</td>
                <td title={a.lastCheckedAt ?? ''}>{timeAgo(a.lastCheckedAt)}</td>
                <td className="mono">{a.lastValue ?? '–'}{a.lastGroup !== null && <span className="muted"> ({a.lastGroup || '(empty)'})</span>}</td>
                <td className="muted small">{open === a.id ? 'Hide history' : 'History'}</td>
              </tr>,
              open === a.id && <tr key={`${a.id}-h`} className="expanded"><td colSpan={7}><History alertId={a.id} /></td></tr>,
            ])}
          </tbody>
        </table>
      )}
    </div>
  );
}
