import pg from 'pg';
import dotenv from 'dotenv';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

dotenv.config();
if (!process.env.DATABASE_URL) {
  dotenv.config({ path: path.join(__dirname, '../../.env') });
}

export const pool = new pg.Pool({
  connectionString: process.env.DATABASE_URL,
  max: 10,
  idleTimeoutMillis: 10000,
  connectionTimeoutMillis: 10000,
  keepAlive: true,
  keepAliveInitialDelayMillis: 10000
});

// Handle error on idle clients in the pool to prevent uncaught exceptions when Neon drops stale TCP sockets
pool.on('error', (err) => {
  console.warn('PostgreSQL idle client connection dropped or reset (handled safely):', err.message);
});

export async function query(text, params) {
  try {
    return await pool.query(text, params);
  } catch (err) {
    const isConnReset =
      err.code === 'ECONNRESET' ||
      err.code === '57P01' ||
      err.code === 'EPIPE' ||
      err.message?.includes('ECONNRESET') ||
      err.message?.includes('Connection terminated unexpectedly') ||
      err.message?.includes('closed unexpectedly');

    if (isConnReset) {
      console.warn('PostgreSQL connection reset by remote server, retrying query once...', err.message);
      return await pool.query(text, params);
    }
    throw err;
  }
}

export async function withTransaction(fn) {
  let client;
  let attempts = 0;
  while (attempts < 2) {
    attempts++;
    try {
      client = await pool.connect();
      break;
    } catch (err) {
      if (attempts >= 2) throw err;
      console.warn('Acquiring transaction client failed, retrying once...', err.message);
    }
  }

  try {
    await client.query('BEGIN');
    const out = await fn(client);
    await client.query('COMMIT');
    return out;
  } catch (e) {
    try { await client.query('ROLLBACK'); } catch {}
    throw e;
  } finally {
    if (client) client.release();
  }
}
