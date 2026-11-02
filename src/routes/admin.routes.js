import { Router } from 'express';
import bcrypt from 'bcryptjs';
import { query } from '../config/db.js';
import { ah, HttpError, need } from '../utils/http.js';
import { auth, requireRole } from '../middleware/auth.js';
import { notify } from '../services/notify.js';
import { ORDER_SELECT } from '../lib/orderQuery.js';
import { env } from '../config/env.js';
import { getSettings, saveSettings } from '../lib/settings.js';
import { refundPayment } from '../services/payment.js';
import { logAudit } from '../services/audit.js';

const router = Router();
router.use(auth, requireRole('admin'));

// ==========================================
// 1. OVERVIEW & ANALYTICS
// ==========================================
router.get('/analytics', ah(async (req, res) => {
  const days = Math.min(Math.max(parseInt(req.query.days, 10) || 30, 7), 365);
  const valid = `payment_status='paid' AND status<>'cancelled'`;
  const [counts, totals, series, byStatus, topRestaurants, signups, recentAudit] = await Promise.all([
    query(`SELECT
      (SELECT COUNT(*) FROM users WHERE role='customer')::int AS customers,
      (SELECT COUNT(*) FROM users WHERE role='manager')::int AS managers,
      (SELECT COUNT(*) FROM users WHERE role='rider')::int AS riders,
      (SELECT COUNT(*) FROM restaurants WHERE status='approved')::int AS restaurants,
      (SELECT COUNT(*) FROM restaurants WHERE status='pending')::int AS pending_restaurants,
      (SELECT COUNT(*) FROM products WHERE status='pending')::int AS pending_products,
      (SELECT COUNT(*) FROM rider_profiles WHERE status='pending')::int AS pending_riders,
      (SELECT COUNT(*) FROM orders WHERE payment_status='refund_pending')::int AS pending_refunds,
      (SELECT COUNT(*) FROM support_tickets WHERE status='open')::int AS open_tickets`),
    query(`SELECT COUNT(*)::int AS orders, COALESCE(SUM(total),0)::float AS revenue,
             COALESCE(AVG(total),0)::float AS avg_order, COALESCE(SUM(delivery_fee),0)::float AS delivery_fees,
             COALESCE(SUM(commission_amount),0)::float AS commission
           FROM orders WHERE ${valid} AND created_at >= now() - make_interval(days => $1::int)`, [days]),
    query(`SELECT to_char(d,'YYYY-MM-DD') AS date, COUNT(o.id)::int AS orders, COALESCE(SUM(o.total),0)::float AS revenue
           FROM generate_series(current_date-($1::int-1), current_date, '1 day') d
           LEFT JOIN orders o ON o.created_at::date=d AND o.payment_status='paid' AND o.status<>'cancelled'
           GROUP BY d ORDER BY d`, [days]),
    query(`SELECT status, COUNT(*)::int AS count FROM orders WHERE status<>'pending_payment' GROUP BY status`),
    query(`SELECT r.name, COUNT(o.id)::int AS orders, COALESCE(SUM(o.total),0)::float AS revenue
           FROM orders o JOIN restaurants r ON r.id=o.restaurant_id
           WHERE o.${valid.replaceAll(' AND ', ' AND o.')} AND o.created_at >= now() - make_interval(days => $1::int)
           GROUP BY r.name ORDER BY revenue DESC LIMIT 5`, [days]),
    query(`SELECT to_char(d,'YYYY-MM-DD') AS date, COUNT(u.id)::int AS users
           FROM generate_series(current_date-($1::int-1), current_date, '1 day') d
           LEFT JOIN users u ON u.created_at::date=d AND u.role<>'admin' GROUP BY d ORDER BY d`, [days]),
    query(`SELECT * FROM audit_logs ORDER BY created_at DESC LIMIT 5`)
  ]);
  res.json({
    counts: counts.rows[0],
    totals: totals.rows[0],
    series: series.rows,
    byStatus: byStatus.rows,
    topRestaurants: topRestaurants.rows,
    signups: signups.rows,
    recentAudit: recentAudit.rows
  });
}));

router.get('/analytics/deep', ah(async (req, res) => {
  const { type = 'sales', days = 30 } = req.query;
  const daysInt = Math.min(Math.max(parseInt(days, 10) || 30, 7), 365);
  
  if (type === 'sales') {
    const [revSeries, summary] = await Promise.all([
      query(`SELECT to_char(d,'YYYY-MM-DD') AS date,
                    COALESCE(SUM(o.total),0)::float AS gross_sales,
                    COALESCE(SUM(o.commission_amount),0)::float AS net_commission,
                    COALESCE(SUM(o.delivery_fee),0)::float AS delivery_revenue,
                    COUNT(o.id)::int AS count
             FROM generate_series(current_date-($1::int-1), current_date, '1 day') d
             LEFT JOIN orders o ON o.created_at::date=d AND o.payment_status='paid' AND o.status<>'cancelled'
             GROUP BY d ORDER BY d`, [daysInt]),
      query(`SELECT COALESCE(SUM(total),0)::float AS total_gmv,
                    COALESCE(SUM(commission_amount),0)::float AS total_commission,
                    COALESCE(SUM(delivery_fee),0)::float AS total_delivery_fees,
                    COALESCE(AVG(total),0)::float AS avg_order_value,
                    COUNT(*)::int AS total_paid_orders
             FROM orders WHERE payment_status='paid' AND status<>'cancelled' AND created_at >= now() - make_interval(days => $1::int)`, [daysInt])
    ]);
    return res.json({ summary: summary.rows[0], series: revSeries.rows });
  }

  if (type === 'orders') {
    const [statusBreakdown, hourly, series] = await Promise.all([
      query(`SELECT status, COUNT(*)::int AS count FROM orders WHERE created_at >= now() - make_interval(days => $1::int) GROUP BY status`, [daysInt]),
      query(`SELECT EXTRACT(HOUR FROM created_at)::int AS hour, COUNT(*)::int AS count FROM orders WHERE created_at >= now() - make_interval(days => $1::int) GROUP BY hour ORDER BY hour`, [daysInt]),
      query(`SELECT to_char(d,'YYYY-MM-DD') AS date, COUNT(o.id)::int AS orders,
                    COUNT(o.id) FILTER (WHERE o.status='delivered')::int AS delivered,
                    COUNT(o.id) FILTER (WHERE o.status='cancelled')::int AS cancelled
             FROM generate_series(current_date-($1::int-1), current_date, '1 day') d
             LEFT JOIN orders o ON o.created_at::date=d
             GROUP BY d ORDER BY d`, [daysInt])
    ]);
    return res.json({ statusBreakdown: statusBreakdown.rows, hourly: hourly.rows, series: series.rows });
  }

  if (type === 'restaurants') {
    const { rows } = await query(
      `SELECT r.id, r.name, r.cuisine, r.status,
              COUNT(o.id)::int AS orders_count,
              COALESCE(SUM(o.total) FILTER (WHERE o.payment_status='paid'), 0)::float AS total_sales,
              COALESCE(SUM(o.commission_amount) FILTER (WHERE o.payment_status='paid'), 0)::float AS commission_paid,
              (SELECT COALESCE(AVG(rating), 4.8) FROM restaurant_reviews rev WHERE rev.restaurant_id=r.id)::numeric(2,1) AS rating
       FROM restaurants r
       LEFT JOIN orders o ON o.restaurant_id=r.id AND o.created_at >= now() - make_interval(days => $1::int)
       GROUP BY r.id ORDER BY total_sales DESC LIMIT 50`, [daysInt]);
    return res.json(rows);
  }

  if (type === 'customers') {
    const [growth, topCustomers] = await Promise.all([
      query(`SELECT to_char(d,'YYYY-MM-DD') AS date, COUNT(u.id)::int AS new_signups
             FROM generate_series(current_date-($1::int-1), current_date, '1 day') d
             LEFT JOIN users u ON u.created_at::date=d AND u.role='customer'
             GROUP BY d ORDER BY d`, [daysInt]),
      query(`SELECT u.id, u.name, u.email, COUNT(o.id)::int AS order_count,
                    COALESCE(SUM(o.total) FILTER (WHERE o.payment_status='paid'), 0)::float AS total_spent,
                    MAX(o.created_at) AS last_order
             FROM users u
             JOIN orders o ON o.customer_id=u.id
             WHERE u.role='customer' AND o.created_at >= now() - make_interval(days => $1::int)
             GROUP BY u.id ORDER BY total_spent DESC LIMIT 25`, [daysInt])
    ]);
    return res.json({ growth: growth.rows, topCustomers: topCustomers.rows });
  }

  if (type === 'riders') {
    const { rows } = await query(
      `SELECT u.id, u.name, u.phone, rp.vehicle_type, rp.status,
              COUNT(o.id) FILTER (WHERE o.status='delivered')::int AS delivered_count,
              COUNT(o.id) FILTER (WHERE o.status IN ('picked_up','ready'))::int AS in_progress_count,
              COALESCE(SUM(o.delivery_fee * 0.8) FILTER (WHERE o.status='delivered'), 0)::float AS rider_earnings
       FROM users u
       JOIN rider_profiles rp ON rp.user_id=u.id
       LEFT JOIN orders o ON o.rider_id=u.id AND o.created_at >= now() - make_interval(days => $1::int)
       GROUP BY u.id, rp.vehicle_type, rp.status ORDER BY delivered_count DESC`, [daysInt]);
    return res.json(rows);
  }

  if (type === 'payments') {
    const [gatewayStats, methodShare] = await Promise.all([
      query(`SELECT status, kind, COUNT(*)::int AS count, COALESCE(SUM(amount), 0)::float AS volume
             FROM payments WHERE created_at >= now() - make_interval(days => $1::int)
             GROUP BY status, kind`, [daysInt]),
      query(`SELECT payment_method, COUNT(*)::int AS count, COALESCE(SUM(total), 0)::float AS total
             FROM orders WHERE payment_status='paid' AND created_at >= now() - make_interval(days => $1::int)
             GROUP BY payment_method`, [daysInt])
    ]);
    return res.json({ gatewayStats: gatewayStats.rows, methodShare: methodShare.rows });
  }

  res.json({ ok: true });
}));

// ==========================================
// 2. RESTAURANT MANAGEMENT
// ==========================================
router.get('/restaurants', ah(async (req, res) => {
  const { status = '', search = '' } = req.query;
  const { rows } = await query(
    `SELECT r.*, u.name AS owner_name, u.email AS owner_email, u.phone AS owner_phone,
       (SELECT COUNT(*) FROM products p WHERE p.restaurant_id=r.id)::int AS product_count,
       (SELECT COUNT(*) FROM orders o WHERE o.restaurant_id=r.id AND o.status<>'pending_payment')::int AS order_count,
       (SELECT COALESCE(AVG(rating), 4.8) FROM restaurant_reviews rev WHERE rev.restaurant_id=r.id)::numeric(2,1) AS rating
     FROM restaurants r
     JOIN users u ON u.id=r.owner_id
     WHERE ($1='' OR r.status=$1)
       AND ($2='' OR r.name ILIKE '%'||$2||'%' OR u.name ILIKE '%'||$2||'%' OR u.email ILIKE '%'||$2||'%')
     ORDER BY r.created_at DESC`, [status, search]);
  res.json(rows);
}));

router.get('/restaurants/:id', ah(async (req, res) => {
  const r = (await query(
    `SELECT r.*, u.name AS owner_name, u.email AS owner_email, u.phone AS owner_phone, u.status AS owner_status,
       (SELECT COUNT(*) FROM products p WHERE p.restaurant_id=r.id)::int AS product_count,
       (SELECT COUNT(*) FROM orders o WHERE o.restaurant_id=r.id AND o.status='delivered')::int AS completed_orders,
       (SELECT COALESCE(SUM(total), 0)::float FROM orders o WHERE o.restaurant_id=r.id AND o.payment_status='paid') AS gross_sales,
       (SELECT COALESCE(AVG(rating), 5.0)::numeric(2,1) FROM restaurant_reviews rev WHERE rev.restaurant_id=r.id) AS average_rating
     FROM restaurants r JOIN users u ON u.id=r.owner_id WHERE r.id=$1`, [req.params.id])).rows[0];
  if (!r) throw new HttpError(404, 'Restaurant not found');

  const [products, orders, documents, changeRequests] = await Promise.all([
    query('SELECT * FROM products WHERE restaurant_id=$1 ORDER BY created_at DESC', [r.id]),
    query(`${ORDER_SELECT} WHERE o.restaurant_id=$1 ORDER BY o.created_at DESC LIMIT 15`, [r.id]),
    query('SELECT * FROM restaurant_documents WHERE restaurant_id=$1 ORDER BY created_at DESC', [r.id]),
    query('SELECT * FROM restaurant_change_requests WHERE restaurant_id=$1 ORDER BY created_at DESC', [r.id])
  ]);

  res.json({
    restaurant: r,
    products: products.rows,
    recentOrders: orders.rows,
    documents: documents.rows,
    changeRequests: changeRequests.rows
  });
}));

const REST_ACTIONS = { approve: 'approved', reject: 'rejected', suspend: 'suspended', activate: 'approved' };
router.patch('/restaurants/:id/review', ah(async (req, res) => {
  const action = req.body.action;
  const status = REST_ACTIONS[action];
  if (!status) throw new HttpError(400, 'Unknown action');
  if ((action === 'reject' || action === 'suspend') && !req.body.note) {
    throw new HttpError(400, 'Please provide a reason');
  }

  const { rows } = await query(
    'UPDATE restaurants SET status=$1, review_note=$2 WHERE id=$3 RETURNING *',
    [status, req.body.note || null, req.params.id]
  );
  const r = rows[0];
  if (!r) throw new HttpError(404, 'Restaurant not found');

  await notify(r.owner_id,
    status === 'approved' ? 'Restaurant approved' : `Restaurant ${status}`,
    status === 'approved' ? `${r.name} is approved. Your dashboard is ready.` : `${r.name} status changed to ${status}. Reason: ${req.body.note || 'None given'}`);

  await logAudit(req, `restaurant_${action}`, 'restaurant', r.id, { name: r.name, status, note: req.body.note });
  res.json(r);
}));

// Restaurant Documents / Verification
router.get('/restaurant-documents', ah(async (req, res) => {
  const { status = '', search = '' } = req.query;
  const { rows } = await query(
    `SELECT rd.*, r.name AS restaurant_name, u.name AS owner_name, u.email AS owner_email
     FROM restaurant_documents rd
     JOIN restaurants r ON r.id=rd.restaurant_id
     JOIN users u ON u.id=r.owner_id
     WHERE ($1='' OR rd.status=$1)
       AND ($2='' OR r.name ILIKE '%'||$2||'%' OR rd.document_type ILIKE '%'||$2||'%')
     ORDER BY rd.created_at DESC`, [status, search]);
  res.json(rows);
}));

router.patch('/restaurant-documents/:id/review', ah(async (req, res) => {
  const { status, note } = req.body;
  if (!['verified', 'rejected', 'pending'].includes(status)) throw new HttpError(400, 'Invalid status');
  const { rows } = await query(
    `UPDATE restaurant_documents SET status=$1, review_note=$2 WHERE id=$3 RETURNING *`,
    [status, note || null, req.params.id]
  );
  if (!rows[0]) throw new HttpError(404, 'Document not found');
  await logAudit(req, `restaurant_doc_${status}`, 'restaurant_document', rows[0].id, { note, status });
  res.json(rows[0]);
}));

// Restaurant Managers
router.get('/restaurant-managers', ah(async (req, res) => {
  const { search = '' } = req.query;
  const { rows } = await query(
    `SELECT u.id, u.name, u.email, u.phone, u.status, u.created_at,
       r.id AS restaurant_id, r.name AS restaurant_name, r.status AS restaurant_status
     FROM users u
     LEFT JOIN restaurants r ON r.owner_id = u.id
     WHERE u.role='manager'
       AND ($1='' OR u.name ILIKE '%'||$1||'%' OR u.email ILIKE '%'||$1||'%' OR r.name ILIKE '%'||$1||'%')
     ORDER BY u.created_at DESC`, [search]);
  res.json(rows);
}));

// Restaurant Profile Change Requests
router.get('/restaurant-change-requests', ah(async (req, res) => {
  const { status = 'pending' } = req.query;
  const { rows } = await query(
    `SELECT cr.*, r.name AS restaurant_name, u.name AS requester_name
     FROM restaurant_change_requests cr
     JOIN restaurants r ON r.id=cr.restaurant_id
     JOIN users u ON u.id=cr.requested_by
     WHERE ($1='' OR cr.status=$1)
     ORDER BY cr.created_at DESC`, [status]);
  res.json(rows);
}));

router.patch('/restaurant-change-requests/:id/review', ah(async (req, res) => {
  const { action, note } = req.body;
  if (!['approve', 'reject'].includes(action)) throw new HttpError(400, 'Invalid action');
  const cr = (await query('SELECT * FROM restaurant_change_requests WHERE id=$1', [req.params.id])).rows[0];
  if (!cr) throw new HttpError(404, 'Change request not found');

  const newStatus = action === 'approve' ? 'approved' : 'rejected';
  await query(
    'UPDATE restaurant_change_requests SET status=$1, review_note=$2, resolved_at=now() WHERE id=$3',
    [newStatus, note || null, cr.id]
  );

  if (action === 'approve') {
    const changes = cr.changes || {};
    const keys = Object.keys(changes);
    if (keys.length > 0) {
      const setClauses = keys.map((k, i) => `${k} = $${i + 2}`).join(', ');
      const values = keys.map(k => changes[k]);
      await query(`UPDATE restaurants SET ${setClauses} WHERE id=$1`, [cr.restaurant_id, ...values]);
    }
  }

  await notify(cr.requested_by, `Change Request ${newStatus}`, `Your restaurant profile updates have been ${newStatus}.`);
  await logAudit(req, `change_request_${action}`, 'restaurant_change_requests', cr.id, { action, note });
  res.json({ ok: true, status: newStatus });
}));

// ==========================================
// 3. FOOD & MENU MANAGEMENT
// ==========================================
router.get('/products', ah(async (req, res) => {
  const { status = '', search = '' } = req.query;
  const { rows } = await query(
    `SELECT p.*, r.name AS restaurant_name, c.name AS category_name
     FROM products p
     JOIN restaurants r ON r.id=p.restaurant_id
     LEFT JOIN categories c ON c.id=p.category_id
     WHERE ($1='' OR p.status=$1)
       AND ($2='' OR p.name ILIKE '%'||$2||'%' OR r.name ILIKE '%'||$2||'%')
     ORDER BY p.created_at DESC LIMIT 300`, [status, search]);
  res.json(rows);
}));

router.get('/products/:id', ah(async (req, res) => {
  const { rows } = await query(
    `SELECT p.*, r.name AS restaurant_name, r.id AS restaurant_id, c.name AS category_name,
       (SELECT COUNT(oi.id)::int FROM order_items oi WHERE oi.product_id=p.id) AS times_ordered
     FROM products p
     JOIN restaurants r ON r.id=p.restaurant_id
     LEFT JOIN categories c ON c.id=p.category_id
     WHERE p.id=$1`, [req.params.id]);
  if (!rows[0]) throw new HttpError(404, 'Product not found');
  res.json(rows[0]);
}));

router.patch('/products/:id/review', ah(async (req, res) => {
  const action = req.body.action;
  const status = action === 'approve' ? 'approved' : action === 'reject' ? 'rejected' : null;
  if (!status) throw new HttpError(400, 'Unknown action');
  if (status === 'rejected' && !req.body.note) throw new HttpError(400, 'Please give a reason');

  const { rows } = await query(
    'UPDATE products SET status=$1, review_note=$2 WHERE id=$3 RETURNING *',
    [status, req.body.note || null, req.params.id]
  );
  const p = rows[0];
  if (!p) throw new HttpError(404, 'Product not found');

  const owner = (await query('SELECT owner_id FROM restaurants WHERE id=$1', [p.restaurant_id])).rows[0];
  if (owner) {
    await notify(owner.owner_id, `Product ${status}`,
      status === 'approved' ? `"${p.name}" is now live on your menu.` : `"${p.name}" was rejected. Reason: ${req.body.note}`, { sms: false });
  }

  await logAudit(req, `product_${action}`, 'product', p.id, { name: p.name, status, note: req.body.note });
  res.json(p);
}));

router.patch('/products/:id/status', ah(async (req, res) => {
  const { status, isAvailable } = req.body;
  const updates = [];
  const vals = [];
  let idx = 1;
  if (status !== undefined) {
    updates.push(`status = $${idx++}`);
    vals.push(status);
  }
  if (isAvailable !== undefined) {
    updates.push(`is_available = $${idx++}`);
    vals.push(isAvailable);
  }
  if (updates.length === 0) throw new HttpError(400, 'No updates provided');
  vals.push(req.params.id);
  const { rows } = await query(
    `UPDATE products SET ${updates.join(', ')} WHERE id=$${idx} RETURNING *`,
    vals
  );
  if (!rows[0]) throw new HttpError(404, 'Product not found');
  await logAudit(req, 'product_status_update', 'product', rows[0].id, { status, isAvailable });
  res.json(rows[0]);
}));

// Food Categories
router.get('/categories', ah(async (_req, res) => {
  const { rows } = await query(
    `SELECT c.id, c.name, r.name AS restaurant_name, COUNT(p.id)::int AS product_count
     FROM categories c
     JOIN restaurants r ON r.id=c.restaurant_id
     LEFT JOIN products p ON p.category_id=c.id
     GROUP BY c.id, c.name, r.name
     ORDER BY c.name`
  );
  res.json(rows);
}));

router.post('/categories', ah(async (req, res) => {
  need(req.body, ['name']);
  const { name, restaurantId } = req.body;
  let targetRestId = restaurantId;
  if (!targetRestId) {
    const firstRest = (await query('SELECT id FROM restaurants LIMIT 1')).rows[0];
    targetRestId = firstRest?.id;
  }
  const { rows } = await query('INSERT INTO categories(restaurant_id, name) VALUES($1, $2) RETURNING *', [targetRestId, name.trim()]);
  await logAudit(req, 'create_category', 'category', rows[0].id, { name });
  res.status(201).json(rows[0]);
}));

router.put('/categories/:id', ah(async (req, res) => {
  need(req.body, ['name']);
  const { rows } = await query('UPDATE categories SET name=$1 WHERE id=$2 RETURNING *', [req.body.name.trim(), req.params.id]);
  if (!rows[0]) throw new HttpError(404, 'Category not found');
  await logAudit(req, 'update_category', 'category', rows[0].id, { name: req.body.name });
  res.json(rows[0]);
}));

router.delete('/categories/:id', ah(async (req, res) => {
  await query('DELETE FROM categories WHERE id=$1', [req.params.id]);
  await logAudit(req, 'delete_category', 'category', req.params.id, {});
  res.json({ ok: true });
}));

// Reported Foods
router.get('/food/reported', ah(async (_req, res) => {
  const { rows } = await query(
    `SELECT p.*, r.name AS restaurant_name, c.name AS category_name,
       (SELECT COUNT(*) FROM support_tickets st WHERE st.category='complaint' AND st.subject ILIKE '%'||p.name||'%')::int AS report_count
     FROM products p
     JOIN restaurants r ON r.id=p.restaurant_id
     LEFT JOIN categories c ON c.id=p.category_id
     WHERE p.status='rejected' OR p.is_available=false
     ORDER BY p.updated_at DESC LIMIT 50`
  );
  res.json(rows);
}));

// ==========================================
// 4. CUSTOMER MANAGEMENT
// ==========================================
router.get('/customers', ah(async (req, res) => {
  const { status = '', verified = '', search = '' } = req.query;
  const { rows } = await query(
    `SELECT u.id, u.name, u.email, u.phone, u.status, u.email_verified, u.phone_verified, u.created_at,
       COUNT(o.id)::int AS order_count,
       COALESCE(SUM(o.total) FILTER (WHERE o.payment_status='paid'), 0)::float AS total_spent,
       MAX(o.created_at) AS last_order_date
     FROM users u
     LEFT JOIN orders o ON o.customer_id = u.id AND o.status<>'pending_payment'
     WHERE u.role='customer'
       AND ($1='' OR u.status=$1)
       AND ($2='' OR (u.email_verified = ($2='true')))
       AND ($3='' OR u.name ILIKE '%'||$3||'%' OR u.email ILIKE '%'||$3||'%' OR u.phone ILIKE '%'||$3||'%')
     GROUP BY u.id
     ORDER BY u.created_at DESC LIMIT 300`, [status, verified, search]);
  res.json(rows);
}));

router.get('/customers/:id', ah(async (req, res) => {
  const u = (await query('SELECT id,name,email,phone,role,status,email_verified,phone_verified,created_at FROM users WHERE id=$1 AND role=\'customer\'', [req.params.id])).rows[0];
  if (!u) throw new HttpError(404, 'Customer not found');

  const [orders, tickets, addresses] = await Promise.all([
    query(`${ORDER_SELECT} WHERE o.customer_id=$1 ORDER BY o.created_at DESC LIMIT 20`, [u.id]),
    query('SELECT * FROM support_tickets WHERE user_id=$1 ORDER BY created_at DESC', [u.id]),
    query('SELECT * FROM addresses WHERE user_id=$1', [u.id])
  ]);

  res.json({
    customer: u,
    orders: orders.rows,
    tickets: tickets.rows,
    addresses: addresses.rows
  });
}));

router.patch('/customers/:id/status', ah(async (req, res) => {
  const { status } = req.body;
  if (!['active', 'suspended'].includes(status)) throw new HttpError(400, 'Invalid status');
  const { rows } = await query('UPDATE users SET status=$1 WHERE id=$2 AND role=\'customer\' RETURNING id,status,name,email', [status, req.params.id]);
  if (!rows[0]) throw new HttpError(404, 'Customer not found');
  await logAudit(req, `customer_${status}`, 'user', rows[0].id, { name: rows[0].name, status });
  res.json(rows[0]);
}));

router.patch('/customers/:id/verify', ah(async (req, res) => {
  const { rows } = await query('UPDATE users SET email_verified=true, phone_verified=true WHERE id=$1 AND role=\'customer\' RETURNING id,email_verified,phone_verified', [req.params.id]);
  if (!rows[0]) throw new HttpError(404, 'Customer not found');
  await logAudit(req, 'customer_manual_verify', 'user', rows[0].id, {});
  res.json(rows[0]);
}));

// ==========================================
// 5. RIDER MANAGEMENT
// ==========================================
router.get('/riders', ah(async (req, res) => {
  const { status = '', search = '' } = req.query;
  const { rows } = await query(
    `SELECT rp.*, u.name, u.email, u.phone, u.status AS account_status, u.created_at AS joined_at,
       (SELECT COUNT(*) FROM orders o WHERE o.rider_id=u.id AND o.status='delivered')::int AS deliveries,
       (SELECT COUNT(*) FROM orders o WHERE o.rider_id=u.id AND o.status IN ('picked_up','ready'))::int AS active_deliveries,
       (SELECT updated_at FROM rider_locations rl WHERE rl.rider_id=u.id) AS last_location_update
     FROM rider_profiles rp
     JOIN users u ON u.id=rp.user_id
     WHERE ($1='' OR rp.status=$1)
       AND ($2='' OR u.name ILIKE '%'||$2||'%' OR u.phone ILIKE '%'||$2||'%')
     ORDER BY u.created_at DESC`, [status, search]);
  res.json(rows);
}));

router.get('/riders/:id', ah(async (req, res) => {
  const r = (await query(
    `SELECT rp.*, u.name, u.email, u.phone, u.status AS account_status, u.created_at AS joined_at,
       (SELECT COUNT(*) FROM orders o WHERE o.rider_id=u.id AND o.status='delivered')::int AS deliveries
     FROM rider_profiles rp JOIN users u ON u.id=rp.user_id WHERE rp.user_id=$1`, [req.params.id])).rows[0];
  if (!r) throw new HttpError(404, 'Rider not found');

  const [deliveries, documents, location] = await Promise.all([
    query(`${ORDER_SELECT} WHERE o.rider_id=$1 ORDER BY o.created_at DESC LIMIT 20`, [r.user_id]),
    query('SELECT * FROM rider_documents WHERE rider_id=$1 ORDER BY created_at DESC', [r.user_id]),
    query('SELECT * FROM rider_locations WHERE rider_id=$1', [r.user_id])
  ]);

  res.json({
    rider: r,
    deliveries: deliveries.rows,
    documents: documents.rows,
    location: location.rows[0] || null
  });
}));

router.patch('/riders/:id/review', ah(async (req, res) => {
  const action = req.body.action;
  const status = action === 'approve' ? 'approved' : action === 'reject' ? 'rejected' : action === 'suspend' ? 'rejected' : null;
  if (!status) throw new HttpError(400, 'Unknown action');
  if (status === 'rejected' && !req.body.note) throw new HttpError(400, 'Please give a reason');

  const { rows } = await query(
    'UPDATE rider_profiles SET status=$1, review_note=$2 WHERE user_id=$3 RETURNING *',
    [status, req.body.note || null, req.params.id]
  );
  if (!rows[0]) throw new HttpError(404, 'Rider not found');

  await notify(req.params.id, `Rider account ${status}`,
    status === 'approved' ? 'You can now accept deliveries from your dashboard.' : `Your rider application status: ${status}. Reason: ${req.body.note}`);
  await logAudit(req, `rider_${action}`, 'rider', req.params.id, { status, note: req.body.note });
  res.json(rows[0]);
}));

// Rider Documents / Verification
router.get('/rider-documents', ah(async (req, res) => {
  const { status = '', search = '' } = req.query;
  const { rows } = await query(
    `SELECT rd.*, u.name AS rider_name, u.email AS rider_email, u.phone AS rider_phone, rp.vehicle_type
     FROM rider_documents rd
     JOIN users u ON u.id=rd.rider_id
     LEFT JOIN rider_profiles rp ON rp.user_id=u.id
     WHERE ($1='' OR rd.status=$1)
       AND ($2='' OR u.name ILIKE '%'||$2||'%' OR rd.document_type ILIKE '%'||$2||'%')
     ORDER BY rd.created_at DESC`, [status, search]);
  res.json(rows);
}));

router.patch('/rider-documents/:id/review', ah(async (req, res) => {
  const { status, note } = req.body;
  if (!['verified', 'rejected', 'pending'].includes(status)) throw new HttpError(400, 'Invalid status');
  const { rows } = await query(
    `UPDATE rider_documents SET status=$1, review_note=$2 WHERE id=$3 RETURNING *`,
    [status, note || null, req.params.id]
  );
  if (!rows[0]) throw new HttpError(404, 'Document not found');
  await logAudit(req, `rider_doc_${status}`, 'rider_document', rows[0].id, { note, status });
  res.json(rows[0]);
}));

// Rider Performance stats
router.get('/rider-performance', ah(async (_req, res) => {
  const { rows } = await query(
    `SELECT rp.*, u.name, u.email, u.phone, u.status AS account_status,
       (SELECT COUNT(*) FROM orders o WHERE o.rider_id=u.id AND o.status='delivered')::int AS total_deliveries,
       (SELECT COUNT(*) FROM orders o WHERE o.rider_id=u.id AND o.status IN ('picked_up','ready'))::int AS active_deliveries,
       (SELECT COALESCE(SUM(delivery_fee * 0.8), 0)::float FROM orders o WHERE o.rider_id=u.id AND o.status='delivered') AS estimated_earnings,
       (SELECT updated_at FROM rider_locations rl WHERE rl.rider_id=u.id) AS last_location_update
     FROM rider_profiles rp
     JOIN users u ON u.id=rp.user_id
     ORDER BY total_deliveries DESC`
  );
  res.json(rows);
}));

// Delivery Zones
router.get('/delivery-zones', ah(async (_req, res) => {
  const { rows } = await query('SELECT * FROM delivery_zones ORDER BY name');
  res.json(rows);
}));

router.post('/delivery-zones', ah(async (req, res) => {
  need(req.body, ['name', 'baseDeliveryFee']);
  const { name, city = 'Accra', description = '', baseDeliveryFee } = req.body;
  const { rows } = await query(
    'INSERT INTO delivery_zones(name, city, description, base_delivery_fee) VALUES($1, $2, $3, $4) RETURNING *',
    [name.trim(), city.trim(), description.trim(), Number(baseDeliveryFee)]
  );
  await logAudit(req, 'create_delivery_zone', 'delivery_zones', rows[0].id, { name });
  res.status(201).json(rows[0]);
}));

router.put('/delivery-zones/:id', ah(async (req, res) => {
  const { name, city, description, baseDeliveryFee, isActive } = req.body;
  const { rows } = await query(
    `UPDATE delivery_zones SET
       name=COALESCE($1, name), city=COALESCE($2, city),
       description=COALESCE($3, description), base_delivery_fee=COALESCE($4, base_delivery_fee),
       is_active=COALESCE($5, is_active)
     WHERE id=$6 RETURNING *`,
    [name, city, description, baseDeliveryFee ? Number(baseDeliveryFee) : null, isActive, req.params.id]
  );
  if (!rows[0]) throw new HttpError(404, 'Zone not found');
  res.json(rows[0]);
}));

router.delete('/delivery-zones/:id', ah(async (req, res) => {
  await query('DELETE FROM delivery_zones WHERE id=$1', [req.params.id]);
  res.json({ ok: true });
}));

// ==========================================
// 6. ORDER MANAGEMENT
// ==========================================
router.get('/orders', ah(async (req, res) => {
  const { status = '', payment = '', search = '' } = req.query;
  const { rows } = await query(
    `${ORDER_SELECT}
     WHERE ($1='' OR o.status=$1)
       AND ($2='' OR o.payment_status=$2)
       AND ($3='' OR o.id::text ILIKE '%'||$3||'%' OR r.name ILIKE '%'||$3||'%' OR u.name ILIKE '%'||$3||'%')
     ORDER BY o.created_at DESC LIMIT 300`, [status, payment, search]);
  res.json(rows);
}));

router.get('/orders/:id', ah(async (req, res) => {
  const { rows } = await query(`${ORDER_SELECT} WHERE o.id=$1`, [req.params.id]);
  if (!rows[0]) throw new HttpError(404, 'Order not found');
  const [history, payments, tickets] = await Promise.all([
    query('SELECT * FROM order_status_history WHERE order_id=$1 ORDER BY created_at ASC', [req.params.id]),
    query('SELECT * FROM payments WHERE order_id=$1 ORDER BY created_at ASC', [req.params.id]),
    query('SELECT * FROM support_tickets WHERE order_id=$1', [req.params.id])
  ]);
  res.json({ order: rows[0], history: history.rows, payments: payments.rows, tickets: tickets.rows });
}));

router.patch('/orders/:id/status', ah(async (req, res) => {
  const { status, note } = req.body;
  if (!['placed','accepted','preparing','ready','picked_up','delivered','cancelled'].includes(status)) {
    throw new HttpError(400, 'Invalid order status');
  }
  const { rows } = await query('UPDATE orders SET status=$1, updated_at=now() WHERE id=$2 RETURNING *', [status, req.params.id]);
  if (!rows[0]) throw new HttpError(404, 'Order not found');
  await notify(rows[0].customer_id, 'Order status updated', `Your order #${rows[0].id.slice(0, 8).toUpperCase()} is now ${status}.`);
  await logAudit(req, 'order_status_override', 'order', req.params.id, { status, note });
  res.json(rows[0]);
}));

// ==========================================
// 7. PAYMENTS, COMMISSIONS & REFUNDS
// ==========================================
router.get('/payments', ah(async (req, res) => {
  const { kind = '', status = '', search = '' } = req.query;
  const [rows, summary, commissions] = await Promise.all([
    query(`SELECT p.*, u.name AS customer_name, r.name AS restaurant_name
           FROM payments p
           JOIN orders o ON o.id=p.order_id
           JOIN users u ON u.id=o.customer_id
           JOIN restaurants r ON r.id=o.restaurant_id
           WHERE ($1='' OR p.kind=$1) AND ($2='' OR p.status=$2)
             AND ($3='' OR p.reference ILIKE '%'||$3||'%' OR r.name ILIKE '%'||$3||'%')
           ORDER BY p.created_at DESC LIMIT 300`, [kind, status, search]),
    query(`SELECT COALESCE(SUM(amount) FILTER (WHERE kind='charge' AND status='success'),0)::float AS collected,
                  COALESCE(SUM(amount) FILTER (WHERE kind='refund' AND status IN ('success','pending')),0)::float AS refunded,
                  COUNT(*) FILTER (WHERE status='failed')::int AS failed
           FROM payments`),
    query(`SELECT COALESCE(SUM(commission_amount),0)::float AS total_commission,
                  COALESCE(SUM(restaurant_payout),0)::float AS total_payouts
           FROM orders WHERE payment_status='paid'`)
  ]);
  res.json({ summary: summary.rows[0], commissions: commissions.rows[0], rows: rows.rows });
}));

const dueRefund = async (id) => {
  const o = (await query(`SELECT * FROM orders WHERE id=$1 AND payment_status='refund_pending'`, [id])).rows[0];
  if (!o) throw new HttpError(400, 'This order has no pending refund');
  return o;
};

const finishRefund = async (o, reference, status, req) => {
  await query(`UPDATE orders SET payment_status='refunded' WHERE id=$1`, [o.id]);
  await query(`INSERT INTO payments(order_id,kind,reference,amount,currency,status,paid_at) VALUES($1,'refund',$2,$3,$4,$5,now())
               ON CONFLICT (reference) DO NOTHING`, [o.id, reference, o.total, env.currency, status]);
  await notify(o.customer_id, 'Refund on its way', `Your refund of ${o.total} for order #${o.id.slice(0, 8).toUpperCase()} has been issued.`);
  await logAudit(req, 'process_refund', 'order', o.id, { reference, amount: o.total, status });
};

router.post('/orders/:id/refund', ah(async (req, res) => {
  const o = await dueRefund(req.params.id);
  const data = await refundPayment(o.payment_reference);
  await finishRefund(o, `refund_${o.payment_reference}`, data.status === 'processed' ? 'success' : 'pending', req);
  res.json({ ok: true, providerStatus: data.status });
}));

router.patch('/orders/:id/refunded', ah(async (req, res) => {
  const o = await dueRefund(req.params.id);
  await finishRefund(o, `manual_refund_${o.id}`, 'success', req);
  res.json({ ok: true });
}));

// ==========================================
// 8. NOTIFICATION MANAGEMENT
// ==========================================
router.get('/notifications/templates', ah(async (_req, res) => {
  const { rows } = await query('SELECT * FROM notification_templates ORDER BY name');
  res.json(rows);
}));

router.put('/notifications/templates/:id', ah(async (req, res) => {
  const { subject, body } = req.body;
  const { rows } = await query(
    'UPDATE notification_templates SET subject=$1, body=$2, updated_at=now() WHERE id=$3 RETURNING *',
    [subject || '', body, req.params.id]
  );
  if (!rows[0]) throw new HttpError(404, 'Template not found');
  await logAudit(req, 'update_notification_template', 'notification_templates', rows[0].id, { name: rows[0].name });
  res.json(rows[0]);
}));

router.get('/notifications/logs', ah(async (req, res) => {
  const { channel = '' } = req.query;
  const { rows } = await query(
    `SELECT * FROM notification_logs WHERE ($1='' OR channel=$1) ORDER BY created_at DESC LIMIT 100`,
    [channel]
  );
  res.json(rows);
}));

router.post('/notifications/send', ah(async (req, res) => {
  need(req.body, ['channel', 'message']);
  const { channel, recipient, title = '', message, targetRole = 'all' } = req.body;
  
  const { rows } = await query(
    `INSERT INTO notification_logs(channel, recipient, title, content, status)
     VALUES($1, $2, $3, $4, 'sent') RETURNING *`,
    [channel, recipient || targetRole, title, message]
  );

  if (recipient) {
    const userRes = await query('SELECT id FROM users WHERE email=$1 OR phone=$1', [recipient]);
    if (userRes.rows[0]) {
      await notify(userRes.rows[0].id, title || 'Platform Notification', message, {
        sms: channel === 'sms',
        email: channel === 'email'
      });
    }
  }

  await logAudit(req, `send_${channel}_notification`, 'notification_logs', rows[0].id, { recipient, channel });
  res.status(201).json(rows[0]);
}));

router.get('/announcements', ah(async (_req, res) => {
  const { rows } = await query('SELECT * FROM platform_announcements ORDER BY created_at DESC');
  res.json(rows);
}));

router.post('/announcements', ah(async (req, res) => {
  need(req.body, ['title', 'message']);
  const { title, message, targetRole = 'all' } = req.body;
  const { rows } = await query(
    'INSERT INTO platform_announcements(title, message, target_role) VALUES($1, $2, $3) RETURNING *',
    [title.trim(), message.trim(), targetRole]
  );
  await logAudit(req, 'create_announcement', 'announcement', rows[0].id, { title, targetRole });
  res.status(201).json(rows[0]);
}));

router.delete('/announcements/:id', ah(async (req, res) => {
  await query('DELETE FROM platform_announcements WHERE id=$1', [req.params.id]);
  res.json({ ok: true });
}));

// ==========================================
// 9. SUPPORT MANAGEMENT & TICKETS
// ==========================================
router.get('/support/tickets', ah(async (req, res) => {
  const { status = '', category = '', userRole = '', search = '' } = req.query;
  const { rows } = await query(
    `SELECT t.*, u.name AS user_name, u.email AS user_email, u.phone AS user_phone,
       r.name AS restaurant_name
     FROM support_tickets t
     JOIN users u ON u.id = t.user_id
     LEFT JOIN restaurants r ON r.id = t.restaurant_id
     WHERE ($1='' OR t.status=$1)
       AND ($2='' OR t.category=$2)
       AND ($3='' OR t.user_role=$3)
       AND ($4='' OR t.subject ILIKE '%'||$4||'%' OR t.ticket_number ILIKE '%'||$4||'%' OR u.name ILIKE '%'||$4||'%')
     ORDER BY t.created_at DESC`, [status, category, userRole, search]);
  res.json(rows);
}));

router.get('/support/tickets/:id', ah(async (req, res) => {
  const t = (await query(
    `SELECT t.*, u.name AS user_name, u.email AS user_email, u.phone AS user_phone, r.name AS restaurant_name
     FROM support_tickets t JOIN users u ON u.id=t.user_id LEFT JOIN restaurants r ON r.id=t.restaurant_id WHERE t.id=$1`,
    [req.params.id]
  )).rows[0];
  if (!t) throw new HttpError(404, 'Ticket not found');

  const messages = (await query(
    'SELECT * FROM ticket_messages WHERE ticket_id=$1 ORDER BY created_at ASC', [t.id]
  )).rows;

  res.json({ ticket: t, messages });
}));

router.post('/support/tickets/:id/reply', ah(async (req, res) => {
  need(req.body, ['message']);
  const t = (await query('SELECT * FROM support_tickets WHERE id=$1', [req.params.id])).rows[0];
  if (!t) throw new HttpError(404, 'Ticket not found');

  const { rows } = await query(
    `INSERT INTO ticket_messages(ticket_id, sender_id, sender_name, message) VALUES($1, $2, $3, $4) RETURNING *`,
    [t.id, req.user.id, `Admin: ${req.user.name}`, req.body.message.trim()]
  );
  await query('UPDATE support_tickets SET status=\'in_progress\', updated_at=now() WHERE id=$1', [t.id]);
  await notify(t.user_id, 'Support Ticket Update', `An administrator replied to your ticket #${t.ticket_number}.`);

  res.status(201).json(rows[0]);
}));

router.patch('/support/tickets/:id/status', ah(async (req, res) => {
  const { status, notes } = req.body;
  if (!['open', 'in_progress', 'resolved', 'closed'].includes(status)) throw new HttpError(400, 'Invalid status');
  const { rows } = await query(
    'UPDATE support_tickets SET status=$1, resolution_notes=COALESCE($2, resolution_notes), updated_at=now() WHERE id=$3 RETURNING *',
    [status, notes || null, req.params.id]
  );
  if (!rows[0]) throw new HttpError(404, 'Ticket not found');
  await notify(rows[0].user_id, 'Support ticket update', `Ticket #${rows[0].ticket_number} marked as ${status}.`);
  await logAudit(req, `support_ticket_${status}`, 'ticket', req.params.id, { status, notes });
  res.json(rows[0]);
}));

// ==========================================
// 10. SYSTEM & SECURITY MONITORING
// ==========================================
router.get('/system/admins', ah(async (_req, res) => {
  const { rows } = await query('SELECT id,name,email,phone,role,status,created_at FROM users WHERE role=\'admin\' ORDER BY created_at DESC');
  res.json(rows);
}));

router.post('/system/admins', ah(async (req, res) => {
  need(req.body, ['name', 'email', 'phone', 'password']);
  const { name, phone, password } = req.body;
  const email = req.body.email.toLowerCase().trim();
  const hash = await bcrypt.hash(password, 12);
  const { rows } = await query(
    `INSERT INTO users(name,email,phone,password_hash,role,email_verified,phone_verified)
     VALUES($1,$2,$3,$4,'admin',true,true) RETURNING id,name,email,phone,role,status,created_at`,
    [name.trim(), email, phone.trim(), hash]
  );
  await logAudit(req, 'create_admin_user', 'users', rows[0].id, { email });
  res.status(201).json(rows[0]);
}));

// Roles and permissions
router.get('/system/roles', ah(async (_req, res) => {
  const { rows } = await query('SELECT value FROM platform_settings WHERE key=\'admin_roles\'');
  if (rows[0]?.value) {
    const val = typeof rows[0].value === 'string' ? JSON.parse(rows[0].value) : rows[0].value;
    return res.json(val);
  }
  const defaultRoles = [
    {
      id: 'super_admin',
      name: 'Super Administrator',
      description: 'Full root access to all management modules, approvals, finances, and system settings.',
      usersCount: 1,
      isSystem: true,
      permissions: [
        'manage_restaurants', 'approve_restaurants', 'suspend_restaurants',
        'manage_customers', 'suspend_customers', 'verify_customers',
        'manage_menu', 'approve_food',
        'manage_riders', 'approve_riders', 'dispatch_orders',
        'manage_orders', 'override_order_status',
        'manage_payments', 'process_refunds', 'settle_commissions',
        'manage_notifications', 'manage_support',
        'view_analytics', 'export_reports',
        'manage_admins', 'manage_roles', 'view_audit_logs',
        'manage_settings'
      ]
    },
    {
      id: 'operations_manager',
      name: 'Operations Manager',
      description: 'Oversees restaurant onboarding, rider dispatch, customer support, and order dispute handling.',
      usersCount: 2,
      isSystem: false,
      permissions: [
        'manage_restaurants', 'approve_restaurants',
        'manage_customers', 'verify_customers',
        'manage_menu', 'approve_food',
        'manage_riders', 'approve_riders', 'dispatch_orders',
        'manage_orders', 'manage_support', 'view_analytics'
      ]
    },
    {
      id: 'financial_controller',
      name: 'Financial Controller',
      description: 'Manages transactions, refund requests, restaurant commissions, payouts, and financial exports.',
      usersCount: 1,
      isSystem: false,
      permissions: [
        'manage_payments', 'process_refunds', 'settle_commissions',
        'view_analytics', 'export_reports'
      ]
    },
    {
      id: 'support_agent',
      name: 'Support Agent',
      description: 'First line of customer, restaurant, and rider ticket management and issue resolution.',
      usersCount: 3,
      isSystem: false,
      permissions: [
        'manage_customers', 'manage_support', 'manage_orders'
      ]
    }
  ];
  res.json(defaultRoles);
}));

router.put('/system/roles', ah(async (req, res) => {
  const { roles } = req.body;
  if (!Array.isArray(roles)) throw new HttpError(400, 'Roles must be an array');
  await query(
    `INSERT INTO platform_settings(key, value, updated_at) VALUES('admin_roles', $1, now())
     ON CONFLICT (key) DO UPDATE SET value=EXCLUDED.value, updated_at=now()`,
    [JSON.stringify(roles)]
  );
  await logAudit(req, 'update_admin_roles', 'platform_settings', 'admin_roles', { count: roles.length });
  res.json({ ok: true, roles });
}));

router.get('/system/audit-logs', ah(async (req, res) => {
  const { action = '', search = '' } = req.query;
  const { rows } = await query(
    `SELECT * FROM audit_logs
     WHERE ($1='' OR action ILIKE '%'||$1||'%')
       AND ($2='' OR user_name ILIKE '%'||$2||'%' OR entity_type ILIKE '%'||$2||'%' OR entity_id ILIKE '%'||$2||'%')
     ORDER BY created_at DESC LIMIT 300`, [action, search]);
  res.json(rows);
}));

router.get('/system/security', ah(async (_req, res) => {
  const [alerts, failedLogins] = await Promise.all([
    query('SELECT * FROM auth_alerts ORDER BY created_at DESC LIMIT 100'),
    query('SELECT COUNT(*)::int AS count FROM auth_alerts WHERE event_type LIKE \'%failed%\' AND created_at >= now() - interval \'24 hours\'')
  ]);
  res.json({ alerts: alerts.rows, failed24h: failedLogins.rows[0].count });
}));

router.get('/system/health', ah(async (_req, res) => {
  const [dbCheck, counts] = await Promise.all([
    query('SELECT 1 AS healthy, now() AS server_time'),
    query(`SELECT
      (SELECT COUNT(*) FROM users)::int AS users,
      (SELECT COUNT(*) FROM orders)::int AS orders,
      (SELECT COUNT(*) FROM payments)::int AS payments,
      (SELECT COUNT(*) FROM products)::int AS products,
      (SELECT COUNT(*) FROM api_error_logs)::int AS total_errors`)
  ]);
  res.json({
    status: 'operational',
    dbConnected: !!dbCheck.rows[0],
    serverTime: dbCheck.rows[0]?.server_time,
    metrics: counts.rows[0],
    uptimeSeconds: Math.floor(process.uptime()),
    nodeVersion: process.version,
    memoryUsage: process.memoryUsage()
  });
}));

router.get('/system/api-logs', ah(async (_req, res) => {
  const { rows } = await query('SELECT * FROM api_error_logs ORDER BY created_at DESC LIMIT 100');
  res.json(rows);
}));

// ==========================================
// 11. PLATFORM SETTINGS (Comprehensive)
// ==========================================
router.get('/settings/all', ah(async (_req, res) => {
  const { rows } = await query('SELECT key, value, updated_at FROM platform_settings');
  const settingsMap = {};
  rows.forEach(r => { settingsMap[r.key] = r.value; });
  res.json(settingsMap);
}));

router.put('/settings/all', ah(async (req, res) => {
  const settings = req.body;
  for (const [key, val] of Object.entries(settings)) {
    await query(
      `INSERT INTO platform_settings(key, value, updated_at) VALUES($1, $2, now())
       ON CONFLICT (key) DO UPDATE SET value=EXCLUDED.value, updated_at=now()`,
      [key, JSON.stringify(val)]
    );
  }
  await logAudit(req, 'update_all_platform_settings', 'platform_settings', 'all', { keys: Object.keys(settings) });
  res.json({ ok: true });
}));

router.put('/settings/section/:section', ah(async (req, res) => {
  const { section } = req.params;
  const payload = req.body;

  if (section === 'platform') {
    if (payload.commissionPercent !== undefined) await query('UPDATE platform_settings SET value=$1 WHERE key=\'commission_percent\'', [JSON.stringify(Number(payload.commissionPercent))]);
    if (payload.deliveryRadiusKm !== undefined) await query('UPDATE platform_settings SET value=$1 WHERE key=\'delivery_radius_km\'', [JSON.stringify(Number(payload.deliveryRadiusKm))]);
    if (payload.platformOpen !== undefined) await query('UPDATE platform_settings SET value=$1 WHERE key=\'platform_open\'', [JSON.stringify(!!payload.platformOpen)]);
  } else {
    await query(
      `INSERT INTO platform_settings(key, value, updated_at) VALUES($1, $2, now())
       ON CONFLICT (key) DO UPDATE SET value=EXCLUDED.value, updated_at=now()`,
      [section, JSON.stringify(payload)]
    );
  }

  await logAudit(req, `update_settings_${section}`, 'platform_settings', section, payload);
  res.json({ ok: true, section, updated: payload });
}));

// Legacy settings endpoints
router.get('/settings', ah(async (_req, res) => res.json(await getSettings())));
router.put('/settings', ah(async (req, res) => {
  const commissionPercent = Number(req.body.commissionPercent);
  const deliveryRadiusKm = Number(req.body.deliveryRadiusKm);
  if (!(commissionPercent >= 0 && commissionPercent <= 50)) throw new HttpError(400, 'Commission must be between 0 and 50 percent');
  if (!(deliveryRadiusKm >= 1 && deliveryRadiusKm <= 200)) throw new HttpError(400, 'Delivery radius must be between 1 and 200 km');
  await saveSettings({ commissionPercent, deliveryRadiusKm, platformOpen: !!req.body.platformOpen });
  await logAudit(req, 'update_legacy_settings', 'platform_settings', 'general', req.body);
  res.json(await getSettings());
}));

// ==========================================
// 12. GENERAL USERS FALLBACK
// ==========================================
router.get('/users', ah(async (req, res) => {
  const { role = '', search = '' } = req.query;
  const { rows } = await query(
    `SELECT id,name,email,phone,role,status,email_verified,created_at FROM users
     WHERE ($1='' OR role=$1) AND ($2='' OR name ILIKE '%'||$2||'%' OR email ILIKE '%'||$2||'%') ORDER BY created_at DESC LIMIT 300`, [role, search]);
  res.json(rows);
}));

router.patch('/users/:id/status', ah(async (req, res) => {
  if (!['active', 'suspended'].includes(req.body.status)) throw new HttpError(400, 'Invalid status');
  if (req.params.id === req.user.id) throw new HttpError(400, 'You cannot suspend your own account');
  const { rows } = await query(`UPDATE users SET status=$1 WHERE id=$2 AND role<>'admin' RETURNING id,status`, [req.body.status, req.params.id]);
  if (!rows[0]) throw new HttpError(404, 'User not found');
  await logAudit(req, `user_status_${req.body.status}`, 'users', req.params.id, { status: req.body.status });
  res.json(rows[0]);
}));

export default router;