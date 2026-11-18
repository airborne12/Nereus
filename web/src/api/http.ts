// The transport every API module shares: JSON requests, errors with their status, and the 401 hook.

export class ApiError extends Error {
  readonly status: number;
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

/** Called when any request answers 401, so the app can show the login page. */
let onUnauthorized: () => void = () => {};
export function setUnauthorizedHandler(f: () => void): void {
  onUnauthorized = f;
}

export async function parse<T>(res: Response): Promise<T> {
  // Only a body that is not JSON is tolerated; an abort while reading must stay an abort, or a
  // superseded request would "succeed" with an empty object.
  const body = await res.json().catch((e: unknown) => {
    if (e instanceof Error && e.name === 'AbortError') throw e;
    return {};
  });
  if (res.status === 401) onUnauthorized();
  if (!res.ok) throw new ApiError(res.status, body.error ?? `HTTP ${res.status}`);
  return body as T;
}

export async function get<T>(path: string, params: Record<string, string | number | undefined>, signal?: AbortSignal): Promise<T> {
  const qs = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) if (v !== undefined) qs.set(k, String(v));
  return parse<T>(await fetch(`${path}?${qs}`, { signal }));
}

/** A GET whose query may repeat a parameter. */
export async function getQuery<T>(path: string, query: URLSearchParams, signal?: AbortSignal): Promise<T> {
  const qs = query.toString();
  return parse<T>(await fetch(qs ? `${path}?${qs}` : path, { signal }));
}

export async function send<T>(method: 'POST' | 'DELETE', path: string, body?: unknown): Promise<T> {
  return parse<T>(await fetch(path, {
    method,
    headers: body === undefined ? {} : { 'content-type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  }));
}

/** Passes a successful response through; an error answer becomes an ApiError with the server's message. */
export async function ensureOk(res: Response): Promise<Response> {
  if (res.ok) return res;
  if (res.status === 401) onUnauthorized();
  const body = await res.json().catch(() => ({}));
  throw new ApiError(res.status, body.error ?? `HTTP ${res.status}`);
}
