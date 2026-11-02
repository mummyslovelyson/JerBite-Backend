import { Router } from 'express';
import { query } from '../config/db.js';
import { ah, HttpError, need } from '../utils/http.js';
import { auth, requireRole, approvedRestaurant } from '../middleware/auth.js';
import { upload, fileUrl } from '../middleware/upload.js';
import { notify } from '../services/notify.js';
import { ORDER_SELECT } from '../lib/orderQuery.js';
import { parseLat, parseLng } from '../lib/geo.js';

const router = Router();
router.use(auth, requireRole('manager'));

const imgs = upload.fields([{ name: 'logo', maxCount: 1 }, { name: 'cover', maxCount: 1 }]);
const num = (v, d = 0) => (v === undefined || v === '' ? d : Number(v));
const t = (v) => (v === '' || v === undefined ? null : v);
const lat = (v) => parseLat(v);
const lng = (v) => parseLng(v);

// ---- Restaurant profile (available before approval) ----
router.get('/restaurant', ah(async (req, res) =>
  res.json((await query('SELECT * FROM restaurants WHERE owner_id=$1', [req.user.id])).rows[0] || null)));

router.post('/restaurant', imgs, ah(async (req, res) => {
  need(req.body, ['name', 'description', 'phone', 'address', 'city']);
  const b = req.body;
  const { rows } = await query(
    `INSERT INTO restaurants(owner_id,name,description,cuisine,phone,email,address,city,logo_url,cover_url,opening_time,closing_time,delivery_fee,min_order,prep_time_minutes,latitude,longitude)
     VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17) RETURNING *`,
    [req.user.id, b.name, b.description, b.cuisine || '', b.phone, b.email || req.user.email, b.address, b.city,
     fileUrl(req.files?.logo?.[0]) || null, fileUrl(req.files?.cover?.[0]) || null,
     t(b.openingTime), t(b.closingTime), num(b.deliveryFee), num(b.minOrder), num(b.prepTime, 30), lat(b.latitude), lng(b.longitude)]);
  const admins = (await query(`SELECT id FROM users WHERE role='admin'`)).rows;
  for (const a of admins) await notify(a.id, 'Restaurant awaiting approval', `${b.name} submitted a new restaurant for review.`, { sms: false });
  res.status(201).json(rows[0]);
}));

router.put('/restaurant', imgs, ah(async (req, res) => {
  const b = req.body;
  need(b, ['name', 'description', 'phone', 'address', 'city']);
  const cur = (await query('SELECT * FROM restaurants WHERE owner_id=$1', [req.user.id])).rows[0];
  if (!cur) throw new HttpError(404, 'Create your restaurant profile first');
  // a rejected restaurant goes back into the review queue after edits
  const { rows } = await query(
    `UPDATE restaurants SET name=$1,description=$2,cuisine=$3,phone=$4,email=$5,address=$6,city=$7,
       logo_url=COALESCE($8,logo_url),cover_url=COALESCE($9,cover_url),opening_time=$10,closing_time=$11,
       delivery_fee=$12,min_order=$13,prep_time_minutes=$14,latitude=$15,longitude=$16,
       status=CASE WHEN status='rejected' THEN 'pending' ELSE status END
     WHERE owner_id=$17 RETURNING *`,
    [b.name, b.description, b.cuisine || '', b.phone, b.email || '', b.address, b.city,
     fileUrl(req.files?.logo?.[0]) || null, fileUrl(req.files?.cover?.[0]) || null,
     t(b.openingTime), t(b.closingTime), num(b.deliveryFee), num(b.minOrder), num(b.prepTime, 30), lat(b.latitude), lng(b.longitude), req.user.id]);
  res.json(rows[0]);
}));

// everything below needs an approved restaurant
router.use(approvedRestaurant);

router.patch('/restaurant/open', ah(async (req, res) => {
  const { rows } = await query('UPDATE restaurants SET is_open=$1 WHERE id=$2 RETURNING is_open', [!!req.body.isOpen, req.restaurant.id]);
  res.json(rows[0]);
}));

// ---- Categories ----
router.get('/categories', ah(async (req, res) => {
  const { rows } = await query(
    `SELECT c.*, COUNT(p.id)::int AS product_count 
     FROM categories c 
     LEFT JOIN products p ON p.category_id=c.id 
     WHERE c.restaurant_id=$1 
     GROUP BY c.id 
     ORDER BY c.name`,
    [req.restaurant.id]
  );
  res.json(rows);
}));

router.post('/categories', ah(async (req, res) => {
  need(req.body, ['name']);
  res.status(201).json((await query('INSERT INTO categories(restaurant_id,name) VALUES($1,$2) RETURNING *', [req.restaurant.id, req.body.name.trim()])).rows[0]);
}));

router.put('/categories/:id', ah(async (req, res) => {
  need(req.body, ['name']);
  const { rows } = await query(
    'UPDATE categories SET name=$1 WHERE id=$2 AND restaurant_id=$3 RETURNING *',
    [req.body.name.trim(), req.params.id, req.restaurant.id]
  );
  if (!rows[0]) throw new HttpError(404, 'Category not found');
  res.json(rows[0]);
}));

router.delete('/categories/:id', ah(async (req, res) => {
  await query('DELETE FROM categories WHERE id=$1 AND restaurant_id=$2', [req.params.id, req.restaurant.id]);
  res.json({ ok: true });
}));

// ---- Products (admin must approve before they show on the menu) ----
router.get('/products', ah(async (req, res) =>
  res.json((await query(
    `SELECT p.*, c.name AS category_name FROM products p LEFT JOIN categories c ON c.id=p.category_id
     WHERE p.restaurant_id=$1 ORDER BY p.created_at DESC`, [req.restaurant.id])).rows)));

router.post('/products', upload.single('image'), ah(async (req, res) => {
  need(req.body, ['name', 'price']);
  const price = Number(req.body.price);
  if (!(price >= 0)) throw new HttpError(400, 'Enter a valid price');
  const { rows } = await query(
    `INSERT INTO products(restaurant_id,category_id,name,description,price,image_url) VALUES($1,$2,$3,$4,$5,$6) RETURNING *`,
    [req.restaurant.id, t(req.body.categoryId), req.body.name.trim(), req.body.description || '', price, fileUrl(req.file) || null]);
  const admins = (await query(`SELECT id FROM users WHERE role='admin'`)).rows;
  for (const a of admins) await notify(a.id, 'Product awaiting approval', `${req.restaurant.name} added "${rows[0].name}".`, { sms: false });
  res.status(201).json(rows[0]);
}));

router.put('/products/:id', upload.single('image'), ah(async (req, res) => {
  need(req.body, ['name', 'price']);
  // any content edit sends the product back for admin review
  const { rows } = await query(
    `UPDATE products SET category_id=$1,name=$2,description=$3,price=$4,image_url=COALESCE($5,image_url),status='pending',review_note=NULL
     WHERE id=$6 AND restaurant_id=$7 RETURNING *`,
    [t(req.body.categoryId), req.body.name.trim(), req.body.description || '', Number(req.body.price), fileUrl(req.file) || null, req.params.id, req.restaurant.id]);
  if (!rows[0]) throw new HttpError(404, 'Product not found');
  res.json(rows[0]);
}));

router.patch('/products/:id/availability', ah(async (req, res) => {
  const { rows } = await query('UPDATE products SET is_available=$1 WHERE id=$2 AND restaurant_id=$3 RETURNING *',
    [!!req.body.isAvailable, req.params.id, req.restaurant.id]);
  if (!rows[0]) throw new HttpError(404, 'Product not found');
  res.json(rows[0]);
}));

router.delete('/products/:id', ah(async (req, res) => {
  await query('DELETE FROM products WHERE id=$1 AND restaurant_id=$2', [req.params.id, req.restaurant.id]);
  res.json({ ok: true });
}));

// ---- Orders ----
router.get('/orders', ah(async (req, res) => {
  const { status = '' } = req.query;
  res.json((await query(
    `${ORDER_SELECT} WHERE o.restaurant_id=$1 AND o.status<>'pending_payment' AND ($2='' OR o.status=$2) ORDER BY o.created_at DESC LIMIT 200`,
    [req.restaurant.id, status])).rows);
}));

router.get('/orders/:id', ah(async (req, res) => {
  const { rows } = await query(
    `${ORDER_SELECT} WHERE o.id=$1 AND o.restaurant_id=$2`,
    [req.params.id, req.restaurant.id]
  );
  if (!rows[0]) throw new HttpError(404, 'Order not found');
  res.json(rows[0]);
}));

const NEXT = { placed: ['accepted', 'cancelled'], accepted: ['preparing'], preparing: ['ready'] };
const MSG = {
  accepted: 'has been accepted by the restaurant.', preparing: 'is being prepared.',
  ready: 'is ready and waiting for a rider.', cancelled: 'was declined by the restaurant. Your payment will be refunded.'
};
router.patch('/orders/:id/status', ah(async (req, res) => {
  const { status, reason } = req.body;
  const o = (await query('SELECT * FROM orders WHERE id=$1 AND restaurant_id=$2', [req.params.id, req.restaurant.id])).rows[0];
  if (!o) throw new HttpError(404, 'Order not found');
  if (!(NEXT[o.status] || []).includes(status)) throw new HttpError(400, `An order that is "${o.status}" cannot move to "${status}"`);
  await query(`UPDATE orders SET status=$1, payment_status=CASE WHEN $1='cancelled' AND payment_status='paid' THEN 'refund_pending' ELSE payment_status END, updated_at=now() WHERE id=$2`, [status, o.id]);
  const cancelSuffix = reason ? ` Reason: ${reason}` : '';
  await notify(o.customer_id, 'Order update', `Order #${o.id.slice(0, 8).toUpperCase()} ${MSG[status]}${cancelSuffix}`);
  if (status === 'ready') {
    const riders = (await query(`SELECT user_id FROM rider_profiles WHERE status='approved' AND is_available`)).rows;
    for (const r of riders) await notify(r.user_id, 'Delivery available', `${req.restaurant.name} has an order ready for pickup.`, { email: false, sms: false });
  }
  res.json({ ok: true });
}));

// ---- Analytics & Overview ----
router.get('/analytics', ah(async (req, res) => {
  const days = Math.min(Math.max(parseInt(req.query.days, 10) || 30, 7), 365);
  const id = req.restaurant.id;
  const valid = `payment_status='paid' AND status<>'cancelled'`;

  const [totals, series, byStatus, top, pendingProducts, today, hourly, categorySales, recentActive, customerStats] = await Promise.all([
    query(`SELECT COUNT(*)::int AS orders, COALESCE(SUM(subtotal),0)::float AS revenue,
             COALESCE(AVG(subtotal),0)::float AS avg_order,
             COALESCE(SUM(commission_amount),0)::float AS commission,
             COALESCE(SUM(restaurant_payout),0)::float AS payout,
             COUNT(*) FILTER (WHERE status IN ('placed','accepted','preparing'))::int AS active
           FROM orders WHERE restaurant_id=$1 AND ${valid} AND created_at >= now() - make_interval(days => $2::int)`, [id, days]),
    query(`SELECT to_char(d,'YYYY-MM-DD') AS date, COUNT(o.id)::int AS orders, COALESCE(SUM(o.subtotal),0)::float AS revenue
           FROM generate_series(current_date-($2::int-1), current_date, '1 day') d
           LEFT JOIN orders o ON o.created_at::date=d AND o.restaurant_id=$1 AND o.${valid.replaceAll(' AND ', ' AND o.')}
           GROUP BY d ORDER BY d`, [id, days]),
    query(`SELECT status, COUNT(*)::int AS count FROM orders WHERE restaurant_id=$1 AND status<>'pending_payment' GROUP BY status`, [id]),
    query(`SELECT oi.name, SUM(oi.quantity)::int AS sold, SUM(oi.quantity*oi.price)::float AS revenue
           FROM order_items oi JOIN orders o ON o.id=oi.order_id
           WHERE o.restaurant_id=$1 AND o.${valid.replaceAll(' AND ', ' AND o.')} GROUP BY oi.name ORDER BY sold DESC LIMIT 6`, [id]),
    query(`SELECT COUNT(*)::int AS n FROM products WHERE restaurant_id=$1 AND status='pending'`, [id]),
    query(`SELECT COUNT(*)::int AS orders, COALESCE(SUM(subtotal),0)::float AS revenue, COALESCE(SUM(restaurant_payout),0)::float AS payout
           FROM orders WHERE restaurant_id=$1 AND ${valid} AND created_at::date = current_date`, [id]),
    query(`SELECT EXTRACT(HOUR FROM created_at)::int AS hour, COUNT(*)::int AS count, COALESCE(SUM(subtotal),0)::float AS revenue
           FROM orders WHERE restaurant_id=$1 AND ${valid} AND created_at >= now() - make_interval(days => $2::int)
           GROUP BY hour ORDER BY hour`, [id, days]),
    query(`SELECT COALESCE(c.name, 'Uncategorized') AS name, COALESCE(SUM(oi.quantity),0)::int AS sold, COALESCE(SUM(oi.quantity*oi.price),0)::float AS revenue
           FROM order_items oi
           JOIN orders o ON o.id=oi.order_id
           LEFT JOIN products p ON p.id=oi.product_id
           LEFT JOIN categories c ON c.id=p.category_id
           WHERE o.restaurant_id=$1 AND o.${valid.replaceAll(' AND ', ' AND o.')}
           GROUP BY c.name ORDER BY revenue DESC LIMIT 6`, [id]),
    query(`${ORDER_SELECT} WHERE o.restaurant_id=$1 AND o.status IN ('placed','accepted','preparing','ready') ORDER BY o.created_at DESC LIMIT 10`, [id]),
    query(`SELECT COUNT(DISTINCT customer_id)::int AS unique_customers,
                  COUNT(*) FILTER (WHERE status='delivered')::int AS delivered_count,
                  COUNT(*) FILTER (WHERE status='cancelled')::int AS cancelled_count,
                  COUNT(*)::int AS total_non_pending
           FROM orders WHERE restaurant_id=$1 AND status<>'pending_payment' AND created_at >= now() - make_interval(days => $2::int)`, [id, days])
  ]);

  // build 24-hour array for clean hourly chart display
  const hourlyMap = new Map(hourly.rows.map(h => [h.hour, h]));
  const fullHourly = Array.from({ length: 24 }, (_, i) => ({
    hour: `${String(i).padStart(2, '0')}:00`,
    orders: hourlyMap.get(i)?.count || 0,
    revenue: hourlyMap.get(i)?.revenue || 0
  }));

  res.json({
    totals: totals.rows[0],
    today: today.rows[0],
    series: series.rows,
    byStatus: byStatus.rows,
    topProducts: top.rows,
    pendingProducts: pendingProducts.rows[0].n,
    hourly: fullHourly,
    categorySales: categorySales.rows,
    recentActive: recentActive.rows,
    customerStats: customerStats.rows[0]
  });
}));

// ---- Finances & Payouts ----
router.get('/finances', ah(async (req, res) => {
  const id = req.restaurant.id;
  const [summary, ledger, restRow] = await Promise.all([
    query(`
      SELECT 
        COUNT(*)::int AS total_orders,
        COALESCE(SUM(subtotal),0)::float AS total_sales,
        COALESCE(SUM(delivery_fee),0)::float AS total_delivery_fees,
        COALESCE(SUM(total),0)::float AS total_order_volume,
        COALESCE(SUM(commission_amount),0)::float AS total_commission,
        COALESCE(SUM(restaurant_payout),0)::float AS total_payout,
        COALESCE(AVG(subtotal),0)::float AS avg_order_value,
        COUNT(*) FILTER (WHERE status='cancelled')::int AS cancelled_orders,
        COUNT(*) FILTER (WHERE payment_status='paid')::int AS paid_orders,
        COUNT(*) FILTER (WHERE payment_status='refund_pending')::int AS refund_pending_orders,
        COUNT(*) FILTER (WHERE payment_status='refunded')::int AS refunded_orders
      FROM orders 
      WHERE restaurant_id=$1 AND status<>'pending_payment'
    `, [id]),
    query(`
      SELECT 
        o.id, o.created_at, o.status, o.payment_status, o.payment_reference,
        o.subtotal, o.delivery_fee, o.total, o.commission_amount, o.restaurant_payout,
        u.name AS customer_name, u.phone AS customer_phone
      FROM orders o
      JOIN users u ON u.id=o.customer_id
      WHERE o.restaurant_id=$1 AND o.status<>'pending_payment'
      ORDER BY o.created_at DESC
      LIMIT 200
    `, [id]),
    query(`SELECT bank_name, account_number, account_name, mobile_money_number, mobile_money_network FROM restaurants WHERE id=$1`, [id])
  ]);

  res.json({
    summary: summary.rows[0],
    payoutAccount: {
      bankName: restRow.rows[0]?.bank_name || '',
      accountNumber: restRow.rows[0]?.account_number || '',
      accountName: restRow.rows[0]?.account_name || '',
      mobileMoneyNumber: restRow.rows[0]?.mobile_money_number || '',
      mobileMoneyNetwork: restRow.rows[0]?.mobile_money_network || ''
    },
    ledger: ledger.rows
  });
}));

router.put('/finances/account', ah(async (req, res) => {
  const { bankName = '', accountNumber = '', accountName = '', mobileMoneyNumber = '', mobileMoneyNetwork = '' } = req.body;
  const { rows } = await query(`
    UPDATE restaurants 
    SET bank_name=$1, account_number=$2, account_name=$3, mobile_money_number=$4, mobile_money_network=$5 
    WHERE id=$6 RETURNING bank_name, account_number, account_name, mobile_money_number, mobile_money_network
  `, [bankName.trim(), accountNumber.trim(), accountName.trim(), mobileMoneyNumber.trim(), mobileMoneyNetwork.trim(), req.restaurant.id]);
  res.json(rows[0]);
}));

// ---- Operating Schedule & Rush Hour Pause ----
router.get('/schedule', ah(async (req, res) => {
  const { rows } = await query(`
    SELECT is_open, opening_time, closing_time, prep_time_minutes, pause_until, schedule 
    FROM restaurants WHERE id=$1
  `, [req.restaurant.id]);
  res.json(rows[0] || {});
}));

router.put('/schedule', ah(async (req, res) => {
  const { openingTime, closingTime, prepTimeMinutes, schedule, pauseUntil } = req.body;
  const { rows } = await query(`
    UPDATE restaurants 
    SET opening_time=COALESCE($1, opening_time),
        closing_time=COALESCE($2, closing_time),
        prep_time_minutes=COALESCE($3, prep_time_minutes),
        schedule=COALESCE($4, schedule),
        pause_until=$5
    WHERE id=$6 RETURNING is_open, opening_time, closing_time, prep_time_minutes, pause_until, schedule
  `, [
    openingTime || null,
    closingTime || null,
    prepTimeMinutes ? Number(prepTimeMinutes) : null,
    schedule ? JSON.stringify(schedule) : null,
    pauseUntil ? new Date(pauseUntil) : null,
    req.restaurant.id
  ]);
  res.json(rows[0]);
}));

router.post('/schedule/pause', ah(async (req, res) => {
  const minutes = Number(req.body.minutes) || 0;
  const pauseUntil = minutes > 0 ? new Date(Date.now() + minutes * 60 * 1000) : null;
  const { rows } = await query(`
    UPDATE restaurants SET pause_until=$1 WHERE id=$2 RETURNING pause_until
  `, [pauseUntil, req.restaurant.id]);
  res.json(rows[0]);
}));

// ---- Product Details ----
router.get('/products/:id', ah(async (req, res) => {
  const { rows } = await query(
    `SELECT p.*, c.name AS category_name
     FROM products p
     LEFT JOIN categories c ON c.id = p.category_id
     WHERE p.id=$1 AND p.restaurant_id=$2`,
    [req.params.id, req.restaurant.id]
  );
  if (!rows[0]) throw new HttpError(404, 'Food item not found');
  res.json(rows[0]);
}));

// ---- Delivery & Pickup Settings ----
router.get('/delivery-settings', ah(async (req, res) => {
  const { rows } = await query(
    'SELECT delivery_fee, min_order, prep_time_minutes, latitude, longitude, pickup_enabled, delivery_enabled, service_radius FROM restaurants WHERE id=$1',
    [req.restaurant.id]
  );
  res.json(rows[0] || {});
}));

router.put('/delivery-settings', ah(async (req, res) => {
  const { deliveryFee, minOrder, prepTimeMinutes, pickupEnabled, deliveryEnabled, serviceRadius } = req.body;
  const { rows } = await query(
    `UPDATE restaurants SET
       delivery_fee=COALESCE($1, delivery_fee),
       min_order=COALESCE($2, min_order),
       prep_time_minutes=COALESCE($3, prep_time_minutes),
       pickup_enabled=COALESCE($4, pickup_enabled),
       delivery_enabled=COALESCE($5, delivery_enabled),
       service_radius=COALESCE($6, service_radius)
     WHERE id=$7 RETURNING delivery_fee, min_order, prep_time_minutes, pickup_enabled, delivery_enabled, service_radius`,
    [
      deliveryFee !== undefined ? Number(deliveryFee) : null,
      minOrder !== undefined ? Number(minOrder) : null,
      prepTimeMinutes !== undefined ? Number(prepTimeMinutes) : null,
      pickupEnabled !== undefined ? !!pickupEnabled : null,
      deliveryEnabled !== undefined ? !!deliveryEnabled : null,
      serviceRadius !== undefined ? Number(serviceRadius) : null,
      req.restaurant.id
    ]
  );
  res.json(rows[0]);
}));

// ---- Restaurant Documents & Verification ----
router.get('/documents', ah(async (req, res) => {
  const { rows } = await query('SELECT * FROM restaurant_documents WHERE restaurant_id=$1 ORDER BY created_at DESC', [req.restaurant.id]);
  res.json(rows);
}));

router.post('/documents', upload.single('file'), ah(async (req, res) => {
  need(req.body, ['documentType']);
  const url = fileUrl(req.file) || req.body.fileUrl;
  if (!url) throw new HttpError(400, 'Please upload a document file');
  const { rows } = await query(
    `INSERT INTO restaurant_documents(restaurant_id, document_type, file_url, status)
     VALUES($1, $2, $3, 'pending') RETURNING *`,
    [req.restaurant.id, req.body.documentType.trim(), url]
  );
  res.status(201).json(rows[0]);
}));

router.delete('/documents/:id', ah(async (req, res) => {
  await query('DELETE FROM restaurant_documents WHERE id=$1 AND restaurant_id=$2', [req.params.id, req.restaurant.id]);
  res.json({ ok: true });
}));

// ---- Profile Change Requests ----
router.get('/change-requests', ah(async (req, res) => {
  const { rows } = await query('SELECT * FROM restaurant_change_requests WHERE restaurant_id=$1 ORDER BY created_at DESC', [req.restaurant.id]);
  res.json(rows);
}));

router.post('/change-requests', ah(async (req, res) => {
  need(req.body, ['changes']);
  const { changes, reason = '' } = req.body;
  const { rows } = await query(
    `INSERT INTO restaurant_change_requests(restaurant_id, requested_by, changes, reason, status)
     VALUES($1, $2, $3, $4, 'pending') RETURNING *`,
    [req.restaurant.id, req.user.id, JSON.stringify(changes), reason.trim()]
  );
  res.status(201).json(rows[0]);
}));

// ---- Delivery & Available Riders ----
router.get('/delivery/riders', ah(async (_req, res) => {
  const { rows } = await query(
    `SELECT u.id, u.name, u.phone, rp.vehicle_type, rp.plate_number, rp.is_available,
       (SELECT COUNT(*) FROM orders o WHERE o.rider_id=u.id AND o.status IN ('picked_up','ready'))::int AS active_deliveries
     FROM rider_profiles rp
     JOIN users u ON u.id = rp.user_id
     WHERE rp.status='approved' AND rp.is_available
     ORDER BY active_deliveries ASC, u.name ASC LIMIT 20`
  );
  res.json(rows);
}));

// ---- Staff Management ----
router.get('/staff', ah(async (req, res) => {
  const { rows } = await query('SELECT * FROM restaurant_staff WHERE restaurant_id=$1 ORDER BY created_at DESC', [req.restaurant.id]);
  res.json(rows);
}));

router.post('/staff', ah(async (req, res) => {
  need(req.body, ['name', 'email']);
  const { name, email, phone = '', role = 'staff', permissions = ['orders'] } = req.body;
  const { rows } = await query(
    `INSERT INTO restaurant_staff(restaurant_id, name, email, phone, role, permissions, status)
     VALUES($1, $2, $3, $4, $5, $6, 'active') RETURNING *`,
    [req.restaurant.id, name.trim(), email.toLowerCase().trim(), phone.trim(), role, JSON.stringify(permissions)]
  );
  res.status(201).json(rows[0]);
}));

router.delete('/staff/:id', ah(async (req, res) => {
  await query('DELETE FROM restaurant_staff WHERE id=$1 AND restaurant_id=$2', [req.params.id, req.restaurant.id]);
  res.json({ ok: true });
}));

// ---- Promotions & Discounts ----
router.get('/promotions', ah(async (req, res) => {
  const { rows } = await query('SELECT * FROM promotions WHERE restaurant_id=$1 ORDER BY created_at DESC', [req.restaurant.id]);
  res.json(rows);
}));

router.post('/promotions', ah(async (req, res) => {
  need(req.body, ['title', 'code', 'discountValue']);
  const { title, code, description = '', discountType = 'percentage', discountValue, minOrderAmount = 0, endDate } = req.body;
  const { rows } = await query(
    `INSERT INTO promotions(restaurant_id, title, description, code, discount_type, discount_value, min_order_amount, end_date, is_active, status)
     VALUES($1, $2, $3, $4, $5, $6, $7, COALESCE($8, now() + interval '30 days'), true, 'approved') RETURNING *`,
    [req.restaurant.id, title.trim(), description.trim(), code.toUpperCase().trim(), discountType, Number(discountValue), Number(minOrderAmount), endDate || null]
  );
  res.status(201).json(rows[0]);
}));

router.delete('/promotions/:id', ah(async (req, res) => {
  await query('DELETE FROM promotions WHERE id=$1 AND restaurant_id=$2', [req.params.id, req.restaurant.id]);
  res.json({ ok: true });
}));

// ---- Restaurant-Specific Customer Management ----
router.get('/customers', ah(async (req, res) => {
  const { search = '' } = req.query;
  const { rows } = await query(
    `SELECT u.id, u.name, u.email, u.phone,
       COUNT(o.id)::int AS order_count,
       COALESCE(SUM(o.subtotal), 0)::float AS total_spent,
       MAX(o.created_at) AS last_order_date
     FROM orders o
     JOIN users u ON u.id = o.customer_id
     WHERE o.restaurant_id=$1 AND o.status<>'pending_payment'
       AND ($2='' OR u.name ILIKE '%'||$2||'%' OR u.phone ILIKE '%'||$2||'%')
     GROUP BY u.id, u.name, u.email, u.phone
     ORDER BY last_order_date DESC`,
    [req.restaurant.id, search]
  );
  res.json(rows);
}));

router.get('/customers/:id', ah(async (req, res) => {
  const { rows } = await query(
    `SELECT u.id, u.name, u.phone, u.created_at,
       COUNT(o.id)::int AS order_count,
       COALESCE(SUM(o.subtotal), 0)::float AS total_spent
     FROM orders o
     JOIN users u ON u.id = o.customer_id
     WHERE o.restaurant_id=$1 AND u.id=$2 AND o.status<>'pending_payment'
     GROUP BY u.id, u.name, u.phone, u.created_at`,
    [req.restaurant.id, req.params.id]
  );
  if (!rows[0]) throw new HttpError(404, 'Customer not found for this restaurant');

  const orders = (await query(
    `${ORDER_SELECT} WHERE o.restaurant_id=$1 AND o.customer_id=$2 ORDER BY o.created_at DESC`,
    [req.restaurant.id, req.params.id]
  )).rows;

  const reviews = (await query(
    'SELECT * FROM restaurant_reviews WHERE restaurant_id=$1 AND customer_id=$2 ORDER BY created_at DESC',
    [req.restaurant.id, req.params.id]
  )).rows;

  res.json({ customer: rows[0], orders, reviews });
}));

// ---- Customer Feedback / Reviews ----
router.get('/feedback', ah(async (req, res) => {
  const { rows } = await query(
    `SELECT rev.*, u.name AS customer_name, o.id AS order_reference
     FROM restaurant_reviews rev
     JOIN users u ON u.id = rev.customer_id
     LEFT JOIN orders o ON o.id = rev.order_id
     WHERE rev.restaurant_id=$1
     ORDER BY rev.created_at DESC`,
    [req.restaurant.id]
  );
  res.json(rows);
}));

router.post('/feedback/:id/reply', ah(async (req, res) => {
  need(req.body, ['reply']);
  const { rows } = await query(
    `UPDATE restaurant_reviews SET manager_reply=$1, manager_replied_at=now()
     WHERE id=$2 AND restaurant_id=$3 RETURNING *`,
    [req.body.reply.trim(), req.params.id, req.restaurant.id]
  );
  if (!rows[0]) throw new HttpError(404, 'Review not found');
  await notify(rows[0].customer_id, 'Restaurant replied to your review', `${req.restaurant.name} replied: "${req.body.reply}"`);
  res.json(rows[0]);
}));

// ---- Customer Issues / Support Tickets for Restaurant ----
router.get('/issues', ah(async (req, res) => {
  const { rows } = await query(
    `SELECT t.*, u.name AS customer_name, u.phone AS customer_phone
     FROM support_tickets t
     JOIN users u ON u.id = t.user_id
     WHERE t.restaurant_id=$1
     ORDER BY t.created_at DESC`,
    [req.restaurant.id]
  );
  res.json(rows);
}));

router.post('/issues/:id/reply', ah(async (req, res) => {
  need(req.body, ['message']);
  const t = (await query('SELECT * FROM support_tickets WHERE id=$1 AND restaurant_id=$2', [req.params.id, req.restaurant.id])).rows[0];
  if (!t) throw new HttpError(404, 'Issue not found');

  const { rows } = await query(
    `INSERT INTO ticket_messages(ticket_id, sender_id, sender_name, message) VALUES($1, $2, $3, $4) RETURNING *`,
    [t.id, req.user.id, `${req.restaurant.name} (Manager)`, req.body.message.trim()]
  );
  await query('UPDATE support_tickets SET updated_at=now() WHERE id=$1', [t.id]);
  await notify(t.user_id, 'Update on your issue', `${req.restaurant.name} sent a reply regarding ticket #${t.ticket_number}.`);
  res.status(201).json(rows[0]);
}));

// ---- Security & Authentication Alerts for Manager ----
router.get('/alerts/auth', ah(async (req, res) => {
  const { rows } = await query(
    `SELECT * FROM auth_alerts WHERE user_id=$1 OR restaurant_id=$2 ORDER BY created_at DESC LIMIT 100`,
    [req.user.id, req.restaurant.id]
  );
  res.json(rows);
}));

router.get('/alerts', ah(async (req, res) => {
  const { category = '' } = req.query;
  const [notifications, authAlerts] = await Promise.all([
    query('SELECT * FROM notifications WHERE user_id=$1 ORDER BY created_at DESC LIMIT 50', [req.user.id]),
    query('SELECT * FROM auth_alerts WHERE user_id=$1 OR restaurant_id=$2 ORDER BY created_at DESC LIMIT 50', [req.user.id, req.restaurant.id])
  ]);
  res.json({ notifications: notifications.rows, authAlerts: authAlerts.rows });
}));

export default router;
