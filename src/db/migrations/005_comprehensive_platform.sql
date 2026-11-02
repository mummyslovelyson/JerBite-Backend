-- 005: Comprehensive JerBite Platform Schema Expansion
-- Support tickets, complaints, disputes, audit logs, security alerts,
-- promotions, reviews, staff, notification templates, change requests, and settings

-- 1. Restaurant enhancements
ALTER TABLE restaurants
  ADD COLUMN IF NOT EXISTS pickup_enabled BOOLEAN NOT NULL DEFAULT TRUE,
  ADD COLUMN IF NOT EXISTS delivery_enabled BOOLEAN NOT NULL DEFAULT TRUE,
  ADD COLUMN IF NOT EXISTS service_radius NUMERIC(10,2) DEFAULT 15,
  ADD COLUMN IF NOT EXISTS tax_rate NUMERIC(5,2) DEFAULT 0;

-- 2. Restaurant Profile Change Requests
CREATE TABLE IF NOT EXISTS restaurant_change_requests (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  restaurant_id UUID NOT NULL REFERENCES restaurants(id) ON DELETE CASCADE,
  requested_by UUID NOT NULL REFERENCES users(id),
  changes JSONB NOT NULL,
  reason TEXT,
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','approved','rejected')),
  review_note TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  resolved_at TIMESTAMPTZ
);
CREATE INDEX IF NOT EXISTS idx_rest_change_status ON restaurant_change_requests(status);

-- 3. Restaurant & Rider Documents
CREATE TABLE IF NOT EXISTS restaurant_documents (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  restaurant_id UUID NOT NULL REFERENCES restaurants(id) ON DELETE CASCADE,
  document_type TEXT NOT NULL,
  file_url TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','verified','rejected')),
  review_note TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS rider_documents (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  rider_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  document_type TEXT NOT NULL,
  file_url TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','verified','rejected')),
  review_note TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- 4. Delivery Zones
CREATE TABLE IF NOT EXISTS delivery_zones (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name TEXT NOT NULL,
  city TEXT NOT NULL DEFAULT '',
  description TEXT DEFAULT '',
  base_delivery_fee NUMERIC(10,2) NOT NULL DEFAULT 5.00,
  is_active BOOLEAN NOT NULL DEFAULT TRUE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- 5. Customer Reviews and Feedback
CREATE TABLE IF NOT EXISTS restaurant_reviews (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  restaurant_id UUID NOT NULL REFERENCES restaurants(id) ON DELETE CASCADE,
  customer_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  order_id UUID REFERENCES orders(id) ON DELETE SET NULL,
  rating INT NOT NULL CHECK (rating BETWEEN 1 AND 5),
  comment TEXT DEFAULT '',
  manager_reply TEXT,
  manager_replied_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_reviews_restaurant ON restaurant_reviews(restaurant_id);

-- 6. Support Tickets and Complaints
CREATE TABLE IF NOT EXISTS support_tickets (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  ticket_number TEXT NOT NULL UNIQUE,
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  user_role TEXT NOT NULL DEFAULT 'customer',
  restaurant_id UUID REFERENCES restaurants(id) ON DELETE SET NULL,
  order_id UUID REFERENCES orders(id) ON DELETE SET NULL,
  category TEXT NOT NULL DEFAULT 'general' CHECK (category IN ('general','order','payment','delivery','account','complaint','dispute')),
  subject TEXT NOT NULL,
  message TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open','in_progress','resolved','closed')),
  priority TEXT NOT NULL DEFAULT 'medium' CHECK (priority IN ('low','medium','high','urgent')),
  resolution_notes TEXT,
  assigned_to UUID REFERENCES users(id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_tickets_user ON support_tickets(user_id);
CREATE INDEX IF NOT EXISTS idx_tickets_status ON support_tickets(status);

CREATE TABLE IF NOT EXISTS ticket_messages (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  ticket_id UUID NOT NULL REFERENCES support_tickets(id) ON DELETE CASCADE,
  sender_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  sender_name TEXT NOT NULL,
  message TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- 7. Promotions and Discounts
CREATE TABLE IF NOT EXISTS promotions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  restaurant_id UUID REFERENCES restaurants(id) ON DELETE CASCADE,
  title TEXT NOT NULL,
  description TEXT DEFAULT '',
  code TEXT NOT NULL UNIQUE,
  discount_type TEXT NOT NULL DEFAULT 'percentage' CHECK (discount_type IN ('percentage','fixed')),
  discount_value NUMERIC(10,2) NOT NULL CHECK (discount_value > 0),
  min_order_amount NUMERIC(10,2) NOT NULL DEFAULT 0,
  start_date TIMESTAMPTZ NOT NULL DEFAULT now(),
  end_date TIMESTAMPTZ NOT NULL DEFAULT (now() + interval '30 days'),
  is_active BOOLEAN NOT NULL DEFAULT TRUE,
  status TEXT NOT NULL DEFAULT 'approved' CHECK (status IN ('pending','approved','rejected')),
  review_note TEXT,
  usage_count INT NOT NULL DEFAULT 0,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_promotions_code ON promotions(code);

-- 8. Restaurant Staff Management
CREATE TABLE IF NOT EXISTS restaurant_staff (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  restaurant_id UUID NOT NULL REFERENCES restaurants(id) ON DELETE CASCADE,
  user_id UUID REFERENCES users(id) ON DELETE SET NULL,
  name TEXT NOT NULL,
  email TEXT NOT NULL,
  phone TEXT DEFAULT '',
  role TEXT NOT NULL DEFAULT 'staff' CHECK (role IN ('manager','chef','cashier','staff')),
  permissions JSONB NOT NULL DEFAULT '["orders","menu"]',
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active','invited','suspended')),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- 9. Audit Logs
CREATE TABLE IF NOT EXISTS audit_logs (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID REFERENCES users(id) ON DELETE SET NULL,
  user_name TEXT DEFAULT '',
  user_role TEXT DEFAULT '',
  action TEXT NOT NULL,
  entity_type TEXT NOT NULL,
  entity_id TEXT,
  details JSONB DEFAULT '{}',
  ip_address TEXT DEFAULT '',
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_audit_created ON audit_logs(created_at DESC);

-- 10. Security & Authentication Alerts
CREATE TABLE IF NOT EXISTS auth_alerts (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  restaurant_id UUID REFERENCES restaurants(id) ON DELETE CASCADE,
  event_type TEXT NOT NULL,
  title TEXT NOT NULL,
  message TEXT NOT NULL,
  ip_address TEXT DEFAULT '',
  user_agent TEXT DEFAULT '',
  is_read BOOLEAN NOT NULL DEFAULT FALSE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_auth_alerts_user ON auth_alerts(user_id, created_at DESC);

-- 11. Notification Templates & Logs
CREATE TABLE IF NOT EXISTS notification_templates (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  key TEXT NOT NULL UNIQUE,
  name TEXT NOT NULL,
  channel TEXT NOT NULL CHECK (channel IN ('email','sms','in_app')),
  subject TEXT DEFAULT '',
  body TEXT NOT NULL,
  variables JSONB DEFAULT '[]',
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS notification_logs (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID REFERENCES users(id) ON DELETE SET NULL,
  channel TEXT NOT NULL,
  recipient TEXT NOT NULL,
  title TEXT DEFAULT '',
  content TEXT DEFAULT '',
  status TEXT NOT NULL DEFAULT 'sent' CHECK (status IN ('sent','delivered','failed')),
  error_message TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- 12. Platform Announcements
CREATE TABLE IF NOT EXISTS platform_announcements (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  title TEXT NOT NULL,
  message TEXT NOT NULL,
  target_role TEXT NOT NULL DEFAULT 'all' CHECK (target_role IN ('all','customer','manager','rider')),
  is_active BOOLEAN NOT NULL DEFAULT TRUE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- 13. System Error Logs
CREATE TABLE IF NOT EXISTS api_error_logs (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  endpoint TEXT,
  method TEXT,
  status_code INT,
  error_message TEXT,
  stack_trace TEXT,
  user_id UUID REFERENCES users(id) ON DELETE SET NULL,
  ip_address TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- 14. Expand platform settings defaults
INSERT INTO platform_settings(key, value) VALUES
  ('tax_percent', '5'),
  ('default_delivery_fee', '10'),
  ('min_order_amount', '20'),
  ('otp_expiry_minutes', '10'),
  ('max_otp_attempts', '5'),
  ('currency_code', '"GHS"'),
  ('payment_provider', '{"provider":"paystack","mode":"test","public_key":""}'),
  ('email_provider', '{"provider":"smtp","from_name":"JerBite Support","from_email":"support@jerbite.com"}'),
  ('sms_provider', '{"provider":"termii","sender_id":"JerBite"}'),
  ('security_settings', '{"max_login_attempts":5,"lockout_minutes":15,"require_verified_email":true,"require_verified_phone":true}')
ON CONFLICT (key) DO NOTHING;

-- Seed default notification templates if not present
INSERT INTO notification_templates (key, name, channel, subject, body, variables) VALUES
  ('order_placed', 'Order Confirmation', 'email', 'Your JerBite order #{{order_id}} has been placed', 'Hi {{name}}, your order for {{items_count}} items has been placed successfully and sent to {{restaurant_name}}.', '["order_id","name","items_count","restaurant_name"]'),
  ('order_ready', 'Order Ready For Pickup', 'sms', '', 'JerBite: Your order #{{order_id}} from {{restaurant_name}} is ready!', '["order_id","restaurant_name"]'),
  ('rider_assigned', 'Rider On The Way', 'sms', '', 'JerBite: Rider {{rider_name}} has picked up your order and is heading your way.', '["rider_name"]'),
  ('welcome_customer', 'Welcome to JerBite', 'email', 'Welcome to JerBite!', 'Hello {{name}}, welcome to JerBite. Start exploring the best restaurants in town.', '["name"]')
ON CONFLICT (key) DO NOTHING;

-- Seed default delivery zones
INSERT INTO delivery_zones (name, city, description, base_delivery_fee, is_active) VALUES
  ('Central Downtown', 'Accra', 'Downtown core coverage with fast rider network', 10.00, true),
  ('Airport Residential & Osu', 'Accra', 'Airport residential, Cantonments, and Osu areas', 12.00, true),
  ('East Legon & Spintex', 'Accra', 'East Legon, Adjiringanor, and Spintex corridor', 15.00, true)
ON CONFLICT DO NOTHING;
