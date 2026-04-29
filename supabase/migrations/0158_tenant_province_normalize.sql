-- Normalize tenants.province to 2-letter codes + lock with CHECK.
--
-- Background: province was free-text. Some rows got "BC", others got
-- "British Columbia". The province-aware tax provider uppercases +
-- hash-looks-up against 'AB'|'BC'|…, so full names silently fell
-- through to the legacy gst_rate/pst_rate path — no 7% PST applied
-- for BC tenants who typed the full name.
--
-- Two fixes:
--   1. Migrate every existing row to its 2-letter code (full names,
--      short forms, mixed case — all collapsed).
--   2. Add a CHECK constraint so the column can only ever hold a valid
--      2-letter Canadian province code (or NULL). Matches the picker
--      UI which only emits codes.

BEGIN;

-- Step 1: normalize. Map full names → codes. Lowercased match.
UPDATE public.tenants
SET province = CASE lower(trim(province))
  WHEN 'alberta'                    THEN 'AB'
  WHEN 'british columbia'           THEN 'BC'
  WHEN 'manitoba'                   THEN 'MB'
  WHEN 'new brunswick'              THEN 'NB'
  WHEN 'newfoundland'               THEN 'NL'
  WHEN 'newfoundland and labrador'  THEN 'NL'
  WHEN 'nova scotia'                THEN 'NS'
  WHEN 'northwest territories'      THEN 'NT'
  WHEN 'nunavut'                    THEN 'NU'
  WHEN 'ontario'                    THEN 'ON'
  WHEN 'prince edward island'       THEN 'PE'
  WHEN 'quebec'                     THEN 'QC'
  WHEN 'québec'                     THEN 'QC'
  WHEN 'saskatchewan'               THEN 'SK'
  WHEN 'yukon'                      THEN 'YT'
  ELSE upper(trim(province))
END
WHERE province IS NOT NULL;

-- Step 2: anything that didn't resolve to a valid code gets NULLed
-- rather than blocking the CHECK constraint. Operators fix on next save.
UPDATE public.tenants
SET province = NULL
WHERE province IS NOT NULL
  AND province NOT IN ('AB','BC','MB','NB','NL','NS','NT','NU','ON','PE','QC','SK','YT');

-- Step 3: enforce.
ALTER TABLE public.tenants
  ADD CONSTRAINT tenants_province_check
    CHECK (province IS NULL OR province IN (
      'AB','BC','MB','NB','NL','NS','NT','NU','ON','PE','QC','SK','YT'
    ));

COMMIT;
