import { MESSAGES, SESSIONS, STEPS } from '../../lib/agents/pages.ts';
import type { Go } from '../../Root.tsx';
import { ComparePage } from './ComparePage.tsx';
import { SequencesPage } from './SequencesPage.tsx';
import { SessionPage } from './SessionPage.tsx';
import { TablePage } from './TablePage.tsx';

/** The Agent trajectories area: its table pages, the session page and the comparison opened from them, and Sequences. */
export function AgentsArea({ path, search, go }: { path: string; search: string; go: Go }) {
  const session = /^\/agents\/sessions\/([^/]+)$/.exec(path);
  if (session) {
    let id = session[1]!;
    try { id = decodeURIComponent(id); } catch { /* shown as written; the API refuses a bad id */ }
    return <SessionPage key={id} id={id} search={search} go={go} />;
  }
  if (path === '/agents/compare') return <ComparePage key={search} search={search} go={go} />;
  if (path === '/agents/sequences') return <SequencesPage search={search} go={go} />;
  const def = path === '/agents/steps' ? STEPS : path === '/agents/messages' ? MESSAGES : SESSIONS;
  return <TablePage key={def.name} def={def} search={search} go={go} />;
}
