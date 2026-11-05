// Saved searches, dashboards, favorites, webhooks and alerts (PostgreSQL). Items are shared by
// the team; favorites belong to a user.

import { metricLabel } from './alerts.ts';
import type pg from 'pg';
import { AuthError } from '../auth/store.ts';
import { AGGREGATES } from '../query/build.ts';

type J = Record<string, unknown>;

// ---------------------------------------------------------------- validation

function bad(msg: string): never {
  throw new AuthError(400, msg);
}

function str(v: unknown, what: string, max = 10_000): string {
  if (v === undefined || v === null) return '';
  if (typeof v !== 'string') bad(`${what} must be text`);
  if (v.length > max) bad(`${what} is too long`);
  return v;
}

function name(v: unknown): string {
  const s = str(v, 'name', 200).trim();
  if (!s) bad('name must not be empty');
  return s;
}

function tags(v: unknown): string[] {
  if (v === undefined) return [];
  if (!Array.isArray(v) || v.length > 20) bad('tags must be a list of at most 20');
  return [...new Set(v.map((t) => str(t, 'tag', 50).trim()).filter(Boolean))];
}

function filters(v: unknown): J[] {
  if (v === undefined) return [];
  if (!Array.isArray(v) || v.length > 50) bad('filters must be a list');
  return v.map((f) => {
    if (typeof f?.field !== 'string' || !Array.isArray(f.values) || f.values.length === 0) bad('each filter needs a field and values');
    return { field: f.field, values: f.values.map(String), ...(f.exclude ? { exclude: true } : {}) };
  });
}

function language(v: unknown): 'lucene' | 'sql' {
  if (v === undefined || v === 'lucene') return 'lucene';
  if (v === 'sql') return 'sql';
  bad("language must be 'lucene' or 'sql'");
}

const SOURCES = ['logs', 'traces', 'metrics'];

function chart(v: unknown): J {
  if (!v || typeof v !== 'object') bad('a tile needs a chart');
  const c = v as J;
  if (!SOURCES.includes(String(c.source))) bad(`chart source must be one of ${SOURCES.join(', ')}`);
  if (!['line', 'table', 'number'].includes(String(c.display))) bad("chart display must be 'line', 'table' or 'number'");
  if (!Array.isArray(c.series) || c.series.length === 0 || c.series.length > 10) bad('a chart needs 1 to 10 series');
  const series = c.series.map((s: J) => {
    if (!AGGREGATES.includes(s?.agg as never)) bad(`unknown aggregate '${String(s?.agg)}'`);
    return { agg: s.agg, ...(s.field ? { field: str(s.field, 'series field', 200) } : {}) };
  });
  return {
    source: c.source, display: c.display, series, where: str(c.where, 'where'), language: language(c.language),
    filters: filters(c.filters), ...(c.groupBy ? { groupBy: str(c.groupBy, 'groupBy', 200) } : {}),
  };
}

function tiles(v: unknown): J[] {
  if (v === undefined) return [];
  if (!Array.isArray(v) || v.length > 60) bad('a dashboard has at most 60 tiles');
  return v.map((t: J) => {
    const w = Number(t?.w ?? 6);
    if (![3, 4, 6, 8, 12].includes(w)) bad('tile width must be 3, 4, 6, 8 or 12 columns');
    return { id: str(t?.id, 'tile id', 64) || crypto.randomUUID(), title: str(t?.title, 'tile title', 200), chart: chart(t?.chart), w };
  });
}

function id(v: unknown): number {
  const n = Number(v);
  if (!Number.isSafeInteger(n) || n <= 0) bad('bad id');
  return n;
}

const iso = (v: unknown) => (v instanceof Date ? v.toISOString() : v === null || v === undefined ? null : String(v));

// ---------------------------------------------------------------- rows

function savedSearch(r: J, fav: boolean) {
  return {
    id: Number(r.id), name: r.name, source: r.source, where: r.where_text, language: r.language, filters: r.filters,
    select: r.select_text, orderBy: r.order_by, tags: r.tags, createdBy: r.created_by_name ?? null,
    createdAt: iso(r.created_at), updatedAt: iso(r.updated_at), favorite: fav,
    alertState: r.alert_state ?? null,
  };
}

function dashboard(r: J, fav: boolean) {
  return {
    id: Number(r.id), name: r.name, tiles: r.tiles, tags: r.tags, createdBy: r.created_by_name ?? null,
    createdAt: iso(r.created_at), updatedAt: iso(r.updated_at), favorite: fav,
  };
}

function alert(r: J) {
  return {
    id: Number(r.id), savedSearchId: r.saved_search_id === null ? null : Number(r.saved_search_id), savedSearchName: r.saved_search_name ?? null,
    dashboardId: r.dashboard_id === null ? null : Number(r.dashboard_id), dashboardName: r.dashboard_name ?? null,
    tileId: r.tile_id ?? null, tileTitle: r.tile_title ?? null, tileMetric: r.tile_series ? metricLabel(r.tile_series as { agg: string; field?: string }) : null,
    lastGroup: r.last_group ?? null,
    webhookId: Number(r.webhook_id), webhookName: r.webhook_name ?? null, thresholdType: r.threshold_type,
    threshold: Number(r.threshold), intervalSeconds: Number(r.interval_seconds), state: r.state,
    lastCheckedAt: iso(r.last_checked_at), lastValue: r.last_value === null ? null : Number(r.last_value),
    silencedUntil: iso(r.silenced_until), createdAt: iso(r.created_at),
  };
}

const INTERVALS = [60, 300, 900, 1800, 3600, 21600, 43200, 86400];

export class ContentStore {
  private db: pg.Pool;
  constructor(db: pg.Pool) {
    this.db = db;
  }

  // ---------------- favorites
  private async favs(userId: number, kind: 'search' | 'dashboard'): Promise<Set<number>> {
    const r = await this.db.query('SELECT item_id FROM favorites WHERE user_id = $1 AND kind = $2', [userId, kind]);
    return new Set(r.rows.map((x) => Number(x.item_id)));
  }

  async setFavorite(userId: number, kind: 'search' | 'dashboard', itemId: number, on: boolean): Promise<void> {
    if (on) {
      await this.db.query('INSERT INTO favorites (user_id, kind, item_id) VALUES ($1, $2, $3) ON CONFLICT DO NOTHING', [userId, kind, id(itemId)]);
    } else {
      await this.db.query('DELETE FROM favorites WHERE user_id = $1 AND kind = $2 AND item_id = $3', [userId, kind, id(itemId)]);
    }
  }

  // ---------------- saved searches
  private static SEARCH_SELECT = `SELECT s.*, u.name AS created_by_name,
      (SELECT CASE WHEN bool_or(a.state = 'ALERT') THEN 'ALERT' WHEN bool_or(a.state = 'ERROR') THEN 'ERROR' ELSE 'OK' END
         FROM alerts a WHERE a.saved_search_id = s.id HAVING count(*) > 0) AS alert_state
    FROM saved_searches s LEFT JOIN users u ON u.id = s.created_by`;

  async listSearches(userId: number) {
    const favs = await this.favs(userId, 'search');
    const r = await this.db.query(`${ContentStore.SEARCH_SELECT} ORDER BY s.updated_at DESC`);
    return r.rows.map((x) => savedSearch(x, favs.has(Number(x.id))));
  }

  async getSearch(userId: number, searchId: number) {
    const r = await this.db.query(`${ContentStore.SEARCH_SELECT} WHERE s.id = $1`, [id(searchId)]);
    if (!r.rows[0]) throw new AuthError(404, 'no such saved search');
    return savedSearch(r.rows[0], (await this.favs(userId, 'search')).has(searchId));
  }

  async saveSearch(userId: number, body: J, searchId?: number) {
    if (!['logs', 'traces'].includes(String(body.source))) bad("source must be 'logs' or 'traces'");
    const v = [name(body.name), body.source, str(body.where, 'where'), language(body.language), JSON.stringify(filters(body.filters)),
      str(body.select, 'select'), str(body.orderBy, 'orderBy', 1000), tags(body.tags)];
    if (searchId === undefined) {
      const r = await this.db.query(`INSERT INTO saved_searches (name, source, where_text, language, filters, select_text, order_by, tags, created_by)
        VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9) RETURNING id`, [...v, userId]);
      return this.getSearch(userId, Number(r.rows[0].id));
    }
    const r = await this.db.query(`UPDATE saved_searches SET name = $1, source = $2, where_text = $3, language = $4, filters = $5,
      select_text = $6, order_by = $7, tags = $8, updated_at = now() WHERE id = $9`, [...v, id(searchId)]);
    if (r.rowCount === 0) throw new AuthError(404, 'no such saved search');
    return this.getSearch(userId, searchId);
  }

  async deleteSearch(searchId: number) {
    const r = await this.db.query('DELETE FROM saved_searches WHERE id = $1', [id(searchId)]);
    if (r.rowCount === 0) throw new AuthError(404, 'no such saved search');
    await this.db.query("DELETE FROM favorites WHERE kind = 'search' AND item_id = $1", [searchId]);
  }

  // ---------------- dashboards
  private static DASH_SELECT = 'SELECT d.*, u.name AS created_by_name FROM dashboards d LEFT JOIN users u ON u.id = d.created_by';

  async listDashboards(userId: number) {
    const favs = await this.favs(userId, 'dashboard');
    const r = await this.db.query(`${ContentStore.DASH_SELECT} ORDER BY d.updated_at DESC`);
    return r.rows.map((x) => dashboard(x, favs.has(Number(x.id))));
  }

  async getDashboard(userId: number, dashId: number) {
    const r = await this.db.query(`${ContentStore.DASH_SELECT} WHERE d.id = $1`, [id(dashId)]);
    if (!r.rows[0]) throw new AuthError(404, 'no such dashboard');
    return dashboard(r.rows[0], (await this.favs(userId, 'dashboard')).has(dashId));
  }

  async saveDashboard(userId: number, body: J, dashId?: number) {
    const v = [name(body.name), JSON.stringify(tiles(body.tiles)), tags(body.tags)];
    if (dashId === undefined) {
      const r = await this.db.query('INSERT INTO dashboards (name, tiles, tags, created_by) VALUES ($1, $2, $3, $4) RETURNING id', [...v, userId]);
      return this.getDashboard(userId, Number(r.rows[0].id));
    }
    // Alerts on tiles that are no longer there go with them, in the same transaction.
    const c = await this.db.connect();
    try {
      await c.query('BEGIN');
      const r = await c.query('UPDATE dashboards SET name = $1, tiles = $2, tags = $3, updated_at = now() WHERE id = $4', [...v, id(dashId)]);
      if (r.rowCount === 0) throw new AuthError(404, 'no such dashboard');
      const kept = (JSON.parse(v[1] as string) as J[]).map((t) => String(t.id));
      await c.query('DELETE FROM alerts WHERE dashboard_id = $1 AND NOT (tile_id = ANY($2::text[]))', [dashId, kept]);
      await c.query('COMMIT');
    } catch (e) {
      await c.query('ROLLBACK');
      throw e;
    } finally {
      c.release();
    }
    return this.getDashboard(userId, dashId);
  }

  async deleteDashboard(dashId: number) {
    const r = await this.db.query('DELETE FROM dashboards WHERE id = $1', [id(dashId)]);
    if (r.rowCount === 0) throw new AuthError(404, 'no such dashboard');
    await this.db.query("DELETE FROM favorites WHERE kind = 'dashboard' AND item_id = $1", [dashId]);
  }

  // ---------------- webhooks (admins)
  async listWebhooks() {
    const r = await this.db.query('SELECT id, name, url, created_at FROM webhooks ORDER BY id');
    return r.rows.map((x) => ({ id: Number(x.id), name: x.name, url: x.url, createdAt: iso(x.created_at) }));
  }

  async createWebhook(userId: number, body: J) {
    const url = str(body.url, 'url', 2000).trim();
    let parsed: URL;
    try {
      parsed = new URL(url);
    } catch {
      bad('url is not a URL');
    }
    if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') bad('url must be http or https');
    const r = await this.db.query('INSERT INTO webhooks (name, url, created_by) VALUES ($1, $2, $3) RETURNING id, name, url, created_at',
      [name(body.name), url, userId]);
    const x = r.rows[0];
    return { id: Number(x.id), name: x.name, url: x.url, createdAt: iso(x.created_at) };
  }

  async webhookUrl(hookId: number): Promise<string> {
    const r = await this.db.query('SELECT url FROM webhooks WHERE id = $1', [id(hookId)]);
    if (!r.rows[0]) throw new AuthError(404, 'no such webhook');
    return String(r.rows[0].url);
  }

  async deleteWebhook(hookId: number) {
    try {
      const r = await this.db.query('DELETE FROM webhooks WHERE id = $1', [id(hookId)]);
      if (r.rowCount === 0) throw new AuthError(404, 'no such webhook');
    } catch (e) {
      if ((e as { code?: string }).code === '23503') throw new AuthError(409, 'alerts still use this webhook');
      throw e;
    }
  }

  // ---------------- alerts
  private static ALERT_SELECT = `SELECT a.*, s.name AS saved_search_name, w.name AS webhook_name, d.name AS dashboard_name,
      (SELECT t->>'title' FROM jsonb_array_elements(d.tiles) t WHERE t->>'id' = a.tile_id) AS tile_title,
      (SELECT t->'chart'->'series'->0 FROM jsonb_array_elements(d.tiles) t WHERE t->>'id' = a.tile_id) AS tile_series
    FROM alerts a JOIN webhooks w ON w.id = a.webhook_id
    LEFT JOIN saved_searches s ON s.id = a.saved_search_id LEFT JOIN dashboards d ON d.id = a.dashboard_id`;

  async listAlerts(by: { savedSearchId?: number; dashboardId?: number } = {}) {
    const r = by.savedSearchId !== undefined
      ? await this.db.query(`${ContentStore.ALERT_SELECT} WHERE a.saved_search_id = $1 ORDER BY a.id`, [id(by.savedSearchId)])
      : by.dashboardId !== undefined
        ? await this.db.query(`${ContentStore.ALERT_SELECT} WHERE a.dashboard_id = $1 ORDER BY a.id`, [id(by.dashboardId)])
        : await this.db.query(`${ContentStore.ALERT_SELECT} ORDER BY a.id`);
    return r.rows.map(alert);
  }

  /** An alert on a saved search ({savedSearchId}) or on a dashboard tile ({dashboardId, tileId}). */
  async createAlert(userId: number, body: J) {
    const type = body.thresholdType;
    if (type !== 'above' && type !== 'below') bad("thresholdType must be 'above' or 'below'");
    const onTile = body.dashboardId !== undefined && body.dashboardId !== null;
    if (onTile === (body.savedSearchId !== undefined && body.savedSearchId !== null)) bad('give either savedSearchId or dashboardId and tileId');
    const threshold = Number(body.threshold);
    // A search alert counts matches; a tile's series can be any number (latency, a rate, a gauge).
    if (!Number.isFinite(threshold) || (!onTile && threshold < 0)) bad(onTile ? 'threshold must be a number' : 'threshold must be a number of matches (0 or more)');
    const interval = Number(body.intervalSeconds);
    if (!INTERVALS.includes(interval)) bad(`intervalSeconds must be one of ${INTERVALS.join(', ')}`);
    let tileId: string | null = null;
    if (onTile) {
      tileId = str(body.tileId, 'tileId', 100);
      const d = await this.db.query('SELECT tiles FROM dashboards WHERE id = $1', [id(body.dashboardId)]);
      if (d.rowCount === 0) bad('no such dashboard');
      if (!(d.rows[0].tiles as J[]).some((t) => t.id === tileId)) bad('no such tile on this dashboard');
    }
    try {
      const r = await this.db.query(`INSERT INTO alerts (saved_search_id, dashboard_id, tile_id, webhook_id, threshold_type, threshold, interval_seconds, created_by)
        VALUES ($1, $2, $3, $4, $5, $6, $7, $8) RETURNING id`,
        [onTile ? null : id(body.savedSearchId), onTile ? id(body.dashboardId) : null, tileId, id(body.webhookId), type, threshold, interval, userId]);
      return (await this.db.query(`${ContentStore.ALERT_SELECT} WHERE a.id = $1`, [r.rows[0].id])).rows.map(alert)[0]!;
    } catch (e) {
      if ((e as { code?: string }).code === '23503') bad('no such saved search or webhook');
      throw e;
    }
  }

  async deleteAlert(alertId: number) {
    const r = await this.db.query('DELETE FROM alerts WHERE id = $1', [id(alertId)]);
    if (r.rowCount === 0) throw new AuthError(404, 'no such alert');
  }

  async silenceAlert(alertId: number, minutes: number) {
    if (!Number.isFinite(minutes) || minutes < 0 || minutes > 7 * 24 * 60) bad('minutes must be between 0 and 10080');
    const r = await this.db.query(`UPDATE alerts SET silenced_until = CASE WHEN $2 = 0 THEN NULL ELSE now() + make_interval(mins => $2) END
      WHERE id = $1`, [id(alertId), Math.round(minutes)]);
    if (r.rowCount === 0) throw new AuthError(404, 'no such alert');
  }

  async alertHistory(alertId: number, limit = 50) {
    const r = await this.db.query('SELECT checked_at, value, state, error, notified, grp FROM alert_history WHERE alert_id = $1 ORDER BY checked_at DESC LIMIT $2',
      [id(alertId), limit]);
    return r.rows.map((x) => ({ checkedAt: iso(x.checked_at), value: x.value === null ? null : Number(x.value), state: x.state, error: x.error, notified: x.notified, group: x.grp }));
  }

  /**
   * Alerts due for a check, claimed by this process: each is marked checked now inside the same
   * statement, so two servers never evaluate the same alert in the same interval.
   */
  async claimDueAlerts(limit = 20) {
    // `tile` is the tile's JSON as it is now, or null once it was removed.
    const r = await this.db.query(`WITH claimed AS (
        UPDATE alerts SET last_checked_at = now()
        WHERE id IN (SELECT id FROM alerts WHERE last_checked_at IS NULL OR last_checked_at <= now() - make_interval(secs => interval_seconds)
                     ORDER BY last_checked_at NULLS FIRST LIMIT $1 FOR UPDATE SKIP LOCKED)
        RETURNING *)
      SELECT a.*, s.name AS saved_search_name, s.source, s.where_text, s.language, s.filters, d.name AS dashboard_name,
        (SELECT t FROM jsonb_array_elements(d.tiles) t WHERE t->>'id' = a.tile_id) AS tile, w.url AS webhook_url,
        (a.silenced_until IS NOT NULL AND a.silenced_until > now()) AS silenced
      FROM claimed a JOIN webhooks w ON w.id = a.webhook_id
      LEFT JOIN saved_searches s ON s.id = a.saved_search_id LEFT JOIN dashboards d ON d.id = a.dashboard_id`, [limit]);
    return r.rows;
  }

  async recordCheck(alertId: number, value: number | null, state: 'OK' | 'ALERT' | 'ERROR', error: string | null, notified: boolean, group: string | null = null) {
    await this.db.query('UPDATE alerts SET state = $2, last_value = $3, last_group = $4 WHERE id = $1', [alertId, state, value, group]);
    await this.db.query('INSERT INTO alert_history (alert_id, value, state, error, notified, grp) VALUES ($1, $2, $3, $4, $5, $6)',
      [alertId, value, state, error, notified, group]);
  }
}
