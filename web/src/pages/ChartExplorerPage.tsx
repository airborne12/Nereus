import { useEffect, useMemo, useState } from 'react';
import * as api from '../api.ts';
import { newId } from '../lib/browser.ts';
import { ChartView } from '../components/Chart.tsx';
import { ChartBuilder, DEFAULT_CHART } from '../components/ChartBuilder.tsx';
import { Modal } from '../components/Modal.tsx';
import { TimePicker } from '../components/TimePicker.tsx';
import { type TimeWindow, resolveWindow } from '../lib/state.ts';

function readChart(): api.ChartDef {
  try {
    const c = new URLSearchParams(window.location.search).get('chart');
    return c ? { ...DEFAULT_CHART, ...JSON.parse(c) } : DEFAULT_CHART;
  } catch {
    return DEFAULT_CHART;
  }
}

function SaveToDashboard({ def, onClose, go }: { def: api.ChartDef; onClose: () => void; go: (url: string) => void }) {
  const [dashboards, setDashboards] = useState<api.Dashboard[]>([]);
  const [target, setTarget] = useState<string>('new');
  const [name, setName] = useState('');
  const [title, setTitle] = useState('');
  const [error, setError] = useState<string | null>(null);
  useEffect(() => { api.content.dashboards().then((r) => setDashboards(r.items), () => {}); }, []);
  async function save() {
    try {
      const tile = { id: newId(), title: title || 'Untitled chart', chart: def, w: 6 };
      const d = target === 'new'
        ? await api.content.createDashboard({ name: name || 'My dashboard', tiles: [tile] })
        : await (async () => {
          const cur = await api.content.dashboard(Number(target));
          return api.content.updateDashboard(cur.id, { ...cur, tiles: [...cur.tiles, tile] });
        })();
      go(`/dashboards/${d.id}`);
    } catch (e) {
      setError((e as Error).message);
    }
  }
  return (
    <Modal title="Save to dashboard" onClose={onClose}>
      <div className="form">
        <label>Tile title<input id="tile-title" value={title} placeholder="e.g. Requests per service" onChange={(e) => setTitle(e.target.value)} /></label>
        <label>Dashboard
          <select id="tile-dashboard" value={target} onChange={(e) => setTarget(e.target.value)}>
            <option value="new">New dashboard…</option>
            {dashboards.map((d) => <option key={d.id} value={d.id}>{d.name}</option>)}
          </select>
        </label>
        {target === 'new' && <label>New dashboard name<input id="new-dashboard-name" value={name} placeholder="My dashboard" onChange={(e) => setName(e.target.value)} /></label>}
        {error && <div className="error">{error}</div>}
        <button type="button" className="btn primary" onClick={save}>Save</button>
      </div>
    </Modal>
  );
}

/** Build a chart over logs, traces or metrics; save it to a dashboard. */
export function ChartExplorerPage({ go }: { go: (url: string) => void }) {
  const [def, setDef] = useState<api.ChartDef>(readChart);
  const [win, setWin] = useState<TimeWindow>({ preset: '1h' });
  const [now, setNow] = useState(Date.now());
  const range = useMemo(() => resolveWindow(win, now), [win, now]);
  const [saving, setSaving] = useState(false);
  const run = (d: api.ChartDef) => {
    setNow(Date.now());
    setDef(d);
    window.history.replaceState(null, '', `/chart?chart=${encodeURIComponent(JSON.stringify(d))}`);
  };
  return (
    <div className="chart-page">
      <div className="chart-page-head">
        <h1>Chart explorer</h1>
        <span className="grow" />
        <TimePicker window={win} range={range} onChange={(w) => { setWin(w); setNow(Date.now()); }} />
        <button type="button" className="btn" onClick={() => setSaving(true)}>Save to dashboard</button>
      </div>
      <ChartBuilder value={def} onRun={run} />
      <div className="chart-panel"><ChartView def={def} range={range} height={320} /></div>
      {saving && <SaveToDashboard def={def} onClose={() => setSaving(false)} go={go} />}
    </div>
  );
}
