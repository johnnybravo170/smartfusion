/**
 * Portal photo tag vocabulary — the homeowner-facing axis. Separate from
 * the internal `photos.tag` column (before/after/progress/damage/etc)
 * which is for contractor documentation and AI categorization.
 *
 * Validated app-side, not a DB enum, so verticals can extend later
 * without a schema change.
 */

export const PORTAL_PHOTO_TAGS = [
  'before',
  'progress',
  'behind_wall',
  'issue',
  'completion',
  'marketing',
] as const;

export type PortalPhotoTag = (typeof PORTAL_PHOTO_TAGS)[number];

export const portalPhotoTagLabels: Record<PortalPhotoTag, string> = {
  before: 'Before',
  progress: 'Progress',
  behind_wall: 'Behind the wall',
  issue: 'Issue',
  completion: 'Completion',
  marketing: 'Highlight',
};

/**
 * Display order for the portal's "Photos" section. behind_wall is held
 * back into its own collapsed section by the page layout — it's listed
 * last here so any default rendering walks the friendlier categories
 * first.
 */
export const PORTAL_PHOTO_TAG_DISPLAY_ORDER: PortalPhotoTag[] = [
  'before',
  'progress',
  'completion',
  'marketing',
  'issue',
  'behind_wall',
];

export function isPortalPhotoTag(value: unknown): value is PortalPhotoTag {
  return typeof value === 'string' && (PORTAL_PHOTO_TAGS as readonly string[]).includes(value);
}

export function sanitizePortalPhotoTags(input: unknown): PortalPhotoTag[] {
  if (!Array.isArray(input)) return [];
  const seen = new Set<PortalPhotoTag>();
  for (const v of input) {
    if (isPortalPhotoTag(v)) seen.add(v);
  }
  return Array.from(seen);
}
