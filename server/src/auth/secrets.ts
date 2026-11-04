// Password hashing and bearer tokens. Only hashes are ever stored.

import { createHash, randomBytes, scrypt, timingSafeEqual } from 'node:crypto';

const N = 16384;
const R = 8;
const P = 1;
const KEYLEN = 32;

function scryptAsync(password: string, salt: Buffer, n: number, r: number, p: number): Promise<Buffer> {
  return new Promise((resolve, reject) =>
    scrypt(password, salt, KEYLEN, { N: n, r, p, maxmem: 64 * 1024 * 1024 }, (err, key) => (err ? reject(err) : resolve(key))));
}

/** "scrypt$N$r$p$salt$hash" with base64url salt and hash. */
export async function hashPassword(password: string): Promise<string> {
  const salt = randomBytes(16);
  const key = await scryptAsync(password, salt, N, R, P);
  return `scrypt$${N}$${R}$${P}$${salt.toString('base64url')}$${key.toString('base64url')}`;
}

export async function verifyPassword(password: string, stored: string): Promise<boolean> {
  const parts = stored.split('$');
  if (parts.length !== 6 || parts[0] !== 'scrypt') throw new Error('unrecognised password hash format');
  const [, n, r, p, salt, hash] = parts as [string, string, string, string, string, string];
  const want = Buffer.from(hash, 'base64url');
  const got = await scryptAsync(password, Buffer.from(salt, 'base64url'), Number(n), Number(r), Number(p));
  return got.length === want.length && timingSafeEqual(got, want);
}

/** A hash compared against when the user does not exist, so both paths cost the same. */
export const DUMMY_PASSWORD_HASH = await hashPassword(randomBytes(16).toString('hex'));

export const SESSION_PREFIX = 'dss';
export const API_KEY_PREFIX = 'dsk';

/** A random token like "dsk_<43 base64url chars>" (256 bits). */
export function newToken(prefix: string): string {
  return `${prefix}_${randomBytes(32).toString('base64url')}`;
}

export function tokenHash(token: string): Buffer {
  return createHash('sha256').update(token).digest();
}

export const MIN_PASSWORD_LENGTH = 8;
