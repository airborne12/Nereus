import { MESSAGES, RISKS, SESSIONS, STEPS } from '../../lib/agents/pages.ts';
import type { Go } from '../../Root.tsx';
import { ComparePage } from './ComparePage.tsx';
import { JudgeForm } from './JudgeForm.tsx';
import { JudgePage } from './JudgePage.tsx';
import { JudgesPage } from './JudgesPage.tsx';
import { SequencesPage } from './SequencesPage.tsx';
import { SessionPage } from './SessionPage.tsx';
import { TablePage } from './TablePage.tsx';

/** The Agent trajectories area: its table pages, the session page and the comparison opened from them, Sequences and Judges. */
/** `admin`: whether the user may use the actions that spend model tokens; the server checks it again. */
export function AgentsArea({ path, search, go, admin }: { path: string; search: string; go: Go; admin: boolean }) {
  const session = /^\/agents\/sessions\/([^/]+)$/.exec(path);
  if (session) {
    let id = session[1]!;
    try { id = decodeURIComponent(id); } catch { /* shown as written; the API refuses a bad id */ }
    return <SessionPage key={id} id={id} search={search} go={go} />;
  }
  if (path === '/agents/compare') return <ComparePage key={search} search={search} go={go} />;
  if (path === '/agents/sequences') return <SequencesPage search={search} go={go} />;
  if (path === '/agents/judges') return <JudgesPage go={go} admin={admin} />;
  if (path === '/agents/judges/new') return <JudgeForm go={go} admin={admin} />;
  const judge = /^\/agents\/judges\/([^/]+)$/.exec(path);
  if (judge) {
    let id = judge[1]!;
    try { id = decodeURIComponent(id); } catch { /* shown as written; the API answers 404 */ }
    return <JudgePage key={id} id={id} search={search} go={go} admin={admin} />;
  }
  const def = path === '/agents/steps' ? STEPS : path === '/agents/messages' ? MESSAGES : path === '/agents/risks' ? RISKS : SESSIONS;
  return <TablePage key={def.name} def={def} search={search} go={go} />;
}
