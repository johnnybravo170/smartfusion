/**
 * Feature gate — 4-tier plan enforcement.
 *
 * Single source of truth for which plan tier unlocks which feature. Adding a
 * gated feature is one line in `FEATURE_TIERS` below — do not scatter plan
 * checks across the codebase.
 *
 * Hierarchy: starter < growth < pro < scale. A tenant on tier N can use any
 * feature whose required tier is <= N.
 *
 * Subscription status side-effects (see `effectivePlan`):
 *   trialing | active   → full access to selected plan
 *   past_due | unpaid   → downgrade to starter at the gate; in-app banner
 *   canceled            → downgrade to starter; data preserved
 */

export const PLANS = ['starter', 'growth', 'pro', 'scale'] as const;
export type Plan = (typeof PLANS)[number];

export const SUBSCRIPTION_STATUSES = [
  'trialing',
  'active',
  'past_due',
  'canceled',
  'unpaid',
] as const;
export type SubscriptionStatus = (typeof SUBSCRIPTION_STATUSES)[number];

const PLAN_RANK: Record<Plan, number> = {
  starter: 1,
  growth: 2,
  pro: 3,
  scale: 4,
};

/**
 * Catalog of every gated feature. Key is a kebab-namespaced string used at
 * call sites; value is the minimum plan tier required to use it.
 *
 * Add a new gated feature by adding one line here. Do NOT add inline
 * `if (tenant.plan === 'pro')` checks — they drift and rot.
 *
 * Source: canonical pricing doc, April 23 2026.
 */
export const FEATURE_TIERS = {
  // ---- Growth (rank 2) ----
  'team.roles': 'growth',
  'team.chat': 'growth',
  'sms.reminders': 'growth',
  'sms.review_requests': 'growth',
  'sms.two_way': 'growth',
  'twilio.dedicated_number': 'growth',
  'leads.public_widget': 'growth',
  'leads.polygon_quoting': 'growth',
  'gbp.auto_posting': 'growth',
  'seo.pack': 'growth',
  'social.auto_posting': 'growth',
  'reviews.automation': 'growth',
  'reviews.reputation_tracking': 'growth',
  'customers.followup_sequences': 'growth',
  'reports.revenue_dashboard': 'growth',
  'sub_quotes.email_inbox': 'growth',
  'sub_quotes.vision_ocr': 'growth',
  'henry.proactive_agents': 'growth',
  'henry.nightly_briefing': 'growth',
  'portal.branded': 'growth',
  'reports.custom_basic': 'growth',
  'quotes.assemblies': 'growth',
  'invoices.recurring': 'growth',

  // ---- Pro (rank 3) ----
  'materials.lifecycle': 'pro',
  'materials.shortage_alerts': 'pro',
  'materials.draft_pos': 'pro',
  'vendors.quote_compare': 'pro',
  'projects.allowances': 'pro',
  'projects.selections': 'pro',
  'projects.phase_dependencies': 'pro',
  'projects.gantt': 'pro',
  'labour.variance_alerts': 'pro',
  'reports.advanced': 'pro',
  'reports.custom_builder': 'pro',
  'routes.optimization': 'pro',
  'routes.trip_logger': 'pro',
  'routes.mileage': 'pro',
  'portal.custom_domain': 'pro',
  'henry.mcp_access': 'pro',
  'subs.insurance_tracking': 'pro',
  'tax.1099_t4a': 'pro',
  'payroll.wagepoint': 'pro',
  'payroll.qbo': 'pro',

  // ---- Scale (rank 4) ----
  'support.priority_sla': 'scale',
  'onboarding.dedicated_specialist': 'scale',
  'auth.sso': 'scale',
  'audit.extended_retention': 'scale',
  'team.department_permissions': 'scale',
  'payroll.adp': 'scale',
  'payroll.ceridian': 'scale',
} as const satisfies Record<string, Plan>;

export type Feature = keyof typeof FEATURE_TIERS;

/**
 * The plan the tenant can actually use right now. past_due / unpaid /
 * canceled all collapse to starter so the gate enforces the spec without
 * each call site having to remember status semantics.
 */
export function effectivePlan(plan: Plan, status: SubscriptionStatus): Plan {
  if (status === 'trialing' || status === 'active') return plan;
  return 'starter';
}

export function planRank(plan: Plan): number {
  return PLAN_RANK[plan];
}

type PlanContext = { plan: Plan; subscriptionStatus: SubscriptionStatus };

export function hasFeature(ctx: PlanContext, feature: Feature): boolean {
  const required = FEATURE_TIERS[feature];
  const effective = effectivePlan(ctx.plan, ctx.subscriptionStatus);
  return PLAN_RANK[effective] >= PLAN_RANK[required];
}

export function requiredTier(feature: Feature): Plan {
  return FEATURE_TIERS[feature];
}

export class FeatureGateError extends Error {
  readonly feature: Feature;
  readonly requiredPlan: Plan;
  readonly currentPlan: Plan;
  constructor(feature: Feature, requiredPlan: Plan, currentPlan: Plan) {
    super(`Feature ${feature} requires ${requiredPlan} plan (current: ${currentPlan})`);
    this.name = 'FeatureGateError';
    this.feature = feature;
    this.requiredPlan = requiredPlan;
    this.currentPlan = currentPlan;
  }
}

/**
 * Server-side guard. Throws FeatureGateError if the tenant cannot use the
 * feature. Server actions should catch and convert to the standard
 * `{ ok: false, error }` shape; route handlers should map to 402.
 */
export function requireFeature(ctx: PlanContext, feature: Feature): void {
  if (!hasFeature(ctx, feature)) {
    throw new FeatureGateError(feature, FEATURE_TIERS[feature], ctx.plan);
  }
}
