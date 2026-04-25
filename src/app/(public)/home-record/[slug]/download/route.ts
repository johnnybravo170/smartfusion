/**
 * GET /home-record/<slug>/download
 *
 * Looks up the home_records row by slug, mints a fresh 5-minute signed
 * URL on the stored `pdf_path`, and 302-redirects the browser to it.
 * Putting this behind our own route (not the raw signed URL) means:
 *   - The download URL the operator shares stays stable forever, even
 *     though the underlying signed URL expires.
 *   - We can log opens to PublicViewLogger for analytics later.
 *   - 404 / 410 responses are clean if the PDF hasn't been generated
 *     yet or was regenerated and replaced.
 */

import { redirect } from 'next/navigation';
import { createAdminClient } from '@/lib/supabase/admin';

export async function GET(_req: Request, { params }: { params: Promise<{ slug: string }> }) {
  const { slug } = await params;
  const admin = createAdminClient();

  const { data: row } = await admin
    .from('home_records')
    .select('pdf_path')
    .eq('slug', slug)
    .single();

  if (!row || !(row as Record<string, unknown>).pdf_path) {
    return new Response('PDF not yet generated for this Home Record.', { status: 404 });
  }

  const pdfPath = (row as Record<string, unknown>).pdf_path as string;
  const { data: signed, error } = await admin.storage
    .from('home-record-pdfs')
    .createSignedUrl(pdfPath, 300);

  if (error || !signed?.signedUrl) {
    return new Response('Failed to mint download URL.', { status: 500 });
  }

  redirect(signed.signedUrl);
}
