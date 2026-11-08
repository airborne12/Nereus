import { type FormEvent, useEffect, useState } from 'react';
import * as api from '../api.ts';
import { CopyButton } from './CopyButton.tsx';

function when(iso: string | null): string {
  return iso ? new Date(iso).toLocaleString() : 'never';
}

function ApiKeys() {
  const [keys, setKeys] = useState<api.ApiKey[]>([]);
  const [name, setName] = useState('');
  const [fresh, setFresh] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const load = () => api.auth.keys().then((r) => setKeys(r.keys), (e) => setError(e.message));
  useEffect(() => {
    load();
  }, []);

  async function create(e: FormEvent) {
    e.preventDefault();
    setError(null);
    try {
      const r = await api.auth.createKey(name);
      setFresh(r.key);
      setName('');
      await load();
    } catch (err) {
      setError((err as Error).message);
    }
  }

  return (
    <section className="card">
      <h2>API keys</h2>
      <p className="muted">Send a key as <code>Authorization: Bearer &lt;key&gt;</code> to call the API from scripts.</p>
      <form className="row" onSubmit={create}>
        <input aria-label="New key name" placeholder="Key name, e.g. ci" value={name} required onChange={(e) => setName(e.target.value)} />
        <button type="submit" className="btn primary">Create key</button>
      </form>
      {fresh && (
        <div className="fresh-key" role="status">
          <div>Copy this key now. It is not shown again.</div>
          <code data-testid="new-key">{fresh}</code>
          <CopyButton className="btn" text={fresh}>Copy</CopyButton>
        </div>
      )}
      {error && <div className="error" role="alert">{error}</div>}
      <table className="list">
        <thead><tr><th>Name</th><th>Key</th><th>Created</th><th>Last used</th><th /></tr></thead>
        <tbody>
          {keys.map((k) => (
            <tr key={k.id} className={k.revoked ? 'revoked' : ''}>
              <td>{k.name}</td>
              <td className="mono">{k.prefix}…</td>
              <td>{when(k.createdAt)}</td>
              <td>{when(k.lastUsedAt)}</td>
              <td>
                {k.revoked ? <span className="muted">revoked</span> : (
                  <button type="button" className="btn" aria-label={`Revoke ${k.name}`}
                    onClick={() => api.auth.revokeKey(k.id).then(load, (e) => setError(e.message))}>Revoke</button>
                )}
              </td>
            </tr>
          ))}
          {keys.length === 0 && <tr><td colSpan={5} className="muted">No keys yet.</td></tr>}
        </tbody>
      </table>
    </section>
  );
}

function Users({ me }: { me: api.User }) {
  const [users, setUsers] = useState<api.User[]>([]);
  const [form, setForm] = useState({ email: '', name: '', password: '', role: 'member' as 'admin' | 'member' });
  const [error, setError] = useState<string | null>(null);
  const load = () => api.auth.users().then((r) => setUsers(r.users), (e) => setError(e.message));
  useEffect(() => {
    load();
  }, []);

  async function create(e: FormEvent) {
    e.preventDefault();
    setError(null);
    try {
      await api.auth.createUser(form);
      setForm({ email: '', name: '', password: '', role: 'member' });
      await load();
    } catch (err) {
      setError((err as Error).message);
    }
  }

  return (
    <section className="card">
      <h2>Users</h2>
      <form className="row" onSubmit={create}>
        <input aria-label="New user email" type="email" placeholder="Email" required value={form.email}
          onChange={(e) => setForm({ ...form, email: e.target.value })} />
        <input aria-label="New user name" placeholder="Name" value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} />
        <input aria-label="New user password" type="password" placeholder="Initial password (8+ characters)" required minLength={8}
          autoComplete="new-password" value={form.password} onChange={(e) => setForm({ ...form, password: e.target.value })} />
        <select aria-label="New user role" value={form.role} onChange={(e) => setForm({ ...form, role: e.target.value as 'admin' | 'member' })}>
          <option value="member">member</option>
          <option value="admin">admin</option>
        </select>
        <button type="submit" className="btn primary">Add user</button>
      </form>
      {error && <div className="error" role="alert">{error}</div>}
      <table className="list">
        <thead><tr><th>Email</th><th>Name</th><th>Role</th><th>Status</th><th /></tr></thead>
        <tbody>
          {users.map((u) => (
            <tr key={u.id} className={u.disabled ? 'revoked' : ''}>
              <td>{u.email}</td>
              <td>{u.name}</td>
              <td>{u.role}</td>
              <td>{u.disabled ? 'disabled' : 'active'}</td>
              <td>
                {u.id !== me.id && (
                  <button type="button" className="btn" aria-label={`${u.disabled ? 'Enable' : 'Disable'} ${u.email}`}
                    onClick={() => api.auth.setDisabled(u.id, !u.disabled).then(load, (e) => setError(e.message))}>
                    {u.disabled ? 'Enable' : 'Disable'}
                  </button>
                )}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </section>
  );
}

function Webhooks() {
  const [hooks, setHooks] = useState<api.Webhook[]>([]);
  const [name, setName] = useState('');
  const [url, setUrl] = useState('');
  const [note, setNote] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const load = () => api.content.webhooks().then((r) => setHooks(r.items), (e) => setError(e.message));
  useEffect(() => { load(); }, []);
  async function create(e: FormEvent) {
    e.preventDefault();
    setError(null);
    try {
      await api.content.createWebhook(name, url);
      setName('');
      setUrl('');
      await load();
    } catch (err) {
      setError((err as Error).message);
    }
  }
  return (
    <section className="card">
      <h2>Webhooks</h2>
      <p className="muted">Alerts post JSON with a Slack-compatible <code>text</code> field. A Slack incoming-webhook URL works as is.</p>
      <form className="row" onSubmit={create}>
        <input aria-label="Webhook name" placeholder="Name, e.g. #oncall" required value={name} onChange={(e) => setName(e.target.value)} />
        <input aria-label="Webhook URL" placeholder="https://hooks.slack.com/services/…" required value={url} onChange={(e) => setUrl(e.target.value)} />
        <button type="submit" className="btn primary">Add webhook</button>
      </form>
      {error && <div className="error" role="alert">{error}</div>}
      {note && <div className="muted small" role="status">{note}</div>}
      <table className="list">
        <thead><tr><th>Name</th><th>URL</th><th /></tr></thead>
        <tbody>
          {hooks.map((h) => (
            <tr key={h.id}>
              <td>{h.name}</td>
              <td className="mono small">{h.url}</td>
              <td>
                <button type="button" className="btn small" onClick={() => api.content.testWebhook(h.id).then(() => setNote(`Test message sent to ${h.name}.`), (e) => setError(e.message))}>Send test</button>{' '}
                <button type="button" className="btn small" aria-label={`Delete webhook ${h.name}`} onClick={() => api.content.deleteWebhook(h.id).then(load, (e) => setError(e.message))}>Delete</button>
              </td>
            </tr>
          ))}
          {hooks.length === 0 && <tr><td colSpan={3} className="muted">No webhooks yet.</td></tr>}
        </tbody>
      </table>
    </section>
  );
}

/** Keys for the browser SDK: they only write session data, so they can sit in public pages. */
function IngestKeys() {
  const [keys, setKeys] = useState<api.IngestKey[]>([]);
  const [name, setName] = useState('');
  const [created, setCreated] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const load = () => api.ingestKeys.list().then((r) => setKeys(r.keys), (e) => setError(e.message));
  useEffect(() => { load(); }, []);
  async function create(e: FormEvent) {
    e.preventDefault();
    setError(null);
    try {
      setCreated((await api.ingestKeys.create(name)).key);
      setName('');
      await load();
    } catch (err) {
      setError((err as Error).message);
    }
  }
  return (
    <section className="card">
      <h2>Ingestion keys</h2>
      <p className="muted">For the browser SDK (Client sessions). An ingestion key can only send session data, never read anything, so it is safe in a web page. Anyone who has it can send data, so revoke it when it leaks into the wrong place.</p>
      <form className="row" onSubmit={create}>
        <input aria-label="Ingestion key name" placeholder="Name, e.g. shop website" required value={name} onChange={(e) => setName(e.target.value)} />
        <button type="submit" className="btn primary">Create ingestion key</button>
      </form>
      {created && (
        <div className="key-shown" role="status">
          <span className="small">Copy it now; it is shown once:</span> <code data-testid="new-ingest-key">{created}</code>
          <pre className="sql">{`<script src="${window.location.origin}/sdk/nereus-rum.js"></script>
<script>
  NereusRUM.init({ url: '${window.location.origin}', apiKey: '${created}', service: 'my-site' });
</script>`}</pre>
        </div>
      )}
      {error && <div className="error" role="alert">{error}</div>}
      <table className="list">
        <thead><tr><th>Name</th><th>Key</th><th>Created</th><th>Last used</th><th /></tr></thead>
        <tbody>
          {keys.map((k) => (
            <tr key={k.id} className={k.revoked ? 'muted' : ''}>
              <td>{k.name}</td>
              <td className="mono small">{k.prefix}…</td>
              <td className="small">{k.createdBy ?? ''} {new Date(k.createdAt).toLocaleDateString()}</td>
              <td className="small">{k.lastUsedAt ? new Date(k.lastUsedAt).toLocaleString() : 'never'}</td>
              <td>{k.revoked ? 'revoked' : <button type="button" className="btn small" aria-label={`Revoke ingestion key ${k.name}`} onClick={() => api.ingestKeys.revoke(k.id).then(load, (e) => setError(e.message))}>Revoke</button>}</td>
            </tr>
          ))}
          {keys.length === 0 && <tr><td colSpan={5} className="muted">No ingestion keys yet.</td></tr>}
        </tbody>
      </table>
    </section>
  );
}

export function SettingsPage({ me }: { me: api.User }) {
  return (
    <div className="settings">
      <ApiKeys />
      {me.role === 'admin' && <Webhooks />}
      {me.role === 'admin' && <IngestKeys />}
      {me.role === 'admin' && <Users me={me} />}
    </div>
  );
}
