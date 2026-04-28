#!/usr/bin/env node
/**
 * One-off cleanup: the seed script's first two runs created duplicate
 * products before idempotency was fixed. Keep the OLDEST product per
 * heyhenry_plan and archive the rest. Prices on archived products
 * become unusable but stay in Stripe history.
 */

import { readFileSync } from 'node:fs';
import Stripe from 'stripe';

for (const line of readFileSync('.env.local', 'utf8').split('\n')) {
  const m = line.match(/^([A-Z_][A-Z0-9_]*)=(.*)$/);
  if (m && !process.env[m[1]]) process.env[m[1]] = m[2].replace(/^["']|["']$/g, '');
}

const stripe = new Stripe(process.env.STRIPE_SECRET_KEY, { apiVersion: '2026-03-25.dahlia' });

const byPlan = {};
for await (const product of stripe.products.list({ active: true, limit: 100 })) {
  const plan = product.metadata?.heyhenry_plan;
  if (!plan) continue;
  byPlan[plan] ??= [];
  byPlan[plan].push(product);
}

for (const [plan, products] of Object.entries(byPlan)) {
  products.sort((a, b) => a.created - b.created);
  const keep = products[0];
  const dupes = products.slice(1);
  console.log(`\n${plan}: keep ${keep.id} (created ${new Date(keep.created * 1000).toISOString()})`);
  for (const d of dupes) {
    console.log(`  archiving ${d.id} (created ${new Date(d.created * 1000).toISOString()})`);
    await stripe.products.update(d.id, { active: false });
  }
}

console.log('\nDone. Run seed-stripe-products.mjs again to verify it now picks up existing products.');
