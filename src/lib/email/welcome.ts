import type { Plan } from '@/lib/billing/features';
import { PLAN_CATALOG } from '@/lib/billing/plans';
import { createAdminClient } from '@/lib/supabase/admin';
import { sendEmail } from './send';

/**
 * Post-signup welcome email signed by Jonathan, sent once per tenant.
 *
 * Idempotent: skips if `tenants.welcome_email_sent_at` is already stamped.
 * Safe to call from multiple paths (public signup, future operator-invite
 * acceptance, manual admin trigger).
 *
 * Reply-able: from `hello@heyhenry.io` so customer replies land in the
 * shared inbox the team already monitors.
 */
export async function sendWelcomeEmail(tenantId: string): Promise<void> {
  const admin = createAdminClient();

  const { data: tenant } = await admin
    .from('tenants')
    .select('id, name, plan, welcome_email_sent_at')
    .eq('id', tenantId)
    .single();
  if (!tenant || tenant.welcome_email_sent_at) return;

  const { data: member } = await admin
    .from('tenant_members')
    .select('user_id, first_name')
    .eq('tenant_id', tenantId)
    .eq('role', 'owner')
    .maybeSingle();
  if (!member) return;

  const { data: userResp } = await admin.auth.admin.getUserById(member.user_id);
  const email = userResp?.user?.email;
  if (!email) return;

  const firstName = (member.first_name as string | null)?.trim() || email.split('@')[0] || 'there';
  const businessName = (tenant.name as string | null) ?? 'your business';
  const planName = PLAN_CATALOG[tenant.plan as Plan]?.name ?? 'free trial';

  const dashboardUrl = `${process.env.NEXT_PUBLIC_APP_URL ?? 'https://app.heyhenry.io'}/dashboard`;

  const html = `
    <p>Hey ${escapeHtml(firstName)},</p>

    <p>Saw you signed up for HeyHenry — really glad you're here. Welcome.</p>

    <p>Quick orientation: HeyHenry is built so you can run <strong>${escapeHtml(businessName)}</strong> from your truck without losing the thread. The first thing most contractors do is create a quote and email it to a real customer. That's the fastest way to see if it fits how you work.</p>

    <p>I personally read every reply that comes to this email. If anything's broken or feels weird, hit reply and I'll sort it out.</p>

    <p>Welcome aboard.</p>

    <p>
      Jonathan<br/>
      Founder, HeyHenry
    </p>

    <p style="margin-top:24px;">
      <a href="${dashboardUrl}" style="display:inline-block;padding:10px 18px;background:#0a0a0a;color:#fff;text-decoration:none;border-radius:6px;">Open HeyHenry</a>
    </p>

    <p style="color:#666;font-size:12px;margin-top:24px;">
      You're on the ${escapeHtml(planName)} plan.
    </p>
  `;

  const result = await sendEmail({
    to: email,
    from: 'Jonathan @ HeyHenry <hello@heyhenry.io>',
    replyTo: 'hello@heyhenry.io',
    subject: 'Welcome to HeyHenry — quick note from Jonathan',
    html,
    caslCategory: 'transactional',
    relatedType: 'onboarding',
    relatedId: tenantId,
    caslEvidence: { kind: 'welcome_email', tenantId, userId: member.user_id },
  });
  if (!result.ok) {
    console.warn('Welcome email send failed:', result.error);
    return;
  }

  await admin
    .from('tenants')
    .update({ welcome_email_sent_at: new Date().toISOString() })
    .eq('id', tenantId);
}

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}
