import { query } from '../config/db.js';

export async function getSettings() {
  const { rows } = await query('SELECT key, value FROM platform_settings');
  const m = Object.fromEntries(rows.map((r) => [r.key, r.value]));
  return {
    commissionPercent: Number(m.commission_percent ?? 10),
    deliveryRadiusKm: Number(m.delivery_radius_km ?? 15),
    platformOpen: m.platform_open !== false
  };
}

export async function saveSettings({ commissionPercent, deliveryRadiusKm, platformOpen }) {
  const pairs = [['commission_percent', commissionPercent], ['delivery_radius_km', deliveryRadiusKm], ['platform_open', platformOpen]];
  for (const [k, v] of pairs)
    await query(`INSERT INTO platform_settings(key,value) VALUES($1,$2::jsonb)
                 ON CONFLICT (key) DO UPDATE SET value=EXCLUDED.value, updated_at=now()`, [k, JSON.stringify(v)]);
}
