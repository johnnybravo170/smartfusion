#!/usr/bin/env tsx
/**
 * Seeds realistic pressure-washing test data into a tenant.
 *
 * Usage:
 *   set -a && source .env.local && set +a
 *   pnpm tsx scripts/seed-test-data.ts --email jonathan@heyhenry.io
 *   pnpm tsx scripts/seed-test-data.ts --email jonathan@heyhenry.io --reset
 *
 * --reset wipes all existing tenant data first (keeps the tenant + members).
 */
import { createClient } from '@supabase/supabase-js';
import postgres from 'postgres';

type Row = Record<string, unknown>;

function arg(name: string): string | undefined {
  const idx = process.argv.indexOf(name);
  return idx >= 0 ? process.argv[idx + 1] : undefined;
}

function flag(name: string): boolean {
  return process.argv.includes(name);
}

async function main() {
  const email = arg('--email');
  if (!email) {
    console.error('Missing --email');
    process.exit(1);
  }

  const { NEXT_PUBLIC_SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, DATABASE_URL } = process.env;
  if (!NEXT_PUBLIC_SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY || !DATABASE_URL) {
    console.error('Need NEXT_PUBLIC_SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, DATABASE_URL in env.');
    process.exit(1);
  }

  const supabase = createClient(NEXT_PUBLIC_SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);
  const sql = postgres(DATABASE_URL, { prepare: false });

  // Find tenant by email
  const { data: list } = await supabase.auth.admin.listUsers();
  const user = list.users.find((u) => u.email === email);
  if (!user) {
    console.error(`No user found for ${email}`);
    process.exit(1);
  }
  const [tenant] = await sql<
    Row[]
  >`select t.id, t.name from tenants t join tenant_members tm on tm.tenant_id=t.id where tm.user_id=${user.id} limit 1`;
  if (!tenant) {
    console.error(`No tenant for user ${email}`);
    process.exit(1);
  }
  const tenantId = tenant.id as string;
  const userId = user.id;
  console.log(`[seed] tenant=${tenant.name} (${tenantId}) user=${email}`);

  if (flag('--reset')) {
    console.log('[seed] --reset: wiping existing tenant data');
    // Order matters: children first
    await sql`delete from public.worklog_entries where tenant_id = ${tenantId}`;
    await sql`delete from public.todos where tenant_id = ${tenantId}`;
    await sql`delete from public.audit_log where tenant_id = ${tenantId}`;
    await sql`delete from public.data_exports where tenant_id = ${tenantId}`;
    await sql`delete from public.invoices where tenant_id = ${tenantId}`;
    await sql`delete from public.photos where tenant_id = ${tenantId}`;
    await sql`delete from public.jobs where tenant_id = ${tenantId}`;
    await sql`delete from public.quote_surfaces qs using public.quotes q where qs.quote_id=q.id and q.tenant_id=${tenantId}`;
    await sql`delete from public.quotes where tenant_id = ${tenantId}`;
    await sql`delete from public.catalog_items where tenant_id = ${tenantId}`;
    await sql`delete from public.customers where tenant_id = ${tenantId}`;
    console.log('[seed] wiped');
  }

  // --- Pricebook (pressure washing surfaces + BC pricing) ---
  const catalog = [
    { name: 'Driveway', surface_type: 'driveway', unit_price_cents: 25, min_charge_cents: 15000 },
    {
      name: 'House siding',
      surface_type: 'house_siding',
      unit_price_cents: 30,
      min_charge_cents: 20000,
    },
    { name: 'Deck / patio', surface_type: 'deck', unit_price_cents: 40, min_charge_cents: 15000 },
    {
      name: 'Roof (soft wash)',
      surface_type: 'roof',
      unit_price_cents: 50,
      min_charge_cents: 30000,
    },
    {
      name: 'Concrete pad',
      surface_type: 'concrete_pad',
      unit_price_cents: 20,
      min_charge_cents: 10000,
    },
    { name: 'Sidewalk', surface_type: 'sidewalk', unit_price_cents: 20, min_charge_cents: 7500 },
  ];
  for (const item of catalog) {
    await sql`
      insert into public.catalog_items (
        tenant_id, name, surface_type, pricing_model, unit_label,
        unit_price_cents, min_charge_cents, category, is_taxable, is_active
      ) values (
        ${tenantId}, ${item.name}, ${item.surface_type}, 'per_unit', 'sqft',
        ${item.unit_price_cents}, ${item.min_charge_cents}, 'service', true, true
      )
    `;
  }
  console.log(`[seed] ${catalog.length} pricebook entries`);

  // --- Customers ---
  const customers = [
    {
      type: 'residential',
      name: 'Sarah Chen',
      email: 'sarah.chen@example.com',
      phone: '604-555-0142',
      address_line1: '3412 Springfield Dr',
      city: 'Abbotsford',
      province: 'BC',
      postal_code: 'V2S 7K9',
    },
    {
      type: 'residential',
      name: 'Mike Dawson',
      email: 'mdawson@example.com',
      phone: '604-555-0183',
      address_line1: '2217 Mountain View Rd',
      city: 'Abbotsford',
      province: 'BC',
      postal_code: 'V2T 4R5',
    },
    {
      type: 'residential',
      name: 'The Patel Family',
      email: 'rpatel@example.com',
      phone: '778-555-0199',
      address_line1: '445 Lakeshore Blvd',
      city: 'Chilliwack',
      province: 'BC',
      postal_code: 'V2P 1B3',
    },
    {
      type: 'residential',
      name: 'Karen Jones',
      phone: '604-555-0221',
      address_line1: '1108 Maple Crescent',
      city: 'Mission',
      province: 'BC',
      postal_code: 'V2V 3N1',
    },
    {
      type: 'commercial',
      name: 'Abbotsford Plaza',
      email: 'management@abbyplaza.com',
      phone: '604-555-0100',
      address_line1: '32500 South Fraser Way',
      city: 'Abbotsford',
      province: 'BC',
      postal_code: 'V2T 4V6',
      notes: 'Quarterly recurring — large parking lot + storefront siding',
    },
    {
      type: 'commercial',
      name: 'Valley Auto Group',
      email: 'service@valleyauto.com',
      phone: '604-555-0175',
      address_line1: '30170 Automall Dr',
      city: 'Abbotsford',
      province: 'BC',
      postal_code: 'V2T 5M1',
      notes: 'Monthly lot wash, net-30',
    },
    {
      type: 'agent',
      name: 'Helen Fraser (ReMax)',
      email: 'hfraser@remax.ca',
      phone: '604-555-0155',
      address_line1: '2630 Bourquin Crescent',
      city: 'Abbotsford',
      province: 'BC',
      postal_code: 'V2S 5N7',
      notes: 'Pre-listing rush jobs, bill to brokerage',
    },
    {
      type: 'agent',
      name: 'Dave Hoang (Royal LePage)',
      email: 'dhoang@royallepage.ca',
      phone: '778-555-0188',
      address_line1: '101-2618 West Railway St',
      city: 'Abbotsford',
      province: 'BC',
      postal_code: 'V2S 2E4',
    },
  ];
  const customerIds: string[] = [];
  for (const c of customers) {
    const [row] = await sql<
      Row[]
    >`insert into public.customers ${sql({ ...c, tenant_id: tenantId })} returning id`;
    customerIds.push(row.id as string);
  }
  console.log(`[seed] ${customers.length} customers`);

  // --- Quotes + surfaces ---
  type QuoteSeed = {
    customer_idx: number;
    status: string;
    sent_days_ago?: number;
    accepted_days_ago?: number;
    notes?: string;
    surfaces: { surface_type: string; sqft: number }[];
  };
  const quoteSeeds: QuoteSeed[] = [
    {
      customer_idx: 0,
      status: 'accepted',
      sent_days_ago: 14,
      accepted_days_ago: 12,
      notes: 'Annual spring clean',
      surfaces: [
        { surface_type: 'driveway', sqft: 680 },
        { surface_type: 'house_siding', sqft: 1850 },
      ],
    },
    {
      customer_idx: 1,
      status: 'sent',
      sent_days_ago: 3,
      surfaces: [
        { surface_type: 'deck', sqft: 420 },
        { surface_type: 'concrete_pad', sqft: 180 },
      ],
    },
    {
      customer_idx: 2,
      status: 'accepted',
      sent_days_ago: 8,
      accepted_days_ago: 6,
      surfaces: [
        { surface_type: 'house_siding', sqft: 2400 },
        { surface_type: 'roof', sqft: 1800 },
      ],
    },
    {
      customer_idx: 3,
      status: 'rejected',
      sent_days_ago: 10,
      notes: 'Price too high, going with cheaper quote',
      surfaces: [{ surface_type: 'driveway', sqft: 520 }],
    },
    {
      customer_idx: 4,
      status: 'accepted',
      sent_days_ago: 21,
      accepted_days_ago: 18,
      notes: 'Q2 recurring maintenance',
      surfaces: [
        { surface_type: 'concrete_pad', sqft: 8500 },
        { surface_type: 'house_siding', sqft: 3200 },
        { surface_type: 'sidewalk', sqft: 900 },
      ],
    },
    {
      customer_idx: 6,
      status: 'sent',
      sent_days_ago: 1,
      notes: 'Pre-listing rush — needs turnaround this week',
      surfaces: [
        { surface_type: 'driveway', sqft: 600 },
        { surface_type: 'house_siding', sqft: 1950 },
        { surface_type: 'deck', sqft: 320 },
      ],
    },
    { customer_idx: 5, status: 'draft', surfaces: [{ surface_type: 'concrete_pad', sqft: 12000 }] },
  ];
  const priceLookup = new Map(catalog.map((s) => [s.surface_type, s] as const));
  const quoteIds: string[] = [];
  for (const qs of quoteSeeds) {
    // Calculate total
    let subtotal = 0;
    const surfaceRows = qs.surfaces.map((s) => {
      const svc = priceLookup.get(s.surface_type);
      if (!svc) throw new Error(`Unknown surface: ${s.surface_type}`);
      const computed = Math.round(s.sqft * svc.unit_price_cents);
      const price_cents = Math.max(computed, svc.min_charge_cents);
      subtotal += price_cents;
      return { surface_type: s.surface_type, sqft: s.sqft, price_cents };
    });
    const tax_cents = Math.round(subtotal * 0.05); // 5% GST
    const total_cents = subtotal + tax_cents;

    const sentAt =
      qs.sent_days_ago !== undefined
        ? sql`now() - interval '${sql.unsafe(String(qs.sent_days_ago))} days'`
        : null;
    const acceptedAt =
      qs.accepted_days_ago !== undefined
        ? sql`now() - interval '${sql.unsafe(String(qs.accepted_days_ago))} days'`
        : null;

    const [quote] = await sql<
      Row[]
    >`insert into public.quotes (tenant_id, customer_id, status, subtotal_cents, tax_cents, total_cents, notes, sent_at, accepted_at)
      values (${tenantId}, ${customerIds[qs.customer_idx]}, ${qs.status}, ${subtotal}, ${tax_cents}, ${total_cents}, ${qs.notes ?? null}, ${sentAt}, ${acceptedAt}) returning id`;
    quoteIds.push(quote.id as string);
    for (const sr of surfaceRows) {
      await sql`insert into public.quote_surfaces ${sql({ ...sr, quote_id: quote.id as string })}`;
    }
  }
  console.log(`[seed] ${quoteIds.length} quotes with surfaces`);

  // --- Jobs (from accepted quotes) ---
  const acceptedIdxs = quoteSeeds
    .map((q, i) => ({ i, status: q.status, customer_idx: q.customer_idx }))
    .filter((q) => q.status === 'accepted');
  const jobSeeds = [
    {
      quote_idx: acceptedIdxs[0]?.i,
      status: 'complete',
      scheduled_days_ago: 10,
      completed_days_ago: 10,
    },
    { quote_idx: acceptedIdxs[1]?.i, status: 'in_progress', scheduled_days_ago: 2 },
    {
      quote_idx: acceptedIdxs[2]?.i,
      status: 'complete',
      scheduled_days_ago: 14,
      completed_days_ago: 13,
    },
    {
      quote_idx: undefined,
      status: 'booked',
      customer_idx: 7,
      scheduled_days_ahead: 5,
      notes: 'Phone quote — no formal quote yet',
    }, // manual job
  ];
  const jobIds: string[] = [];
  for (const j of jobSeeds) {
    const customer_id =
      j.quote_idx !== undefined
        ? customerIds[quoteSeeds[j.quote_idx].customer_idx]
        : customerIds[j.customer_idx ?? 0];
    const quote_id = j.quote_idx !== undefined ? quoteIds[j.quote_idx] : null;
    const scheduled_at =
      'scheduled_days_ago' in j && j.scheduled_days_ago !== undefined
        ? sql`now() - interval '${sql.unsafe(String(j.scheduled_days_ago))} days'`
        : 'scheduled_days_ahead' in j && j.scheduled_days_ahead !== undefined
          ? sql`now() + interval '${sql.unsafe(String(j.scheduled_days_ahead))} days'`
          : null;
    const completed_at =
      'completed_days_ago' in j && j.completed_days_ago !== undefined
        ? sql`now() - interval '${sql.unsafe(String(j.completed_days_ago))} days'`
        : null;
    const [job] = await sql<
      Row[]
    >`insert into public.jobs (tenant_id, customer_id, quote_id, status, scheduled_at, completed_at, notes)
      values (${tenantId}, ${customer_id}, ${quote_id}, ${j.status}, ${scheduled_at}, ${completed_at}, ${('notes' in j ? j.notes : null) ?? null}) returning id`;
    jobIds.push(job.id as string);
  }
  console.log(`[seed] ${jobIds.length} jobs`);

  // --- Invoices (from completed jobs) ---
  const invoices = [
    {
      job_idx: 0,
      customer_idx: 0,
      status: 'paid',
      amount_cents: 67000,
      tax_cents: 3350,
      sent_days_ago: 9,
      paid_days_ago: 5,
    },
    {
      job_idx: 2,
      customer_idx: 2,
      status: 'sent',
      amount_cents: 192000,
      tax_cents: 9600,
      sent_days_ago: 12,
    },
    { job_idx: 3, customer_idx: 7, status: 'draft', amount_cents: 58000, tax_cents: 2900 },
  ];
  for (const inv of invoices) {
    const sent_at =
      'sent_days_ago' in inv && inv.sent_days_ago !== undefined
        ? sql`now() - interval '${sql.unsafe(String(inv.sent_days_ago))} days'`
        : null;
    const paid_at =
      'paid_days_ago' in inv && inv.paid_days_ago !== undefined
        ? sql`now() - interval '${sql.unsafe(String(inv.paid_days_ago))} days'`
        : null;
    await sql`insert into public.invoices (tenant_id, customer_id, job_id, status, amount_cents, tax_cents, sent_at, paid_at)
      values (${tenantId}, ${customerIds[inv.customer_idx]}, ${jobIds[inv.job_idx]}, ${inv.status}, ${inv.amount_cents}, ${inv.tax_cents}, ${sent_at}, ${paid_at})`;
  }
  console.log(`[seed] ${invoices.length} invoices`);

  // --- Todos ---
  const todos = [
    {
      title: 'Call Sarah Chen to confirm Monday deck wash',
      done: false,
      due_in_days: 1,
      related_type: 'customer',
      related_idx: 0,
    },
    {
      title: 'Follow up with Mike Dawson on pending quote',
      done: false,
      due_in_days: 2,
      related_type: 'quote',
      related_quote_idx: 1,
    },
    {
      title: 'Send invoice to Abbotsford Plaza Q2',
      done: true,
      related_type: 'customer',
      related_idx: 4,
    },
    { title: 'Order more surface cleaner (low stock)', done: false, due_in_days: 7 },
    { title: 'Update Google Business Profile hours for summer', done: false, due_in_days: 14 },
  ];
  for (const t of todos) {
    const related_id =
      t.related_type === 'customer' && 'related_idx' in t && t.related_idx !== undefined
        ? customerIds[t.related_idx]
        : t.related_type === 'quote' &&
            'related_quote_idx' in t &&
            t.related_quote_idx !== undefined
          ? quoteIds[t.related_quote_idx]
          : null;
    const due_date =
      'due_in_days' in t && t.due_in_days !== undefined
        ? sql`(current_date + interval '${sql.unsafe(String(t.due_in_days))} days')::date`
        : null;
    await sql`insert into public.todos (tenant_id, user_id, title, done, due_date, related_type, related_id)
      values (${tenantId}, ${userId}, ${t.title}, ${t.done}, ${due_date}, ${t.related_type ?? null}, ${related_id})`;
  }
  console.log(`[seed] ${todos.length} todos`);

  // --- Worklog entries ---
  const worklog = [
    {
      entry_type: 'system',
      title: 'Quote sent',
      body: 'Quote #1 sent to Sarah Chen',
      days_ago: 14,
    },
    {
      entry_type: 'system',
      title: 'Quote accepted',
      body: 'Sarah Chen accepted quote #1 ($670 total)',
      days_ago: 12,
    },
    {
      entry_type: 'system',
      title: 'Job scheduled',
      body: 'Sarah Chen driveway + siding wash scheduled for 10 days ago',
      days_ago: 11,
    },
    {
      entry_type: 'note',
      title: 'Patel roof job notes',
      body: 'Customer noted moss on north side. Soft wash only, 3% bleach mix. Follow-up needed in 2 yrs.',
      days_ago: 13,
    },
    {
      entry_type: 'system',
      title: 'Job completed',
      body: 'Sarah Chen job marked complete',
      days_ago: 10,
    },
    {
      entry_type: 'system',
      title: 'Invoice paid',
      body: 'Sarah Chen invoice paid $703.50 via Stripe',
      days_ago: 5,
    },
    {
      entry_type: 'note',
      title: 'Abbotsford Plaza Q2 plan',
      body: 'Set up recurring scheduled for first Monday of each quarter. Manager wants a heads-up text 48h prior.',
      days_ago: 18,
    },
    {
      entry_type: 'milestone',
      title: '100th job complete',
      body: 'Hit 100 jobs since launch. Small win worth noting.',
      days_ago: 21,
    },
  ];
  for (const w of worklog) {
    const created_at = sql`now() - interval '${sql.unsafe(String(w.days_ago))} days'`;
    await sql`insert into public.worklog_entries (tenant_id, user_id, entry_type, title, body, created_at)
      values (${tenantId}, ${userId}, ${w.entry_type}, ${w.title}, ${w.body}, ${created_at})`;
  }
  console.log(`[seed] ${worklog.length} worklog entries`);

  console.log('\n[seed] DONE');
  console.log(`       tenant: ${tenant.name} (${tenantId})`);
  console.log(`       user:   ${email}`);
  console.log('       visit https://app.heyhenry.io/dashboard (log in first)');

  await sql.end();
}

main().catch((e) => {
  console.error('[seed] FAIL:', e);
  process.exit(1);
});
