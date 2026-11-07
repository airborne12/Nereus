import { type FormEvent, useState } from 'react';
import * as api from '../api.ts';

interface Props {
  /** setup: create the first admin account; login: sign in. */
  mode: 'setup' | 'login';
  onDone: (user: api.User) => void;
}

export function LoginPage({ mode, onDone }: Props) {
  const [email, setEmail] = useState('');
  const [name, setName] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function submit(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const r = mode === 'setup' ? await api.auth.setup(email, name, password) : await api.auth.login(email, password);
      onDone(r.user);
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="login">
      <form className="login-card" onSubmit={submit}>
        <h1>Nereus</h1>
        <p className="muted">
          {mode === 'setup' ? 'Create the first account. It becomes the administrator.' : 'Sign in to search your logs and traces.'}
        </p>
        <label>Email<input type="email" autoComplete="username" required value={email} onChange={(e) => setEmail(e.target.value)} /></label>
        {mode === 'setup' && <label>Name<input autoComplete="name" value={name} onChange={(e) => setName(e.target.value)} /></label>}
        <label>Password
          <input type="password" autoComplete={mode === 'setup' ? 'new-password' : 'current-password'} required
            minLength={mode === 'setup' ? 8 : undefined} value={password} onChange={(e) => setPassword(e.target.value)} />
        </label>
        {error && <div className="error" role="alert">{error}</div>}
        <button type="submit" className="btn primary" disabled={busy}>
          {mode === 'setup' ? 'Create admin account' : 'Sign in'}
        </button>
      </form>
    </div>
  );
}
