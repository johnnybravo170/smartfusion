/**
 * Public gallery queries. Runs under the admin client (bypasses RLS) because
 * the share-link token is the access control.
 */

import { getBusinessProfileAdmin, type Socials } from '@/lib/db/queries/profile';
import { createAdminClient } from '@/lib/supabase/admin';

const PHOTOS_BUCKET = 'photos';
const GALLERY_URL_TTL = 60 * 60 * 24; // 24h

async function signGalleryUrls(paths: string[]): Promise<Map<string, string>> {
  const map = new Map<string, string>();
  if (paths.length === 0) return map;
  const admin = createAdminClient();
  const { data } = await admin.storage.from(PHOTOS_BUCKET).createSignedUrls(paths, GALLERY_URL_TTL);
  for (let i = 0; i < (data ?? []).length; i++) {
    const entry = (data ?? [])[i];
    if (entry?.signedUrl && !entry.error) map.set(paths[i], entry.signedUrl);
  }
  return map;
}

export type GalleryPhoto = {
  id: string;
  tag: string;
  caption: string | null;
  takenAt: string | null;
  url: string | null;
};

export type GalleryData = {
  tenantName: string;
  jobLabel: string | null;
  photos: GalleryPhoto[];
  logoUrl: string | null;
  websiteUrl: string | null;
  reviewUrl: string | null;
  socials: Socials;
};

// Tags not shown to the customer. Internal-only photos never appear on a
// public gallery link, regardless of scope.
const HIDDEN_TAGS = new Set(['concern', 'serial', 'materials', 'equipment']);

export async function loadGalleryForJob(params: {
  tenantId: string;
  jobId: string;
}): Promise<GalleryData | null> {
  const admin = createAdminClient();

  const [profile, { data: job }, { data: photos }] = await Promise.all([
    getBusinessProfileAdmin(params.tenantId),
    admin
      .from('jobs')
      .select('id, customers:customer_id (name, city)')
      .eq('id', params.jobId)
      .maybeSingle(),
    admin
      .from('photos')
      .select('id, tag, caption, storage_path, taken_at, created_at')
      .eq('job_id', params.jobId)
      .is('deleted_at', null)
      .order('taken_at', { ascending: true, nullsFirst: false })
      .order('created_at', { ascending: true }),
  ]);

  if (!profile) return null;

  const visible = (photos ?? []).filter((p) => !HIDDEN_TAGS.has((p.tag as string) ?? ''));
  const paths = visible.map((p) => p.storage_path as string);
  const urlMap = await signGalleryUrls(paths);

  const customerRaw = (job as { customers?: unknown } | null)?.customers;
  const customer = Array.isArray(customerRaw) ? customerRaw[0] : customerRaw;
  const label =
    customer && typeof customer === 'object' && 'name' in customer
      ? ((customer as { name: string }).name as string)
      : null;

  return {
    tenantName: profile.name,
    jobLabel: label,
    photos: visible.map((p) => ({
      id: p.id as string,
      tag: (p.tag as string) ?? 'other',
      caption: (p.caption as string | null) ?? null,
      takenAt: (p.taken_at as string | null) ?? null,
      url: urlMap.get(p.storage_path as string) ?? null,
    })),
    logoUrl: profile.logoSignedUrl,
    websiteUrl: profile.websiteUrl,
    reviewUrl: profile.reviewUrl,
    socials: profile.socials,
  };
}
