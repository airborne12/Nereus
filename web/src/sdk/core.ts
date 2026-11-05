// Browser SDK, the parts that do not touch the DOM: sessions, batching, element descriptions.

export interface SessionState {
  id: string;
  started: number;
  lastActive: number;
  /** Next replay chunk number in this session. */
  seq: number;
  user: { id?: string; email?: string; name?: string } | null;
}

/** A session ends after 30 minutes without activity or 4 hours in all, as in ClickStack. */
export const IDLE_MS = 30 * 60_000;
export const MAX_MS = 4 * 3600_000;

export function touchSession(s: SessionState | null, now: number, newId: () => string): { state: SessionState; rotated: boolean } {
  if (s && now - s.lastActive < IDLE_MS && now - s.started < MAX_MS) return { state: { ...s, lastActive: now }, rotated: false };
  return { state: { id: newId(), started: now, lastActive: now, seq: 0, user: s?.user ?? null }, rotated: s !== null };
}

export interface ElementLike {
  tagName: string;
  id?: string;
  className?: unknown;
  getAttribute?: (n: string) => string | null;
  textContent?: string | null;
  type?: string;
}

/** `button#buy.primary "Buy now"`; never the value or text of a form field. */
export function describeElement(el: ElementLike): string {
  const tag = el.tagName.toLowerCase();
  const id = el.id ? `#${el.id}` : '';
  const cls = typeof el.className === 'string' && el.className.trim() ? `.${el.className.trim().split(/\s+/).slice(0, 2).join('.')}` : '';
  const field = tag === 'input' || tag === 'textarea' || tag === 'select' || el.getAttribute?.('contenteditable') === 'true';
  const label = el.getAttribute?.('aria-label') ?? (field ? null : (el.textContent ?? '').replace(/\s+/g, ' ').trim().slice(0, 60));
  return `${tag}${id}${cls}${label ? ` "${label}"` : ''}`;
}

export interface SdkEvent {
  t: number;
  type: 'click' | 'navigation' | 'error' | 'console' | 'network' | 'custom';
  url?: string;
  message?: string;
  attributes?: Record<string, unknown>;
}

/** Target body size; one replay event bigger than this goes alone (the server takes up to 10 MB). */
export const MAX_BODY_CHARS = 1_500_000;

/**
 * What is waiting to be sent. take() empties it into request bodies: replay events go into chunks
 * of at most MAX_BODY_CHARS (each its own seq); events ride along with the first body.
 */
export class Batch {
  private replay: { t: number; json: string }[] = [];
  private events: SdkEvent[] = [];
  private chars = 0;

  addReplay(e: { timestamp: number }): void {
    const json = JSON.stringify(e);
    this.replay.push({ t: e.timestamp, json });
    this.chars += json.length;
  }

  addEvent(e: SdkEvent): void {
    this.events.push(e);
    this.chars += 200;
  }

  get size(): number {
    return this.chars;
  }

  get empty(): boolean {
    return this.replay.length === 0 && this.events.length === 0;
  }

  /** Request bodies (sessionId, user and the rest are added by the caller); advances seq. */
  take(seq: () => number): { replay: { seq: number; t: number; events: unknown[] }[]; events: SdkEvent[] }[] {
    const bodies: { replay: { seq: number; t: number; events: unknown[] }[]; events: SdkEvent[] }[] = [];
    let cur: { t: number; json: string }[] = [];
    let size = 0;
    const close = () => {
      if (cur.length) bodies.push({ replay: [{ seq: seq(), t: cur[0]!.t, events: cur.map((x) => JSON.parse(x.json)) }], events: [] });
      cur = [];
      size = 0;
    };
    for (const r of this.replay) {
      if (size + r.json.length > MAX_BODY_CHARS && cur.length) close();
      cur.push(r);
      size += r.json.length;
    }
    close();
    // Events go 1000 to a body, the server's limit.
    for (let i = 0; i < this.events.length; i += 1000) {
      const evs = this.events.slice(i, i + 1000);
      if (i === 0 && bodies[0]) bodies[0].events = evs;
      else bodies.push({ replay: [], events: evs });
    }
    this.replay = [];
    this.events = [];
    this.chars = 0;
    return bodies;
  }
}

export function newSessionId(): string {
  const b = new Uint8Array(16);
  crypto.getRandomValues(b);
  return [...b].map((x) => x.toString(16).padStart(2, '0')).join('');
}

// ---------------------------------------------------------------- trace propagation (W3C)

const hex = (bytes: number) => {
  const b = new Uint8Array(bytes);
  crypto.getRandomValues(b);
  return [...b].map((x) => x.toString(16).padStart(2, '0')).join('');
};

/** A sampled `traceparent` for a request the browser starts: 00-<trace id>-<span id>-01. */
export function newTraceparent(): { header: string; traceId: string; spanId: string } {
  const traceId = hex(16), spanId = hex(8);
  return { header: `00-${traceId}-${spanId}-01`, traceId, spanId };
}

/** The ids of a `traceparent` the page set itself (its own OTel instrumentation), or null. */
export function parseTraceparent(h: string | null | undefined): { traceId: string; spanId: string } | null {
  const m = /^[0-9a-f]{2}-([0-9a-f]{32})-([0-9a-f]{16})-[0-9a-f]{2}$/.exec((h ?? '').trim().toLowerCase());
  if (!m || /^0+$/.test(m[1]!) || /^0+$/.test(m[2]!)) return null;
  return { traceId: m[1]!, spanId: m[2]! };
}

/**
 * Whether a request gets a `traceparent`: always on the page's own origin; on another origin only
 * when listed (its CORS must allow the header, or the browser blocks the request).
 */
export function shouldPropagate(url: string, pageOrigin: string, targets: (string | RegExp)[]): boolean {
  let u: URL;
  try {
    u = new URL(url, pageOrigin);
  } catch {
    return false;
  }
  if (u.origin === pageOrigin) return true;
  return targets.some((t) => (typeof t === 'string' ? u.href.startsWith(t) : t.test(u.href)));
}
