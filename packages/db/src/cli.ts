import { createPool } from './client';
import { migrate } from './migrate';
import { seedDev } from './seed';

const cmd = process.argv[2];
const url = process.env.DATABASE_URL ?? 'postgres://neuroflow:neuroflow@localhost:5433/neuroflow';
const pool = createPool(url, { max: 2, applicationName: 'neuroflow-cli' });

try {
  if (cmd === 'migrate') {
    const applied = await migrate(pool, process.env.MIGRATIONS_DIR);
    console.log(applied.length ? `Applied: ${applied.join(', ')}` : 'Database is up to date');
  } else if (cmd === 'seed') {
    const ids = await seedDev(pool, { apiKey: process.env.DEV_API_KEY });
    console.log(`Seeded dev user ${ids.userId} / workspace ${ids.workspaceId}`);
  } else {
    console.error('Usage: cli.ts <migrate|seed>');
    process.exitCode = 1;
  }
} finally {
  await pool.end();
}
