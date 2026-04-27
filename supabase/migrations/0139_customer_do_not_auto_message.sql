-- 0139_customer_do_not_auto_message.sql
--
-- Single-customer CASL kill switch.
--
-- Hard-stops every automated outbound message to a customer. The flag is
-- checked at AR enrollment time AND at every step execution, so flipping it
-- mid-sequence stops further sends.
--
-- Auto-set when:
--   • customer clicks the unsubscribe link in any AR send
--   • customer replies STOP to any SMS
--   • Resend reports a complaint event for the customer's email
--
-- Manual override is in the customer detail page (Contact preferences).
--
-- Customer matching across channels:
--   email path → match on customers.email (case-insensitive)
--   phone path → match on customers.phone (E.164 normalized)
--   matched rows are updated platform-wide (not tenant-scoped) — once a
--   recipient says stop on any channel, every tenant honors it. This is the
--   only way to defend a CASL audit when the same person is in multiple
--   contractors' books.

ALTER TABLE customers
  ADD COLUMN do_not_auto_message boolean NOT NULL DEFAULT false,
  ADD COLUMN do_not_auto_message_at timestamptz,
  ADD COLUMN do_not_auto_message_source text;

ALTER TABLE customers
  ADD CONSTRAINT customers_do_not_auto_message_source_check
  CHECK (
    do_not_auto_message_source IS NULL OR do_not_auto_message_source IN (
      'unsubscribe_link',
      'sms_stop',
      'email_complaint',
      'manual_owner',
      'manual_admin'
    )
  );

-- Lookup paths the AR policy engine uses.
CREATE INDEX customers_email_lower_idx ON customers (lower(email)) WHERE email IS NOT NULL;
CREATE INDEX customers_phone_idx ON customers (phone) WHERE phone IS NOT NULL;
CREATE INDEX customers_dnam_idx ON customers (do_not_auto_message) WHERE do_not_auto_message = true;
