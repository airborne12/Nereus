// DorisStack browser SDK: records sessions (rrweb) with their clicks, page views, errors, console
// errors and network requests, and sends them to DorisStack with an ingestion key.
//
//   <script src="https://dorisstack.example.com/sdk/dorisstack-rum.js"></script>
//   <script>
//     DorisStackRUM.init({ url: 'https://dorisstack.example.com', apiKey: 'dsi_…', service: 'shop-web' });
//     DorisStackRUM.setUser({ id: 'u42', email: 'ada@example.com', name: 'Ada' });
//   </script>
//
// Privacy: every input's value is masked by default (maskAllInputs), request and response bodies
// are never recorded, clicked form fields are described without their text, and elements with
// the class `ds-block` are not recorded at all (`ds-mask` masks their text).

import { record } from 'rrweb';
import { Batch, describeElement, newSessionId, newTraceparent, parseTraceparent, type SdkEvent, type SessionState, shouldPropagate, touchSession } from './core.ts';

export interface InitOptions {
  /** Address of DorisStack. */
  url: string;
  /** An ingestion key (Team settings → Ingestion keys), not an API key. */
  apiKey: string;
  service?: string;
  /** Mask the value of every input (default true). */
  maskAllInputs?: boolean;
  /** Mask all text on the page, not only inputs (default false). */
  maskAllText?: boolean;
  /** Record DOM changes for replay (default true); off sends only the events. */
  recordReplay?: boolean;
  /** Record network requests (method, URL, status, duration; default true). */
  recordNetwork?: boolean;
  /** Record console.error and console.warn (default true). */
  recordConsole?: boolean;
  /**
   * Other origins whose requests get a W3C `traceparent` header (URL prefixes or patterns), so the
   * backend trace links to this session. The page's own origin always gets it. A listed API must
   * allow the header in its CORS (Access-Control-Allow-Headers: traceparent).
   */
  tracePropagationTargets?: (string | RegExp)[];
  flushIntervalMs?: number;
}

const STORE = 'dorisstack.rum';
let opts: Required<InitOptions> | null = null;
let state: SessionState | null = null;
const batch = new Batch();
let stopRecording: (() => void) | undefined;

function load(): SessionState | null {
  try {
    return JSON.parse(sessionStorage.getItem(STORE) ?? 'null');
  } catch {
    return null;
  }
}

function save(): void {
  try {
    sessionStorage.setItem(STORE, JSON.stringify(state));
  } catch {
    // Storage may be blocked; the session then lasts as long as the page.
  }
}

/** The current session, rotated after inactivity; a new session starts with a full snapshot. */
function session(): SessionState {
  const { state: next, rotated } = touchSession(state, Date.now(), newSessionId);
  const changed = state?.id !== next.id;
  state = next;
  save();
  if (changed && rotated && opts?.recordReplay) record.takeFullSnapshot(true);
  return state;
}

function event(e: Omit<SdkEvent, 't' | 'url'> & { url?: string }): void {
  if (!opts) return;
  session();
  batch.addEvent({ t: Date.now(), url: location.href, ...e });
  if (batch.size > 1_000_000) void flush();
}

const endpoint = () => `${opts!.url.replace(/\/$/, '')}/api/ingest/sessions`;

async function flush(leaving = false): Promise<void> {
  if (!opts || batch.empty) return;
  const s = session();
  const bodies = batch.take(() => s.seq++);
  save();
  for (const b of bodies) {
    const body = JSON.stringify({ sessionId: s.id, service: opts.service, userAgent: navigator.userAgent, user: s.user ?? undefined, ...b });
    // On page hide only a beacon reliably leaves; it cannot carry headers, so the key goes in the URL.
    if (leaving && body.length < 60_000 && navigator.sendBeacon(`${endpoint()}?key=${encodeURIComponent(opts.apiKey)}`, new Blob([body], { type: 'text/plain' }))) continue;
    try {
      await origFetch(endpoint(), {
        method: 'POST', headers: { authorization: `Bearer ${opts.apiKey}`, 'content-type': 'application/json' }, body,
        keepalive: body.length < 60_000, credentials: 'omit',
      });
    } catch {
      // Lost: the page keeps working either way.
    }
  }
}

const origFetch: typeof fetch = typeof window !== 'undefined' ? window.fetch.bind(window) : (undefined as never);

/** Request URLs as absolute addresses, so the timeline says which host was called. */
function absolute(u: string): string {
  try {
    return new URL(u, location.href).href;
  } catch {
    return u;
  }
}

/**
 * The trace of a request: the page's own traceparent when it set one (its OTel instrumentation),
 * else a new one when the URL may carry it, else none.
 */
function traceFor(url: string, existing: string | null): { header: string | null; ids: { trace_id: string; span_id: string } | Record<string, never> } {
  const own = parseTraceparent(existing);
  if (own) return { header: null, ids: { trace_id: own.traceId, span_id: own.spanId } };
  if (!shouldPropagate(url, location.origin, opts!.tracePropagationTargets)) return { header: null, ids: {} };
  const t = newTraceparent();
  return { header: t.header, ids: { trace_id: t.traceId, span_id: t.spanId } };
}

function instrumentNetwork(): void {
  const ours = (u: string) => u.startsWith(endpoint());
  window.fetch = async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = absolute(typeof input === 'string' ? input : input instanceof URL ? input.href : input.url);
    if (ours(url)) return origFetch(input, init);
    const method = (init?.method ?? (input instanceof Request ? input.method : 'GET')).toUpperCase();
    const headers = new Headers(init?.headers ?? (input instanceof Request ? input.headers : undefined));
    const trace = traceFor(url, headers.get('traceparent'));
    if (trace.header) {
      headers.set('traceparent', trace.header);
      init = { ...init, headers };
    }
    const t0 = performance.now();
    try {
      const res = await origFetch(input, init);
      event({ type: 'network', message: `${method} ${url} ${res.status}`, attributes: { method, url, status: res.status, duration_ms: Math.round(performance.now() - t0), ...trace.ids } });
      return res;
    } catch (e) {
      event({ type: 'network', message: `${method} ${url} failed`, attributes: { method, url, status: 0, error: String(e), duration_ms: Math.round(performance.now() - t0), ...trace.ids } });
      throw e;
    }
  };
  type Tracked = XMLHttpRequest & { __ds?: { method: string; url: string; traceparent?: string } };
  const open = XMLHttpRequest.prototype.open;
  const send = XMLHttpRequest.prototype.send;
  const setHeader = XMLHttpRequest.prototype.setRequestHeader;
  XMLHttpRequest.prototype.open = function (this: Tracked, method: string, url: string | URL, ...rest: unknown[]) {
    this.__ds = { method: method.toUpperCase(), url: absolute(String(url)) };
    return (open as (...a: unknown[]) => void).call(this, method, url, ...rest);
  } as typeof open;
  XMLHttpRequest.prototype.setRequestHeader = function (this: Tracked, name: string, value: string) {
    if (this.__ds && name.toLowerCase() === 'traceparent') this.__ds.traceparent = value;
    return setHeader.call(this, name, value);
  };
  XMLHttpRequest.prototype.send = function (this: Tracked, body?: Document | XMLHttpRequestBodyInit | null) {
    const info = this.__ds, t0 = performance.now();
    if (info && !ours(info.url)) {
      const trace = traceFor(info.url, info.traceparent ?? null);
      if (trace.header) setHeader.call(this, 'traceparent', trace.header);
      this.addEventListener('loadend', () => event({ type: 'network', message: `${info.method} ${info.url} ${this.status || 'failed'}`,
        attributes: { method: info.method, url: info.url, status: this.status, duration_ms: Math.round(performance.now() - t0), ...trace.ids } }));
    }
    return send.call(this, body);
  };
}

function instrumentNavigation(): void {
  const page = () => event({ type: 'navigation', message: document.title || location.pathname });
  for (const m of ['pushState', 'replaceState'] as const) {
    const orig = history[m];
    history[m] = function (this: History, ...args: Parameters<History['pushState']>) {
      const before = location.href;
      const r = orig.apply(this, args);
      if (location.href !== before) setTimeout(page, 0);
      return r;
    };
  }
  addEventListener('popstate', page);
  addEventListener('hashchange', page);
  page();
}

function instrumentConsole(): void {
  for (const level of ['error', 'warn'] as const) {
    const orig = console[level];
    console[level] = (...args: unknown[]) => {
      event({ type: 'console', message: `${level}: ${args.map((a) => (a instanceof Error ? a.message : typeof a === 'string' ? a : JSON.stringify(a))).join(' ').slice(0, 2000)}` });
      orig.apply(console, args);
    };
  }
}

export function init(o: InitOptions): void {
  if (opts) return;
  if (!o.apiKey?.startsWith('dsi_')) throw new Error('DorisStackRUM: apiKey must be an ingestion key (dsi_…)');
  opts = { service: '', maskAllInputs: true, maskAllText: false, recordReplay: true, recordNetwork: true, recordConsole: true, tracePropagationTargets: [], flushIntervalMs: 5000, ...o };
  state = load();
  session();
  if (opts.recordReplay) {
    stopRecording = record({
      emit: (e) => {
        session();
        batch.addReplay(e as { timestamp: number });
        if (batch.size > 1_000_000) void flush();
      },
      maskAllInputs: opts.maskAllInputs,
      maskTextSelector: opts.maskAllText ? '*' : '.ds-mask',
      blockClass: 'ds-block',
      // A fresh full snapshot every 5 minutes keeps any part of a long session replayable.
      checkoutEveryNms: 5 * 60_000,
      sampling: { mousemove: 50, scroll: 150, input: 'last' },
    });
  }
  addEventListener('click', (e) => {
    const el = (e.target as Element | null)?.closest?.('a, button, [role=button], input, select, textarea, label, [onclick]') ?? (e.target as Element | null);
    // Text typed into rich-text editors, and masked or blocked parts of the page, stay out.
    const hide = opts!.maskAllText || Boolean(el?.closest?.('[contenteditable]:not([contenteditable="false"]), .ds-mask, .ds-block'));
    if (el) event({ type: 'click', message: describeElement(el as unknown as Parameters<typeof describeElement>[0], hide) });
  }, { capture: true });
  addEventListener('error', (e) => event({ type: 'error', message: e.message || String(e.error), attributes: { source: e.filename, line: e.lineno, column: e.colno, stack: e.error?.stack?.slice(0, 4000) } }));
  addEventListener('unhandledrejection', (e) => event({ type: 'error', message: `Unhandled rejection: ${e.reason instanceof Error ? e.reason.message : String(e.reason)}`, attributes: { stack: e.reason?.stack?.slice(0, 4000) } }));
  if (opts.recordNetwork) instrumentNetwork();
  if (opts.recordConsole) instrumentConsole();
  instrumentNavigation();
  setInterval(() => void flush(), opts.flushIntervalMs);
  addEventListener('visibilitychange', () => document.visibilityState === 'hidden' && void flush(true));
  addEventListener('pagehide', () => void flush(true));
}

export function setUser(u: { id?: string; email?: string; name?: string } | null): void {
  session();
  state!.user = u;
  save();
}

/** A custom event on the session timeline, e.g. track('checkout', { total: 42 }). */
export function track(name: string, attributes?: Record<string, unknown>): void {
  event({ type: 'custom', message: name, attributes });
}

export function sessionId(): string | null {
  return state?.id ?? null;
}

/** Stop recording and send what is left. */
export async function stop(): Promise<void> {
  stopRecording?.();
  await flush();
  opts = null;
}

export { flush };
