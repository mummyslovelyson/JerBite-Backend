import { Router } from 'express';
import bcrypt from 'bcryptjs';
import { query } from '../config/db.js';
import { ah, HttpError, need } from '../utils/http.js';
import { auth } from '../middleware/auth.js';

const router = Router();
router.use(auth);

router.put('/profile', ah(async (req, res) => {
  need(req.body, ['name', 'phone']);
  const phone = req.body.phone.replace(/\s/g, '');
  if (!/^\+?[0-9]{9,15}$/.test(phone)) throw new HttpError(400, 'Enter a valid phone number with country code');
  const { rows } = await query(`UPDATE users SET name=$1, phone=$2 WHERE id=$3 RETURNING id,name,email,phone,role,status`,
    [req.body.name.trim(), phone, req.user.id]);
  res.json(rows[0]);
}));

router.put('/password', ah(async (req, res) => {
  need(req.body, ['currentPassword', 'newPassword']);
  if (req.body.newPassword.length < 8) throw new HttpError(400, 'New password must be at least 8 characters');
  const { rows } = await query('SELECT password_hash FROM users WHERE id=$1', [req.user.id]);
  if (!(await bcrypt.compare(req.body.currentPassword, rows[0].password_hash))) throw new HttpError(400, 'Current password is incorrect');
  await query('UPDATE users SET password_hash=$1 WHERE id=$2', [await bcrypt.hash(req.body.newPassword, 12), req.user.id]);
  res.json({ message: 'Password changed' });
}));

router.get('/addresses', ah(async (req, res) =>
  res.json((await query('SELECT * FROM addresses WHERE user_id=$1 ORDER BY label', [req.user.id])).rows)));
router.post('/addresses', ah(async (req, res) => {
  need(req.body, ['label', 'address']);
  const { rows } = await query('INSERT INTO addresses(user_id,label,address,city) VALUES($1,$2,$3,$4) RETURNING *',
    [req.user.id, req.body.label, req.body.address, req.body.city || '']);
  res.status(201).json(rows[0]);
}));
router.delete('/addresses/:id', ah(async (req, res) => {
  await query('DELETE FROM addresses WHERE id=$1 AND user_id=$2', [req.params.id, req.user.id]);
  res.json({ ok: true });
}));

router.get('/notifications', ah(async (req, res) =>
  res.json((await query('SELECT * FROM notifications WHERE user_id=$1 ORDER BY created_at DESC LIMIT 100', [req.user.id])).rows)));
router.patch('/notifications/read', ah(async (req, res) => {
  await query('UPDATE notifications SET is_read=true WHERE user_id=$1', [req.user.id]);
  res.json({ ok: true });
}));

export default router;
