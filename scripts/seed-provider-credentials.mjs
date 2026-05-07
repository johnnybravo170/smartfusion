#!/usr/bin/env node
/**
 * Upserts the LIVE Stripe secret key into Supabase `provider_credentials`.
 *
 * The secret never enters stdout, env-printing, or tool-call payloads —
 * it's read from .env.local (`STRIPE_SECRET_KEY_LIVE`) and written
 * straight to the row.
 *
 * Idempotent: re-running overwrites the existing row.
 *
 * Usage:
 *   node scripts/seed-provider-credentials.mjs            # dry preview
 *   node scripts/seed-provider-credentials.mjs --confirm  # actually upsert
 *
 * Reads from .env.local:
 *   STRIPE_SECRET_KEY_LIVE       — the value to store
 *   NEXT_PUBLIC_SUPABASE_URL     — Supabase project to write to
 *   SUPABASE_SERVICE_ROLE_KEY    — service-role auth for the write
 *
 * Heads-up: this writes to whichever Supabase project your .env.local
 * points at. If that's prod (most likely), this is a prod write.
 */

import { readFileSync } from 'node:fs';
import { createClient } from '@supabase/supabase-js';

// === Load .env.local ===
for (const line of readFileSync('.env.local', 'utf8').split('\n')) {
  const m = line.match(/^([A-Z_][A-Z0-9_]*)=(.*)$/);
  if (m && !process.env[m[1]]) process.env[m[1]] = m[2].replace(/^["']|["']$/g, '');
}

const stripeKey = process.env.STRIPE_SECRET_KEY_LIVE;
const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL;
const supabaseServiceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;

if (!stripeKey) {
  console.error('STRIPE_SECRET_KEY_LIVE missing from .env.local');
  process.exit(1);
}
if (!stripeKey.startsWith('sk_live_')) {
  console.error(
    `STRIPE_SECRET_KEY_LIVE does not look like a live key (starts with "${stripeKey.slice(0, 8)}").`,
  );
  process.exit(1);
}
if (!supabaseUrl) {
  console.error('NEXT_PUBLIC_SUPABASE_URL missing from .env.local');
  process.exit(1);
}
if (!supabaseServiceKey) {
  console.error('SUPABASE_SERVICE_ROLE_KEY missing from .env.local');
  process.exit(1);
}

const REGION = 'ca-central-1';
const PROVIDER = 'stripe';
const KEY_NAME = 'secret_key';

const confirmed = process.argv.includes('--confirm');
if (!confirmed) {
  console.log('\nDry preview — nothing has been changed.\n');
  console.log('This script will UPSERT into provider_credentials:');
  console.log(`  Supabase project: ${supabaseUrl}`);
  console.log(`  region   = ${REGION}`);
  console.log(`  provider = ${PROVIDER}`);
  console.log(`  key_name = ${KEY_NAME}`);
  console.log(`  value    = ${stripeKey.slice(0, 8)}...${stripeKey.slice(-4)} (sk_live, ${stripeKey.length} chars)`);
  console.log('\nIdempotent: re-running overwrites the existing row.');
  console.log('Re-run with --confirm to apply.\n');
  process.exit(0);
}

const supabase = createClient(supabaseUrl, supabaseServiceKey, {
  auth: { persistSession: false },
});

console.log(`\nUpserting Stripe secret_key into provider_credentials at ${supabaseUrl}...\n`);

const { data, error } = await supabase
  .from('provider_credentials')
  .upsert(
    {
      region: REGION,
      provider: PROVIDER,
      key_name: KEY_NAME,
      value: stripeKey,
      updated_at: new Date().toISOString(),
    },
    { onConflict: 'region,provider,key_name' },
  )
  .select('id, region, provider, key_name, updated_at')
  .single();

if (error) {
  console.error('Upsert failed:', error.message);
  process.exit(1);
}

console.log('✓ row written:');
console.log(`  id         = ${data.id}`);
console.log(`  region     = ${data.region}`);
console.log(`  provider   = ${data.provider}`);
console.log(`  key_name   = ${data.key_name}`);
console.log(`  updated_at = ${data.updated_at}`);
console.log('\nThe app will now resolve sk_live via getProviderSecret() at runtime.');
console.log('(env-var fallback in Vercel is still fine to keep — DB row takes precedence.)\n');
