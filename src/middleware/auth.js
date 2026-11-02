import jwt from 'jsonwebtoken';
import { env } from '../config/env.js';
import { query } from '../config/db.js';
import { ah, HttpError } from '../utils/http.js';

export const signToken = (user) =>
  jwt.sign({ id: user.id, role: user.role }, env.jwtSecret, { expiresIn: env.jwtExpiresIn });

export const auth = ah(async (req, _res, next) => {
  const header = req.headers.authorization || '';
  const token = header.startsWith('Bearer ') ? header.slice(7) : null;
  if (!token) throw new HttpError(401, 'Please log in to continue');
  let payload;
  try { payload = jwt.verify(token, env.jwtSecret); }
  catch { throw new HttpError(401, 'Your session has expired. Please log in again'); }
  const { rows } = await query('SELECT id,name,email,phone,role,status,email_verified FROM users WHERE id=$1', [payload.id]);
  const user = rows[0];
  if (!user) throw new HttpError(401, 'Account not found');
  if (user.status === 'suspended') throw new HttpError(403, 'Your account has been suspended');
  req.user = user;
  next();
});

export const requireRole = (...roles) => (req, _res, next) =>
  roles.includes(req.user.role) ? next() : next(new HttpError(403, 'You do not have access to this resource'));

// Manager must own an APPROVED restaurant to use the dashboard
export const approvedRestaurant = ah(async (req, _res, next) => {
  const { rows } = await query('SELECT * FROM restaurants WHERE owner_id=$1', [req.user.id]);
  const r = rows[0];
  if (!r) throw new HttpError(403, 'Create your restaurant profile first', { code: 'NO_RESTAURANT' });
  if (r.status !== 'approved') throw new HttpError(403, 'Your restaurant is awaiting admin approval', { code: 'NOT_APPROVED', status: r.status });
  req.restaurant = r;
  next();
});

export const approvedRider = ah(async (req, _res, next) => {
  const { rows } = await query('SELECT * FROM rider_profiles WHERE user_id=$1', [req.user.id]);
  if (!rows[0] || rows[0].status !== 'approved') throw new HttpError(403, 'Your rider account is awaiting admin approval', { code: 'NOT_APPROVED' });
  req.rider = rows[0];
  next();
});
