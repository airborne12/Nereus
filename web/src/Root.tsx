import { useCallback, useEffect, useRef, useState } from 'react';
import * as api from './api.ts';
import { AppShell, type Favorites, type Page, PlannedPage } from './components/AppShell.tsx';
import { LoginPage } from './components/LoginPage.tsx';
import { SettingsPage } from './components/SettingsPage.tsx';
import { AlertsPage } from './pages/AlertsPage.tsx';
import { ChartExplorerPage } from './pages/ChartExplorerPage.tsx';
import { DashboardPage, DashboardsPage } from './pages/DashboardsPage.tsx';
import { SavedSearchesPage } from './pages/SavedSearchesPage.tsx';
import { ServiceMapPage } from './pages/ServiceMapPage.tsx';
import { SearchPage } from './SearchPage.tsx';

type Auth = { state: 'loading' } | { state: 'setup' } | { state: 'login' } | { state: 'in'; user: api.User };

export const PATHS: Record<Page, string> = {
  search: '/search', saved: '/search/list', chart: '/chart', alerts: '/alerts', sessions: '/sessions',
  'service-map': '/service-map', dashboards: '/dashboards/list', settings: '/team',
};

function route(path: string): { page: Page; dashboard: number | null } {
  const d = /^\/dashboards\/(\d+)$/.exec(path);
  if (d) return { page: 'dashboards', dashboard: Number(d[1]) };
  const hit = (Object.entries(PATHS) as [Page, string][]).find(([, p]) => p === path);
  return { page: hit ? hit[0] : 'search', dashboard: null };
}

/** Setup, login, or the app with its navigation, depending on the session and the path. */
export function Root() {
  const [auth, setAuth] = useState<Auth>({ state: 'loading' });
  const [loc, setLoc] = useState(() => ({ path: window.location.pathname, search: window.location.search }));
  const [favorites, setFavorites] = useState<Favorites>({ searches: [], dashboards: [] });
  const lastSearch = useRef(route(window.location.pathname).page === 'search' ? window.location.search : '');

  const refresh = useCallback(() => {
    api.auth.status().then(
      (s) => setAuth(s.setupRequired ? { state: 'setup' } : s.user ? { state: 'in', user: s.user } : { state: 'login' }),
      () => setAuth({ state: 'login' }),
    );
  }, []);
  useEffect(refresh, [refresh]);
  // A 401 while signed in means the session ended (expired, logged out elsewhere, disabled).
  useEffect(() => api.setUnauthorizedHandler(() => setAuth((a) => (a.state === 'in' ? { state: 'login' } : a))), []);
  useEffect(() => {
    const onPop = () => setLoc({ path: window.location.pathname, search: window.location.search });
    window.addEventListener('popstate', onPop);
    return () => window.removeEventListener('popstate', onPop);
  }, []);

  const loadFavorites = useCallback(() => {
    Promise.all([api.content.searches(), api.content.dashboards()]).then(([s, d]) => setFavorites({
      searches: s.items.filter((x) => x.favorite).map((x) => ({ id: x.id, name: x.name, alertState: x.alertState })),
      dashboards: d.items.filter((x) => x.favorite).map((x) => ({ id: x.id, name: x.name, alertState: null })),
    }), () => {});
  }, []);
  useEffect(() => { if (auth.state === 'in') loadFavorites(); }, [auth.state, loadFavorites]);

  const { page, dashboard } = route(loc.path);
  const go = (url: string) => {
    if (page === 'search') lastSearch.current = window.location.search;
    window.history.pushState(null, '', url);
    const u = new URL(url, window.location.origin);
    setLoc({ path: u.pathname, search: u.search });
  };
  // The nav's Search item returns to the last search (query, filters, time range).
  const navigate = (p: Page) => go(p === 'search' ? `${PATHS.search}${lastSearch.current}` : PATHS[p]);

  if (auth.state === 'loading') return <div className="empty">Loading…</div>;
  if (auth.state === 'setup' || auth.state === 'login') {
    return <LoginPage key={auth.state} mode={auth.state} onDone={(user) => setAuth({ state: 'in', user })} />;
  }
  let body;
  if (page === 'search') body = <SearchPage key={loc.search.includes('saved=') ? loc.search : 'search'} go={go} onChanged={loadFavorites} />;
  else if (page === 'saved') body = <SavedSearchesPage go={go} onChanged={loadFavorites} />;
  else if (page === 'alerts') body = <AlertsPage go={go} />;
  else if (page === 'chart') body = <ChartExplorerPage key={loc.search} go={go} />;
  else if (page === 'dashboards' && dashboard !== null) body = <DashboardPage key={dashboard} id={dashboard} go={go} onChanged={loadFavorites} />;
  else if (page === 'dashboards') body = <DashboardsPage go={go} onChanged={loadFavorites} />;
  else if (page === 'settings') body = <SettingsPage me={auth.user} />;
  else if (page === 'service-map') body = <ServiceMapPage go={go} />;
  else body = <PlannedPage page={page} />;
  return (
    <AppShell page={page} user={auth.user} favorites={favorites} onNavigate={navigate} onOpen={go}
      onLogout={() => api.auth.logout().finally(() => setAuth({ state: 'login' }))}>
      {body}
    </AppShell>
  );
}
