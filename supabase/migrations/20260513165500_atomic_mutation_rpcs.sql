-- Atomic multi-step mutations as Postgres functions.
--
-- Three flows that were doing 2-4 separate Supabase round trips, with no
-- rollback if a later step failed. Each function below runs inside a
-- single implicit transaction (PL/pgSQL functions are transactional by
-- default) so either every row commits together or none of them do.
--
--   signup_tenant         — tenants + tenant_members + referral_codes
--                           + seed_default_expense_categories
--                           + seed_default_payment_sources
--   mark_invoice_paid     — invoices UPDATE + worklog_entries INSERT
--   update_job_status     — jobs UPDATE + worklog_entries INSERT
--
-- The auth.users row stays on the JS side because it lives in the
-- auth schema and is managed by Supabase Auth (not direct SQL). The
-- signup_tenant caller still rolls back the auth user if the RPC
-- fails — but now THAT'S the only compensating action needed.

-- ----------------------------------------------------------------------
-- signup_tenant
-- ----------------------------------------------------------------------
-- Creates the tenant + the owner's tenant_members row + the auto
-- referral code, and seeds default expense categories / payment
-- sources. Returns the new tenant_id.
--
-- p_referred_by_code can be NULL. If non-null, the trial is extended to
-- 14 days. The caller is responsible for updating the referral_codes
-- row via updateReferralOnSignup; we don't gate signup on that side
-- effect.
--
-- The seeded categories / payment sources are best-effort inside the
-- transaction: if their helper functions error, the whole signup
-- aborts. That's deliberate — a half-set-up tenant is worse than a
-- failed signup the user can retry.

CREATE OR REPLACE FUNCTION public.signup_tenant(
  p_user_id              uuid,
  p_business_name        text,
  p_vertical             text,
  p_phone                text,
  p_tos_version          text,
  p_privacy_version      text,
  p_accepted_at          timestamptz,
  p_referral_code        text,        -- public.referral_codes.code prefix to insert for this tenant
  p_referred_by_code     text         -- inbound code (extends trial)
) RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_tenant_id           uuid;
  v_has_active_member   boolean;
  v_inherited_phone     text;
  v_inherited_verified  timestamptz;
  v_trial_ends_at       timestamptz;
BEGIN
  -- Tenant
  IF p_referred_by_code IS NOT NULL THEN
    v_trial_ends_at := now() + interval '14 days';
  END IF;

  INSERT INTO public.tenants (name, vertical, referred_by_code, trial_ends_at)
    VALUES (p_business_name, p_vertical, p_referred_by_code, v_trial_ends_at)
    RETURNING id INTO v_tenant_id;

  -- Inherit phone + verified from any existing tenant_members for this
  -- user (multi-tenant scenario). Mark this new membership active only
  -- if the user has no other active membership.
  SELECT EXISTS (
    SELECT 1 FROM public.tenant_members
    WHERE user_id = p_user_id AND is_active_for_user = true
  ) INTO v_has_active_member;

  SELECT phone, phone_verified_at
    INTO v_inherited_phone, v_inherited_verified
    FROM public.tenant_members
    WHERE user_id = p_user_id AND phone_verified_at IS NOT NULL
    ORDER BY created_at ASC
    LIMIT 1;

  -- Tenant member (owner)
  INSERT INTO public.tenant_members (
    tenant_id,
    user_id,
    role,
    is_active_for_user,
    phone,
    phone_verified_at,
    tos_version,
    tos_accepted_at,
    privacy_version,
    privacy_accepted_at
  ) VALUES (
    v_tenant_id,
    p_user_id,
    'owner',
    NOT v_has_active_member,
    COALESCE(v_inherited_phone, p_phone),
    v_inherited_verified,
    p_tos_version,
    p_accepted_at,
    p_privacy_version,
    p_accepted_at
  );

  -- Auto referral code for this new tenant. Errors abort the whole
  -- transaction (caller will see them and roll back the auth user).
  INSERT INTO public.referral_codes (tenant_id, code, type)
    VALUES (v_tenant_id, p_referral_code, 'operator');

  -- Seed defaults. These helpers already exist; they're called
  -- separately today via .rpc(). Wrap into the same transaction.
  PERFORM public.seed_default_expense_categories(v_tenant_id, p_vertical);
  PERFORM public.seed_default_payment_sources(v_tenant_id);

  RETURN v_tenant_id;
END;
$$;

REVOKE EXECUTE ON FUNCTION public.signup_tenant(uuid, text, text, text, text, text, timestamptz, text, text)
  FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.signup_tenant(uuid, text, text, text, text, text, timestamptz, text, text)
  TO service_role;

-- ----------------------------------------------------------------------
-- mark_invoice_paid
-- ----------------------------------------------------------------------
-- Set invoices.status='paid' + paid_at + stripe_payment_intent_id, and
-- insert a worklog_entries row, atomically. Returns the invoice's
-- tenant_id and job_id so the caller can act on them (e.g. revalidate
-- a route).
--
-- Idempotent: if the invoice is already 'paid', the function returns
-- the existing tenant_id/job_id without re-writing or duplicating the
-- worklog row.

CREATE OR REPLACE FUNCTION public.mark_invoice_paid(
  p_invoice_id            uuid,
  p_payment_intent_id     text,
  p_source                text        -- e.g. 'stripe_checkout', 'manual'
) RETURNS TABLE (tenant_id uuid, job_id uuid, was_already_paid boolean)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_tenant_id  uuid;
  v_job_id     uuid;
  v_status     text;
  v_short_id   text;
BEGIN
  SELECT i.tenant_id, i.job_id, i.status
    INTO v_tenant_id, v_job_id, v_status
    FROM public.invoices i
    WHERE i.id = p_invoice_id;

  IF v_tenant_id IS NULL THEN
    RAISE EXCEPTION 'invoice % not found', p_invoice_id;
  END IF;

  IF v_status = 'paid' THEN
    RETURN QUERY SELECT v_tenant_id, v_job_id, true;
    RETURN;
  END IF;

  UPDATE public.invoices
    SET status = 'paid',
        paid_at = now(),
        stripe_payment_intent_id = COALESCE(p_payment_intent_id, stripe_payment_intent_id),
        updated_at = now()
    WHERE id = p_invoice_id;

  v_short_id := substr(p_invoice_id::text, 1, 8);

  INSERT INTO public.worklog_entries (tenant_id, entry_type, title, body, related_type, related_id)
    VALUES (
      v_tenant_id,
      'system',
      'Invoice paid',
      format('Invoice #%s paid via %s.', v_short_id, COALESCE(p_source, 'unknown')),
      'job',
      v_job_id
    );

  RETURN QUERY SELECT v_tenant_id, v_job_id, false;
END;
$$;

REVOKE EXECUTE ON FUNCTION public.mark_invoice_paid(uuid, text, text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.mark_invoice_paid(uuid, text, text) TO service_role;

-- ----------------------------------------------------------------------
-- update_job_status_with_worklog
-- ----------------------------------------------------------------------
-- Updates jobs.status + started_at/completed_at side-effects, and
-- inserts the worklog_entries row, atomically. Caller passes the
-- already-formatted worklog body (we'd need to re-fetch the customer
-- name otherwise; cheaper to do it once on the JS side).
--
-- Returns the prior status so the caller can fire post-update side
-- effects (closeout, ICS cancel) only on transitions.

CREATE OR REPLACE FUNCTION public.update_job_status_with_worklog(
  p_job_id          uuid,
  p_tenant_id       uuid,
  p_new_status      text,
  p_worklog_title   text,
  p_worklog_body    text
) RETURNS TABLE (prior_status text, applied boolean)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_prior_status   text;
  v_started_at     timestamptz;
  v_completed_at   timestamptz;
  v_now            timestamptz := now();
BEGIN
  SELECT status, started_at, completed_at
    INTO v_prior_status, v_started_at, v_completed_at
    FROM public.jobs
    WHERE id = p_job_id AND deleted_at IS NULL;

  IF v_prior_status IS NULL THEN
    RAISE EXCEPTION 'job % not found', p_job_id;
  END IF;

  IF v_prior_status = p_new_status THEN
    RETURN QUERY SELECT v_prior_status, false;
    RETURN;
  END IF;

  UPDATE public.jobs
    SET status = p_new_status,
        started_at = CASE
          WHEN p_new_status = 'in_progress' AND started_at IS NULL THEN v_now
          ELSE started_at
        END,
        completed_at = CASE
          WHEN p_new_status = 'complete' AND completed_at IS NULL THEN v_now
          ELSE completed_at
        END,
        updated_at = v_now
    WHERE id = p_job_id;

  INSERT INTO public.worklog_entries (tenant_id, entry_type, title, body, related_type, related_id)
    VALUES (p_tenant_id, 'system', p_worklog_title, p_worklog_body, 'job', p_job_id);

  RETURN QUERY SELECT v_prior_status, true;
END;
$$;

REVOKE EXECUTE ON FUNCTION public.update_job_status_with_worklog(uuid, uuid, text, text, text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.update_job_status_with_worklog(uuid, uuid, text, text, text) TO service_role;
