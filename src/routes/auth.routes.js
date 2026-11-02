import { Router } from 'express';
import bcrypt from 'bcryptjs';
import crypto from 'crypto';
import rateLimit from 'express-rate-limit';
import { query } from '../config/db.js';
import { env } from '../config/env.js';
import { ah, HttpError, need } from '../utils/http.js';
import { auth, signToken } from '../middleware/auth.js';
import { sendEmail } from '../services/email.js';
import { sendSms } from '../services/sms.js';
import { logAudit, logAuthAlert } from '../services/audit.js';

const router = Router();
router.use(rateLimit({ windowMs: 15 * 60 * 1000, limit: 60, standardHeaders: true, legacyHeaders: false }));

const sha = (s) => crypto.createHash('sha256').update(s).digest('hex');
const clean = (u) => ({ id: u.id, name: u.name, email: u.email, phone: u.phone, role: u.role, status: u.status });

// One code, delivered to BOTH the user's email and phone.
async function issueOtp(user, purpose) {
  const { rows } = await query(
    `SELECT created_at FROM otp_codes WHERE user_id=$1 AND purpose=$2 ORDER BY created_at DESC LIMIT 1`, [user.id, purpose]);
  if (rows[0] && Date.now() - new Date(rows[0].created_at).getTime() < 60_000)
    throw new HttpError(429, 'Please wait a minute before requesting another code');
  const code = String(crypto.randomInt(100000, 1000000));
  await query(`DELETE FROM otp_codes WHERE user_id=$1 AND purpose=$2`, [user.id, purpose]);
  await query(`INSERT INTO otp_codes(user_id,purpose,code_hash,expires_at) VALUES($1,$2,$3, now() + interval '10 minutes')`,
    [user.id, purpose, sha(code)]);
  const text = `Your ${env.appName} ${purpose === 'reset' ? 'password reset' : 'verification'} code is ${code}. It expires in 10 minutes. Never share it with anyone.`;
  await Promise.allSettled([
    sendEmail(user.email, `${env.appName} ${purpose === 'reset' ? 'password reset' : 'verification'} code`, text),
    sendSms(user.phone, text)
  ]);
}

async function checkOtp(user, purpose, code) {
  const { rows } = await query(`SELECT * FROM otp_codes WHERE user_id=$1 AND purpose=$2`, [user.id, purpose]);
  const row = rows[0];
  if (!row || new Date(row.expires_at) < new Date()) throw new HttpError(400, 'This code has expired. Request a new one');
  if (row.attempts >= 5) throw new HttpError(429, 'Too many wrong attempts. Request a new code');
  if (sha(String(code).trim()) !== row.code_hash) {
    await query(`UPDATE otp_codes SET attempts=attempts+1 WHERE id=$1`, [row.id]);
    throw new HttpError(400, 'That code is not correct');
  }
  await query(`DELETE FROM otp_codes WHERE id=$1`, [row.id]);
}

const findByEmail = async (email) =>
  (await query('SELECT * FROM users WHERE email=$1', [String(email || '').toLowerCase().trim()])).rows[0];

router.post('/register', ah(async (req, res) => {
  need(req.body, ['name', 'email', 'phone', 'password']);
  const { name, phone, password, role = 'customer', vehicleType = '', plateNumber = '' } = req.body;
  const email = req.body.email.toLowerCase().trim();
  if (!['customer', 'manager', 'rider'].includes(role)) throw new HttpError(400, 'Invalid account type');
  if (password.length < 8) throw new HttpError(400, 'Password must be at least 8 characters');
  if (!/^\S+@\S+\.\S+$/.test(email)) throw new HttpError(400, 'Enter a valid email address');
  if (!/^\+?[0-9]{9,15}$/.test(phone.replace(/\s/g, ''))) throw new HttpError(400, 'Enter a valid phone number with country code');

  const existing = await findByEmail(email);
  if (existing && !existing.email_verified) {
    // allow unverified accounts to restart registration
    await query('DELETE FROM users WHERE id=$1', [existing.id]);
  } else if (existing) throw new HttpError(409, 'An account with this email already exists');

  const hash = await bcrypt.hash(password, 12);
  const { rows } = await query(
    `INSERT INTO users(name,email,phone,password_hash,role) VALUES($1,$2,$3,$4,$5) RETURNING *`,
    [name.trim(), email, phone.replace(/\s/g, ''), hash, role]);
  if (role === 'rider') await query(`INSERT INTO rider_profiles(user_id,vehicle_type,plate_number) VALUES($1,$2,$3)`, [rows[0].id, vehicleType, plateNumber]);
  await issueOtp(rows[0], 'verify');
  res.status(201).json({ message: 'Account created. Enter the code we sent to your email and phone.', email });
}));

router.post('/verify-otp', ah(async (req, res) => {
  need(req.body, ['email', 'code']);
  const user = await findByEmail(req.body.email);
  if (!user) throw new HttpError(404, 'Account not found');
  await checkOtp(user, 'verify', req.body.code);
  await query(`UPDATE users SET email_verified=true, phone_verified=true WHERE id=$1`, [user.id]);
  await logAuthAlert(user.id, null, 'email_phone_verified', 'Contact details verified', 'Your email address and phone number were successfully verified.', req);
  res.json({ token: signToken(user), user: clean(user) });
}));

router.post('/resend-otp', ah(async (req, res) => {
  const user = await findByEmail(req.body.email);
  if (user && !user.email_verified) await issueOtp(user, 'verify');
  res.json({ message: 'If the account exists, a new code has been sent.' });
}));

router.post('/login', ah(async (req, res) => {
  need(req.body, ['email', 'password']);
  const user = await findByEmail(req.body.email);
  if (!user || !(await bcrypt.compare(req.body.password, user.password_hash))) {
    if (user) {
      await logAuthAlert(user.id, null, 'failed_login', 'Failed login attempt', 'An unsuccessful login attempt was detected for your account.', req);
    }
    throw new HttpError(401, 'Incorrect email or password');
  }
  if (user.role === 'admin') {
    throw new HttpError(403, 'Administrator accounts cannot log in through the public user portal. Please sign in via the dedicated Admin Portal at /admin/login.');
  }
  if (user.status === 'suspended') throw new HttpError(403, 'Your account has been suspended. Contact support');
  if (!user.email_verified) {
    await issueOtp(user, 'verify').catch(() => {});
    throw new HttpError(403, 'Verify your account to continue. We sent you a new code', { code: 'NOT_VERIFIED', email: user.email });
  }

  let restId = null;
  if (user.role === 'manager') {
    const r = (await query('SELECT id FROM restaurants WHERE owner_id=$1', [user.id])).rows[0];
    restId = r?.id || null;
  }
  await logAuthAlert(user.id, restId, 'new_signin', 'Successful sign-in', `Signed in successfully from ${req.headers['user-agent']?.slice(0, 50) || 'browser'}.`, req);

  res.json({ token: signToken(user), user: clean(user) });
}));

// Dedicated Admin Login Endpoint
router.post('/admin-login', ah(async (req, res) => {
  need(req.body, ['email', 'password']);
  const user = await findByEmail(req.body.email);
  if (!user || user.role !== 'admin' || !(await bcrypt.compare(req.body.password, user.password_hash))) {
    if (user && user.role === 'admin') {
      await logAuthAlert(user.id, null, 'failed_admin_login', 'Failed admin login', 'An invalid password was entered at the Admin Portal.', req);
    }
    throw new HttpError(401, 'Invalid administrator credentials. Access restricted to authorized platform administrators.');
  }
  if (user.status === 'suspended') throw new HttpError(403, 'This administrator account is currently suspended');

  await logAuthAlert(user.id, null, 'admin_signin', 'Admin portal login', 'Administrator session initiated successfully.', req);
  await logAudit({ user, headers: req.headers, socket: req.socket }, 'login', 'admin_session', user.id, { email: user.email });

  res.json({ token: signToken(user), user: clean(user) });
}));

router.post('/forgot-password', ah(async (req, res) => {
  const user = await findByEmail(req.body.email);
  if (user) {
    await issueOtp(user, 'reset').catch((e) => { if (e.status === 429) throw e; });
    await logAuthAlert(user.id, null, 'password_reset_requested', 'Password reset requested', 'A password reset code was requested for your account.', req);
  }
  res.json({ message: 'If that email is registered, a reset code has been sent to your email and phone.' });
}));

router.post('/reset-password', ah(async (req, res) => {
  need(req.body, ['email', 'code', 'newPassword']);
  if (req.body.newPassword.length < 8) throw new HttpError(400, 'Password must be at least 8 characters');
  const user = await findByEmail(req.body.email);
  if (!user) throw new HttpError(400, 'That code is not correct');
  await checkOtp(user, 'reset', req.body.code);
  await query('UPDATE users SET password_hash=$1 WHERE id=$2', [await bcrypt.hash(req.body.newPassword, 12), user.id]);
  await logAuthAlert(user.id, null, 'password_changed', 'Password changed successfully', 'Your account password has been updated.', req);
  res.json({ message: 'Password updated. You can log in now.' });
}));

router.get('/me', auth, ah(async (req, res) => {
  const out = { user: clean(req.user) };
  if (req.user.role === 'manager')
    out.restaurant = (await query('SELECT * FROM restaurants WHERE owner_id=$1', [req.user.id])).rows[0] || null;
  if (req.user.role === 'rider')
    out.rider = (await query('SELECT * FROM rider_profiles WHERE user_id=$1', [req.user.id])).rows[0] || null;
  res.json(out);
}));

export default router;
