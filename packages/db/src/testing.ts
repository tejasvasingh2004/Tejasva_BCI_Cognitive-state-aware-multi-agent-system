import { randomBytes } from 'node:crypto';
import pg from 'pg';
import { createPool } from './client';
import { migrate } from './migrate';

/**
 * Creates an isolated, migrated database for integration tests and drops it afterwards.
 * Uses TEST_DATABASE_URL (a server-level URL) or the local docker-compose Postgres.
 */
export async function createTestDatabase(): Promise<{ url: string; pool: pg.Pool; drop: () => Promise<void> }> {
  const base = new URL(process.env.TEST_DATABASE_URL ?? 'postgres://neuroflow:neuroflow@localhost:5433/neuroflow');
  const name = `nf_test_${randomBytes(4).toString('hex')}`;
  const admin = new pg.Client({ connectionString: base.toString() });
  await admin.connect();
  await admin.query(`CREATE DATABASE ${name}`);
  await admin.end();

  const url = new URL(base);
  url.pathname = `/${name}`;
  const pool = createPool(url.toString(), { max: 5, applicationName: 'neuroflow-test' });
  await migrate(pool);

  return {
    url: url.toString(),
    pool,
    async drop() {
      await pool.end();
      const c = new pg.Client({ connectionString: base.toString() });
      await c.connect();
      await c.query(`DROP DATABASE IF EXISTS ${name} WITH (FORCE)`);
      await c.end();
    },
  };
}

export async function isPostgresReachable(): Promise<boolean> {
  const c = new pg.Client({
    connectionString: process.env.TEST_DATABASE_URL ?? 'postgres://neuroflow:neuroflow@localhost:5433/neuroflow',
    connectionTimeoutMillis: 1500,
  });
  try {
    await c.connect();
    await c.end();
    return true;
  } catch {
    return false;
  }
}
