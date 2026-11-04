// Users, sessions and API keys in PostgreSQL.

import type pg from 'pg';
import {
  API_KEY_PREFIX, DUMMY_PASSWORD_HASH, MIN_PASSWORD_LENGTH, SESSION_PREFIX,
  hashPassword, newToken, tokenHash, verifyPassword,
} from './secrets.ts';

export type Role = 'admin' | 'member';

export interface User {
  id: number;
  email: string;
  name: string;
  role: Role;
  disabled: boolean;
}

export interface ApiKey {
  id: number;
  name: string;
  prefix: string;
  createdAt: string;
  lastUsedAt: string | null;
  revoked: boolean;
}

/** An error the HTTP layer answers with `status` and `message`. */
export class AuthError extends Error {
  readonly status: number;
  constructor(status: number, message: string) {
    super(message);
    this.name = 'AuthError';
    this.status = status;
  }
}

const SESSION_TTL_DAYS = 7;
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

function toUser(r: Record<string, unknown>): User {
  return { id: Number(r.id), email: String(r.email), name: String(r.name), role: r.role as Role, disabled: r.disabled_at !== null };
}

function checkNewUser(email: string, password: string, role: string): void {
  if (!EMAIL_RE.test(email) || email.length > 254) throw new AuthError(400, 'invalid email address');
  if (password.length < MIN_PASSWORD_LENGTH) throw new AuthError(400, `password must have at least ${MIN_PASSWORD_LENGTH} characters`);
  if (password.length > 1024) throw new AuthError(400, 'password is too long');
  if (role !== 'admin' && role !== 'member') throw new AuthError(400, "role must be 'admin' or 'member'");
}

export class AuthStore {
  private db: pg.Pool;
  constructor(db: pg.Pool) {
    this.db = db;
  }

  async userCount(): Promise<number> {
    return Number((await this.db.query('SELECT count(*) AS n FROM users')).rows[0].n);
  }

  private async insertUser(c: pg.Pool | pg.PoolClient, email: string, name: string, password: string, role: Role): Promise<User> {
    checkNewUser(email, password, role);
    try {
      const r = await c.query(
        'INSERT INTO users (email, name, password_hash, role) VALUES ($1, $2, $3, $4) RETURNING *',
        [email.trim(), name.trim(), await hashPassword(password), role]);
      return toUser(r.rows[0]);
    } catch (e) {
      if ((e as { code?: string }).code === '23505') throw new AuthError(409, 'a user with this email already exists');
      throw e;
    }
  }

  /** The first admin. Only works while there are no users; concurrent calls create one. */
  async setup(email: string, name: string, password: string): Promise<User> {
    const c = await this.db.connect();
    try {
      await c.query('BEGIN');
      await c.query('LOCK TABLE users IN EXCLUSIVE MODE');
      const n = Number((await c.query('SELECT count(*) AS n FROM users')).rows[0].n);
      if (n > 0) throw new AuthError(409, 'setup is already done');
      const u = await this.insertUser(c, email, name, password, 'admin');
      await c.query('COMMIT');
      return u;
    } catch (e) {
      await c.query('ROLLBACK');
      throw e;
    } finally {
      c.release();
    }
  }

  createUser(email: string, name: string, password: string, role: Role): Promise<User> {
    return this.insertUser(this.db, email, name, password, role);
  }

  async listUsers(): Promise<User[]> {
    return (await this.db.query('SELECT * FROM users ORDER BY id')).rows.map(toUser);
  }

  /** Disabling also ends the user's sessions; their API keys stop working while disabled. */
  async setDisabled(id: number, disabled: boolean): Promise<User> {
    const r = await this.db.query(
      'UPDATE users SET disabled_at = CASE WHEN $2 THEN coalesce(disabled_at, now()) ELSE NULL END WHERE id = $1 RETURNING *',
      [id, disabled]);
    if (r.rowCount === 0) throw new AuthError(404, 'no such user');
    if (disabled) await this.db.query('DELETE FROM sessions WHERE user_id = $1', [id]);
    return toUser(r.rows[0]);
  }

  /** Check a password; returns the user, or null for a wrong email/password or a disabled user. */
  async checkPassword(email: string, password: string): Promise<User | null> {
    const r = await this.db.query('SELECT * FROM users WHERE lower(email) = lower($1)', [email.trim()]);
    const row = r.rows[0];
    const ok = await verifyPassword(password, row ? row.password_hash : DUMMY_PASSWORD_HASH);
    if (!row || !ok || row.disabled_at !== null) return null;
    return toUser(row);
  }

  async createSession(userId: number): Promise<string> {
    const token = newToken(SESSION_PREFIX);
    await this.db.query(
      `INSERT INTO sessions (token_hash, user_id, expires_at) VALUES ($1, $2, now() + interval '${SESSION_TTL_DAYS} days')`,
      [tokenHash(token), userId]);
    return token;
  }

  async deleteSession(token: string): Promise<void> {
    await this.db.query('DELETE FROM sessions WHERE token_hash = $1', [tokenHash(token)]);
  }

  /** The user a session or API key token belongs to, or null if it is unknown, expired or revoked. */
  async userForToken(token: string): Promise<User | null> {
    if (token.startsWith(`${SESSION_PREFIX}_`)) {
      const r = await this.db.query(
        `SELECT u.* FROM sessions s JOIN users u ON u.id = s.user_id
         WHERE s.token_hash = $1 AND s.expires_at > now() AND u.disabled_at IS NULL`, [tokenHash(token)]);
      return r.rows[0] ? toUser(r.rows[0]) : null;
    }
    if (token.startsWith(`${API_KEY_PREFIX}_`)) {
      const r = await this.db.query(
        `SELECT u.*, k.id AS key_id, k.last_used_at < now() - interval '1 minute' OR k.last_used_at IS NULL AS stale
         FROM api_keys k JOIN users u ON u.id = k.user_id
         WHERE k.key_hash = $1 AND k.revoked_at IS NULL AND u.disabled_at IS NULL`, [tokenHash(token)]);
      const row = r.rows[0];
      if (!row) return null;
      // At most one write a minute per key, however often it is used.
      if (row.stale) await this.db.query('UPDATE api_keys SET last_used_at = now() WHERE id = $1', [row.key_id]);
      return toUser(row);
    }
    return null;
  }

  /** Returns the key itself; it is shown once and only its hash is kept. */
  async createApiKey(userId: number, name: string): Promise<{ key: string; apiKey: ApiKey }> {
    const clean = name.trim();
    if (clean.length === 0 || clean.length > 100) throw new AuthError(400, 'name must have 1 to 100 characters');
    const key = newToken(API_KEY_PREFIX);
    const r = await this.db.query(
      'INSERT INTO api_keys (user_id, name, prefix, key_hash) VALUES ($1, $2, $3, $4) RETURNING *',
      [userId, clean, key.slice(0, 12), tokenHash(key)]);
    return { key, apiKey: toApiKey(r.rows[0]) };
  }

  async listApiKeys(userId: number): Promise<ApiKey[]> {
    return (await this.db.query('SELECT * FROM api_keys WHERE user_id = $1 ORDER BY id DESC', [userId])).rows.map(toApiKey);
  }

  async revokeApiKey(userId: number, id: number): Promise<void> {
    const r = await this.db.query(
      'UPDATE api_keys SET revoked_at = coalesce(revoked_at, now()) WHERE id = $1 AND user_id = $2', [id, userId]);
    if (r.rowCount === 0) throw new AuthError(404, 'no such API key');
  }
}

function toApiKey(r: Record<string, unknown>): ApiKey {
  const iso = (v: unknown) => (v instanceof Date ? v.toISOString() : v === null ? null : String(v));
  return {
    id: Number(r.id), name: String(r.name), prefix: String(r.prefix),
    createdAt: iso(r.created_at)!, lastUsedAt: iso(r.last_used_at), revoked: r.revoked_at !== null,
  };
}
