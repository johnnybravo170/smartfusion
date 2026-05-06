-- 0196_add_referrals_to_personal_nav.sql
-- Restore the Refer & Earn nav item on the `personal` vertical pack.
-- The other active packs (pressure_washing, renovation, tile) already
-- have it; personal was the only one missing, so operators on a
-- personal-vertical tenant couldn't reach /referrals from the sidebar.

UPDATE vertical_profile_packs
SET config = jsonb_set(
  config,
  '{nav_items}',
  (
    SELECT jsonb_agg(
      CASE
        WHEN item->>'href' = '/settings'
          THEN jsonb_build_array(
            jsonb_build_object(
              'href', '/referrals',
              'label', 'Refer & Earn',
              'icon', 'Gift'
            ),
            item
          )
        ELSE jsonb_build_array(item)
      END
    )
    -- jsonb_agg of arrays gives us an array-of-arrays; flatten via a
    -- second pass so the shape stays a flat nav_items array.
    FROM jsonb_array_elements(config->'nav_items') AS item
  )
)
WHERE vertical = 'personal'
  AND config ? 'nav_items'
  AND NOT EXISTS (
    SELECT 1
    FROM jsonb_array_elements(config->'nav_items') item
    WHERE item->>'href' = '/referrals'
  );

-- Flatten the array-of-arrays produced above into a single nav_items array.
UPDATE vertical_profile_packs
SET config = jsonb_set(
  config,
  '{nav_items}',
  (
    SELECT jsonb_agg(inner_item)
    FROM jsonb_array_elements(config->'nav_items') outer_item,
         jsonb_array_elements(outer_item) inner_item
  )
)
WHERE vertical = 'personal'
  AND jsonb_typeof((config->'nav_items')->0) = 'array';
