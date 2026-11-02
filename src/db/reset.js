import { pool } from '../config/db.js';

// DEVELOPMENT ONLY: wipes every table, then run `npm run migrate && npm run seed:admin` again.
if (process.env.NODE_ENV === 'production') {
  console.error('Refusing to reset a production database.');
  process.exit(1);
}
await pool.query('DROP SCHEMA public CASCADE; CREATE SCHEMA public;');
console.log('Database wiped. Now run: npm run migrate && npm run seed:admin');
await pool.end();
