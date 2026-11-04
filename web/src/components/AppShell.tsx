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

interface Props {
  page: Page;
  user: api.User;
  onNavigate: (p: Page) => void;
  onLogout: () => void;
  children: ReactNode;
}

/** Left navigation (collapsible to icons) and the page beside it. */
export function AppShell({ page, user, onNavigate, onLogout, children }: Props) {
  const [collapsed, setCollapsed] = useState(readCollapsed);
  const [menu, setMenu] = useState(false);
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
              <button type="button" className={`nav-item${page === it.page ? ' active' : ''}`} title={collapsed ? it.label : undefined}
                aria-current={page === it.page ? 'page' : undefined} onClick={() => onNavigate(it.page)}>
                <Icon name={it.icon} />
                {!collapsed && <span>{it.label}</span>}
                {!collapsed && it.beta && <span className="badge">Beta</span>}
              </button>
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
  saved: 'Saved searches, with tags and favorites, and alerts on a saved search.',
  chart: 'Chart explorer: time series, tables, numbers and more over logs, traces and metrics.',
  alerts: 'Alerts on saved searches and dashboard tiles, with webhook and Slack notifications.',
  sessions: 'Client sessions: browser session replay linked to traces.',
  'service-map': 'Service map: services and the calls between them, from traces.',
  dashboards: 'Dashboards: grids of chart tiles with filters and a shared time range.',
};

export function PlannedPage({ page }: { page: Page }) {
  return (
    <div className="planned">
      <h1>{ITEMS.find((i) => i.page === page)?.label}</h1>
      <p>{PLANNED[page]}</p>
      <p className="muted">Not built yet: planned for milestone M2 or M3. Search is available now.</p>
    </div>
  );
}
