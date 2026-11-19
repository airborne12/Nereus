import type { Statement } from '../../api/agents.ts';
import { CopyButton } from '../CopyButton.tsx';
import { Modal } from '../Modal.tsx';

/** One statement, read-only, with its own Copy button. */
export function SqlSection({ statement }: { statement: Statement }) {
  return (
    <section className="ag-stmt" aria-label={statement.title}>
      <h4><span>{statement.title}</span><CopyButton className="btn small" text={statement.sql}>Copy</CopyButton></h4>
      <pre className="sql" tabIndex={0}>{statement.sql}</pre>
    </section>
  );
}

/** "Generated SQL": the statements behind what the page shows now. */
export function SqlDialog({ statements, onClose }: { statements: Statement[]; onClose: () => void }) {
  return (
    <Modal title="Generated SQL" onClose={onClose} wide>
      <p className="muted small ag-dialog-note">The statements behind what this page shows now.</p>
      {statements.length === 0 && <p className="muted">Nothing has been read yet.</p>}
      {statements.map((s, i) => <SqlSection key={`${i}:${s.title}`} statement={s} />)}
    </Modal>
  );
}
