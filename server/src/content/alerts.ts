// Alert checks: every tick, claim the alerts whose interval has passed, measure their target over
// the last interval (a saved search's match count, or a dashboard tile's first series), compare
// with the threshold, and call the webhook when the state changes (OK -> ALERT fires, ALERT -> OK
// resolves) unless the alert is silenced. A grouped tile breaches when any of its groups does
// (the highest value for "above", the lowest for "below", among the 100 largest groups).

import type { Doris } from '../db.ts';
import { type ChartSpec, chartSql, countSql, type Filter } from '../query/build.ts';
import type { Source } from '../query/source.ts';
import type { ContentStore } from './store.ts';

export interface AlertMessage {
  text: string;
  state: 'ALERT' | 'OK';
  value: number;
  threshold: number;
  thresholdType: 'above' | 'below';
  intervalSeconds: number;
  savedSearch: { id: number; name: string } | null;
  tile: { dashboardId: number; dashboard: string; id: string; title: string; metric: string; group: string | null } | null;
  link: string | null;
}

/** "p99(duration)", "count". */
export function metricLabel(s: { agg: string; field?: string }): string {
  return s.agg === 'count' ? 'count' : `${s.agg}(${s.field ?? ''})`;
}

function interval(s: number): string {
  return s % 3600 === 0 ? `${s / 3600}h` : `${s / 60}m`;
}

export function alertMessage(a: Record<string, unknown>, value: number, state: 'ALERT' | 'OK', baseUrl: string | null, group: string | null = null): AlertMessage {
  const cond = `${a.threshold_type === 'above' ? 'above' : 'below'} ${Number(a.threshold)}`;
  const last = `in the last ${interval(Number(a.interval_seconds))}`;
  const base = baseUrl ? baseUrl.replace(/\/$/, '') : null;
  const common = { state, value, threshold: Number(a.threshold), thresholdType: a.threshold_type as 'above' | 'below', intervalSeconds: Number(a.interval_seconds) };
  if (a.dashboard_id !== null && a.dashboard_id !== undefined) {
    const tile = a.tile as { title: string; chart: { series: { agg: string; field?: string }[] } };
    const name = `${String(a.dashboard_name)} / ${tile.title}`;
    const metric = metricLabel(tile.chart.series[0]!);
    const what = `${metric} = ${value}${group !== null ? ` for ${group || '(empty)'}` : ''} ${last}`;
    return {
      ...common,
      text: state === 'ALERT' ? `[ALERT] "${name}": ${what} (alert when ${cond})` : `[RESOLVED] "${name}": ${what}, back within ${cond}`,
      savedSearch: null,
      tile: { dashboardId: Number(a.dashboard_id), dashboard: String(a.dashboard_name), id: String(a.tile_id), title: tile.title, metric, group },
      link: base ? `${base}/dashboards/${Number(a.dashboard_id)}` : null,
    };
  }
  const name = String(a.saved_search_name);
  return {
    ...common,
    text: state === 'ALERT' ? `[ALERT] "${name}": ${value} matches ${last} (alert when ${cond})` : `[RESOLVED] "${name}": ${value} matches ${last}, back within ${cond}`,
    savedSearch: { id: Number(a.saved_search_id), name },
    tile: null,
    link: base ? `${base}/search?saved=${Number(a.saved_search_id)}` : null,
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

  /** The value an alert watches over [from, to); null when a tile's series has no data. */
  private async measure(a: Record<string, unknown>, from: string, to: string): Promise<{ value: number | null; group: string | null }> {
    if (a.dashboard_id === null || a.dashboard_id === undefined) {
      const sql = countSql(this.o.sources[String(a.source)]!, {
        where: String(a.where_text), language: a.language as 'lucene' | 'sql', filters: a.filters as Filter[], from, to,
      });
      const [row] = await this.o.doris.query(sql);
      return { value: Number(row?.n ?? 0), group: null };
    }
    const tile = a.tile as { chart: ChartSpec & { source: string } } | null;
    if (!tile) throw new Error('the tile was removed from its dashboard');
    const source = this.o.sources[tile.chart.source];
    if (!source) throw new Error(`unknown source '${tile.chart.source}'`);
    const grouped = Boolean(tile.chart.groupBy);
    const { sql } = chartSql(source, { ...tile.chart, series: [tile.chart.series[0]!], display: grouped ? 'table' : 'number', from, to });
    const rows = (await this.o.doris.query(sql)) as Record<string, unknown>[];
    const points = rows.map((r) => ({ v: r.v0 === null ? NaN : Number(r.v0), g: grouped ? String(r.g ?? '') : null }))
      .filter((p) => Number.isFinite(p.v));
    if (points.length === 0) return { value: null, group: null };
    const pick = points.reduce((best, p) => ((a.threshold_type === 'above' ? p.v > best.v : p.v < best.v) ? p : best));
    return { value: pick.v, group: pick.g };
  }

  private async check(a: Record<string, unknown>): Promise<void> {
    const now = (this.o.now ?? Date.now)();
    const intervalMs = Number(a.interval_seconds) * 1000;
    let value: number | null, group: string | null;
    try {
      ({ value, group } = await this.measure(a, new Date(now - intervalMs).toISOString(), new Date(now).toISOString()));
    } catch (e) {
      await this.o.store.recordCheck(Number(a.id), null, 'ERROR', (e as Error).message, false);
      return;
    }
    // No data for a tile's series (an average over nothing) breaches neither way.
    const breached = value !== null && (a.threshold_type === 'above' ? value > Number(a.threshold) : value < Number(a.threshold));
    const state = breached ? 'ALERT' : 'OK';
    const prev = String(a.state);
    // Fire on entering ALERT, resolve on leaving it; an ERROR check does not count as a change.
    const changed = (state === 'ALERT' && prev !== 'ALERT') || (state === 'OK' && prev === 'ALERT');
    let notified = false;
    let error: string | null = null;
    if (changed && !a.silenced) {
      try {
        await postWebhook(String(a.webhook_url), alertMessage(a, value ?? 0, state, this.o.baseUrl ?? null, group), this.o.fetchImpl);
        notified = true;
      } catch (e) {
        error = `notification failed: ${(e as Error).message}`;
      }
    }
    await this.o.store.recordCheck(Number(a.id), value, state, error, notified, group);
  }

  start(everyMs = 15_000): void {
    this.timer = setInterval(() => this.tick().catch((e) => console.error('alert check failed', e)), everyMs);
    this.timer.unref();
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
  }
}
