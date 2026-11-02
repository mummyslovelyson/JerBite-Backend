import { Router } from 'express';
import { query } from '../config/db.js';
import { ah, HttpError, need } from '../utils/http.js';
import { getSettings } from '../lib/settings.js';

const router = Router();

router.get('/restaurants', ah(async (req, res) => {
  const { search = '', cuisine = '', category = '' } = req.query;
  const { rows } = await query(
    `SELECT r.id, r.name, r.description, r.cuisine, r.city, r.logo_url, r.cover_url,
            r.delivery_fee, r.min_order, r.prep_time_minutes, r.is_open, r.address,
            COALESCE(AVG(rev.rating), 4.8)::numeric(2,1) AS rating,
            COUNT(rev.id)::int AS review_count
     FROM restaurants r
     LEFT JOIN restaurant_reviews rev ON rev.restaurant_id = r.id
     WHERE r.status='approved'
       AND ($1='' OR r.name ILIKE '%'||$1||'%' OR r.cuisine ILIKE '%'||$1||'%' OR r.description ILIKE '%'||$1||'%')
       AND ($2='' OR r.cuisine ILIKE $2)
       AND ($3='' OR EXISTS (
         SELECT 1 FROM products p JOIN categories c ON c.id=p.category_id
         WHERE p.restaurant_id=r.id AND c.name ILIKE '%'||$3||'%' AND p.status='approved' AND p.is_available
       ))
     GROUP BY r.id
     ORDER BY r.is_open DESC, rating DESC, r.name`, [search, cuisine, category]);
  res.json(rows);
}));

router.get('/restaurants/:id', ah(async (req, res) => {
  const r = (await query(`SELECT * FROM restaurants WHERE id=$1 AND status='approved'`, [req.params.id])).rows[0];
  if (!r) throw new HttpError(404, 'Restaurant not found');
  delete r.review_note; delete r.owner_id;
  const categories = (await query('SELECT id,name FROM categories WHERE restaurant_id=$1 ORDER BY name', [r.id])).rows;
  const products = (await query(
    `SELECT id,name,description,price,image_url,category_id FROM products
     WHERE restaurant_id=$1 AND status='approved' AND is_available ORDER BY name`, [r.id])).rows;
  const reviews = (await query(
    `SELECT rev.id, rev.rating, rev.comment, rev.manager_reply, rev.created_at, u.name AS customer_name
     FROM restaurant_reviews rev
     JOIN users u ON u.id = rev.customer_id
     WHERE rev.restaurant_id = $1
     ORDER BY rev.created_at DESC LIMIT 15`, [r.id])).rows;
  res.json({ restaurant: r, categories, products, reviews });
}));

// Dish search across all approved restaurants
router.get('/dishes', ah(async (req, res) => {
  const { search = '', category = '', limit = 60 } = req.query;
  const lim = Math.min(Number(limit) || 60, 100);
  const { rows } = await query(
    `SELECT p.id, p.name, p.description, p.price, p.image_url, p.category_id,
            r.id AS restaurant_id, r.name AS restaurant_name, r.delivery_fee, r.prep_time_minutes,
            c.name AS category_name
     FROM products p
     JOIN restaurants r ON r.id=p.restaurant_id
     LEFT JOIN categories c ON c.id=p.category_id
     WHERE p.status='approved' AND p.is_available AND r.status='approved'
       AND ($1='' OR p.name ILIKE '%'||$1||'%' OR p.description ILIKE '%'||$1||'%' OR r.name ILIKE '%'||$1||'%')
       AND ($2='' OR (c.name IS NOT NULL AND c.name ILIKE '%'||$2||'%'))
     ORDER BY p.name LIMIT $3`, [search, category, lim]);
  res.json(rows);
}));

// Food Categories list across all active menus
router.get('/categories', ah(async (_req, res) => {
  const { rows } = await query(
    `SELECT c.name, COUNT(p.id)::int AS count
     FROM categories c
     JOIN products p ON p.category_id=c.id
     JOIN restaurants r ON r.id=p.restaurant_id
     WHERE p.status='approved' AND p.is_available AND r.status='approved'
     GROUP BY c.name
     ORDER BY count DESC LIMIT 12`
  );
  res.json(rows);
}));

// Public Active Promotions
router.get('/promotions', ah(async (_req, res) => {
  const { rows } = await query(
    `SELECT p.id, p.title, p.description, p.code, p.discount_type, p.discount_value,
            p.min_order_amount, p.end_date, r.name AS restaurant_name
     FROM promotions p
     LEFT JOIN restaurants r ON r.id = p.restaurant_id
     WHERE p.is_active AND p.status='approved' AND (p.end_date IS NULL OR p.end_date > now())
     ORDER BY p.created_at DESC LIMIT 10`
  );
  res.json(rows);
}));

// Public support ticket submission
router.post('/support/ticket', ah(async (req, res) => {
  need(req.body, ['subject', 'message', 'email', 'name']);
  const ticketNumber = 'TICK-' + Math.floor(100000 + Math.random() * 900000);
  // Link ticket to registered user or route to platform administrative desk
  let user = (await query('SELECT id FROM users WHERE email=$1', [req.body.email.toLowerCase().trim()])).rows[0];
  const userId = user?.id || (await query('SELECT id FROM users WHERE role=\'admin\' LIMIT 1')).rows[0]?.id;
  
  const { rows } = await query(
    `INSERT INTO support_tickets(ticket_number, user_id, user_role, subject, message, category, status)
     VALUES($1, $2, $3, $4, $5, $6, 'open') RETURNING *`,
    [ticketNumber, userId, 'customer', req.body.subject, req.body.message, req.body.category || 'general']
  );
  res.status(201).json(rows[0]);
}));

router.get('/settings/public', ah(async (_req, res) => {
  const s = await getSettings();
  res.json({
    platformOpen: s.platformOpen,
    deliveryRadiusKm: s.deliveryRadiusKm,
    commissionPercent: s.commissionPercent,
    taxPercent: s.taxPercent || 5,
    currencyCode: 'GHS'
  });
}));

export default router;
