-- 002: data integrity, performance indexes, automatic audit trails.

-- ---------- Constraints ----------
ALTER TABLE users       ADD CONSTRAINT users_email_lowercase CHECK (email = lower(email));
ALTER TABLE users       ADD CONSTRAINT users_phone_format    CHECK (phone ~ '^\+?[0-9]{9,15}$');
ALTER TABLE restaurants ADD CONSTRAINT restaurants_money_ok  CHECK (delivery_fee >= 0 AND min_order >= 0 AND prep_time_minutes > 0);
ALTER TABLE orders      ADD CONSTRAINT orders_money_ok       CHECK (subtotal >= 0 AND delivery_fee >= 0 AND total = subtotal + delivery_fee);
ALTER TABLE order_items ADD CONSTRAINT order_items_price_ok  CHECK (price >= 0);
ALTER TABLE otp_codes   ADD CONSTRAINT otp_one_per_purpose   UNIQUE (user_id, purpose);
CREATE UNIQUE INDEX uq_categories_name_ci ON categories (restaurant_id, lower(name));
CREATE UNIQUE INDEX uq_restaurants_name_ci ON restaurants (lower(name));

-- ---------- Indexes ----------
CREATE INDEX idx_users_role_created        ON users (role, created_at DESC);
CREATE INDEX idx_otp_expires               ON otp_codes (expires_at);
CREATE INDEX idx_restaurants_status        ON restaurants (status);
CREATE INDEX idx_products_public_menu      ON products (restaurant_id, category_id) WHERE status = 'approved' AND is_available;
CREATE INDEX idx_products_review_queue     ON products (created_at DESC) WHERE status = 'pending';
CREATE INDEX idx_rider_profiles_status     ON rider_profiles (status);
CREATE INDEX idx_orders_created            ON orders (created_at DESC);
CREATE INDEX idx_orders_paid_by_day        ON orders (created_at) WHERE payment_status = 'paid' AND status <> 'cancelled';
CREATE INDEX idx_orders_refunds_due        ON orders (created_at) WHERE payment_status = 'refund_pending';
CREATE INDEX idx_orders_ready_unassigned   ON orders (updated_at) WHERE status = 'ready' AND rider_id IS NULL;
CREATE INDEX idx_order_items_order         ON order_items (order_id);
CREATE INDEX idx_notifications_user        ON notifications (user_id, created_at DESC);
CREATE INDEX idx_addresses_user            ON addresses (user_id);

-- ---------- updated_at maintained by the database ----------
CREATE OR REPLACE FUNCTION set_updated_at() RETURNS trigger AS $$
BEGIN NEW.updated_at = now(); RETURN NEW; END $$ LANGUAGE plpgsql;
CREATE TRIGGER trg_orders_updated BEFORE UPDATE ON orders FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- ---------- Role integrity: the right kind of user on the right row ----------
CREATE OR REPLACE FUNCTION enforce_roles() RETURNS trigger AS $$
DECLARE r text;
BEGIN
  IF TG_TABLE_NAME = 'restaurants' THEN
    SELECT role INTO r FROM users WHERE id = NEW.owner_id;
    IF r IS DISTINCT FROM 'manager' THEN RAISE EXCEPTION 'Restaurant owner must be a manager account'; END IF;
  ELSIF TG_TABLE_NAME = 'rider_profiles' THEN
    SELECT role INTO r FROM users WHERE id = NEW.user_id;
    IF r IS DISTINCT FROM 'rider' THEN RAISE EXCEPTION 'Rider profile requires a rider account'; END IF;
  ELSIF TG_TABLE_NAME = 'orders' THEN
    SELECT role INTO r FROM users WHERE id = NEW.customer_id;
    IF r IS DISTINCT FROM 'customer' THEN RAISE EXCEPTION 'Only customer accounts can place orders'; END IF;
    IF NEW.rider_id IS NOT NULL THEN
      SELECT role INTO r FROM users WHERE id = NEW.rider_id;
      IF r IS DISTINCT FROM 'rider' THEN RAISE EXCEPTION 'Orders can only be assigned to rider accounts'; END IF;
    END IF;
  END IF;
  RETURN NEW;
END $$ LANGUAGE plpgsql;
CREATE TRIGGER trg_restaurants_roles BEFORE INSERT ON restaurants    FOR EACH ROW EXECUTE FUNCTION enforce_roles();
CREATE TRIGGER trg_riders_roles      BEFORE INSERT ON rider_profiles FOR EACH ROW EXECUTE FUNCTION enforce_roles();
CREATE TRIGGER trg_orders_roles      BEFORE INSERT OR UPDATE OF rider_id ON orders FOR EACH ROW EXECUTE FUNCTION enforce_roles();

-- ---------- Order timeline (filled automatically, no app code needed) ----------
CREATE TABLE order_status_history (
  id BIGSERIAL PRIMARY KEY,
  order_id UUID NOT NULL REFERENCES orders(id) ON DELETE CASCADE,
  from_status TEXT,
  to_status TEXT NOT NULL,
  changed_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX idx_order_history_order ON order_status_history (order_id, changed_at);

CREATE OR REPLACE FUNCTION log_order_status() RETURNS trigger AS $$
BEGIN
  IF TG_OP = 'INSERT' THEN
    INSERT INTO order_status_history(order_id, from_status, to_status) VALUES (NEW.id, NULL, NEW.status);
  ELSIF NEW.status IS DISTINCT FROM OLD.status THEN
    INSERT INTO order_status_history(order_id, from_status, to_status) VALUES (NEW.id, OLD.status, NEW.status);
  END IF;
  RETURN NEW;
END $$ LANGUAGE plpgsql;
CREATE TRIGGER trg_orders_history AFTER INSERT OR UPDATE OF status ON orders FOR EACH ROW EXECUTE FUNCTION log_order_status();

-- ---------- Admin review trail (restaurants, products, riders) ----------
CREATE TABLE review_log (
  id BIGSERIAL PRIMARY KEY,
  entity TEXT NOT NULL,
  entity_id UUID NOT NULL,
  from_status TEXT,
  to_status TEXT NOT NULL,
  note TEXT,
  changed_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX idx_review_log_entity ON review_log (entity, entity_id, changed_at DESC);

CREATE OR REPLACE FUNCTION log_review() RETURNS trigger AS $$
BEGIN
  IF NEW.status IS DISTINCT FROM OLD.status THEN
    INSERT INTO review_log(entity, entity_id, from_status, to_status, note)
    VALUES (TG_TABLE_NAME, COALESCE(to_jsonb(NEW)->>'id', to_jsonb(NEW)->>'user_id')::uuid, OLD.status, NEW.status, NEW.review_note);
  END IF;
  RETURN NEW;
END $$ LANGUAGE plpgsql;
CREATE TRIGGER trg_restaurants_review AFTER UPDATE OF status ON restaurants    FOR EACH ROW EXECUTE FUNCTION log_review();
CREATE TRIGGER trg_products_review    AFTER UPDATE OF status ON products       FOR EACH ROW EXECUTE FUNCTION log_review();
CREATE TRIGGER trg_riders_review      AFTER UPDATE OF status ON rider_profiles FOR EACH ROW EXECUTE FUNCTION log_review();

-- ---------- Housekeeping ----------
CREATE OR REPLACE FUNCTION purge_stale_data() RETURNS void AS $$
BEGIN
  DELETE FROM otp_codes WHERE expires_at < now() - interval '1 day';
  DELETE FROM notifications WHERE is_read AND created_at < now() - interval '90 days';
  -- unverified accounts that never confirmed within 7 days
  DELETE FROM users WHERE NOT email_verified AND created_at < now() - interval '7 days';
  -- orders abandoned before payment
  UPDATE orders SET status = 'cancelled' WHERE status = 'pending_payment' AND created_at < now() - interval '1 day';
END $$ LANGUAGE plpgsql;
