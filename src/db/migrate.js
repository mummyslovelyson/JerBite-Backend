import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { pool } from '../config/db.js';

// Usage: node migrate.js [status]
// Applies every migrations/NNN_name.sql that has not run yet, in order, each in its own transaction.
const dir = path.join(path.dirname(fileURLToPath(import.meta.url)), 'migrations');
const statusOnly = process.argv[2] === 'status';
const files = fs.readdirSync(dir).filter((f) => /^\d+_.+\.sql$/.test(f)).sort();

const client = await pool.connect();
try {
  await client.query('SELECT pg_advisory_lock(727274)'); // stops two deploys migrating at once
  await client.query(`CREATE TABLE IF NOT EXISTS schema_migrations (name TEXT PRIMARY KEY, applied_at TIMESTAMPTZ NOT NULL DEFAULT now())`);
  const done = new Set((await client.query('SELECT name FROM schema_migrations')).rows.map((r) => r.name));

  if (statusOnly) {
    files.forEach((f) => console.log(`${done.has(f) ? 'applied ' : 'PENDING '} ${f}`));
  } else {
    let ran = 0;
    for (const f of files) {
      if (done.has(f)) continue;
      console.log(`Applying ${f} ...`);
      try {
        await client.query('BEGIN');
        await client.query(fs.readFileSync(path.join(dir, f), 'utf8'));
        await client.query('INSERT INTO schema_migrations(name) VALUES($1)', [f]);
        await client.query('COMMIT');
        ran++;
      } catch (e) {
        await client.query('ROLLBACK');
        throw new Error(`${f} failed: ${e.message}`);
      }
    }
    console.log(ran ? `Done. ${ran} migration(s) applied.` : 'Database is already up to date.');
  }
} catch (e) {
  console.error(e.message);
  process.exitCode = 1;
} finally {
  await client.query('SELECT pg_advisory_unlock(727274)').catch(() => {});
  client.release();
  await pool.end();
}
