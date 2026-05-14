-- Add first/last name to signup_tenant.
--
-- Operator name is now required at signup, so the owner's tenant_members
-- row should carry first_name/last_name from the start instead of being
-- backfilled later via Settings → Profile. The two new params are appended
-- (callers use named args, so position is irrelevant) and the old 9-arg
-- signature is dropped so there's no ambiguous overload.

DROP FUNCTION IF EXISTS public.signup_tenant(
  uuid, text, text, text, text, text, timestamptz, text, text
);

CREATE OR REPLACE FUNCTION public.signup_tenant(
  p_user_id              uuid,
  p_business_name        text,
  p_vertical             text,
  p_phone                text,
  p_tos_version          text,
  p_privacy_version      text,
  p_accepted_at          timestamptz,
  p_referral_code        text,        -- public.referral_codes.code prefix to insert for this tenant
  p_referred_by_code     text,        -- inbound code (extends trial)
  p_first_name           text,        -- owner's first name (required at signup)
  p_last_name            text         -- owner's last name (required at signup)
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
    first_name,
    last_name,
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
    p_first_name,
    p_last_name,
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

REVOKE EXECUTE ON FUNCTION public.signup_tenant(uuid, text, text, text, text, text, timestamptz, text, text, text, text)
  FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.signup_tenant(uuid, text, text, text, text, text, timestamptz, text, text, text, text)
  TO service_role;
