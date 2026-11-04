import { useCallback, useEffect, useRef, useState } from 'react';
import * as api from './api.ts';
import { App } from './App.tsx';
import { LoginPage } from './components/LoginPage.tsx';
import { SettingsPage } from './components/SettingsPage.tsx';

type Auth = { state: 'loading' } | { state: 'setup' } | { state: 'login' } | { state: 'in'; user: api.User };

function usePath(): [string, (p: string) => void] {
  const [path, setPath] = useState(window.location.pathname);
  useEffect(() => {
    const onPop = () => setPath(window.location.pathname);
    window.addEventListener('popstate', onPop);
    return () => window.removeEventListener('popstate', onPop);
  }, []);
  const go = useCallback((p: string) => {
    window.history.pushState(null, '', p);
    setPath(p);
  }, []);
  return [path, go];
}

/** Shows setup, login, the search page or settings depending on the session and the path. */
export function Root() {
  const [auth, setAuth] = useState<Auth>({ state: 'loading' });
  const [path, go] = usePath();
  const lastSearch = useRef('');

  const refresh = useCallback(() => {
    api.auth.status().then(
      (s) => setAuth(s.setupRequired ? { state: 'setup' } : s.user ? { state: 'in', user: s.user } : { state: 'login' }),
      () => setAuth({ state: 'login' }),
    );
  }, []);
  useEffect(refresh, [refresh]);
  // A 401 while signed in means the session ended (expired, logged out elsewhere, disabled).
  useEffect(() => api.setUnauthorizedHandler(() => setAuth((a) => (a.state === 'in' ? { state: 'login' } : a))), []);

  if (auth.state === 'loading') return <div className="empty">Loading…</div>;
  if (auth.state === 'setup' || auth.state === 'login') {
    return <LoginPage key={auth.state} mode={auth.state} onDone={(user) => setAuth({ state: 'in', user })} />;
  }

  const userMenu = (
    <span className="user-menu">
      <button type="button" className={path === '/settings' ? 'btn active' : 'btn'}
        onClick={() => {
          // Keep the search (query, time range) to come back to it from settings.
          if (path === '/settings') go(`/${lastSearch.current}`);
          else {
            lastSearch.current = window.location.search;
            go('/settings');
          }
        }}>{path === '/settings' ? 'Search' : 'Settings'}</button>
      <span className="muted" title={auth.user.email}>{auth.user.name || auth.user.email}</span>
      <button type="button" className="btn" onClick={() => api.auth.logout().finally(() => setAuth({ state: 'login' }))}>Sign out</button>
    </span>
  );

  if (path === '/settings') {
    return (
      <div className="app">
        <header className="topbar"><span className="brand">DorisStack</span><span className="grow" />{userMenu}</header>
        <SettingsPage me={auth.user} />
      </div>
    );
  }
  return <App userMenu={userMenu} />;
}
