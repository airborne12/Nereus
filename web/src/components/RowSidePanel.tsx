import { type ReactNode, useEffect, useMemo, useState } from 'react';
import * as api from '../api.ts';
import { type FieldValue, isError, type Row, rowFields, type Span, waterfall } from '../lib/rows.ts';
import { dorisTimeToMs, type Filter, type SourceName } from '../lib/state.ts';
import { Icon } from './Icon.tsx';
import { formatDuration, formatTime, levelClass } from './ResultsTable.tsx';

export interface PanelActions {
  onFilter: (field: string, value: string, mode: 'include' | 'exclude' | 'only') => void;
  onSearchValue: (field: string, value: string) => void;
  onAddColumn: (field: string) => void;
  /** Go to another page of the app (the session replay of a trace). */
  onNavigate?: (url: string) => void;
}

/** The browser session whose request started this trace, if the SDK recorded one. */
function SessionLink({ traceId, range, onNavigate }: { traceId: string; range: api.Range; onNavigate?: (url: string) => void }) {
  const [s, setS] = useState<{ sessionId: string; at: string; started: string; ended: string; user: string | null } | null>(null);
  useEffect(() => {
    const ac = new AbortController();
    api.sessionForTrace(traceId, range, ac.signal).then((r) => !ac.signal.aborted && setS(r.session), () => {});
    return () => ac.abort();
  }, [traceId]); // eslint-disable-line react-hooks/exhaustive-deps
  if (!s || !onNavigate) return null;
  const p = new URLSearchParams({ session: s.sessionId, from: String(dorisTimeToMs(s.started) - 60_000), to: String(dorisTimeToMs(s.ended) + 60_000), at: String(dorisTimeToMs(s.at)) });
  return (
    <div className="session-link" role="note">
      <Icon name="laptop" size={13} /> Started by a request in a browser session{s.user ? ` of ${s.user}` : ''}.
      <button type="button" className="link" onClick={() => onNavigate(`/sessions?${p}`)}>Open session replay</button>
    </div>
  );
}

type Tab = 'overview' | 'columns' | 'trace' | 'context';

const GROUP_TITLES: Record<string, string> = {
  fields: 'Top Level Attributes',
  log_attributes: 'Log Attributes',
  span_attributes: 'Span Attributes',
  resource_attributes: 'Resource Attributes',
};

function copy(text: string) {
  navigator.clipboard?.writeText(text).catch(() => {});
}

function ValueActions({ f, actions }: { f: FieldValue; actions: PanelActions }) {
  return (
    <span className="kv-actions">
      <button type="button" title="Add to Filters" aria-label={`Filter ${f.field}`} onClick={() => actions.onFilter(f.field, f.value, 'include')}><Icon name="plus" size={12} /></button>
      <button type="button" title="Exclude this value" aria-label={`Exclude ${f.field}`} onClick={() => actions.onFilter(f.field, f.value, 'exclude')}><Icon name="minus" size={12} /></button>
      <button type="button" title="Search for this value only" aria-label={`Search ${f.field}`} onClick={() => actions.onSearchValue(f.field, f.value)}><Icon name="search" size={12} /></button>
      <button type="button" title={`Add ${f.field} column to results table`} aria-label={`Add column ${f.field}`} onClick={() => actions.onAddColumn(f.field)}><Icon name="columns" size={12} /></button>
      <button type="button" title="Copy value" aria-label={`Copy ${f.field}`} onClick={() => copy(f.value)}><Icon name="copy" size={12} /></button>
    </span>
  );
}

function KeyValues({ fields, actions, labelOf = (f) => f.field }: { fields: FieldValue[]; actions: PanelActions; labelOf?: (f: FieldValue) => string }) {
  return (
    <dl className="kvs">
      {fields.map((f) => (
        <div className="kv" key={`${f.group}.${f.field}`}>
          <dt title={labelOf(f)}>{labelOf(f)}</dt>
          <dd className="mono">{f.value}</dd>
          <ValueActions f={f} actions={actions} />
        </div>
      ))}
    </dl>
  );
}

function Overview({ row, actions }: { row: Row; actions: PanelActions }) {
  const fields = rowFields(row).filter((f) => f.field !== 'body');
  const groups = [...new Set(fields.map((f) => f.group))];
  const [closed, setClosed] = useState<Record<string, boolean>>({});
  return (
    <div className="overview">
      {groups.map((g) => (
        <section key={g} className="accordion">
          <button type="button" className="acc-head" aria-expanded={!closed[g]} onClick={() => setClosed({ ...closed, [g]: !closed[g] })}>
            <Icon name={closed[g] ? 'chevron-right' : 'chevron-down'} size={12} />{GROUP_TITLES[g] ?? g}
          </button>
          {!closed[g] && <KeyValues fields={fields.filter((f) => f.group === g)} actions={actions} />}
        </section>
      ))}
    </div>
  );
}

function ColumnValues({ row, actions }: { row: Row; actions: PanelActions }) {
  const [q, setQ] = useState('');
  const fields = rowFields(row);
  const full = (f: FieldValue) => (f.group === 'fields' ? f.field : `${f.group}.${f.field}`);
  const shown = fields.filter((f) => `${full(f)} ${f.value}`.toLowerCase().includes(q.toLowerCase()));
  return (
    <div className="column-values">
      <div className="cv-toolbar">
        <input placeholder="Search properties by key or value" aria-label="Search properties by key or value" value={q}
          onChange={(e) => setQ(e.target.value)} />
        <button type="button" className="btn" onClick={() => copy(JSON.stringify(row, null, 2))}>Copy row as JSON</button>
      </div>
      <KeyValues fields={shown} actions={actions} labelOf={full} />
    </div>
  );
}

function Tabs({ tabs, active, onChange }: { tabs: [Tab, string][]; active: Tab; onChange: (t: Tab) => void }) {
  return (
    <div className="tabs" role="tablist">
      {tabs.map(([t, label]) => (
        <button key={t} type="button" role="tab" aria-selected={active === t} onClick={() => onChange(t)}>{label}</button>
      ))}
    </div>
  );
}

interface LogRow extends Row {
  timestamp: string;
  span_id: string;
  body: string;
  severity_text: string;
}

/** Waterfall of the row's trace, with each span's log lines interleaved under it. */
function TraceTab({ traceId, around, focusSpan, actions }: { traceId: string; around: number; focusSpan: string | null; actions: PanelActions }) {
  const [spans, setSpans] = useState<Span[] | null>(null);
  const [logs, setLogs] = useState<LogRow[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [show, setShow] = useState({ spans: true, logs: true });
  const [picked, setPicked] = useState<Row | null>(null);
  const [detailTab, setDetailTab] = useState<Tab>('overview');

  useEffect(() => {
    const ac = new AbortController();
    const range = { from: around - 86400_000, to: around + 86400_000 };
    setSpans(null);
    Promise.all([
      api.trace(traceId, range, ac.signal),
      api.search({ source: 'logs', where: `trace:${traceId}`, language: 'lucene', filters: [], range }, { limit: 1000, orderBy: 'timestamp ASC' }, ac.signal),
    ]).then(([t, l]) => {
      setSpans(t.spans);
      setLogs(l.rows as LogRow[]);
      const focus = t.spans.find((s) => s.span_id === focusSpan) ?? null;
      setPicked(focus as Row | null);
    }, (e) => !ac.signal.aborted && setError(String(e.message ?? e)));
    return () => ac.abort();
  }, [traceId, around, focusSpan]);

  const { rows, totalMs } = useMemo(() => waterfall(spans ?? [], dorisTimeToMs), [spans]);
  const start = rows.length ? dorisTimeToMs(rows[0]!.span.timestamp) - rows[0]!.offsetMs : 0;
  const services = [...new Set(rows.map((r) => r.span.service_name))];
  const color = (svc: string) => `var(--series-${(services.indexOf(svc) % 8) + 1})`;
  const errors = rows.filter((r) => isError(r.span.status_code)).length;
  const pct = (ms: number) => `${(ms / (totalMs || 1)) * 100}%`;

  if (error) return <div className="error">{error}</div>;
  if (!spans) return <div className="empty">Loading Traces...</div>;
  if (spans.length === 0) return <div className="empty">No matching spans or logs found</div>;
  return (
    <div className="trace-tab">
      <SessionLink traceId={traceId} range={{ from: around - 86400_000, to: around + 86400_000 }} onNavigate={actions.onNavigate} />
      <div className="trace-summary">
        <span>{spans.length} spans, <span className={errors ? 'lvl-error' : ''}>{errors} errors</span> · {formatDuration(totalMs * 1000)}</span>
        <span className="grow" />
        <span className="muted">Show:</span>
        {(['spans', 'logs'] as const).map((k) => (
          <button key={k} type="button" className={`chip${show[k] ? ' on' : ''}`} aria-pressed={show[k]}
            onClick={() => setShow({ ...show, [k]: !show[k] })}>{k === 'spans' ? 'Spans' : `Logs (${logs.length})`}</button>
        ))}
      </div>
      <div className="waterfall">
        {rows.map((r) => {
          const spanLogs = show.logs ? logs.filter((l) => l.span_id === r.span.span_id) : [];
          return [
            show.spans && (
              <div key={r.span.span_id} className={`wf-row${picked?.span_id === r.span.span_id && !('body' in (picked ?? {})) ? ' selected' : ''}`}
                data-span={r.span.span_id} onClick={() => { setPicked(r.span as unknown as Row); setDetailTab('overview'); }}>
                <div className="wf-name" style={{ paddingLeft: 8 + r.depth * 14 }}>
                  {isError(r.span.status_code) && <span className="lvl-error">●</span>}
                  <span className="wf-svc" style={{ color: color(r.span.service_name) }}>{r.span.service_name}</span> {r.span.span_name}
                </div>
                <div className="wf-track">
                  <div className={`wf-bar${isError(r.span.status_code) ? ' err' : ''}`} style={{
                    left: pct(r.offsetMs), width: `max(2px, ${pct(r.durationMs)})`,
                    background: isError(r.span.status_code) ? undefined : color(r.span.service_name),
                  }} />
                  <span className="wf-dur mono">{formatDuration(r.span.duration)}</span>
                </div>
              </div>
            ),
            ...spanLogs.map((l, i) => (
              <div key={`${r.span.span_id}-log-${i}`} className={`wf-row wf-log${picked === l ? ' selected' : ''}`} data-log={r.span.span_id}
                onClick={() => { setPicked(l); setDetailTab('overview'); }}>
                <div className="wf-name" style={{ paddingLeft: 8 + (r.depth + 1) * 14 }}>
                  <span className={levelClass(l.severity_text)}>{l.severity_text}</span> <span className="mono">{l.body}</span>
                </div>
                <div className="wf-track">
                  <span className={`wf-mark ${levelClass(l.severity_text)}`} style={{ left: pct(dorisTimeToMs(l.timestamp) - start) }} />
                </div>
              </div>
            )),
          ];
        })}
      </div>
      {picked && (
        <section className="span-detail" aria-label="Span details">
          <div className="span-detail-head">
            <strong>{'body' in picked ? 'Log' : `${String(picked.service_name)} · ${String(picked.span_name)}`}</strong>
            <span className="grow" />
            <button type="button" className="icon-btn" aria-label="Close span details" onClick={() => setPicked(null)}><Icon name="close" size={12} /></button>
          </div>
          <Tabs tabs={[['overview', 'Overview'], ['columns', 'Column Values']]} active={detailTab} onChange={setDetailTab} />
          {detailTab === 'overview' ? <Overview row={picked} actions={actions} /> : <ColumnValues row={picked} actions={actions} />}
        </section>
      )}
    </div>
  );
}

const WINDOWS: [string, number][] = [['100ms', 100], ['500ms', 500], ['1s', 1000], ['5s', 5000], ['30s', 30000], ['1m', 60000], ['5m', 300000], ['15m', 900000]];
const SCOPES: [string, string | null][] = [['Anything', null], ['Service', 'service_name'], ['Host', 'host.name'], ['Pod', 'k8s.pod.name']];

/** Events just before and after this one, optionally from the same service, host or pod. */
function ContextTab({ source, row, onOpen }: { source: SourceName; row: Row; onOpen: (r: Row) => void }) {
  const [win, setWin] = useState(30000);
  const [scope, setScope] = useState<string | null>(null);
  const [rows, setRows] = useState<Row[] | null>(null);
  const t = dorisTimeToMs(String(row.timestamp));
  const scopeValue = scope === null ? null : scope === 'service_name' ? String(row.service_name ?? '')
    : rowFields(row).find((f) => f.field === scope)?.value ?? null;
  useEffect(() => {
    const ac = new AbortController();
    const filters: Filter[] = scope && scopeValue ? [{ field: scope, values: [scopeValue] }] : [];
    setRows(null);
    // The 100 events up to this one (newest first, then reversed) and the 100 after it, so this
    // event sits in the middle however busy the window is.
    const spec = (from: number, to: number) => ({ source, where: '', language: 'lucene' as const, filters, range: { from, to } });
    Promise.all([
      api.search(spec(t - win, t + 1), { limit: 100, orderBy: 'timestamp DESC' }, ac.signal),
      api.search(spec(t + 1, t + win + 1), { limit: 100, orderBy: 'timestamp ASC' }, ac.signal),
    ]).then(([before, afterRows]) => setRows([...before.rows.reverse(), ...afterRows.rows]), () => setRows([]));
    return () => ac.abort();
  }, [source, t, win, scope, scopeValue]);
  const isThis = (r: Row) => r.timestamp === row.timestamp && r.span_id === row.span_id && r.body === row.body;
  return (
    <div className="context-tab">
      <div className="ctx-controls">
        <div className="segmented" role="group" aria-label="Window">
          {WINDOWS.map(([l, ms]) => <button key={l} type="button" aria-pressed={win === ms} onClick={() => setWin(ms)}>±{l}</button>)}
        </div>
        <div className="segmented" role="group" aria-label="Scope">
          {SCOPES.map(([l, f]) => <button key={l} type="button" aria-pressed={scope === f} disabled={f !== null && !(f === 'service_name' ? row.service_name : rowFields(row).some((x) => x.field === f))}
            onClick={() => setScope(f)}>{l}</button>)}
        </div>
      </div>
      {!rows ? <div className="empty">Loading…</div> : (
        <table className="results ctx">
          <tbody>
            {rows.map((r, i) => (
              <tr key={i} className={isThis(r) ? 'this-event' : ''} onClick={() => !isThis(r) && onOpen(r)}
                ref={(el) => { if (el && isThis(r)) el.scrollIntoView({ block: 'center' }); }}>
                <td className="c-time mono">{formatTime(r.timestamp)}</td>
                <td className="c-svc">{String(r.service_name ?? '')}</td>
                {source === 'logs'
                  ? <><td className="c-lvl"><span className={levelClass(r.severity_text)}>{String(r.severity_text ?? '')}</span></td><td className="c-body mono">{String(r.body ?? '')}</td></>
                  : <><td className="c-body">{String(r.span_name ?? '')}</td><td className="c-dur mono">{formatDuration(r.duration)}</td></>}
                <td className="this-mark">{isThis(r) ? 'This Event' : ''}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </div>
  );
}

interface Props {
  source: SourceName;
  row: Row;
  actions: PanelActions;
  onClose: () => void;
  onOpenRow: (r: Row) => void;
}

function readWidth(): number {
  try {
    return Number(localStorage.getItem('nereus.panelWidth')) || 80;
  } catch {
    return 80;
  }
}

/** Drawer from the right with the selected event: resizable, expandable, Esc closes. */
export function RowSidePanel({ source, row, actions, onClose, onOpenRow }: Props) {
  const [width, setWidth] = useState(readWidth);
  const [full, setFull] = useState(false);
  const traceId = typeof row.trace_id === 'string' && /^[0-9a-f]{32}$/.test(row.trace_id) ? row.trace_id : null;
  const tabs: [Tab, string][] = source === 'logs'
    ? [['overview', 'Overview'], ['columns', 'Column Values'], ...(traceId ? [['trace', 'Trace'] as [Tab, string]] : []), ['context', 'Surrounding Context']]
    : [['trace', 'Trace'], ['context', 'Surrounding Context']];
  const [tab, setTab] = useState<Tab>(tabs[0]![0]);
  useEffect(() => setTab(tabs[0]![0]), [row]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => {
    const key = (e: KeyboardEvent) => e.key === 'Escape' && !(e.target as HTMLElement).closest('input') && onClose();
    document.addEventListener('keydown', key);
    return () => document.removeEventListener('keydown', key);
  }, [onClose]);
  useEffect(() => {
    try {
      localStorage.setItem('nereus.panelWidth', String(width));
    } catch { /* private mode */ }
  }, [width]);

  function startResize(e: React.MouseEvent) {
    e.preventDefault();
    const move = (m: MouseEvent) => setWidth(Math.min(98, Math.max(30, ((window.innerWidth - m.clientX) / window.innerWidth) * 100)));
    const up = () => {
      document.removeEventListener('mousemove', move);
      document.removeEventListener('mouseup', up);
    };
    document.addEventListener('mousemove', move);
    document.addEventListener('mouseup', up);
  }

  const isErr = source === 'traces' && isError(row.status_code);
  let body: ReactNode;
  if (tab === 'overview') body = <Overview row={row} actions={actions} />;
  else if (tab === 'columns') body = <ColumnValues row={row} actions={actions} />;
  else if (tab === 'trace' && traceId) body = <TraceTab traceId={traceId} around={dorisTimeToMs(String(row.timestamp))} focusSpan={source === 'traces' ? String(row.span_id) : null} actions={actions} />;
  else body = <ContextTab source={source} row={row} onOpen={onOpenRow} />;

  return (
    <aside className="drawer" style={{ width: full ? '100vw' : `${width}vw` }} aria-label="Event details">
      <div className="drawer-resize" onMouseDown={startResize} title="Drag to resize" />
      <div className="drawer-head">
        <div className="summary">
          <span className="mono">{formatTime(row.timestamp)}</span>
          <span>· {String(row.service_name ?? '')}</span>
          {source === 'logs' && <span className={levelClass(row.severity_text)}>{String(row.severity_text ?? '')}</span>}
          {source === 'traces' && <>
            <span>· {formatDuration(row.duration)}</span>
            <span className={isErr ? 'lvl lvl-error' : 'lvl ok'}>{isErr ? 'Error' : 'Ok'}</span>
            <span className="badge">{String(row.span_kind ?? '').replace('SPAN_KIND_', '').toLowerCase()}</span>
          </>}
          {traceId && <button type="button" className="link small" onClick={() => copy(traceId)}>Copy Trace ID</button>}
        </div>
        <span className="grow" />
        <button type="button" className="icon-btn" aria-label={full ? 'Collapse panel width' : 'Expand panel width'} title={full ? 'Collapse panel width' : 'Expand panel width'}
          onClick={() => setFull(!full)}><Icon name="maximize" size={14} /></button>
        <button type="button" className="icon-btn" aria-label="Close" title="Close (Esc)" onClick={onClose}><Icon name="close" size={14} /></button>
      </div>
      <div className="drawer-title mono">{source === 'logs' ? String(row.body ?? '') : String(row.span_name ?? '')}</div>
      <Tabs tabs={tabs} active={tab} onChange={setTab} />
      <div className="drawer-body">{body}</div>
    </aside>
  );
}
