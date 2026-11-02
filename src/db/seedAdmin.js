import bcrypt from 'bcryptjs';
import { pool } from '../config/db.js';

const { ADMIN_NAME, ADMIN_EMAIL, ADMIN_PHONE, ADMIN_PASSWORD } = process.env;
if (!ADMIN_NAME || !ADMIN_EMAIL || !ADMIN_PHONE || !ADMIN_PASSWORD) {
  console.error('Set ADMIN_NAME, ADMIN_EMAIL, ADMIN_PHONE and ADMIN_PASSWORD in .env first.');
  process.exit(1);
}
const hash = await bcrypt.hash(ADMIN_PASSWORD, 12);
await pool.query(
  `INSERT INTO users(name,email,phone,password_hash,role,email_verified,phone_verified)
   VALUES($1,$2,$3,$4,'admin',true,true)
   ON CONFLICT (email) DO UPDATE SET role='admin', password_hash=EXCLUDED.password_hash`,
  [ADMIN_NAME, ADMIN_EMAIL.toLowerCase(), ADMIN_PHONE, hash]
);
console.log(`Admin account ready for ${ADMIN_EMAIL}`);
await pool.end();
