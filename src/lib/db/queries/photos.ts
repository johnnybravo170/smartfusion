/**
 * Photo queries that run through the RLS-aware Supabase server client.
 *
 * Tenant isolation is enforced by `current_tenant_id()` in `photos`
 * policies (migration 0016). We don't filter on `tenant_id` in app code.
 *
 * Each listed photo comes paired with a short-lived signed URL so callers
 * can render the thumbnail directly without a second round trip. Signing
 * runs under the same server client, so RLS on `storage.objects` applies.
 */

import { getSignedUrl, getSignedUrls } from '@/lib/storage/photos';
import { createClient } from '@/lib/supabase/server';
import type { PhotoTag } from '@/lib/validators/photo';

export type PhotoQualityFlags = {
  blurry?: boolean;
  too_dark?: boolean;
  low_contrast?: boolean;
  notes?: string;
};

export type PhotoRow = {
  id: string;
  tenant_id: string;
  job_id: string | null;
  project_id: string | null;
  memo_id: string | null;
  storage_path: string;
  tag: PhotoTag;
  caption: string | null;
  taken_at: string | null;
  created_at: string;
  updated_at: string;
  ai_tag: PhotoTag | null;
  ai_tag_confidence: number | null;
  ai_caption: string | null;
  ai_caption_confidence: number | null;
  caption_source: 'user' | 'ai' | 'hybrid';
  quality_flags: PhotoQualityFlags;
  ai_processed_at: string | null;
};

export type PhotoWithUrl = PhotoRow & { url: string | null };

export type PhotoListFilters = {
  limit?: number;
  offset?: number;
};

const PHOTO_COLUMNS =
  'id, tenant_id, job_id, project_id, memo_id, storage_path, tag, caption, taken_at, created_at, updated_at, ai_tag, ai_tag_confidence, ai_caption, ai_caption_confidence, caption_source, quality_flags, ai_processed_at';

async function decorateWithUrls(rows: PhotoRow[]): Promise<PhotoWithUrl[]> {
  if (rows.length === 0) return [];

  // Batch-sign all URLs in a single API call instead of N+1 individual requests.
  const paths = rows.map((row) => row.storage_path);
  const urlMap = await getSignedUrls(paths);

  return rows.map((row) => ({
    ...row,
    url: urlMap.get(row.storage_path) ?? null,
  }));
}

export async function listPhotosByJob(jobId: string): Promise<PhotoWithUrl[]> {
  const supabase = await createClient();
  const { data, error } = await supabase
    .from('photos')
    .select(PHOTO_COLUMNS)
    .eq('job_id', jobId)
    .order('created_at', { ascending: false });

  if (error) {
    throw new Error(`Failed to list photos for job: ${error.message}`);
  }
  return decorateWithUrls((data ?? []) as PhotoRow[]);
}

export async function listPhotosByProject(projectId: string): Promise<PhotoWithUrl[]> {
  const supabase = await createClient();
  const { data, error } = await supabase
    .from('photos')
    .select(PHOTO_COLUMNS)
    .eq('project_id', projectId)
    .order('created_at', { ascending: false });

  if (error) {
    throw new Error(`Failed to list photos for project: ${error.message}`);
  }
  return decorateWithUrls((data ?? []) as PhotoRow[]);
}

export async function listPhotosByTenant(filters: PhotoListFilters = {}): Promise<PhotoWithUrl[]> {
  const supabase = await createClient();
  const limit = filters.limit ?? 100;
  const offset = filters.offset ?? 0;

  const { data, error } = await supabase
    .from('photos')
    .select(PHOTO_COLUMNS)
    .order('created_at', { ascending: false })
    .range(offset, offset + limit - 1);

  if (error) {
    throw new Error(`Failed to list photos: ${error.message}`);
  }
  return decorateWithUrls((data ?? []) as PhotoRow[]);
}

export async function countPhotosByJob(jobId: string): Promise<number> {
  const supabase = await createClient();
  const { count, error } = await supabase
    .from('photos')
    .select('id', { count: 'exact', head: true })
    .eq('job_id', jobId);
  if (error) {
    throw new Error(`Failed to count photos for job: ${error.message}`);
  }
  return count ?? 0;
}

export async function getPhotoWithUrl(photoId: string): Promise<PhotoWithUrl | null> {
  const supabase = await createClient();
  const { data, error } = await supabase
    .from('photos')
    .select(PHOTO_COLUMNS)
    .eq('id', photoId)
    .maybeSingle();

  if (error) {
    if (error.code === 'PGRST116') return null;
    throw new Error(`Failed to load photo: ${error.message}`);
  }
  if (!data) return null;

  const url = await getSignedUrl((data as PhotoRow).storage_path);
  return { ...(data as PhotoRow), url };
}
