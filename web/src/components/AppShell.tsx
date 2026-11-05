import { type ReactNode, useEffect, useState } from 'react';
import type * as api from '../api.ts';
import { Icon, type IconName } from './Icon.tsx';

export type Page = 'search' | 'saved' | 'chart' | 'alerts' | 'sessions' | 'service-map' | 'dashboards' | 'settings';

const ITEMS: { page: Page; label: string; icon: IconName; beta?: boolean }[] = [
  { page: 'search', label: 'Search', icon: 'table' },
  { page: 'saved', label: 'Saved searches', icon: 'floppy' },
  { page: 'chart', label: 'Chart explorer', icon: 'chart' },
  { page: 'alerts', label: 'Alerts', icon: 'bell' },
  { page: 'sessions', label: 'Client sessions', icon: 'laptop' },
  { page: 'service-map', label: 'Service map', icon: 'sitemap', beta: true },
  { page: 'dashboards', label: 'Dashboards', icon: 'grid' },
];

function readCollapsed(): boolean {
  try {
    return localStorage.getItem('ds.navCollapsed') === '1';
  } catch {
    return false;
  }
}

export interface Favorites {
  searches: { id: number; name: string; alertState: string | null }[];
  dashboards: { id: number; name: string; alertState: string | null }[];
}

interface Props {
  page: Page;
  user: api.User;
  favorites: Favorites;
  onNavigate: (p: Page) => void;
  onOpen: (url: string) => void;
  onLogout: () => void;
  children: ReactNode;
}

/** Left navigation (collapsible to icons) and the page beside it. */
export function AppShell({ page, user, favorites, onNavigate, onOpen, onLogout, children }: Props) {
  const [collapsed, setCollapsed] = useState(readCollapsed);
  const [menu, setMenu] = useState(false);
  const [showFav, setShowFav] = useState<Record<string, boolean>>({ saved: true, dashboards: true });
  useEffect(() => {
    try {
      localStorage.setItem('ds.navCollapsed', collapsed ? '1' : '0');
    } catch { /* private mode */ }
  }, [collapsed]);
  const tz = Intl.DateTimeFormat().resolvedOptions().timeZone;

  return (
    <div className={`shell${collapsed ? ' nav-collapsed' : ''}`}>
      <nav className="nav" aria-label="Main">
        <div className="nav-head">
          <button type="button" className="logo" onClick={() => onNavigate('search')} aria-label="DorisStack home">
            <span className="logo-mark">◆</span>{!collapsed && <span className="logo-text">DorisStack</span>}
          </button>
          {!collapsed && <span className="tz" title={`Showing time in ${tz}`}>{tz.split('/').at(-1)}</span>}
        </div>
        <ul className="nav-items">
          {ITEMS.map((it) => (
            <li key={it.page}>
              <div className="nav-row">
                <button type="button" className={`nav-item${page === it.page ? ' active' : ''}`} title={collapsed ? it.label : undefined}
                  aria-current={page === it.page ? 'page' : undefined} onClick={() => onNavigate(it.page)}>
                  <Icon name={it.icon} />
                  {!collapsed && <span>{it.label}</span>}
                  {!collapsed && it.beta && <span className="badge">Beta</span>}
                </button>
                {!collapsed && (it.page === 'saved' || it.page === 'dashboards') && (
                  <button type="button" className="fav-toggle" aria-label={`${showFav[it.page] ? 'Hide' : 'Show'} favorite ${it.label.toLowerCase()}`}
                    title={showFav[it.page] ? 'Hide favorites' : 'Show favorites'} onClick={() => setShowFav({ ...showFav, [it.page]: !showFav[it.page] })}>
                    <Icon name={showFav[it.page] ? 'chevron-down' : 'chevron-right'} size={12} />
                  </button>
                )}
              </div>
              {!collapsed && (it.page === 'saved' || it.page === 'dashboards') && showFav[it.page] && (
                <ul className="nav-favs" aria-label={`Favorite ${it.label.toLowerCase()}`}>
                  {(it.page === 'saved' ? favorites.searches : favorites.dashboards).map((f) => (
                    <li key={f.id}>
                      <button type="button" onClick={() => onOpen(it.page === 'saved' ? `/search?saved=${f.id}` : `/dashboards/${f.id}`)}>
                        {f.alertState === 'ALERT' && <span className="lvl-error">●</span>}<span>{f.name}</span>
                      </button>
                    </li>
                  ))}
                  {(it.page === 'saved' ? favorites.searches : favorites.dashboards).length === 0 && (
                    <li className="muted small nav-fav-empty">No favorites. Star on {it.label}.</li>
                  )}
                </ul>
              )}
            </li>
          ))}
        </ul>
        <div className="nav-foot">
          <button type="button" className={`nav-item${page === 'settings' ? ' active' : ''}`} title={collapsed ? 'Team settings' : undefined}
            onClick={() => onNavigate('settings')}>
            <Icon name="settings" />{!collapsed && <span>Team settings</span>}
          </button>
          <div className="user-menu-wrap">
            <button type="button" className="nav-item user" aria-haspopup="menu" aria-expanded={menu} onClick={() => setMenu(!menu)}>
              <span className="avatar">{(user.name || user.email).slice(0, 1).toUpperCase()}</span>
              {!collapsed && <span className="user-name"><strong>{user.name || user.email}</strong><small>{user.email}</small></span>}
            </button>
            {menu && (
              <div className="menu" role="menu">
                <button type="button" role="menuitem" onClick={() => { setMenu(false); onNavigate('settings'); }}>Team settings</button>
                <hr />
                <button type="button" role="menuitem" className="danger" onClick={() => { setMenu(false); onLogout(); }}>Logout</button>
              </div>
            )}
          </div>
          <button type="button" className="nav-item collapse" title="Collapse/expand navigation" aria-label="Collapse/expand navigation"
            onClick={() => setCollapsed(!collapsed)}>
            <Icon name={collapsed ? 'expand' : 'collapse'} />
          </button>
        </div>
      </nav>
      <div className="page">{children}</div>
    </div>
  );
}

const PLANNED: Partial<Record<Page, string>> = {
  sessions: 'Client sessions: browser session replay linked to traces.',
  'service-map': 'Service map: services and the calls between them, from traces.',
};
