import { Router } from 'express';
import { query, withTransaction } from '../config/db.js';
import { env } from '../config/env.js';
import { ah, HttpError, need } from '../utils/http.js';
import { auth, requireRole } from '../middleware/auth.js';
import { initializePayment, verifyPayment, newReference, validWebhookSignature } from '../services/payment.js';
import { notify } from '../services/notify.js';
import { ORDER_SELECT } from '../lib/orderQuery.js';
import { getSettings } from '../lib/settings.js';
import { distanceKm, parseLat, parseLng } from '../lib/geo.js';

export const orders = Router();
export const payments = Router();

const short = (id) => String(id).slice(0, 8).toUpperCase();

export async function markPaid(orderId) {
  const { commissionPercent } = await getSettings();
  const { rows } = await query(
    `UPDATE orders SET payment_status='paid', status='placed',
       commission_amount = round(subtotal * $2::numeric / 100, 2),
       restaurant_payout = subtotal - round(subtotal * $2::numeric / 100, 2)
     WHERE id=$1 AND payment_status='unpaid' RETURNING *`, [orderId, commissionPercent]);
  const o = rows[0];
  if (!o) return null;
  await query(`UPDATE payments SET status='success', paid_at=now() WHERE reference=$1`, [o.payment_reference]);
  const r = (await query('SELECT owner_id,name FROM restaurants WHERE id=$1', [o.restaurant_id])).rows[0];
  await notify(o.customer_id, 'Payment received', `Order #${short(o.id)} is confirmed and sent to ${r.name}.`);
  await notify(r.owner_id, 'New order', `Order #${short(o.id)} just came in. Open your dashboard to accept it.`);
  return o;
}

async function startPayment(order, email) {
  const reference = newReference();
  await query('UPDATE orders SET payment_reference=$1 WHERE id=$2', [reference, order.id]);
  await query('INSERT INTO payments(order_id,reference,amount,currency) VALUES($1,$2,$3,$4)', [order.id, reference, order.total, env.currency]);
  try {
    const data = await initializePayment({
      email, amount: Number(order.total), reference,
      callbackUrl: `${env.clientUrl}/account/orders/${order.id}`
    });
    return data.authorization_url;
  } catch (e) {
    await query(`UPDATE payments SET status='failed' WHERE reference=$1`, [reference]);
    throw e;
  }
}

orders.use(auth, requireRole('customer'));

orders.post('/', ah(async (req, res) => {
  need(req.body, ['restaurantId', 'address', 'phone']);
  const { restaurantId, items, address, phone, notes = '' } = req.body;
  if (!Array.isArray(items) || !items.length) throw new HttpError(400, 'Your cart is empty');
  const settings = await getSettings();
  if (!settings.platformOpen) throw new HttpError(503, 'Ordering is paused right now. Please try again later');
  const lat = parseLat(req.body.latitude);
  const lng = parseLng(req.body.longitude);

  const r = (await query(`SELECT * FROM restaurants WHERE id=$1 AND status='approved'`, [restaurantId])).rows[0];
  if (!r) throw new HttpError(404, 'Restaurant not found');
  if (!r.is_open) throw new HttpError(400, `${r.name} is closed right now`);
  if (r.latitude !== null) {
    if (lat === null || lng === null)
      throw new HttpError(400, 'Share your location so we can check that this restaurant delivers to you', { code: 'NEED_LOCATION' });
    const km = distanceKm(Number(r.latitude), Number(r.longitude), lat, lng);
    if (km > settings.deliveryRadiusKm)
      throw new HttpError(400, `You are ${km.toFixed(1)} km from ${r.name}. We deliver within ${settings.deliveryRadiusKm} km`);
  }

  const prods = (await query(
    `SELECT * FROM products WHERE id = ANY($1::uuid[]) AND restaurant_id=$2 AND status='approved' AND is_available`,
    [items.map((i) => i.productId), restaurantId])).rows;
  const byId = new Map(prods.map((p) => [p.id, p]));
  let subtotal = 0;
  const lines = items.map((i) => {
    const p = byId.get(i.productId); const qty = parseInt(i.quantity, 10);
    if (!p || !(qty > 0 && qty <= 50)) throw new HttpError(400, 'One of the items in your cart is no longer available');
    subtotal += Number(p.price) * qty;
    return { p, qty };
  });
  if (subtotal < Number(r.min_order)) throw new HttpError(400, `Minimum order for ${r.name} is ${r.min_order}`);
  const deliveryFee = Number(r.delivery_fee);

  const order = await withTransaction(async (c) => {
    const o = (await c.query(
      `INSERT INTO orders(customer_id,restaurant_id,subtotal,delivery_fee,total,delivery_address,delivery_phone,notes,delivery_lat,delivery_lng)
       VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) RETURNING *`,
      [req.user.id, restaurantId, subtotal, deliveryFee, subtotal + deliveryFee, address, phone, notes, lat, lng])).rows[0];
    for (const { p, qty } of lines)
      await c.query('INSERT INTO order_items(order_id,product_id,name,price,quantity) VALUES($1,$2,$3,$4,$5)', [o.id, p.id, p.name, p.price, qty]);
    return o;
  });
  const paymentUrl = await startPayment(order, req.user.email);
  res.status(201).json({ orderId: order.id, paymentUrl });
}));

orders.get('/', ah(async (req, res) =>
  res.json((await query(`${ORDER_SELECT} WHERE o.customer_id=$1 ORDER BY o.created_at DESC`, [req.user.id])).rows)));

orders.get('/:id', ah(async (req, res) => {
  const o = (await query(`${ORDER_SELECT} WHERE o.id=$1 AND o.customer_id=$2`, [req.params.id, req.user.id])).rows[0];
  if (!o) throw new HttpError(404, 'Order not found');
  res.json(o);
}));

orders.post('/:id/pay', ah(async (req, res) => {
  const o = (await query(`SELECT * FROM orders WHERE id=$1 AND customer_id=$2 AND payment_status='unpaid' AND status='pending_payment'`,
    [req.params.id, req.user.id])).rows[0];
  if (!o) throw new HttpError(400, 'This order cannot be paid for');
  res.json({ paymentUrl: await startPayment(o, req.user.email) });
}));

orders.post('/:id/cancel', ah(async (req, res) => {
  const o = (await query('SELECT * FROM orders WHERE id=$1 AND customer_id=$2', [req.params.id, req.user.id])).rows[0];
  if (!o) throw new HttpError(404, 'Order not found');
  if (!['pending_payment', 'placed'].includes(o.status)) throw new HttpError(400, 'The restaurant already accepted this order, so it can no longer be cancelled');
  await query(`UPDATE orders SET status='cancelled', payment_status = CASE WHEN payment_status='paid' THEN 'refund_pending' ELSE payment_status END, updated_at=now() WHERE id=$1`, [o.id]);
  if (o.payment_status === 'paid') {
    const r = (await query('SELECT owner_id FROM restaurants WHERE id=$1', [o.restaurant_id])).rows[0];
    await notify(r.owner_id, 'Order cancelled', `The customer cancelled order #${short(o.id)}.`);
  }
  res.json({ ok: true });
}));

// ---- Payments ----
// Called by the frontend after Paystack redirects back
payments.post('/verify', auth, ah(async (req, res) => {
  need(req.body, ['reference']);
  const o = (await query('SELECT * FROM orders WHERE payment_reference=$1 AND customer_id=$2', [req.body.reference, req.user.id])).rows[0];
  if (!o) throw new HttpError(404, 'Payment reference not found');
  if (o.payment_status === 'paid') return res.json({ paid: true });
  const data = await verifyPayment(req.body.reference);
  const ok = data && data.status === 'success' && data.amount === Math.round(Number(o.total) * 100);
  if (ok) await markPaid(o.id);
  res.json({ paid: !!ok });
}));

// Paystack webhook: set this URL in your Paystack dashboard -> {API_URL}/api/payments/webhook
payments.post('/webhook', ah(async (req, res) => {
  if (!validWebhookSignature(req.rawBody, req.headers['x-paystack-signature'])) return res.sendStatus(401);
  const evt = req.body;
  if (evt.event === 'charge.success') {
    const o = (await query('SELECT * FROM orders WHERE payment_reference=$1', [evt.data.reference])).rows[0];
    if (o && evt.data.amount === Math.round(Number(o.total) * 100)) await markPaid(o.id);
  }
  res.sendStatus(200);
}));
