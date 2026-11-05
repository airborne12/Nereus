import { useEffect, useMemo, useRef, useState } from 'react';
import type { Replayer as ReplayerType } from 'rrweb';
import type * as api from '../api.ts';
import { dorisTimeToMs } from '../lib/state.ts';
import { Icon } from './Icon.tsx';

const SPEEDS = [1, 2, 4, 8];
const FILTERS = [['all', 'All'], ['error', 'Errors'], ['network', 'Network'], ['click', 'Clicks'], ['navigation', 'Pages']] as const;

export const clock = (ms: number) => {
  const s = Math.max(0, Math.floor(ms / 1000));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
};

/** An error, a failed request or a console error: what the timeline marks red. */
export function isBad(e: api.SessionEvent): boolean {
  if (e.type === 'error') return true;
  if (e.type === 'console') return (e.message ?? '').startsWith('error');
  if (e.type === 'network') return Number(e.attributes?.status ?? 0) >= 400 || Number(e.attributes?.status ?? 1) === 0;
  return false;
}

/**
 * Replay of one session (rrweb, in a sandboxed iframe without scripts) with its timeline. The
 * recorded page is scaled to fit; events on the right seek the player.
 */
export function SessionPlayer({ detail }: { detail: api.SessionDetail }) {
  const stage = useRef<HTMLDivElement>(null);
  const host = useRef<HTMLDivElement>(null);
  const [player, setPlayer] = useState<ReplayerType | null>(null);
  const [meta, setMeta] = useState({ startTime: 0, totalTime: 0 });
  const [now, setNow] = useState(0);
  const [playing, setPlaying] = useState(false);
  const [speed, setSpeed] = useState(1);
  const [skip, setSkip] = useState(true);
  const [filter, setFilter] = useState<(typeof FILTERS)[number][0]>('all');
  const [open, setOpen] = useState<number | null>(null);
  const [error, setError] = useState<string | null>(null);
  const events = useMemo(() => detail.replay.flat().sort((a, b) => a.timestamp - b.timestamp), [detail]);

  useEffect(() => {
    if (events.length < 2) return;
    let r: ReplayerType | null = null;
    let cancelled = false;
    // rrweb loads with the page that needs it, not with the app.
    Promise.all([import('rrweb'), import('rrweb/dist/style.css')]).then(([{ Replayer }]) => {
      if (cancelled) return;
      try {
        r = new Replayer(events as never, { root: host.current!, skipInactive: true, showWarning: false, mouseTail: { strokeStyle: 'var(--accent)' } as never });
      } catch (e) {
        return setError(`This recording cannot be replayed: ${(e as Error).message}`);
      }
      const fit = (w: number, h: number) => {
        const box = stage.current!.getBoundingClientRect();
        const scale = Math.min(box.width / w, box.height / h, 1);
        const wrapper = host.current!.querySelector<HTMLElement>('.replayer-wrapper');
        if (wrapper) {
          wrapper.style.transform = `scale(${scale})`;
          wrapper.style.transformOrigin = 'top left';
          host.current!.style.width = `${w * scale}px`;
          host.current!.style.height = `${h * scale}px`;
        }
      };
      r.on('resize', (d) => fit((d as { width: number }).width, (d as { height: number }).height));
      r.on('finish', () => setPlaying(false));
      const m = r.getMetaData();
      setMeta({ startTime: m.startTime, totalTime: m.totalTime });
      setPlayer(r);
      r.pause(0);
    });
    return () => {
      cancelled = true;
      r?.pause();
      r?.destroy();
      if (host.current) host.current.innerHTML = '';
    };
  }, [events]);

  useEffect(() => {
    if (!player || !playing) return;
    const t = setInterval(() => setNow(player.getCurrentTime()), 200);
    return () => clearInterval(t);
  }, [player, playing]);
  useEffect(() => player?.setConfig({ speed, skipInactive: skip }), [player, speed, skip]);

  const seek = (ms: number, play = playing) => {
    if (!player) return;
    const at = Math.max(0, Math.min(meta.totalTime, ms));
    if (play) player.play(at);
    else player.pause(at);
    setNow(at);
  };
  const toggle = () => {
    if (!player) return;
    if (playing) {
      player.pause();
      setNow(player.getCurrentTime());
    } else {
      player.play(now >= meta.totalTime ? 0 : now);
    }
    setPlaying(!playing);
  };

  const timeline = detail.events.map((e) => ({ ...e, at: dorisTimeToMs(e.t) - meta.startTime }));
  const shown = timeline.filter((e) => filter === 'all' || (filter === 'error' ? isBad(e) : e.type === filter));

  if (events.length < 2) {
    return <div className="empty">This session has no replay (the SDK may run with recordReplay off). Its events are listed below.</div>;
  }
  return (
    <div className="session-view">
      <div className="player">
        <div className="player-stage" ref={stage}>
          {error ? <div className="error">{error}</div> : <div className="player-host" ref={host} data-testid="replay" />}
        </div>
        <div className="player-bar">
          <button type="button" className="icon-btn" aria-label={playing ? 'Pause' : 'Play'} onClick={toggle} disabled={!player}>
            <Icon name={playing ? 'pause' : 'play'} size={14} /></button>
          <span className="mono small" aria-label="Replay time">{clock(now)} / {clock(meta.totalTime)}</span>
          <div className="progress" role="slider" aria-label="Seek" aria-valuemin={0} aria-valuemax={meta.totalTime} aria-valuenow={Math.round(now)}
            onClick={(e) => { const r = e.currentTarget.getBoundingClientRect(); seek(((e.clientX - r.left) / r.width) * meta.totalTime); }}>
            <div className="progress-fill" style={{ width: `${meta.totalTime ? (now / meta.totalTime) * 100 : 0}%` }} />
            {timeline.filter((e) => isBad(e) || e.type === 'navigation').map((e, i) => (
              <i key={i} className={`mark ${isBad(e) ? 'bad' : 'page'}`} style={{ left: `${meta.totalTime ? (Math.max(0, e.at) / meta.totalTime) * 100 : 0}%` }} title={e.message ?? e.type} />
            ))}
          </div>
          <select aria-label="Speed" value={speed} onChange={(e) => setSpeed(Number(e.target.value))}>
            {SPEEDS.map((s) => <option key={s} value={s}>{s}x</option>)}
          </select>
          <label className="small"><input type="checkbox" checked={skip} onChange={(e) => setSkip(e.target.checked)} /> Skip inactivity</label>
        </div>
      </div>
      <aside className="session-events" aria-label="Session events">
        <div className="segmented" role="tablist">
          {FILTERS.map(([k, label]) => (
            <button key={k} type="button" role="tab" aria-selected={filter === k} onClick={() => setFilter(k)}>
              {label}{k !== 'all' && <span className="muted"> {timeline.filter((e) => (k === 'error' ? isBad(e) : e.type === k)).length}</span>}
            </button>
          ))}
        </div>
        <ul>
          {shown.map((e, i) => (
            <li key={i} className={`${isBad(e) ? 'bad' : ''}${Math.abs(e.at - now) < 600 ? ' current' : ''}`}>
              <button type="button" className="ev" onClick={() => { seek(e.at); setOpen(open === i ? null : i); }}>
                <span className="mono muted">{clock(e.at)}</span>
                <span className={`ev-type t-${e.type}`}>{e.type}</span>
                <span className="ev-msg" title={e.message ?? ''}>{e.message ?? ''}</span>
              </button>
              {open === i && (e.attributes || e.url) && (
                <pre className="ev-detail mono">{JSON.stringify({ url: e.url, ...(e.attributes ?? {}) }, null, 2)}</pre>
              )}
            </li>
          ))}
          {shown.length === 0 && <li className="muted small">No events of this kind.</li>}
        </ul>
      </aside>
    </div>
  );
}
