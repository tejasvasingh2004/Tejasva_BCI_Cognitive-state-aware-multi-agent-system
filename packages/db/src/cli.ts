import { parseArgs } from 'node:util';
import { ALL_SCOPES, PASSWORD_MIN_LENGTH, Plan } from '@neuroflow/contracts';
import { authRepo } from './auth';
import { createPool } from './client';
import { migrate } from './migrate';
import { seedDev } from './seed';

const USAGE = `Usage:
  cli.ts migrate
  cli.ts seed
  cli.ts create-user --email <email> --name <display name> [--workspace <name>]   (password read from NEUROFLOW_PASSWORD)
  cli.ts set-password --email <email>                                           (password read from NEUROFLOW_PASSWORD)
  cli.ts create-api-key --email <email> --name <key name>                       (prints the key once)
  cli.ts set-plan --email <owner email> --plan <free|pro|team|enterprise>      (plan of the owner's workspaces)`;

const cmd = process.argv[2];
const { values } = parseArgs({
  args: process.argv.slice(3),
  options: { email: { type: 'string' }, name: { type: 'string' }, workspace: { type: 'string' }, plan: { type: 'string' } },
  strict: false,
});
const url = process.env.DATABASE_URL ?? 'postgres://neuroflow:neuroflow@localhost:5433/neuroflow';
const pool = createPool(url, { max: 2, applicationName: 'neuroflow-cli' });

function password(): string {
  // Taken from the environment so it never appears in shell history or process listings.
  const pw = process.env.NEUROFLOW_PASSWORD ?? '';
  if (pw.length < PASSWORD_MIN_LENGTH) throw new Error(`Set NEUROFLOW_PASSWORD (at least ${PASSWORD_MIN_LENGTH} characters).`);
  return pw;
}

function required(v: unknown, flag: string): string {
  if (typeof v !== 'string' || !v.trim()) throw new Error(`--${flag} is required\n\n${USAGE}`);
  return v.trim();
}

try {
  if (cmd === 'migrate') {
    const applied = await migrate(pool, process.env.MIGRATIONS_DIR);
    console.log(applied.length ? `Applied: ${applied.join(', ')}` : 'Database is up to date');
  } else if (cmd === 'seed') {
    const ids = await seedDev(pool, { apiKey: process.env.DEV_API_KEY });
    console.log(`Seeded dev user ${ids.userId} / workspace ${ids.workspaceId}`);
  } else if (cmd === 'create-user') {
    const email = required(values.email, 'email');
    const name = required(values.name, 'name');
    const pw = password();
    await migrate(pool, process.env.MIGRATIONS_DIR);
    const ids = await authRepo.ensureUserWithWorkspace(pool, {
      email,
      displayName: name,
      workspaceName: typeof values.workspace === 'string' ? values.workspace : `${name}'s workspace`,
    });
    await authRepo.setPassword(pool, ids.userId, pw);
    console.log(`User ${email} ready (user ${ids.userId}, workspace ${ids.workspaceId}).`);
  } else if (cmd === 'set-plan') {
    const email = required(values.email, 'email');
    const plan = Plan.parse(required(values.plan, 'plan'));
    const { rows } = await pool.query(
      'UPDATE workspaces SET plan = $2 WHERE owner_id = (SELECT id FROM users WHERE email = $1) RETURNING id, name',
      [email.toLowerCase(), plan],
    );
    if (!rows.length) throw new Error(`No workspaces owned by ${email}`);
    console.log(`Plan "${plan}" set for ${rows.map((r) => r.name).join(', ')}.`);
  } else if (cmd === 'set-password') {
    const email = required(values.email, 'email');
    const { rows } = await pool.query('SELECT id FROM users WHERE email = $1', [email.toLowerCase()]);
    if (!rows[0]) throw new Error(`No user ${email}`);
    await authRepo.setPassword(pool, rows[0].id, password());
    console.log(`Password updated for ${email}.`);
  } else if (cmd === 'create-api-key') {
    const email = required(values.email, 'email');
    const name = required(values.name, 'name');
    const { rows } = await pool.query(
      `SELECT u.id AS user_id, m.workspace_id FROM users u JOIN workspace_members m ON m.user_id = u.id
        WHERE u.email = $1 ORDER BY (m.role = 'owner') DESC LIMIT 1`,
      [email.toLowerCase()],
    );
    if (!rows[0]) throw new Error(`No user ${email} with a workspace`);
    const key = await authRepo.createApiKey(pool, {
      workspaceId: rows[0].workspace_id,
      userId: rows[0].user_id,
      name,
      scopes: ALL_SCOPES.filter((s) => s !== 'admin'),
    });
    console.log(`API key (shown once): ${key.key}`);
  } else {
    console.error(USAGE);
    process.exitCode = 1;
  }
} catch (err) {
  console.error(err instanceof Error ? err.message : err);
  process.exitCode = 1;
} finally {
  await pool.end();
}
