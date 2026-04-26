-- 0138_casl_compliance.sql
--
-- CASL compliance plumbing.
--
-- Adds the audit-trail and consent-evidence schema required to defend every
-- outbound message under Canada's Anti-Spam Legislation. See CASL.md at the
-- repo root for the rules these tables enforce.
--
-- What this migration does:
--   1. Add casl_category + casl_evidence to ar_send_log and twilio_messages
--   2. Create email_send_log for all email sent via the sendEmail wrapper
--      (estimates, invoices, change orders, auth, etc — everything outside AR)
--   3. Create consent_events to store proof-of-opt-in for express_consent sends
--
-- Categories (enforced at the application layer, mirrored in DB CHECK):
--   transactional             — invoice/receipt/appointment/completion/auth
--   response_to_request       — direct reply to an inbound inquiry
--   implied_consent_inquiry   — promotional, ≤6mo since inquiry
--   implied_consent_ebr       — promotional, ≤2y since last paid job
--   express_consent           — newsletter/drip/broadcast (requires consent_event_id)
--   unclassified              — temporary; phase B replaces these with real values

-- ---------------------------------------------------------------------------
-- 1. Shared CHECK predicate
-- ---------------------------------------------------------------------------

-- Use a domain-style CHECK list everywhere so adding/removing a category is
-- a single migration edit.

-- ---------------------------------------------------------------------------
-- 2. Augment ar_send_log
-- ---------------------------------------------------------------------------

ALTER TABLE ar_send_log
  ADD COLUMN casl_category text,
  ADD COLUMN casl_evidence jsonb;

-- AR sends are express_consent or unclassified (legacy rows).
ALTER TABLE ar_send_log
  ADD CONSTRAINT ar_send_log_casl_category_check
  CHECK (
    casl_category IS NULL OR casl_category IN (
      'transactional',
      'response_to_request',
      'implied_consent_inquiry',
      'implied_consent_ebr',
      'express_consent',
      'unclassified'
    )
  );

CREATE INDEX ar_send_log_casl_category_idx ON ar_send_log (casl_category);

-- ---------------------------------------------------------------------------
-- 3. Augment twilio_messages
-- ---------------------------------------------------------------------------

ALTER TABLE twilio_messages
  ADD COLUMN casl_category text,
  ADD COLUMN casl_evidence jsonb;

ALTER TABLE twilio_messages
  ADD CONSTRAINT twilio_messages_casl_category_check
  CHECK (
    casl_category IS NULL OR casl_category IN (
      'transactional',
      'response_to_request',
      'implied_consent_inquiry',
      'implied_consent_ebr',
      'express_consent',
      'unclassified'
    )
  );

CREATE INDEX twilio_messages_casl_category_idx ON twilio_messages (casl_category);

-- ---------------------------------------------------------------------------
-- 4. New email_send_log
-- ---------------------------------------------------------------------------

-- Mirrors twilio_messages shape so reporting can union the two when needed.
-- Lives separately from ar_send_log because AR has its own engagement
-- tracking (opens/clicks/bounces via Resend webhooks); transactional sends
-- do not need that machinery.

CREATE TABLE email_send_log (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid REFERENCES tenants(id) ON DELETE CASCADE,
  direction text NOT NULL DEFAULT 'outbound',
  to_address text NOT NULL,
  from_address text,
  reply_to text,
  subject text,
  provider_id text,                       -- Resend message id
  status text NOT NULL DEFAULT 'queued',  -- queued | sent | failed
  error_code text,
  error_message text,
  casl_category text NOT NULL,
  casl_evidence jsonb,
  related_type text,                      -- estimate | invoice | change_order | job | billing | auth | home_record | platform
  related_id text,
  sent_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE email_send_log
  ADD CONSTRAINT email_send_log_casl_category_check
  CHECK (casl_category IN (
    'transactional',
    'response_to_request',
    'implied_consent_inquiry',
    'implied_consent_ebr',
    'express_consent',
    'unclassified'
  ));

CREATE INDEX email_send_log_tenant_idx ON email_send_log (tenant_id, created_at DESC);
CREATE INDEX email_send_log_to_idx ON email_send_log (to_address);
CREATE INDEX email_send_log_casl_category_idx ON email_send_log (casl_category);
CREATE INDEX email_send_log_related_idx ON email_send_log (related_type, related_id);

-- RLS: platform-admin only. Send logs are sensitive; tenant operators see
-- their own data through dedicated views/queries, not by direct table reads.
ALTER TABLE email_send_log ENABLE ROW LEVEL SECURITY;

CREATE POLICY email_send_log_service_role
  ON email_send_log
  FOR ALL
  TO service_role
  USING (true)
  WITH CHECK (true);

-- ---------------------------------------------------------------------------
-- 5. consent_events
-- ---------------------------------------------------------------------------

-- Proof-of-opt-in for express_consent sends. Every row is a discrete event
-- (form submission, checkbox tick, double opt-in confirmation). The send-time
-- code stores the consent_event_id in casl_evidence on the send-log row.
--
-- Free text wording_shown for now (snapshot of what was on screen at consent
-- time). If versioning becomes necessary, add consent_form_versions later.

CREATE TABLE consent_events (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid REFERENCES tenants(id) ON DELETE CASCADE,
  contact_id uuid,                        -- soft ref; contacts span multiple tables
  contact_kind text,                      -- 'ar_contact' | 'customer' | 'lead' | 'platform_user'
  email text,
  phone text,
  consent_type text NOT NULL,             -- 'email_marketing' | 'sms_marketing' | 'voice_recording' | 'general_marketing'
  source text NOT NULL,                   -- 'intake_form' | 'ar_signup' | 'admin_import' | 'double_optin' | 'verbal_logged' | 'oral_at_intake'
  wording_shown text,                     -- snapshot of the consent text shown to the user
  ip text,
  user_agent text,
  evidence jsonb,                         -- form id, submission id, screenshot ref, etc
  withdrawn_at timestamptz,               -- null = still active
  created_at timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE consent_events
  ADD CONSTRAINT consent_events_consent_type_check
  CHECK (consent_type IN (
    'email_marketing',
    'sms_marketing',
    'voice_recording',
    'general_marketing'
  ));

CREATE INDEX consent_events_tenant_idx ON consent_events (tenant_id);
CREATE INDEX consent_events_email_idx ON consent_events (email) WHERE email IS NOT NULL;
CREATE INDEX consent_events_phone_idx ON consent_events (phone) WHERE phone IS NOT NULL;
CREATE INDEX consent_events_contact_idx ON consent_events (contact_kind, contact_id) WHERE contact_id IS NOT NULL;
CREATE INDEX consent_events_active_idx ON consent_events (consent_type, withdrawn_at) WHERE withdrawn_at IS NULL;

ALTER TABLE consent_events ENABLE ROW LEVEL SECURITY;

CREATE POLICY consent_events_service_role
  ON consent_events
  FOR ALL
  TO service_role
  USING (true)
  WITH CHECK (true);

-- ---------------------------------------------------------------------------
-- 6. Backfill existing ar_send_log rows
-- ---------------------------------------------------------------------------

-- Existing AR sends were broadcast/drip — closest accurate label is
-- express_consent, but we can't prove consent without a consent_events row,
-- so flag them unclassified for the audit. Phase B reconciles per row.

UPDATE ar_send_log SET casl_category = 'unclassified' WHERE casl_category IS NULL;
UPDATE twilio_messages SET casl_category = 'unclassified' WHERE casl_category IS NULL AND direction = 'outbound';
