import app from './app.js';
import { env } from './config/env.js';
import { pool, query } from './config/db.js';

const server = app.listen(env.port, '0.0.0.0', () => console.log(`API running on http://localhost:${env.port}`));
const purge = () => query('SELECT purge_stale_data()').catch((e) => console.error('purge failed:', e.message));
purge();
const timer = setInterval(purge, 60 * 60 * 1000);
const stop = () => clearInterval(timer) || server.close(() => pool.end().then(() => process.exit(0)));
process.on('SIGINT', stop);
process.on('SIGTERM', stop);
