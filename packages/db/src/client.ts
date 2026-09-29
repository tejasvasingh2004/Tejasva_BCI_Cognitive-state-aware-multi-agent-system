import pg from 'pg';

export type Queryable = Pick<pg.Pool, 'query'> | pg.PoolClient;
export type Pool = pg.Pool;

export function createPool(connectionString: string, opts: { max?: number; applicationName?: string } = {}): pg.Pool {
  const pool = new pg.Pool({
    connectionString,
    max: opts.max ?? 10,
    application_name: opts.applicationName ?? 'neuroflow',
    idleTimeoutMillis: 30_000,
    connectionTimeoutMillis: 5_000,
    statement_timeout: 30_000,
  });
  // Idle client errors (e.g. DB restart) must not crash the process.
  pool.on('error', () => {});
  return pool;
}

export async function withTransaction<T>(pool: pg.Pool, fn: (client: pg.PoolClient) => Promise<T>): Promise<T> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const result = await fn(client);
    await client.query('COMMIT');
    return result;
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    throw err;
  } finally {
    client.release();
  }
}

export async function pingDb(pool: Queryable): Promise<boolean> {
  try {
    await pool.query('SELECT 1');
    return true;
  } catch {
    return false;
  }
}

export const iso = (d: Date | string | null | undefined): string | null =>
  d == null ? null : d instanceof Date ? d.toISOString() : new Date(d).toISOString();
