// Stream Load into Doris over the BE HTTP port: JSON lines with a label per batch, so that a batch
// sent twice is loaded once.

export interface StreamLoadConfig { url: string; user: string; password: string }

export function streamLoadConfigFromEnv(env: NodeJS.ProcessEnv = process.env): StreamLoadConfig {
  return { url: env.DORIS_BE_HTTP_URL ?? 'http://127.0.0.1:8040', user: env.DORIS_USER ?? 'root', password: env.DORIS_PASSWORD ?? '' };
}

export type LoadOutcome = 'loaded' | 'already-loaded';

export class StreamLoadError extends Error {}

interface Answer { Status?: string; Message?: string; ExistingJobStatus?: string; ErrorURL?: string }

export async function streamLoad(cfg: StreamLoadConfig, db: string, table: string, label: string, rows: readonly object[],
  fetchImpl: typeof fetch = fetch): Promise<LoadOutcome> {
  if (!/^[A-Za-z0-9_:-]{1,128}$/.test(label)) throw new StreamLoadError(`invalid stream load label '${label}'`);
  const res = await fetchImpl(`${cfg.url}/api/${db}/${table}/_stream_load`, {
    method: 'PUT',
    headers: {
      authorization: `Basic ${Buffer.from(`${cfg.user}:${cfg.password}`).toString('base64')}`,
      label, format: 'json', read_json_by_line: 'true', strict_mode: 'true', max_filter_ratio: '0', 'content-type': 'application/json',
    },
    body: rows.map((r) => JSON.stringify(r)).join('\n') + '\n',
  });
  const answer = (await res.json()) as Answer;
  if (answer.Status === 'Success' || answer.Status === 'Publish Timeout') return 'loaded';
  if (answer.Status === 'Label Already Exists' && answer.ExistingJobStatus === 'FINISHED') return 'already-loaded';
  throw new StreamLoadError(`stream load into ${table} failed: ${answer.Status ?? res.status} ${answer.Message ?? ''} ${answer.ErrorURL ?? ''}`.trim());
}
