-- 004: manager enhancements: schedule, payout accounts, temporary busy pause
ALTER TABLE restaurants
  ADD COLUMN IF NOT EXISTS schedule JSONB DEFAULT NULL,
  ADD COLUMN IF NOT EXISTS bank_name TEXT DEFAULT '',
  ADD COLUMN IF NOT EXISTS account_number TEXT DEFAULT '',
  ADD COLUMN IF NOT EXISTS account_name TEXT DEFAULT '',
  ADD COLUMN IF NOT EXISTS mobile_money_number TEXT DEFAULT '',
  ADD COLUMN IF NOT EXISTS mobile_money_network TEXT DEFAULT '',
  ADD COLUMN IF NOT EXISTS pause_until TIMESTAMPTZ DEFAULT NULL;
