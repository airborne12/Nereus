import { MESSAGES, SESSIONS, STEPS } from '../../lib/agents/pages.ts';
import type { Go } from '../../Root.tsx';
import { TablePage } from './TablePage.tsx';

/** The Agent trajectories area: its table pages. */
export function AgentsArea({ path, search, go }: { path: string; search: string; go: Go }) {
  const def = path === '/agents/steps' ? STEPS : path === '/agents/messages' ? MESSAGES : SESSIONS;
  return <TablePage key={def.name} def={def} search={search} go={go} />;
}
