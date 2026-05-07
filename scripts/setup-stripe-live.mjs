#!/usr/bin/env node
/**
 * One-shot LIVE Stripe setup for Hey Henry.
 *
 * Does three things, all idempotent (safe to re-run):
 *   1. Seeds products + prices + FOUNDER coupon/promo (delegates to
 *      seed-stripe-products.mjs).
 *   2. Creates the webhook endpoint pointed at the prod URL with the
 *      exact event list the app handler processes.
 *   3. Configures the Customer Portal (cancel off — we handle it in-app
 *      with prorated refunds; payment method + invoices on).
 *
 * Reads STRIPE_SECRET_KEY_LIVE from .env.local. Refuses to run unless
 * --confirm is passed because every operation hits the live account.
 *
 * Usage:
 *   node scripts/setup-stripe-live.mjs            # dry preview
 *   node scripts/setup-stripe-live.mjs --confirm  # actually run
 *
 * After this script:
 *   - Paste output env vars into Vercel Production
 *   - Paste sk_live_... into Supabase provider_credentials
 *     (region=ca-central-1, provider=stripe, key=secret_key)
 */

import { spawnSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import Stripe from 'stripe';

// === Config ===
const PROD_DOMAIN = 'https://app.heyhenry.io';
const WEBHOOK_URL = `${PROD_DOMAIN}/api/stripe/webhook`;
const PORTAL_RETURN_URL = `${PROD_DOMAIN}/settings/billing`;
const API_VERSION = '2026-03-25.dahlia';

// Events the app's webhook handler processes
// (see src/app/api/stripe/webhook/route.ts).
const WEBHOOK_EVENTS = [
  'checkout.session.completed',
  'customer.subscription.created',
  'customer.subscription.updated',
  'customer.subscription.deleted',
  'invoice.payment_succeeded',
  'invoice.payment_failed',
  'account.updated', // Stripe Connect onboarding status
];

// === Load .env.local ===
for (const line of readFileSync('.env.local', 'utf8').split('\n')) {
  const m = line.match(/^([A-Z_][A-Z0-9_]*)=(.*)$/);
  if (m && !process.env[m[1]]) process.env[m[1]] = m[2].replace(/^["']|["']$/g, '');
}

const key = process.env.STRIPE_SECRET_KEY_LIVE;
if (!key) {
  console.error('STRIPE_SECRET_KEY_LIVE missing from .env.local. Paste your sk_live_... and re-run.');
  process.exit(1);
}
if (!key.startsWith('sk_live_')) {
  console.error(`STRIPE_SECRET_KEY_LIVE is not a live key (starts with "${key.slice(0, 8)}").`);
  process.exit(1);
}

const confirmed = process.argv.includes('--confirm');
if (!confirmed) {
  console.log('\nDry preview — nothing has been changed.\n');
  console.log('This script will, on your LIVE Stripe account:');
  console.log('  1. Seed 4 products + 8 prices + FOUNDER coupon/promo (idempotent)');
  console.log(`  2. Register webhook ${WEBHOOK_URL}`);
  console.log(`     events: ${WEBHOOK_EVENTS.join(', ')}`);
  console.log(`  3. Configure Customer Portal (return ${PORTAL_RETURN_URL})`);
  console.log('     - cancel: OFF (handled in-app for prorated refund)');
  console.log('     - plan switch: OFF (no in-app upgrade UI yet)');
  console.log('     - payment method update: ON');
  console.log('     - invoice history: ON');
  console.log('\nAll operations are idempotent. Re-run with --confirm to apply.\n');
  process.exit(0);
}

const stripe = new Stripe(key, { apiVersion: API_VERSION });

console.log('\nSetting up Stripe LIVE for Hey Henry...\n');

// ---------------------------------------------------------------------------
// 1. Seed products / prices / coupon / promo (delegate to existing script)
// ---------------------------------------------------------------------------
console.log('--- Step 1: seed products, prices, FOUNDER coupon ---\n');
const seed = spawnSync('node', ['scripts/seed-stripe-products.mjs', '--allow-live'], {
  stdio: 'inherit',
  // Override the seed's STRIPE_SECRET_KEY with our LIVE one for this run
  env: { ...process.env, STRIPE_SECRET_KEY: key },
});
if (seed.status !== 0) {
  console.error('\nSeed failed. Aborting before webhook/portal setup.');
  process.exit(seed.status ?? 1);
}

// ---------------------------------------------------------------------------
// 2. Webhook endpoint
// ---------------------------------------------------------------------------
console.log('\n--- Step 2: webhook endpoint ---\n');

async function ensureWebhook() {
  // List existing endpoints, look for one pointed at our URL.
  const existing = await stripe.webhookEndpoints.list({ limit: 100 });
  const found = existing.data.find((w) => w.url === WEBHOOK_URL);

  if (found) {
    // Patch event list if it drifts from what the handler supports.
    const desired = new Set(WEBHOOK_EVENTS);
    const current = new Set(found.enabled_events);
    const drift =
      desired.size !== current.size ||
      [...desired].some((e) => !current.has(e)) ||
      [...current].some((e) => !desired.has(e));

    if (drift || found.status !== 'enabled') {
      const updated = await stripe.webhookEndpoints.update(found.id, {
        enabled_events: WEBHOOK_EVENTS,
        disabled: false,
      });
      console.log(`  webhook ${updated.id} (existing — patched event list)`);
    } else {
      console.log(`  webhook ${found.id} (existing)`);
    }
    // The signing secret is only returned on create. For existing endpoints
    // it must be retrieved manually from the dashboard or rotated.
    return { id: found.id, secret: null };
  }

  const wh = await stripe.webhookEndpoints.create({
    url: WEBHOOK_URL,
    enabled_events: WEBHOOK_EVENTS,
    description: 'Hey Henry production app — subscription billing + Connect',
  });
  console.log(`  webhook ${wh.id} (created)`);
  return { id: wh.id, secret: wh.secret ?? null };
}

const webhook = await ensureWebhook();

// ---------------------------------------------------------------------------
// 3. Customer Portal configuration
// ---------------------------------------------------------------------------
console.log('\n--- Step 3: customer portal ---\n');

const portalFeatures = {
  customer_update: {
    enabled: true,
    allowed_updates: ['email', 'address', 'phone', 'tax_id'],
  },
  invoice_history: { enabled: true },
  payment_method_update: { enabled: true },
  // Cancel and upgrade flows are handled in-app — leaving them off here
  // routes users to /settings/billing where the prorated-refund logic
  // lives. Turn these on later if/when we want to delegate.
  subscription_cancel: { enabled: false },
  subscription_pause: { enabled: false },
  subscription_update: { enabled: false },
};

async function ensurePortalConfig() {
  const existing = await stripe.billingPortal.configurations.list({
    is_default: true,
    limit: 1,
  });
  const found = existing.data[0];

  if (found) {
    const updated = await stripe.billingPortal.configurations.update(found.id, {
      features: portalFeatures,
      default_return_url: PORTAL_RETURN_URL,
    });
    console.log(`  portal config ${updated.id} (existing — updated)`);
    return updated;
  }

  const created = await stripe.billingPortal.configurations.create({
    features: portalFeatures,
    default_return_url: PORTAL_RETURN_URL,
  });
  console.log(`  portal config ${created.id} (created — set as default)`);
  return created;
}

await ensurePortalConfig();

// ---------------------------------------------------------------------------
// Output: env vars written to a local-only file (NOT echoed to stdout because
// some values are sensitive and stdout may end up in shared transcripts).
// ---------------------------------------------------------------------------
const OUT_FILE = '.stripe-live-output.local';
const lines = [
  '# Stripe LIVE setup output — paste into Vercel Production env',
  '# This file is gitignored. Delete it after pasting.',
  `# Generated: ${new Date().toISOString()}`,
  '',
  `STRIPE_PUBLISHABLE_KEY=${process.env.STRIPE_PUBLISHABLE_KEY_LIVE ?? 'pk_live_...'}`,
];
if (webhook.secret) {
  lines.push(`STRIPE_WEBHOOK_SECRET=${webhook.secret}`);
} else {
  lines.push('STRIPE_WEBHOOK_SECRET=<grab from dashboard — see note below>');
}
lines.push('');
lines.push('# (price + coupon + promo IDs are printed in stdout above — also paste those)');

writeFileSync(OUT_FILE, lines.join('\n') + '\n', { mode: 0o600 });

console.log('\n=== Done ===\n');
console.log(`Sensitive output written to ${OUT_FILE} (mode 0600, gitignored).`);
console.log('Open it locally to copy into Vercel, then delete the file.\n');

console.log('Supabase provider_credentials row:');
console.log('  region=ca-central-1, provider=stripe, key=secret_key');
console.log('  value=<your sk_live_... — same one this script just used>\n');

if (!webhook.secret) {
  console.log('⚠  Webhook signing secret was NOT printed because this endpoint already');
  console.log('   existed. Either:');
  console.log('     a) Find it in Stripe Dashboard → Developers → Webhooks → click the');
  console.log(`        endpoint (${webhook.id}) → "Signing secret" → Reveal`);
  console.log('     b) Or roll the secret here — but that breaks any existing deployment');
  console.log('        until the new value is in Vercel env.');
  console.log('');
}

console.log('Next steps:');
console.log('  1. Paste the env vars above into Vercel Production env');
console.log('  2. Add the sk_live secret to Supabase provider_credentials');
console.log('  3. Redeploy from Vercel dashboard or push a commit');
console.log('  4. Smoke-test: sign up via /onboarding/plan?plan=growth&promo=FOUNDER');
console.log('     with your own card, verify $222.88 + FOUNDER -$200 line + tax line');
console.log('     + webhook fires + banner shows + portal works, then refund yourself.');
console.log('');
