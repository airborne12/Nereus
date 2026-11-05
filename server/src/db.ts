// Doris connection pool. Every connection gets the session settings that compiled search
// queries depend on.

import mysql from 'mysql2/promise';

export interface DorisConfig {
  host: string;
  port: number;
  user: string;
  password: string;
  /** Seconds; Doris cancels a query that runs longer. */
  queryTimeout: number;
  connectionLimit: number;
}

export function configFromEnv(env: NodeJS.ProcessEnv = process.env): DorisConfig {
  return {
    host: env.DORIS_HOST ?? '127.0.0.1',
    port: Number(env.DORIS_PORT ?? 9030),
    user: env.DORIS_USER ?? 'root',
    password: env.DORIS_PASSWORD ?? '',
    queryTimeout: Number(env.DORIS_QUERY_TIMEOUT ?? 60),
    connectionLimit: Number(env.DORIS_POOL_SIZE ?? 10),
  };
}

export type Row = Record<string, unknown>;

const TEXT_TYPES = new Set(['VAR_STRING', 'STRING', 'BLOB', 'JSON']);

export class Doris {
  private pool: mysql.Pool;

  constructor(cfg: DorisConfig) {
    this.pool = mysql.createPool({
      host: cfg.host,
      port: cfg.port,
      user: cfg.user,
      password: cfg.password,
      connectionLimit: cfg.connectionLimit,
      // Doris labels result columns with the 3-byte utf8 charset, which mysql2 decodes as CESU-8 and
      // so garbles 4-byte characters (emoji, rare CJK). The bytes are UTF-8: decode them as such.
      typeCast: (field, next) => (TEXT_TYPES.has(field.type) ? field.string('utf8') : next()),
      // DATETIME(6) values stay strings in UTC, exactly as stored.
      dateStrings: true,
      supportBigNumbers: true,
      bigNumberStrings: true,
    });
    const timeout = Math.trunc(cfg.queryTimeout);
    this.pool.on('connection', (conn) => {
      // search() turns the BKD index-skip heuristic into an error, so disable it.
      // describe_extend_variant_column: DESC lists VARIANT sub-paths (field discovery).
      conn.query(`SET inverted_index_skip_threshold = 0, query_timeout = ${timeout}, describe_extend_variant_column = true`);
    });
  }

  async query(sql: string): Promise<Row[]> {
    const [rows] = await this.pool.query(sql);
    return rows as Row[];
  }

  async close(): Promise<void> {
    await this.pool.end();
  }
}
