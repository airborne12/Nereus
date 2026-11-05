// HTTP endpoints for saved searches, dashboards, favorites, webhooks and alerts.
//
//   GET|POST /api/saved-searches        GET|PUT|DELETE /api/saved-searches/<id>   POST .../<id>/favorite {on}
//   GET|POST /api/dashboards            GET|PUT|DELETE /api/dashboards/<id>       POST .../<id>/favorite {on}
//   GET /api/webhooks (URLs for admins only); POST, DELETE /api/webhooks/<id>, POST .../<id>/test (admins)
//   GET|POST /api/alerts[?savedSearchId=|?dashboardId=] (on a saved search or a dashboard tile)  DELETE /api/alerts/<id>  POST .../<id>/silence {minutes}
//   GET /api/alerts/<id>/history

import type { IncomingMessage, ServerResponse } from 'node:http';
import { readJson } from '../auth/http.ts';
import { AuthError, type User } from '../auth/store.ts';
import { postWebhook } from './alerts.ts';
import type { ContentStore } from './store.ts';

type Send = (res: ServerResponse, status: number, body: unknown) => void;

function admin(user: User): void {
  if (user.role !== 'admin') throw new AuthError(403, 'only admins can manage webhooks');
}

export function contentRoutes(store: ContentStore, send: Send, fetchImpl: typeof fetch = fetch) {
  return async function handle(req: IncomingMessage, res: ServerResponse, url: URL, user: User): Promise<boolean> {
    const path = url.pathname;
    const m = req.method ?? 'GET';
    let x: RegExpExecArray | null;

    for (const [base, kind] of [['/api/saved-searches', 'search'], ['/api/dashboards', 'dashboard']] as const) {
      const isSearch = kind === 'search';
      if (path === base && m === 'GET') {
        send(res, 200, { items: isSearch ? await store.listSearches(user.id) : await store.listDashboards(user.id) });
        return true;
      }
      if (path === base && m === 'POST') {
        const b = await readJson(req);
        send(res, 201, isSearch ? await store.saveSearch(user.id, b) : await store.saveDashboard(user.id, b));
        return true;
      }
      if ((x = new RegExp(`^${base}/(\\d+)$`).exec(path))) {
        const itemId = Number(x[1]);
        if (m === 'GET') send(res, 200, isSearch ? await store.getSearch(user.id, itemId) : await store.getDashboard(user.id, itemId));
        else if (m === 'PUT') {
          const b = await readJson(req);
          send(res, 200, isSearch ? await store.saveSearch(user.id, b, itemId) : await store.saveDashboard(user.id, b, itemId));
        } else if (m === 'DELETE') {
          await (isSearch ? store.deleteSearch(itemId) : store.deleteDashboard(itemId));
          send(res, 200, { ok: true });
        } else return false;
        return true;
      }
      if ((x = new RegExp(`^${base}/(\\d+)/favorite$`).exec(path)) && m === 'POST') {
        const b = await readJson(req);
        await store.setFavorite(user.id, kind, Number(x[1]), Boolean(b.on));
        send(res, 200, { ok: true });
        return true;
      }
    }

    if (path === '/api/webhooks' && m === 'GET') {
      const hooks = await store.listWebhooks();
      // Webhook URLs often carry a secret token; members only need to pick one by name.
      send(res, 200, { items: user.role === 'admin' ? hooks : hooks.map(({ url: _u, ...h }) => h) });
      return true;
    }
    if (path === '/api/webhooks' && m === 'POST') {
      admin(user);
      send(res, 201, await store.createWebhook(user.id, await readJson(req)));
      return true;
    }
    if ((x = /^\/api\/webhooks\/(\d+)$/.exec(path)) && m === 'DELETE') {
      admin(user);
      await store.deleteWebhook(Number(x[1]));
      send(res, 200, { ok: true });
      return true;
    }
    if ((x = /^\/api\/webhooks\/(\d+)\/test$/.exec(path)) && m === 'POST') {
      admin(user);
      await readJson(req);
      try {
        await postWebhook(await store.webhookUrl(Number(x[1])), { text: '[TEST] DorisStack webhook test', state: 'TEST' }, fetchImpl);
      } catch (e) {
        if (e instanceof AuthError) throw e;
        throw new AuthError(502, `the webhook did not accept the test message: ${(e as Error).message}`);
      }
      send(res, 200, { ok: true });
      return true;
    }

    if (path === '/api/alerts' && m === 'GET') {
      const s = url.searchParams.get('savedSearchId'), d = url.searchParams.get('dashboardId');
      send(res, 200, { items: await store.listAlerts({ savedSearchId: s === null ? undefined : Number(s), dashboardId: d === null ? undefined : Number(d) }) });
      return true;
    }
    if (path === '/api/alerts' && m === 'POST') {
      send(res, 201, await store.createAlert(user.id, await readJson(req)));
      return true;
    }
    if ((x = /^\/api\/alerts\/(\d+)$/.exec(path)) && m === 'DELETE') {
      await store.deleteAlert(Number(x[1]));
      send(res, 200, { ok: true });
      return true;
    }
    if ((x = /^\/api\/alerts\/(\d+)\/silence$/.exec(path)) && m === 'POST') {
      const b = await readJson(req);
      await store.silenceAlert(Number(x[1]), Number(b.minutes));
      send(res, 200, { ok: true });
      return true;
    }
    if ((x = /^\/api\/alerts\/(\d+)\/history$/.exec(path)) && m === 'GET') {
      send(res, 200, { items: await store.alertHistory(Number(x[1])) });
      return true;
    }
    return false;
  };
}
