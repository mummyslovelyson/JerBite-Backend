import { Router } from 'express';
import { query } from '../config/db.js';
import { ah, HttpError } from '../utils/http.js';
import { auth, requireRole, approvedRider } from '../middleware/auth.js';
import { notify } from '../services/notify.js';
import { ORDER_SELECT } from '../lib/orderQuery.js';
import { parseLat, parseLng } from '../lib/geo.js';

const router = Router();
router.use(auth, requireRole('rider'));

router.patch('/profile', ah(async (req, res) => {
  const { rows } = await query(`UPDATE rider_profiles SET vehicle_type=$1, plate_number=$2 WHERE user_id=$3 RETURNING *`,
    [req.body.vehicleType || '', req.body.plateNumber || '', req.user.id]);
  res.json(rows[0]);
}));

router.use(approvedRider);

router.patch('/availability', ah(async (req, res) => {
  const { rows } = await query('UPDATE rider_profiles SET is_available=$1 WHERE user_id=$2 RETURNING is_available', [!!req.body.isAvailable, req.user.id]);
  res.json(rows[0]);
}));

router.post('/location', ah(async (req, res) => {
  const lat = parseLat(req.body.lat);
  const lng = parseLng(req.body.lng);
  if (lat === null || lng === null) throw new HttpError(400, 'Invalid location');
  await query(`INSERT INTO rider_locations(rider_id,lat,lng) VALUES($1,$2,$3)
               ON CONFLICT (rider_id) DO UPDATE SET lat=EXCLUDED.lat, lng=EXCLUDED.lng, updated_at=now()`, [req.user.id, lat, lng]);
  res.json({ ok: true });
}));

router.get('/available', ah(async (_req, res) =>
  res.json((await query(`${ORDER_SELECT} WHERE o.status='ready' AND o.rider_id IS NULL ORDER BY o.updated_at`)).rows)));

router.get('/orders', ah(async (req, res) =>
  res.json((await query(`${ORDER_SELECT} WHERE o.rider_id=$1 ORDER BY o.updated_at DESC LIMIT 200`, [req.user.id])).rows)));

// Atomic claim: only one rider can win
router.post('/orders/:id/accept', ah(async (req, res) => {
  const { rows } = await query(
    `UPDATE orders SET rider_id=$1, updated_at=now() WHERE id=$2 AND status='ready' AND rider_id IS NULL RETURNING *`,
    [req.user.id, req.params.id]);
  if (!rows[0]) throw new HttpError(409, 'Another rider already took this delivery');
  await notify(rows[0].customer_id, 'Rider assigned', `${req.user.name} will deliver your order #${rows[0].id.slice(0, 8).toUpperCase()}.`);
  res.json({ ok: true });
}));

router.patch('/orders/:id/status', ah(async (req, res) => {
  const { status } = req.body;
  const o = (await query('SELECT * FROM orders WHERE id=$1 AND rider_id=$2', [req.params.id, req.user.id])).rows[0];
  if (!o) throw new HttpError(404, 'Delivery not found');
  const ok = (o.status === 'ready' && status === 'picked_up') || (o.status === 'picked_up' && status === 'delivered');
  if (!ok) throw new HttpError(400, 'That status change is not allowed');
  await query('UPDATE orders SET status=$1, updated_at=now() WHERE id=$2', [status, o.id]);
  const code = o.id.slice(0, 8).toUpperCase();
  await notify(o.customer_id, status === 'picked_up' ? 'Order on the way' : 'Order delivered',
    status === 'picked_up' ? `Your order #${code} has been picked up and is on its way.` : `Order #${code} was delivered. Enjoy your meal!`);
  if (status === 'delivered') {
    const r = (await query('SELECT owner_id FROM restaurants WHERE id=$1', [o.restaurant_id])).rows[0];
    await notify(r.owner_id, 'Order delivered', `Order #${code} was delivered to the customer.`, { sms: false });
  }
  res.json({ ok: true });
}));

router.get('/stats', ah(async (req, res) => {
  const { rows } = await query(
    `SELECT COUNT(*) FILTER (WHERE status='delivered')::int AS completed,
            COALESCE(SUM(delivery_fee) FILTER (WHERE status='delivered'),0)::float AS earnings,
            COUNT(*) FILTER (WHERE status IN ('ready','picked_up'))::int AS active,
            COALESCE(SUM(delivery_fee) FILTER (WHERE status='delivered' AND updated_at::date=current_date),0)::float AS today
     FROM orders WHERE rider_id=$1`, [req.user.id]);
  res.json(rows[0]);
}));

export default router;
