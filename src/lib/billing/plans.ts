/**
 * Plan metadata + Stripe price ID resolver.
 *
 * Source of truth for the marketing/pricing-facing copy and for mapping
 * `(plan, billing)` → Stripe price ID. Stripe-side product/price config
 * lives in the Stripe dashboard (see ops kanban for the seeding card).
 *
 * Env vars (set in Vercel + .env.local):
 *   STRIPE_PRICE_<PLAN>_<MONTHLY|YEARLY>
 */

import type { Plan } from './features';

export const BILLING_CYCLES = ['monthly', 'yearly'] as const;
export type BillingCycle = (typeof BILLING_CYCLES)[number];

export type PlanCopy = {
  plan: Plan;
  name: string;
  tagline: string;
  monthlyCadCents: number;
  yearlyCadCents: number; // already 20% off vs monthly × 12
  seatBand: string;
  highlights: string[];
};

export const PLAN_CATALOG: Record<Plan, PlanCopy> = {
  starter: {
    plan: 'starter',
    name: 'Starter',
    tagline: 'Solo operator, 1–2 people',
    monthlyCadCents: 16_900,
    yearlyCadCents: 162_240, // $169 × 12 × 0.8
    seatBand: '1–2 seats',
    highlights: [
      'CRM + jobs + scheduling',
      'Quoting + invoicing + change orders',
      'Photos, closeout packages, dispute defense',
      'QBO sync + Stripe Connect + Helcim EFT',
      'Henry voice, support, Month at a Glance',
    ],
  },
  growth: {
    plan: 'growth',
    name: 'Growth',
    tagline: 'Small crew, 2–10 people',
    monthlyCadCents: 39_900,
    yearlyCadCents: 383_040, // $399 × 12 × 0.8
    seatBand: '2–10 seats',
    highlights: [
      'Everything in Starter, plus:',
      'SMS reminders + two-way relay + dedicated number',
      'Public lead widget + polygon quoting',
      'Reviews + GBP auto-posting + SEO pack',
      'Branded portal + revenue dashboard',
      'Proactive Henry agents + nightly briefing',
    ],
  },
  pro: {
    plan: 'pro',
    name: 'Pro',
    tagline: 'Established operation, 10–25 people',
    monthlyCadCents: 69_900,
    yearlyCadCents: 671_040, // $699 × 12 × 0.8
    seatBand: '10–25 seats',
    highlights: [
      'Everything in Growth, plus:',
      'Materials lifecycle + shortage alerts + draft POs',
      'Allowances + selections + Gantt + phase deps',
      'Real-time labour variance + advanced reporting',
      'Route optimization + custom domain + MCP access',
      'Payroll (Wagepoint, QBO Payroll) + 1099/T4A',
    ],
  },
  scale: {
    plan: 'scale',
    name: 'Scale',
    tagline: '25–100 people',
    monthlyCadCents: 129_900,
    yearlyCadCents: 1_247_040, // $1,299 × 12 × 0.8
    seatBand: '25–100 seats',
    highlights: [
      'Everything in Pro, plus:',
      'Priority support SLA + dedicated onboarding',
      'SSO (Google Workspace, Microsoft 365)',
      'Department-level permissions + extended audit log',
      'Payroll (ADP Canada, Ceridian Dayforce)',
    ],
  },
};

const ENV_BY_PLAN: Record<Plan, { monthly: string; yearly: string }> = {
  starter: { monthly: 'STRIPE_PRICE_STARTER_MONTHLY', yearly: 'STRIPE_PRICE_STARTER_YEARLY' },
  growth: { monthly: 'STRIPE_PRICE_GROWTH_MONTHLY', yearly: 'STRIPE_PRICE_GROWTH_YEARLY' },
  pro: { monthly: 'STRIPE_PRICE_PRO_MONTHLY', yearly: 'STRIPE_PRICE_PRO_YEARLY' },
  scale: { monthly: 'STRIPE_PRICE_SCALE_MONTHLY', yearly: 'STRIPE_PRICE_SCALE_YEARLY' },
};

/**
 * Resolves the Stripe price ID for a given (plan, cycle). Throws if the
 * env var is unset — fail loudly, do not silently downgrade to Starter.
 */
export function getPriceId(plan: Plan, cycle: BillingCycle): string {
  const envName = ENV_BY_PLAN[plan][cycle];
  const value = process.env[envName];
  if (!value) {
    throw new Error(`Missing Stripe price ID env var: ${envName}`);
  }
  return value;
}

/**
 * Reverse lookup: given a Stripe price ID from a webhook, figure out
 * which (plan, cycle) it represents. Returns null for unknown IDs.
 */
export function findPlanForPriceId(priceId: string): { plan: Plan; cycle: BillingCycle } | null {
  for (const plan of Object.keys(ENV_BY_PLAN) as Plan[]) {
    for (const cycle of BILLING_CYCLES) {
      if (process.env[ENV_BY_PLAN[plan][cycle]] === priceId) {
        return { plan, cycle };
      }
    }
  }
  return null;
}

export function isPlan(value: string | null | undefined): value is Plan {
  return value === 'starter' || value === 'growth' || value === 'pro' || value === 'scale';
}

export function isBillingCycle(value: string | null | undefined): value is BillingCycle {
  return value === 'monthly' || value === 'yearly';
}

export function formatCad(cents: number): string {
  return `$${Math.round(cents / 100).toLocaleString('en-CA')}`;
}
