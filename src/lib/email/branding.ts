/**
 * Shared branding bits for every outbound email.
 *
 * - `brandingLogoHtml` — renders the tenant's logo at the top of the email
 *   when they've uploaded one. Empty string otherwise so the existing layout
 *   is unchanged.
 * - `brandingFooterHtml` — renders the "Sent via HeyHenry" footer. Styling
 *   matches the previous plain-text line exactly (same gray, same size, no
 *   underline); the whole phrase is wrapped in an <a> so clicks track back
 *   to heyhenry.io with a UTM that identifies which surface drove the visit.
 * - `getEmailBrandingForTenant` — one call to fetch and long-sign the logo
 *   URL so each outbound send doesn't have to re-implement the lookup.
 *
 * The logo bucket is private so we have to sign. Signing for 30 days gives
 * the recipient time to open the email later without the image breaking.
 */

import { createClient } from '@/lib/supabase/server';

export type EmailBranding = {
  logoUrl: string | null;
  businessName: string;
};

export type EmailTemplateKey =
  | 'change_order'
  | 'quote'
  | 'quote_response'
  | 'invoice'
  | 'estimate'
  | 'portal_invite'
  | 'job_booking'
  | 'lead_notification'
  | 'referral_invite'
  | 'pulse_update'
  | 'refund_confirmation'
  | 'estimate_accepted_notification'
  | 'inbound_bounce';

const LOGO_SIGN_SECONDS = 60 * 60 * 24 * 30; // 30 days

export async function getEmailBrandingForTenant(tenantId: string): Promise<EmailBranding> {
  const supabase = await createClient();
  const { data } = await supabase
    .from('tenants')
    .select('name, logo_storage_path')
    .eq('id', tenantId)
    .maybeSingle();

  const businessName = (data?.name as string | undefined) ?? 'HeyHenry';
  const logoPath = (data?.logo_storage_path as string | null) ?? null;

  let logoUrl: string | null = null;
  if (logoPath) {
    const { data: signed } = await supabase.storage
      .from('photos')
      .createSignedUrl(logoPath, LOGO_SIGN_SECONDS);
    logoUrl = signed?.signedUrl ?? null;
  }

  return { logoUrl, businessName };
}

export function brandingLogoHtml(logoUrl: string | null | undefined, businessName: string): string {
  if (!logoUrl) return '';
  const alt = escapeHtml(`${businessName} logo`);
  // `height:auto;width:auto` keeps aspect ratio across clients that ignore
  // `max-*` (older Outlook especially) and would otherwise stretch the image
  // to fill its container.
  return `<img src="${logoUrl}" alt="${alt}" style="max-height:48px;max-width:220px;height:auto;width:auto;margin-bottom:16px;display:block" />`;
}

export function brandingFooterHtml(templateKey: EmailTemplateKey): string {
  const url = `https://heyhenry.io/?utm_source=tenant_email&utm_medium=referral&utm_campaign=sent_via_footer&utm_content=${templateKey}`;
  // Style matches the previous plain <p> footer; the <a> inherits color
  // and strips underline so the email looks identical unless clicked.
  return `<p style="color:#999;font-size:12px;"><a href="${url}" style="color:inherit;text-decoration:none">Sent via HeyHenry</a></p>`;
}

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}
