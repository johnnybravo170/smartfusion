/**
 * Stripe webhook handler.
 *
 * Handles:
 *   - checkout.session.completed: marks the invoice as paid
 *   - account.updated: updates tenant onboarding status
 *
 * The webhook secret must be configured in STRIPE_WEBHOOK_SECRET.
 * Use `stripe listen --forward-to localhost:3000/api/stripe/webhook`
 * during local development.
 */

import type Stripe from 'stripe';
import { getStripe } from '@/lib/stripe/client';
import { createClient } from '@/lib/supabase/server';

export async function POST(request: Request) {
  const body = await request.text();
  const sig = request.headers.get('stripe-signature');

  if (!sig) {
    return new Response('Missing stripe-signature header', { status: 400 });
  }

  let event: Stripe.Event;
  try {
    const webhookSecret = process.env.STRIPE_WEBHOOK_SECRET;
    if (!webhookSecret) {
      return new Response('STRIPE_WEBHOOK_SECRET not configured', { status: 500 });
    }
    event = getStripe().webhooks.constructEvent(body, sig, webhookSecret);
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Unknown error';
    return new Response(`Webhook signature verification failed: ${message}`, { status: 400 });
  }

  const supabase = await createClient();

  switch (event.type) {
    case 'checkout.session.completed': {
      const session = event.data.object;
      const invoiceId = session.metadata?.invoice_id;

      if (invoiceId) {
        const now = new Date().toISOString();
        const paymentIntentId =
          typeof session.payment_intent === 'string'
            ? session.payment_intent
            : (session.payment_intent?.id ?? null);

        await supabase
          .from('invoices')
          .update({
            status: 'paid',
            paid_at: now,
            stripe_payment_intent_id: paymentIntentId,
            updated_at: now,
          })
          .eq('id', invoiceId);

        // Load the invoice to get tenant_id and job_id for the worklog entry.
        const { data: invoice } = await supabase
          .from('invoices')
          .select('tenant_id, job_id')
          .eq('id', invoiceId)
          .single();

        if (invoice) {
          await supabase.from('worklog_entries').insert({
            tenant_id: invoice.tenant_id,
            entry_type: 'system',
            title: 'Invoice paid',
            body: `Invoice #${invoiceId.slice(0, 8)} paid via Stripe Checkout.`,
            related_type: 'job',
            related_id: invoice.job_id,
          });
        }
      }
      break;
    }

    case 'account.updated': {
      const account = event.data.object;
      if (account.charges_enabled && account.payouts_enabled) {
        const now = new Date().toISOString();
        // Find the tenant with this stripe_account_id and mark as onboarded.
        await supabase
          .from('tenants')
          .update({ stripe_onboarded_at: now, updated_at: now })
          .eq('stripe_account_id', account.id);
      }
      break;
    }

    default:
      // Unhandled event type -- ignore.
      break;
  }

  return new Response('ok', { status: 200 });
}
