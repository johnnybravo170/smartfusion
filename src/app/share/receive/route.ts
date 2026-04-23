/**
 * Web Share Target endpoint. Receives files shared to HeyHenry from
 * iOS Share Sheet (or any Web Share API consumer). Stores the file in
 * the `share-drafts` bucket, then redirects to /share with a token so
 * the operator can pick which project to attach it to.
 *
 * Declared in `public/manifest.json` under `share_target`. Only fires
 * when HeyHenry is installed as a PWA (Add to Home Screen on iOS).
 */

import { randomUUID } from 'node:crypto';
import { type NextRequest, NextResponse } from 'next/server';
import { getCurrentTenant } from '@/lib/auth/helpers';
import { createAdminClient } from '@/lib/supabase/admin';

const BUCKET = 'share-drafts';
const MAX_BYTES = 10 * 1024 * 1024; // 10MB

function extFromContentType(contentType: string): string {
  if (contentType === 'image/png') return 'png';
  if (contentType === 'image/webp') return 'webp';
  if (contentType === 'image/heic' || contentType === 'image/heif') return 'heic';
  if (contentType === 'application/pdf') return 'pdf';
  return 'jpg';
}

export async function POST(request: NextRequest) {
  // Auth gate — if the user isn't signed in, bounce through login and
  // come back to the share flow with the file still attached (the
  // browser resubmits on post-login redirect).
  const tenant = await getCurrentTenant();
  if (!tenant) {
    return NextResponse.redirect(new URL('/login?next=/share', request.url));
  }

  const form = await request.formData().catch(() => null);
  if (!form) {
    return NextResponse.redirect(new URL('/share?err=no_form', request.url));
  }

  const file = form.get('file');
  const fallbackText = String(form.get('text') ?? form.get('title') ?? '').trim();
  const fallbackUrl = String(form.get('url') ?? '').trim();

  if (!(file instanceof File) || file.size === 0) {
    // No file — treat as a text/link share. Redirect to the picker
    // with the text preserved; the picker can let the operator paste
    // it into a note.
    const params = new URLSearchParams();
    if (fallbackText) params.set('t', fallbackText);
    if (fallbackUrl) params.set('u', fallbackUrl);
    return NextResponse.redirect(new URL(`/share?${params.toString()}`, request.url));
  }

  if (file.size > MAX_BYTES) {
    return NextResponse.redirect(new URL('/share?err=too_big', request.url));
  }

  const admin = createAdminClient();
  const id = randomUUID();
  const ext = extFromContentType(file.type);
  const path = `${tenant.id}/${id}.${ext}`;

  const { error } = await admin.storage
    .from(BUCKET)
    .upload(path, file, { contentType: file.type || 'application/octet-stream', upsert: false });
  if (error) {
    console.warn('share-target upload failed:', error.message);
    return NextResponse.redirect(new URL('/share?err=upload', request.url));
  }

  const params = new URLSearchParams({ f: id, name: file.name || 'shared-file' });
  return NextResponse.redirect(new URL(`/share?${params.toString()}`, request.url));
}
