-- 003: admin-editable settings, payments ledger, delivery distance, commission, rider live location.

CREATE TABLE platform_settings (
  key TEXT PRIMARY KEY,
  value JSONB NOT NULL,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
-- Defaults only. The admin changes these from the Settings page.
INSERT INTO platform_settings(key, value) VALUES
  ('commission_percent', '10'),
  ('delivery_radius_km', '15'),
  ('platform_open', 'true');

-- Restaurant location (set by the manager) and customer drop-off location
ALTER TABLE restaurants
  ADD COLUMN latitude NUMERIC(9,6),
  ADD COLUMN longitude NUMERIC(9,6),
  ADD CONSTRAINT restaurants_geo_pair CHECK ((latitude IS NULL) = (longitude IS NULL)),
  ADD CONSTRAINT restaurants_geo_range CHECK (latitude BETWEEN -90 AND 90 AND longitude BETWEEN -180 AND 180);

ALTER TABLE orders
  ADD COLUMN delivery_lat NUMERIC(9,6),
  ADD COLUMN delivery_lng NUMERIC(9,6),
  ADD COLUMN commission_amount NUMERIC(10,2) NOT NULL DEFAULT 0 CHECK (commission_amount >= 0),
  ADD COLUMN restaurant_payout NUMERIC(10,2) NOT NULL DEFAULT 0 CHECK (restaurant_payout >= 0);

-- Payments ledger: every charge attempt and every refund
CREATE TABLE payments (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  order_id UUID NOT NULL REFERENCES orders(id) ON DELETE CASCADE,
  kind TEXT NOT NULL DEFAULT 'charge' CHECK (kind IN ('charge','refund')),
  reference TEXT NOT NULL UNIQUE,
  provider TEXT NOT NULL DEFAULT 'paystack',
  amount NUMERIC(10,2) NOT NULL CHECK (amount >= 0),
  currency TEXT NOT NULL DEFAULT 'GHS',
  status TEXT NOT NULL DEFAULT 'initiated' CHECK (status IN ('initiated','success','failed','pending')),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  paid_at TIMESTAMPTZ
);
CREATE INDEX idx_payments_order ON payments (order_id);
CREATE INDEX idx_payments_created ON payments (created_at DESC);

-- Bring pre-existing orders into the ledger
INSERT INTO payments(order_id, reference, amount, status, paid_at)
SELECT id, payment_reference, total,
  CASE WHEN payment_status IN ('paid','refund_pending','refunded') THEN 'success' ELSE 'initiated' END,
  CASE WHEN payment_status IN ('paid','refund_pending','refunded') THEN updated_at END
FROM orders WHERE payment_reference IS NOT NULL;

-- Latest known position of each rider (one row per rider, overwritten)
CREATE TABLE rider_locations (
  rider_id UUID PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  lat NUMERIC(9,6) NOT NULL CHECK (lat BETWEEN -90 AND 90),
  lng NUMERIC(9,6) NOT NULL CHECK (lng BETWEEN -180 AND 180),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE OR REPLACE FUNCTION purge_stale_data() RETURNS void AS $$
BEGIN
  DELETE FROM otp_codes WHERE expires_at < now() - interval '1 day';
  DELETE FROM notifications WHERE is_read AND created_at < now() - interval '90 days';
  DELETE FROM users WHERE NOT email_verified AND created_at < now() - interval '7 days';
  UPDATE orders SET status = 'cancelled' WHERE status = 'pending_payment' AND created_at < now() - interval '1 day';
  UPDATE payments SET status = 'failed' WHERE kind = 'charge' AND status = 'initiated' AND created_at < now() - interval '1 day';
  DELETE FROM rider_locations WHERE updated_at < now() - interval '1 day';
END $$ LANGUAGE plpgsql;
