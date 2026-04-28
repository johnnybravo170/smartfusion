#!/usr/bin/env node
/**
 * Seeds Stripe with HeyHenry's 4 subscription products + 8 prices + founder coupon.
 *
 * Idempotent: looks up existing products by `metadata.heyhenry_plan` and
 * existing prices by `metadata.heyhenry_plan + heyhenry_cycle`. Re-run is
 * safe — outputs the same IDs.
 *
 * Reads STRIPE_SECRET_KEY from .env.local. Errors if you point it at a
 * live key (sk_live_*) — flip the explicit `--allow-live` flag if you
 * really mean to seed production.
 *
 * Usage:
 *   node scripts/seed-stripe-products.mjs            # test mode
 *   node scripts/seed-stripe-products.mjs --allow-live   # production (extra confirmation)
 *
 * Output: paste the printed env vars into Vercel (Preview for test mode,
 * Production for live).
 */

import { readFileSync } from 'node:fs';
import Stripe from 'stripe';

// Hand-roll .env.local loading — avoids a dotenv dep just for one script.
for (const line of readFileSync('.env.local', 'utf8').split('\n')) {
  const m = line.match(/^([A-Z_][A-Z0-9_]*)=(.*)$/);
  if (m && !process.env[m[1]]) process.env[m[1]] = m[2].replace(/^["']|["']$/g, '');
}

const allowLive = process.argv.includes('--allow-live');
const key = process.env.STRIPE_SECRET_KEY;
if (!key) {
  console.error('STRIPE_SECRET_KEY missing from .env.local');
  process.exit(1);
}

const isLive = key.startsWith('sk_live_');
if (isLive && !allowLive) {
  console.error(
    'Refusing to seed against a LIVE Stripe key without --allow-live. Use a test key (sk_test_) or pass --allow-live.',
  );
  process.exit(1);
}

const stripe = new Stripe(key, { apiVersion: '2026-03-25.dahlia' });

console.log(`\nSeeding Stripe in ${isLive ? 'LIVE' : 'TEST'} mode...\n`);

// === Plan catalog (mirrors src/lib/billing/plans.ts) ===
const PLANS = [
  {
    plan: 'starter',
    name: 'HeyHenry Starter',
    description: 'Solo operator, 1–2 people. CRM + jobs + quoting + invoicing.',
    monthlyCadCents: 16_900,
    yearlyCadCents: 162_240,
  },
  {
    plan: 'growth',
    name: 'HeyHenry Growth',
    description: 'Small crew, 2–10 people. Adds SMS, lead widget, reviews, branded portal.',
    monthlyCadCents: 39_900,
    yearlyCadCents: 383_040,
  },
  {
    plan: 'pro',
    name: 'HeyHenry Pro',
    description: 'Established operation, 10–25 people. Adds materials, Gantt, payroll.',
    monthlyCadCents: 69_900,
    yearlyCadCents: 671_040,
  },
  {
    plan: 'scale',
    name: 'HeyHenry Scale',
    description: '25–100 people. Adds priority SLA, SSO, advanced permissions.',
    monthlyCadCents: 129_900,
    yearlyCadCents: 1_247_040,
  },
];

// Stripe's search API has a propagation delay — rows just created may
// not appear for several seconds. We use products.list (no delay) and
// filter in JS instead. Slower per call but reliable for re-runs.
async function findProductByPlan(planSlug) {
  for await (const product of stripe.products.list({ active: true, limit: 100 })) {
    if (product.metadata?.heyhenry_plan === planSlug) return product;
  }
  return null;
}

async function findPriceForProduct(productId, cycle) {
  for await (const price of stripe.prices.list({ product: productId, active: true, limit: 100 })) {
    if (price.metadata?.heyhenry_cycle === cycle) return price;
  }
  return null;
}

async function ensureProduct(planSpec) {
  const existing = await findProductByPlan(planSpec.plan);
  if (existing) {
    console.log(`  product ${planSpec.plan} → ${existing.id} (existing)`);
    return existing;
  }
  const product = await stripe.products.create({
    name: planSpec.name,
    description: planSpec.description,
    metadata: { heyhenry_plan: planSpec.plan },
  });
  console.log(`  product ${planSpec.plan} → ${product.id} (created)`);
  return product;
}

async function ensurePrice(product, planSpec, cycle) {
  const existing = await findPriceForProduct(product.id, cycle);
  if (existing) {
    console.log(`  price   ${planSpec.plan}/${cycle} → ${existing.id} (existing)`);
    return existing;
  }
  const unitAmount =
    cycle === 'monthly' ? planSpec.monthlyCadCents : planSpec.yearlyCadCents;
  const interval = cycle === 'monthly' ? 'month' : 'year';
  const price = await stripe.prices.create({
    product: product.id,
    currency: 'cad',
    unit_amount: unitAmount,
    recurring: { interval },
    metadata: { heyhenry_plan: planSpec.plan, heyhenry_cycle: cycle },
  });
  console.log(`  price   ${planSpec.plan}/${cycle} → ${price.id} (created)`);
  return price;
}

async function ensureFounderCoupon(growthProductId) {
  // Look up by id — we use a stable id so re-runs find it.
  const couponId = 'FOUNDER_GROWTH_LIFETIME';
  let coupon;
  try {
    coupon = await stripe.coupons.retrieve(couponId);
    console.log(`  coupon  ${couponId} (existing)`);
  } catch (err) {
    if (err.code !== 'resource_missing') throw err;
    coupon = await stripe.coupons.create({
      id: couponId,
      name: 'Founding Member — Growth Lifetime',
      amount_off: 20_000, // $200 CAD
      currency: 'cad',
      duration: 'forever',
      applies_to: { products: [growthProductId] },
      metadata: { heyhenry_program: 'founding_member' },
    });
    console.log(`  coupon  ${couponId} (created — $200 CAD off Growth, lifetime)`);
  }
  return coupon;
}

async function ensureFounderPromotionCode(couponId) {
  // dahlia API (2026-03-25) renamed top-level `coupon` to a `promotion`
  // object. The `code` filter on list still works; on create we now pass
  // `promotion: { type: 'coupon', coupon }`.
  const existing = await stripe.promotionCodes.list({ code: 'FOUNDER', active: true, limit: 10 });
  const found = existing.data.find((p) => {
    const cid = typeof p.promotion?.coupon === 'string' ? p.promotion.coupon : p.promotion?.coupon?.id;
    return cid === couponId;
  });
  if (found) {
    console.log(`  promo   FOUNDER → ${found.id} (existing)`);
    return found;
  }
  const promo = await stripe.promotionCodes.create({
    promotion: { type: 'coupon', coupon: couponId },
    code: 'FOUNDER',
    metadata: { heyhenry_program: 'founding_member' },
  });
  console.log(`  promo   FOUNDER → ${promo.id} (created)`);
  return promo;
}

// === Run ===

const envOut = {};
const productByPlan = {};
for (const planSpec of PLANS) {
  const product = await ensureProduct(planSpec);
  productByPlan[planSpec.plan] = product;
  for (const cycle of ['monthly', 'yearly']) {
    const price = await ensurePrice(product, planSpec, cycle);
    const envName = `STRIPE_PRICE_${planSpec.plan.toUpperCase()}_${cycle.toUpperCase()}`;
    envOut[envName] = price.id;
  }
}

// Founder coupon — applies only to Growth product.
const coupon = await ensureFounderCoupon(productByPlan.growth.id);
const promo = await ensureFounderPromotionCode(coupon.id);

console.log('\n--- Env vars to set in Vercel (Preview for test mode, Production for live) ---\n');
for (const [name, value] of Object.entries(envOut)) {
  console.log(`${name}=${value}`);
}
console.log(`\nSTRIPE_FOUNDER_COUPON_ID=${coupon.id}`);
console.log(`STRIPE_FOUNDER_PROMO_CODE_ID=${promo.id}`);
console.log(`\nFounder promo code: FOUNDER  →  $200 CAD off Growth monthly, lifetime\n`);
