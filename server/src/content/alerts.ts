// Alert checks: every tick, claim the alerts whose interval has passed, count their saved
// search's matches over the last interval, compare with the threshold, and call the webhook when
// the state changes (OK -> ALERT fires, ALERT -> OK resolves) unless the alert is silenced.

import type { Doris } from '../db.ts';
import { countSql, type Filter } from '../query/build.ts';
import type { Source } from '../query/source.ts';
import type { ContentStore } from './store.ts';

export interface AlertMessage {
  text: string;
  state: 'ALERT' | 'OK';
  value: number;
  threshold: number;
  thresholdType: 'above' | 'below';
  intervalSeconds: number;
  savedSearch: { id: number; name: string };
  link: string | null;
}

function interval(s: number): string {
  return s % 3600 === 0 ? `${s / 3600}h` : `${s / 60}m`;
}

export function alertMessage(a: Record<string, unknown>, value: number, state: 'ALERT' | 'OK', baseUrl: string | null): AlertMessage {
  const name = String(a.saved_search_name);
  const cond = `${a.threshold_type === 'above' ? 'above' : 'below'} ${Number(a.threshold)}`;
  const text = state === 'ALERT'
    ? `[ALERT] "${name}": ${value} matches in the last ${interval(Number(a.interval_seconds))} (alert when ${cond})`
    : `[RESOLVED] "${name}": ${value} matches in the last ${interval(Number(a.interval_seconds))}, back within ${cond}`;
  return {
    text, state, value, threshold: Number(a.threshold), thresholdType: a.threshold_type as 'above' | 'below',
    intervalSeconds: Number(a.interval_seconds), savedSearch: { id: Number(a.saved_search_id), name },
    link: baseUrl ? `${baseUrl.replace(/\/$/, '')}/search?saved=${Number(a.saved_search_id)}` : null,
  };
}

/** POST a JSON message (Slack-compatible `text`). Redirects are not followed. */
export async function postWebhook(url: string, body: unknown, fetchImpl: typeof fetch = fetch): Promise<void> {
  const res = await fetchImpl(url, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body),
    redirect: 'manual', signal: AbortSignal.timeout(5000),
  });
  if (res.status < 200 || res.status >= 300) throw new Error(`webhook answered HTTP ${res.status}`);
}

export interface AlertRunnerOptions {
  store: ContentStore;
  doris: Doris;
  sources: Record<string, Source>;
  /** Public URL of the UI, for links in messages. */
  baseUrl?: string | null;
  fetchImpl?: typeof fetch;
  now?: () => number;
}

export class AlertRunner {
  private o: AlertRunnerOptions;
  private timer: NodeJS.Timeout | null = null;
  private running = false;
  constructor(o: AlertRunnerOptions) {
    this.o = o;
  }

  /** Check every due alert once; returns how many were checked. */
  async tick(): Promise<number> {
    if (this.running) return 0;
    this.running = true;
    try {
      const due = await this.o.store.claimDueAlerts();
      for (const a of due) await this.check(a);
      return due.length;
    } finally {
      this.running = false;
    }
  }

  private async check(a: Record<string, unknown>): Promise<void> {
    const source = this.o.sources[String(a.source)]!;
    const now = (this.o.now ?? Date.now)();
    const intervalMs = Number(a.interval_seconds) * 1000;
    let value: number;
    try {
      const sql = countSql(source, {
        where: String(a.where_text), language: a.language as 'lucene' | 'sql', filters: a.filters as Filter[],
        from: new Date(now - intervalMs).toISOString(), to: new Date(now).toISOString(),
      });
      const [row] = await this.o.doris.query(sql);
      value = Number(row?.n ?? 0);
    } catch (e) {
      await this.o.store.recordCheck(Number(a.id), null, 'ERROR', (e as Error).message, false);
      return;
    }
    const breached = a.threshold_type === 'above' ? value > Number(a.threshold) : value < Number(a.threshold);
    const state = breached ? 'ALERT' : 'OK';
    const prev = String(a.state);
    // Fire on entering ALERT, resolve on leaving it; an ERROR check does not count as a change.
    const changed = (state === 'ALERT' && prev !== 'ALERT') || (state === 'OK' && prev === 'ALERT');
    let notified = false;
    let error: string | null = null;
    if (changed && !a.silenced) {
      try {
        await postWebhook(String(a.webhook_url), alertMessage(a, value, state, this.o.baseUrl ?? null), this.o.fetchImpl);
        notified = true;
      } catch (e) {
        error = `notification failed: ${(e as Error).message}`;
      }
    }
    await this.o.store.recordCheck(Number(a.id), value, state, error, notified);
  }

  start(everyMs = 15_000): void {
    this.timer = setInterval(() => this.tick().catch((e) => console.error('alert check failed', e)), everyMs);
    this.timer.unref();
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
  }
}
