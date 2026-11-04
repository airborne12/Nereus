import { useCallback, useEffect, useRef, useState } from 'react';
import * as api from './api.ts';
import { AppShell, type Page, PlannedPage } from './components/AppShell.tsx';
import { LoginPage } from './components/LoginPage.tsx';
import { SettingsPage } from './components/SettingsPage.tsx';
import { SearchPage } from './SearchPage.tsx';

type Auth = { state: 'loading' } | { state: 'setup' } | { state: 'login' } | { state: 'in'; user: api.User };

const PATHS: Record<Page, string> = {
  search: '/search', saved: '/search/list', chart: '/chart', alerts: '/alerts', sessions: '/sessions',
  'service-map': '/service-map', dashboards: '/dashboards/list', settings: '/team',
};

function pageOf(path: string): Page {
  const hit = (Object.entries(PATHS) as [Page, string][]).find(([, p]) => p === path);
  return hit ? hit[0] : 'search';
}

/** Setup, login, or the app with its navigation, depending on the session and the path. */
export function Root() {
  const [auth, setAuth] = useState<Auth>({ state: 'loading' });
  const [page, setPage] = useState<Page>(() => pageOf(window.location.pathname));
  const lastSearch = useRef(window.location.pathname === PATHS.search || pageOf(window.location.pathname) === 'search' ? window.location.search : '');

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
    const onPop = () => setPage(pageOf(window.location.pathname));
    window.addEventListener('popstate', onPop);
    return () => window.removeEventListener('popstate', onPop);
  }, []);

  const navigate = (p: Page) => {
    if (page === 'search') lastSearch.current = window.location.search;
    // Coming back to search restores the query, filters and time range.
    window.history.pushState(null, '', p === 'search' ? `${PATHS.search}${lastSearch.current}` : PATHS[p]);
    setPage(p);
  };

  if (auth.state === 'loading') return <div className="empty">Loading…</div>;
  if (auth.state === 'setup' || auth.state === 'login') {
    return <LoginPage key={auth.state} mode={auth.state} onDone={(user) => setAuth({ state: 'in', user })} />;
  }
  return (
    <AppShell page={page} user={auth.user} onNavigate={navigate}
      onLogout={() => api.auth.logout().finally(() => setAuth({ state: 'login' }))}>
      {page === 'search' ? <SearchPage /> : page === 'settings' ? <SettingsPage me={auth.user} /> : <PlannedPage page={page} />}
    </AppShell>
  );
}
