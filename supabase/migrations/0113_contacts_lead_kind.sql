-- ============================================================
-- Promote 'lead' to a first-class contact kind.
--
-- Semantics:
--   lead     — someone you're tracking but haven't started work for
--   customer — a contact you have (or had) an active project with
--
-- Transition: lead → customer, one-way, triggered automatically by
-- the first project insert for that contact. Handled in the DB so
-- every create path (intake, manual, AI, etc.) gets it for free.
--
-- Retroactive flip at migration time: any existing kind='customer'
-- row that has zero projects moves to kind='lead'. Customers with
-- one or more projects are already "promoted" — leave them alone.
--
-- Both lead and customer may carry a non-null type (residential /
-- commercial subtype); every other kind still requires type=NULL.
-- ============================================================

-- 1. Expand the kind check to include 'lead'.
ALTER TABLE public.customers
  DROP CONSTRAINT IF EXISTS customers_kind_check;
ALTER TABLE public.customers
  ADD CONSTRAINT customers_kind_check
    CHECK (
      kind IN ('lead','customer','vendor','sub','agent','inspector','referral','other')
    );

-- 2. Loosen the type-requires-kind invariant so leads can also carry
--    residential / commercial subtypes.
ALTER TABLE public.customers
  DROP CONSTRAINT IF EXISTS customers_type_requires_customer_kind;
ALTER TABLE public.customers
  ADD CONSTRAINT customers_type_requires_customer_kind
    CHECK (kind IN ('customer','lead') OR type IS NULL);

-- 3. Back-fill: customer rows with no projects are actually leads.
UPDATE public.customers c
   SET kind = 'lead'
 WHERE c.kind = 'customer'
   AND c.deleted_at IS NULL
   AND NOT EXISTS (
     SELECT 1 FROM public.projects p
      WHERE p.customer_id = c.id
        AND p.deleted_at IS NULL
   );

-- 4. Auto-promotion trigger. Fires on every project insert and bumps
--    the owning contact from lead → customer if that's still their
--    kind. Does nothing for contacts who are already customer (or
--    vendor/sub/etc. — those shouldn't have projects in the first
--    place, but the guard keeps the trigger safe regardless).
CREATE OR REPLACE FUNCTION public.promote_lead_on_project_insert()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
BEGIN
  IF NEW.customer_id IS NOT NULL THEN
    UPDATE public.customers
       SET kind = 'customer',
           updated_at = now()
     WHERE id = NEW.customer_id
       AND kind = 'lead';
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_promote_lead_on_project_insert ON public.projects;
CREATE TRIGGER trg_promote_lead_on_project_insert
  AFTER INSERT ON public.projects
  FOR EACH ROW
  EXECUTE FUNCTION public.promote_lead_on_project_insert();

COMMENT ON FUNCTION public.promote_lead_on_project_insert IS
  'Auto-promotes customers.kind from lead → customer whenever the first project is inserted for them. One-way transition; customers never demote back to lead.';
