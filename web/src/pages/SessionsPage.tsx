import { useEffect, useMemo, useState } from 'react';
import * as api from '../api.ts';
import { formatValue } from '../components/Chart.tsx';
import { Icon } from '../components/Icon.tsx';
import { timeAgo } from '../components/Modal.tsx';
import { clock, SessionPlayer } from '../components/SessionPlayer.tsx';
import { TimePicker } from '../components/TimePicker.tsx';
import { dorisTimeToMs, type TimeWindow, resolveWindow } from '../lib/state.ts';

/** Browser and OS from a user agent, roughly: "Chrome · macOS". */
export function agentLabel(ua: string | null): string {
  if (!ua) return '';
  const browser = /Edg\//.test(ua) ? 'Edge' : /Firefox\//.test(ua) ? 'Firefox' : /Chrome\//.test(ua) ? 'Chrome' : /Safari\//.test(ua) ? 'Safari' : 'Browser';
  const os = /Windows/.test(ua) ? 'Windows' : /Mac OS X|Macintosh/.test(ua) ? 'macOS' : /Android/.test(ua) ? 'Android' : /iPhone|iPad/.test(ua) ? 'iOS' : /Linux/.test(ua) ? 'Linux' : '';
  return os ? `${browser} · ${os}` : browser;
}

function readUrl() {
  const p = new URLSearchParams(window.location.search);
  return { session: p.get('session'), from: Number(p.get('from')), to: Number(p.get('to')), at: Number(p.get('at')) || undefined, where: p.get('where') ?? '' };
}

/** Client sessions: those with an event matching the search, and the replay of one of them. */
export function SessionsPage({ go }: { go: (url: string) => void }) {
  const initial = readUrl();
  const [win, setWin] = useState<TimeWindow>({ preset: '1d' });
  const [now, setNow] = useState(Date.now());
  const range = useMemo(() => resolveWindow(win, now), [win, now]);
  const [where, setWhere] = useState(initial.where);
  const [applied, setApplied] = useState(initial.where);
  const [items, setItems] = useState<api.SessionSummary[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [detail, setDetail] = useState<api.SessionDetail | null>(null);
  const [detailError, setDetailError] = useState<string | null>(null);
  const openId = initial.session;

  useEffect(() => {
    if (openId) return;
    const ac = new AbortController();
    setItems(null);
    setError(null);
    api.sessions({ where: applied, language: 'lucene', filters: [], range }, ac.signal)
      .then((r) => !ac.signal.aborted && setItems(r.sessions), (e) => !ac.signal.aborted && setError(String(e.message ?? e)));
    return () => ac.abort();
  }, [applied, range, openId]);

  useEffect(() => {
    if (!openId) return setDetail(null);
    const ac = new AbortController();
    setDetail(null);
    setDetailError(null);
    api.session(openId, { from: initial.from, to: initial.to }, ac.signal)
      .then((d) => !ac.signal.aborted && setDetail(d), (e) => !ac.signal.aborted && setDetailError(String(e.message ?? e)));
    return () => ac.abort();
  }, [openId]); // eslint-disable-line react-hooks/exhaustive-deps

  const open = (s: api.SessionSummary) => {
    // A minute either side, so rows written at the edges of the list's range are included.
    const p = new URLSearchParams({ session: s.session_id, from: String(dorisTimeToMs(s.started) - 60_000), to: String(dorisTimeToMs(s.ended) + 60_000) });
    if (applied) p.set('where', applied);
    go(`/sessions?${p}`);
  };

  if (openId) {
    const s = detail?.session;
    return (
      <div className="chart-page session-page">
        <div className="chart-page-head">
          <button type="button" className="link small" onClick={() => go(`/sessions${applied ? `?where=${encodeURIComponent(applied)}` : ''}`)}>Client sessions</button>
          <span className="muted">/</span>
          <h1>{s ? s.user.email ?? s.user.name ?? 'Anonymous user' : 'Session'}</h1>
          {s && <span className="muted small">{s.service} · {agentLabel(s.userAgent)} · {new Date(dorisTimeToMs(s.started)).toLocaleString()} · {clock(dorisTimeToMs(s.ended) - dorisTimeToMs(s.started))}</span>}
          <span className="grow" />
          <span className="mono small muted" title="Session id">{openId}</span>
        </div>
        {detailError && <div className="error">{detailError}</div>}
        {!detail && !detailError && <div className="empty">Loading the recording…</div>}
        {detail && <SessionPlayer detail={detail} at={initial.at} go={go} />}
      </div>
    );
  }

  return (
    <div className="chart-page">
      <div className="chart-page-head">
        <h1>Client sessions</h1>
        <span className="grow" />
        <form className="sql-field map-where" onSubmit={(e) => { e.preventDefault(); setNow(Date.now()); setApplied(where); }}>
          <span className="sql-kw">WHERE</span>
          <input aria-label="Session filter" className="mono" value={where} placeholder='Lucene, e.g. type:error email:ada@example.com url:checkout' onChange={(e) => setWhere(e.target.value)} />
        </form>
        <TimePicker window={win} range={range} onChange={(w) => { setWin(w); setNow(Date.now()); }} />
      </div>
      {error && <div className="error">{error}</div>}
      {!items && !error && <div className="empty">Loading…</div>}
      {items && items.length === 0 && (
        <div className="empty">
          No sessions in this time range. Add the browser SDK to your site:
          <pre className="sql">{`<script src="${window.location.origin}/sdk/dorisstack-rum.js"></script>
<script>
  DorisStackRUM.init({ url: '${window.location.origin}', apiKey: 'dsi_…', service: 'my-site' });
</script>`}</pre>
          An admin creates the ingestion key under Team settings.
        </div>
      )}
      {items && items.length > 0 && (
        <table className="list sessions-list">
          <thead><tr><th>User</th><th>Started</th><th>Duration</th><th>First page</th><th className="num">Pages</th><th className="num">Clicks</th><th className="num">Errors</th><th>Browser</th></tr></thead>
          <tbody>
            {items.map((s) => (
              <tr key={s.session_id} className="clickable" onClick={() => open(s)} data-session={s.session_id}>
                <td><Icon name="laptop" size={12} /> <strong>{s.user_email ?? s.user_name ?? 'Anonymous'}</strong><div className="muted small">{s.service}</div></td>
                <td title={s.started}>{timeAgo(new Date(dorisTimeToMs(s.started)).toISOString())}</td>
                <td className="mono">{clock(dorisTimeToMs(s.ended) - dorisTimeToMs(s.started))}</td>
                <td className="mono small ellipsis" title={s.first_url ?? ''}>{s.first_url ? s.first_url.replace(/^https?:\/\/[^/]+/, '') || '/' : ''}</td>
                <td className="num mono">{formatValue(s.pages)}</td>
                <td className="num mono">{formatValue(s.clicks)}</td>
                <td className={`num mono${Number(s.errors) ? ' bad' : ''}`}>{formatValue(s.errors)}</td>
                <td className="small">{agentLabel(s.user_agent)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </div>
  );
}
