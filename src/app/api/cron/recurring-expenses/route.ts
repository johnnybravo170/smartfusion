/**
 * Daily cron — materialize expenses for recurring rules.
 *
 * For every active rule whose next_run_at <= today:
 *   1. Create a new expenses row cloning the rule's template fields,
 *      with expense_date = next_run_at.
 *   2. Advance next_run_at to the same day of the following month.
 *
 * Skips rules whose next_run_at falls on or before the tenant's
 * books_closed_through (can't backdate into a locked period).
 *
 * Idempotent: if today's run already created an expense for a rule
 * (linked via recurring_rule_id + matching expense_date), we skip —
 * prevents double-creation if the cron runs twice on the same day.
 */

import { createAdminClient } from '@/lib/supabase/admin';

export const dynamic = 'force-dynamic';
export const maxDuration = 60;

function addOneMonth(isoDate: string): string {
  const [y, m, d] = isoDate.split('-').map(Number);
  // day_of_month is capped at 28 in the schema, so no month-length edge case.
  const next = new Date(Date.UTC(y ?? 0, (m ?? 1) - 1, d ?? 1));
  next.setUTCMonth(next.getUTCMonth() + 1);
  return next.toISOString().slice(0, 10);
}

export async function GET() {
  const admin = createAdminClient();
  const today = new Date().toISOString().slice(0, 10);

  const { data: rules, error } = await admin
    .from('expense_recurring_rules')
    .select(
      'id, tenant_id, created_by, category_id, vendor, description, amount_cents, tax_cents, next_run_at',
    )
    .eq('active', true)
    .lte('next_run_at', today);

  if (error) {
    return Response.json({ ok: false, error: error.message }, { status: 500 });
  }

  const rows = rules ?? [];
  let created = 0;
  let skippedClosedBooks = 0;
  let skippedDuplicate = 0;

  for (const rule of rows) {
    const tenantId = rule.tenant_id as string;
    const runDate = rule.next_run_at as string;

    // Honor the tenant's books-closed-through guard.
    const { data: t } = await admin
      .from('tenants')
      .select('books_closed_through')
      .eq('id', tenantId)
      .single();
    const closedThrough = (t?.books_closed_through as string | null) ?? null;
    if (closedThrough && runDate <= closedThrough) {
      skippedClosedBooks++;
      // Still advance the rule so we don't spin on the same locked date.
      await admin
        .from('expense_recurring_rules')
        .update({ next_run_at: addOneMonth(runDate), updated_at: new Date().toISOString() })
        .eq('id', rule.id as string);
      continue;
    }

    // Idempotency: skip if an expense already exists for this rule on this date.
    const { data: existing } = await admin
      .from('expenses')
      .select('id')
      .eq('recurring_rule_id', rule.id as string)
      .eq('expense_date', runDate)
      .limit(1);
    if (existing && existing.length > 0) {
      skippedDuplicate++;
      await admin
        .from('expense_recurring_rules')
        .update({ next_run_at: addOneMonth(runDate), updated_at: new Date().toISOString() })
        .eq('id', rule.id as string);
      continue;
    }

    // Resolve a user_id for the expense row (we want created_by to be the
    // rule's creator so the audit trail is sensible). Falls back to the
    // first owner on the tenant if the creator member has been removed.
    let userId: string | null = null;
    if (rule.created_by) {
      const { data: m } = await admin
        .from('tenant_members')
        .select('user_id')
        .eq('id', rule.created_by as string)
        .maybeSingle();
      userId = (m?.user_id as string | null) ?? null;
    }
    if (!userId) {
      const { data: owner } = await admin
        .from('tenant_members')
        .select('user_id')
        .eq('tenant_id', tenantId)
        .eq('role', 'owner')
        .limit(1)
        .maybeSingle();
      userId = (owner?.user_id as string | null) ?? null;
    }
    if (!userId) continue; // defensive — nobody to attribute to

    const { error: insErr } = await admin.from('expenses').insert({
      tenant_id: tenantId,
      user_id: userId,
      project_id: null,
      bucket_id: null,
      job_id: null,
      category_id: rule.category_id as string | null,
      recurring_rule_id: rule.id as string,
      amount_cents: rule.amount_cents as number,
      tax_cents: (rule.tax_cents as number) ?? 0,
      vendor: (rule.vendor as string | null) ?? null,
      description: (rule.description as string | null) ?? null,
      expense_date: runDate,
    });
    if (insErr) {
      // Don't advance on error — we want to retry tomorrow.
      continue;
    }
    created++;

    await admin
      .from('expense_recurring_rules')
      .update({ next_run_at: addOneMonth(runDate), updated_at: new Date().toISOString() })
      .eq('id', rule.id as string);
  }

  return Response.json({
    ok: true,
    today,
    rules_checked: rows.length,
    expenses_created: created,
    skipped_closed_books: skippedClosedBooks,
    skipped_duplicate: skippedDuplicate,
  });
}
