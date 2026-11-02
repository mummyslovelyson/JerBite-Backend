import { query } from '../config/db.js';

export async function logAudit(req, action, entityType, entityId = null, details = {}) {
  try {
    const userId = req.user?.id || null;
    const userName = req.user?.name || '';
    const userRole = req.user?.role || '';
    const ip = req.headers['x-forwarded-for'] || req.socket?.remoteAddress || '';
    await query(
      `INSERT INTO audit_logs(user_id, user_name, user_role, action, entity_type, entity_id, details, ip_address)
       VALUES($1, $2, $3, $4, $5, $6, $7, $8)`,
      [userId, userName, userRole, action, entityType, String(entityId || ''), JSON.stringify(details), ip]
    );
  } catch (err) {
    console.error('Audit log failed:', err.message);
  }
}

export async function logAuthAlert(userId, restaurantId, eventType, title, message, req = null) {
  try {
    const ip = req?.headers?.['x-forwarded-for'] || req?.socket?.remoteAddress || '';
    const ua = req?.headers?.['user-agent'] || '';
    await query(
      `INSERT INTO auth_alerts(user_id, restaurant_id, event_type, title, message, ip_address, user_agent)
       VALUES($1, $2, $3, $4, $5, $6, $7)`,
      [userId, restaurantId || null, eventType, title, message, ip, ua]
    );
  } catch (err) {
    console.error('Auth alert failed:', err.message);
  }
}
