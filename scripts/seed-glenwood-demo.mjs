/**
 * One-shot demo project seed for Northbeam Construction.
 *
 *   - Active project with 70%+ cost-burn already accumulated
 *   - 8 buckets, ~25 cost lines
 *   - Bills + expenses + POs + time entries (most tagged to specific
 *     cost_line_id so the line-level inline-expand has data)
 *   - 2 approved + applied change orders, with snapshots at v1/v2/v3
 *   - 6-7 Imagen-generated project photos uploaded to the photos bucket
 *
 * Idempotent on customer email — re-run is a no-op if it's already there.
 *
 * Run: node --env-file=.env.local scripts/seed-glenwood-demo.mjs
 */
import { GoogleGenAI } from '@google/genai';
import { createClient } from '@supabase/supabase-js';
import postgres from 'postgres';

const TENANT_ID = '1f3ee53d-3767-4a10-abfb-e2c06b36fc12'; // Northbeam Construction

const sql = postgres(process.env.DATABASE_URL, { ssl: 'require' });
const supabase = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY,
);
const genai = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY });

const today = new Date();
const day = (offset) => new Date(today.getTime() + offset * 86400_000).toISOString().slice(0, 10);
const ts = (offset) => new Date(today.getTime() + offset * 86400_000).toISOString();
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

// ── owner + worker ──────────────────────────────────────────────────────────
const [owner] = await sql`
  SELECT user_id FROM public.tenant_members
  WHERE tenant_id = ${TENANT_ID} AND role = 'owner'
  LIMIT 1
`;
if (!owner) throw new Error('no owner for tenant');

const [worker] = await sql`
  SELECT id, default_hourly_rate_cents, default_charge_rate_cents
  FROM public.worker_profiles
  WHERE tenant_id = ${TENANT_ID}
  ORDER BY created_at ASC
  LIMIT 1
`;
if (!worker) throw new Error('no worker profiles for tenant — create one first');

console.log('owner user_id:', owner.user_id);
console.log('worker profile:', worker.id);

// ── idempotency check ───────────────────────────────────────────────────────
const CUST_EMAIL = 'glenwood.demo@example.com';
const existing = await sql`
  SELECT c.id AS customer_id, p.id AS project_id, p.name
  FROM public.customers c
  LEFT JOIN public.projects p ON p.customer_id = c.id AND p.tenant_id = c.tenant_id
  WHERE c.tenant_id = ${TENANT_ID} AND c.email = ${CUST_EMAIL}
  LIMIT 1
`;
if (existing.length > 0 && existing[0].project_id) {
  console.log(`SKIP (already seeded): ${existing[0].name} → ${existing[0].project_id}`);
  console.log(`https://app.heyhenry.io/projects/${existing[0].project_id}`);
  await sql.end();
  process.exit(0);
}

// ── customer ────────────────────────────────────────────────────────────────
const [customer] = await sql`
  INSERT INTO public.customers
    (tenant_id, type, kind, name, email, phone,
     address_line1, city, province, postal_code, notes, tax_exempt)
  VALUES (${TENANT_ID}, 'residential', 'customer',
          'Daniel & Priya Mohan', ${CUST_EMAIL}, '+1-604-555-0820',
          '4720 Glenwood Heights Drive', 'Burnaby', 'BC', 'V5G 4N2',
          'Master suite addition — 2nd-floor bump-out, ~420 sqft. Couple has 2 young kids, working from home, want crew quiet during nap windows.',
          false)
  RETURNING id, name
`;
console.log('customer:', customer.id);

// ── project ─────────────────────────────────────────────────────────────────
const START_OFFSET = -56;
const END_OFFSET = 24;
const [project] = await sql`
  INSERT INTO public.projects
    (tenant_id, customer_id, name, description, management_fee_rate,
     start_date, target_end_date, percent_complete,
     portal_enabled, estimate_status, estimate_sent_at, estimate_approved_at,
     estimate_approved_by_name, estimate_approval_method, estimate_approval_proof_paths,
     lifecycle_stage, document_type)
  VALUES (${TENANT_ID}, ${customer.id},
          'Glenwood Heights Master Suite Addition',
          'Second-floor bump-out adding 420 sqft master bed + ensuite + walk-in closet over the existing garage. Includes structural framing, roof tie-in, full plumbing rough, electrical, mid-grade ensuite finishes, walk-in closet build-out, hardwood throughout.',
          0.18,
          ${day(START_OFFSET)}, ${day(END_OFFSET)}, 72,
          true, 'approved', ${ts(START_OFFSET - 6)}, ${ts(START_OFFSET - 2)},
          'Daniel Mohan', 'digital', ARRAY[]::text[],
          'active', 'estimate')
  RETURNING id, name
`;
const projectId = project.id;
console.log(`\n=== ${project.name} (${projectId}) ===`);

// ── buckets ─────────────────────────────────────────────────────────────────
// Free-form sections (per migration 0072) — using "Master suite addition"
// as the section so the budget table groups them under one header.
const SECTION = 'Master suite addition';
const bucketSpecs = [
  { name: 'Site prep + demo', est: 380000 },
  { name: 'Structural framing + roof', est: 1880000 },
  { name: 'Plumbing rough', est: 980000 },
  { name: 'Electrical rough', est: 1180000 },
  { name: 'Insulation + drywall', est: 880000 },
  { name: 'Ensuite bath', est: 2280000 },
  { name: 'Walk-in closet + bedroom finish', est: 1180000 },
  { name: 'Flooring', est: 580000 },
  { name: 'Paint + trim', est: 380000 },
];

const buckets = {};
for (let i = 0; i < bucketSpecs.length; i++) {
  const b = bucketSpecs[i];
  const [row] = await sql`
    INSERT INTO public.project_budget_categories
      (project_id, tenant_id, name, section, estimate_cents, display_order, is_visible_in_report)
    VALUES (${projectId}, ${TENANT_ID}, ${b.name}, ${SECTION}, ${b.est}, ${i + 1}, true)
    RETURNING id, name
  `;
  buckets[b.name] = row.id;
}

// ── cost lines (planning version) ──────────────────────────────────────────
// [bucket, category, label, qty, unit, unit_cost_cents, unit_price_cents]
const planningLines = [
  ['Site prep + demo', 'sub', 'Tear out garage ceiling + structural prep', 1, 'lump', 280000, 335000],
  ['Site prep + demo', 'overhead', 'Bin rental + disposal (2 bins)', 2, 'each', 35000, 42000],

  ['Structural framing + roof', 'sub', 'Frame 2nd-storey addition (walls, joists)', 1, 'lump', 980000, 1180000],
  ['Structural framing + roof', 'material', 'Lumber + sheathing package', 1, 'lot', 380000, 450000],
  ['Structural framing + roof', 'sub', 'Roof tie-in + new shingles section', 1, 'lump', 320000, 385000],
  ['Structural framing + roof', 'material', 'LVL beams + hangers', 1, 'lot', 95000, 115000],

  ['Plumbing rough', 'sub', 'Plumbing rough — ensuite + laundry stub', 1, 'lump', 720000, 865000],
  ['Plumbing rough', 'material', 'PEX + drain materials', 1, 'lot', 145000, 175000],

  ['Electrical rough', 'sub', 'Electrical rough — addition + ensuite', 1, 'lump', 880000, 1060000],
  ['Electrical rough', 'material', 'Wire + boxes + smoke/CO + fixtures package', 1, 'lot', 195000, 230000],

  ['Insulation + drywall', 'sub', 'Insulation — spray foam attic + batt walls', 1, 'lump', 285000, 340000],
  ['Insulation + drywall', 'sub', 'Drywall + tape + mud + texture', 1, 'lump', 480000, 575000],

  ['Ensuite bath', 'material', 'Tile package — floor + shower walls + niche', 1, 'lot', 380000, 450000],
  ['Ensuite bath', 'sub', 'Tile install + waterproofing', 1, 'lump', 520000, 625000],
  ['Ensuite bath', 'material', 'Freestanding tub + filler', 1, 'set', 285000, 340000],
  ['Ensuite bath', 'material', 'Vanity (double, 60") + quartz top + fixtures', 1, 'set', 520000, 625000],
  ['Ensuite bath', 'material', 'Toilet + glass shower enclosure', 1, 'set', 240000, 290000],
  ['Ensuite bath', 'sub', 'Plumbing + fixtures install (final)', 1, 'lump', 195000, 235000],

  ['Walk-in closet + bedroom finish', 'material', 'Custom closet system (Innotech)', 1, 'set', 480000, 575000],
  ['Walk-in closet + bedroom finish', 'sub', 'Closet system install', 1, 'lump', 145000, 175000],
  ['Walk-in closet + bedroom finish', 'material', 'Bedroom doors + hardware', 1, 'set', 95000, 115000],
  ['Walk-in closet + bedroom finish', 'sub', 'Trim + millwork install', 1, 'lump', 195000, 235000],

  ['Flooring', 'material', 'Engineered hardwood (~420sf)', 420, 'sqft', 880, 1050],
  ['Flooring', 'sub', 'Flooring install', 1, 'lump', 195000, 235000],

  ['Paint + trim', 'sub', 'Paint — addition (2 coats + ceilings)', 1, 'lump', 240000, 290000],
  ['Paint + trim', 'material', 'Paint + supplies', 1, 'lot', 75000, 90000],
];

const lineIds = {};
for (let i = 0; i < planningLines.length; i++) {
  const [bucketName, category, label, qty, unit, uc, up] = planningLines[i];
  const lineCost = Math.round(qty * uc);
  const linePrice = Math.round(qty * up);
  const markup = uc > 0 ? ((up - uc) / uc) * 100 : 0;
  const [row] = await sql`
    INSERT INTO public.project_cost_lines
      (project_id, budget_category_id, category, label, qty, unit,
       unit_cost_cents, unit_price_cents, markup_pct,
       line_cost_cents, line_price_cents, sort_order, photo_storage_paths)
    VALUES (${projectId}, ${buckets[bucketName]}, ${category}, ${label},
            ${qty}, ${unit}, ${uc}, ${up}, ${markup.toFixed(2)},
            ${lineCost}, ${linePrice}, ${i}, '[]'::jsonb)
    RETURNING id, label
  `;
  lineIds[label] = row.id;
}

// ── snapshot v1 (Original estimate) ─────────────────────────────────────────
async function snapshot(label, signedAt, signedByName, changeOrderId = null) {
  const lines = await sql`
    SELECT id, budget_category_id, category, label, qty, unit,
           unit_cost_cents, unit_price_cents, line_cost_cents, line_price_cents, sort_order
    FROM public.project_cost_lines WHERE project_id = ${projectId}
    ORDER BY sort_order, created_at
  `;
  const cats = await sql`
    SELECT id, name, section, estimate_cents, display_order
    FROM public.project_budget_categories WHERE project_id = ${projectId}
    ORDER BY display_order
  `;
  const [next] = await sql`
    SELECT COALESCE(MAX(version_number), 0) + 1 AS v
    FROM public.project_scope_snapshots WHERE project_id = ${projectId}
  `;
  const total = lines.reduce((s, l) => s + Number(l.line_price_cents ?? 0), 0);
  await sql`
    INSERT INTO public.project_scope_snapshots
      (project_id, tenant_id, version_number, label, change_order_id,
       cost_lines, budget_categories, total_cents, signed_at, signed_by_name)
    VALUES (${projectId}, ${TENANT_ID}, ${next.v}, ${label}, ${changeOrderId},
            ${JSON.stringify(lines)}::jsonb, ${JSON.stringify(cats)}::jsonb,
            ${total}, ${signedAt}, ${signedByName})
  `;
  return next.v;
}
await snapshot('Original estimate', ts(START_OFFSET - 2), 'Daniel Mohan');

// ── worker assignment ──────────────────────────────────────────────────────
await sql`
  INSERT INTO public.project_assignments
    (tenant_id, project_id, worker_profile_id,
     scheduled_date, hourly_rate_cents, charge_rate_cents, notes)
  VALUES (${TENANT_ID}, ${projectId}, ${worker.id},
          NULL, ${worker.default_hourly_rate_cents}, ${worker.default_charge_rate_cents},
          'Lead carpenter — full project assignment')
  ON CONFLICT DO NOTHING
`;

// ── time entries ────────────────────────────────────────────────────────────
// (dayOffset, hours, bucket, lineLabel, notes)
const timeEntries = [
  [-50, 8, 'Site prep + demo', 'Tear out garage ceiling + structural prep', 'Demo + prep'],
  [-49, 7, 'Site prep + demo', 'Tear out garage ceiling + structural prep', 'Demo finish + cleanup'],

  [-46, 9, 'Structural framing + roof', 'Frame 2nd-storey addition (walls, joists)', 'Sole plates + studs first wall'],
  [-45, 9, 'Structural framing + roof', 'Frame 2nd-storey addition (walls, joists)', 'Walls 2 + 3 + corners'],
  [-44, 8, 'Structural framing + roof', 'Frame 2nd-storey addition (walls, joists)', 'Joists + blocking'],
  [-43, 7, 'Structural framing + roof', 'Frame 2nd-storey addition (walls, joists)', 'Sheathing'],
  [-40, 8, 'Structural framing + roof', 'Roof tie-in + new shingles section', 'Strip + tie-in'],
  [-39, 8, 'Structural framing + roof', 'Roof tie-in + new shingles section', 'Underlayment + shingles'],

  [-35, 6, 'Plumbing rough', 'Plumbing rough — ensuite + laundry stub', 'Walked plumber, set drains'],
  [-32, 6, 'Electrical rough', 'Electrical rough — addition + ensuite', 'Walked sparky, ran a few'],

  [-26, 8, 'Insulation + drywall', 'Drywall + tape + mud + texture', 'Hung sheets w/ drywall sub'],
  [-25, 8, 'Insulation + drywall', 'Drywall + tape + mud + texture', 'Mud day 1'],

  [-18, 8, 'Ensuite bath', 'Tile install + waterproofing', 'Waterproofing — Schluter Kerdi'],
  [-17, 9, 'Ensuite bath', 'Tile install + waterproofing', 'Floor tile lay'],
  [-16, 9, 'Ensuite bath', 'Tile install + waterproofing', 'Shower wall tile + niche'],
  [-15, 7, 'Ensuite bath', 'Tile install + waterproofing', 'Grout + cleanup'],

  [-10, 7, 'Walk-in closet + bedroom finish', 'Trim + millwork install', 'Baseboards + casings — bedroom'],
  [-9, 8, 'Walk-in closet + bedroom finish', 'Trim + millwork install', 'Closet trim + door jambs'],

  [-7, 8, 'Flooring', 'Flooring install', 'Hardwood install'],
  [-6, 8, 'Flooring', 'Flooring install', 'Hardwood + transitions'],

  [-3, 7, 'Ensuite bath', 'Plumbing + fixtures install (final)', 'Set vanity + faucets'],
  [-2, 6, 'Ensuite bath', 'Plumbing + fixtures install (final)', 'Toilet + tub trim out'],
];

let totalHours = 0;
for (const [d, h, bucketName, lineLabel, notes] of timeEntries) {
  totalHours += h;
  await sql`
    INSERT INTO public.time_entries
      (tenant_id, user_id, worker_profile_id, project_id,
       budget_category_id, cost_line_id, hours,
       hourly_rate_cents, charge_rate_cents, notes, entry_date)
    VALUES (${TENANT_ID}, ${owner.user_id}, ${worker.id}, ${projectId},
            ${buckets[bucketName]}, ${lineIds[lineLabel]}, ${h},
            ${worker.default_hourly_rate_cents}, ${worker.default_charge_rate_cents},
            ${notes}, ${day(d)})
  `;
}
console.log(`time entries: ${timeEntries.length} (${totalHours} hours)`);

// ── bills (paid + pending) ──────────────────────────────────────────────────
// (vendor, dayOffset, description, amount_cents, gst_cents, bucket, lineLabel, status, costCode)
const bills = [
  ['Lumber World', -47, 'Framing lumber package + sheathing', 385000, 19250, 'Structural framing + roof', 'Lumber + sheathing package', 'paid', 'LBR-001'],
  ['Lumber World', -45, 'LVL beams + Simpson hangers', 92000, 4600, 'Structural framing + roof', 'LVL beams + hangers', 'paid', 'LBR-002'],
  ['Pacific Plumbing', -34, 'Plumbing rough — Phase 1 invoice (50%)', 360000, 18000, 'Plumbing rough', 'Plumbing rough — ensuite + laundry stub', 'paid', 'SUB-PL-1'],
  ['Pacific Plumbing', -2, 'Plumbing rough — Phase 2 + final fixtures partial', 360000, 18000, 'Plumbing rough', 'Plumbing rough — ensuite + laundry stub', 'pending', 'SUB-PL-2'],
  ['Bright Spark Electric', -31, 'Electrical rough — invoice 1 (60%)', 528000, 26400, 'Electrical rough', 'Electrical rough — addition + ensuite', 'paid', 'SUB-EL-1'],
  ['Stucco King Drywall', -23, 'Drywall + tape + mud — full', 478000, 23900, 'Insulation + drywall', 'Drywall + tape + mud + texture', 'paid', 'SUB-DW-1'],
  ['Stucco King Drywall', -27, 'Insulation — spray foam attic + batts', 285000, 14250, 'Insulation + drywall', 'Insulation — spray foam attic + batt walls', 'paid', 'SUB-INS-1'],
  ['Stoneworks Tile', -16, 'Ensuite tile install + waterproofing', 510000, 25500, 'Ensuite bath', 'Tile install + waterproofing', 'paid', 'SUB-TL-1'],
  ['Cosentino', -12, 'Quartz vanity top — Calacatta Pearl', 195000, 9750, 'Ensuite bath', 'Vanity (double, 60") + quartz top + fixtures', 'paid', 'MAT-VAN-1'],
  ['Innotech Closets', -8, 'Custom walk-in closet system', 480000, 24000, 'Walk-in closet + bedroom finish', 'Custom closet system (Innotech)', 'pending', 'MAT-CL-1'],
  ['Westcoast Hardwoods', -9, 'Engineered hardwood — 420sf', 380000, 19000, 'Flooring', 'Engineered hardwood (~420sf)', 'paid', 'MAT-FL-1'],
];

let totalBillCents = 0;
for (const [vendor, d, desc, amt, gst, bucketName, lineLabel, status, costCode] of bills) {
  totalBillCents += amt;
  await sql`
    INSERT INTO public.project_bills
      (tenant_id, project_id, vendor, bill_date, description,
       amount_cents, gst_cents, status, budget_category_id, cost_line_id, cost_code)
    VALUES (${TENANT_ID}, ${projectId}, ${vendor}, ${day(d)}, ${desc},
            ${amt}, ${gst}, ${status}, ${buckets[bucketName]}, ${lineIds[lineLabel]}, ${costCode})
  `;
}
console.log(`bills: ${bills.length} ($${(totalBillCents/100).toLocaleString()})`);

// ── expenses ────────────────────────────────────────────────────────────────
// (dayOffset, vendor, description, amount_cents, bucket, lineLabel)
const expenses = [
  [-48, 'Home Depot', 'Demo supplies — gloves, blades, tarps', 18900, 'Site prep + demo', 'Tear out garage ceiling + structural prep'],
  [-44, 'Home Depot', 'Framing nails, screws, joist hangers fill-in', 12450, 'Structural framing + roof', 'Frame 2nd-storey addition (walls, joists)'],
  [-40, 'Roof Centre', 'Extra bundle of shingles to match', 8800, 'Structural framing + roof', 'Roof tie-in + new shingles section'],
  [-30, 'Home Depot', 'PEX fittings — top-up for plumber', 4200, 'Plumbing rough', 'PEX + drain materials'],
  [-22, 'Benjamin Moore', 'Primer + paint — addition (5 gal + supplies)', 36800, 'Paint + trim', 'Paint + supplies'],
  [-13, 'Stoneworks Tile', 'Extra grout + sealer (delta)', 5200, 'Ensuite bath', 'Tile install + waterproofing'],
  [-4, 'Home Depot', 'Trim — extra casing + base for closet', 8900, 'Walk-in closet + bedroom finish', 'Trim + millwork install'],
];

let totalExpenseCents = 0;
for (const [d, vendor, desc, amt, bucketName, lineLabel] of expenses) {
  totalExpenseCents += amt;
  await sql`
    INSERT INTO public.expenses
      (tenant_id, user_id, project_id,
       budget_category_id, cost_line_id, amount_cents,
       vendor, description, expense_date)
    VALUES (${TENANT_ID}, ${owner.user_id}, ${projectId},
            ${buckets[bucketName]}, ${lineIds[lineLabel]}, ${amt},
            ${vendor}, ${desc}, ${day(d)})
  `;
}
console.log(`expenses: ${expenses.length} ($${(totalExpenseCents/100).toLocaleString()})`);

// ── purchase orders ─────────────────────────────────────────────────────────
async function createPO({ vendor, poNumber, issuedOffset, expectedOffset, status, notes, items }) {
  const total = items.reduce((s, it) => s + Math.round(it.qty * it.unit_cost_cents), 0);
  const [po] = await sql`
    INSERT INTO public.purchase_orders
      (tenant_id, project_id, vendor, po_number, status,
       issued_date, expected_date, notes, total_cents)
    VALUES (${TENANT_ID}, ${projectId}, ${vendor}, ${poNumber}, ${status},
            ${day(issuedOffset)}, ${expectedOffset != null ? day(expectedOffset) : null},
            ${notes}, ${total})
    RETURNING id
  `;
  for (const it of items) {
    await sql`
      INSERT INTO public.purchase_order_items
        (po_id, cost_line_id, label, qty, unit, unit_cost_cents, line_total_cents, received_qty)
      VALUES (${po.id}, ${it.cost_line_id ?? null}, ${it.label},
              ${it.qty}, ${it.unit}, ${it.unit_cost_cents},
              ${Math.round(it.qty * it.unit_cost_cents)}, ${it.received_qty ?? 0})
    `;
  }
  return po.id;
}

await createPO({
  vendor: 'Wayfair Pro',
  poNumber: 'PO-1042',
  issuedOffset: -20,
  expectedOffset: -8,
  status: 'received',
  notes: 'Tub + shower glass + toilet — ensuite. All received and installed.',
  items: [
    { label: 'Freestanding tub + filler', qty: 1, unit: 'set', unit_cost_cents: 285000, cost_line_id: lineIds['Freestanding tub + filler'], received_qty: 1 },
    { label: 'Toilet + frameless glass shower enclosure', qty: 1, unit: 'set', unit_cost_cents: 240000, cost_line_id: lineIds['Toilet + glass shower enclosure'], received_qty: 1 },
  ],
});
await createPO({
  vendor: 'Vanity Source',
  poNumber: 'PO-1043',
  issuedOffset: -18,
  expectedOffset: -10,
  status: 'received',
  notes: 'Double vanity 60" + faucets — quartz top billed separately by Cosentino.',
  items: [
    { label: 'Double vanity (60") + brushed nickel faucets', qty: 1, unit: 'set', unit_cost_cents: 325000, cost_line_id: lineIds['Vanity (double, 60") + quartz top + fixtures'], received_qty: 1 },
  ],
});
await createPO({
  vendor: 'Innotech Closets',
  poNumber: 'PO-1051',
  issuedOffset: -12,
  expectedOffset: 4,
  status: 'sent',
  notes: 'Custom walk-in closet system — pending delivery.',
  items: [
    { label: 'Custom closet system (boxes + drawers + rods)', qty: 1, unit: 'set', unit_cost_cents: 480000, cost_line_id: lineIds['Custom closet system (Innotech)'], received_qty: 0 },
  ],
});
console.log('purchase orders: 3');

// ── change order #1 — upgraded tile package ────────────────────────────────
// Customer upgraded the tile package mid-stream from mid-grade ($3,800
// material) to a marble-look porcelain with a feature wall niche
// ($6,200). Difference: +$2,400 cost, +$2,850 price.
async function applyChangeOrder({ title, description, reason, approvedAtOffset, approvedBy, lines }) {
  const totalCostDelta = lines.reduce((s, l) => s + (l.cost_delta_cents ?? 0), 0);
  const totalPriceDelta = lines.reduce((s, l) => s + (l.price_delta_cents ?? 0), 0);
  const [co] = await sql`
    INSERT INTO public.change_orders
      (project_id, tenant_id, title, description, reason,
       cost_impact_cents, timeline_impact_days, status,
       approved_by_name, approved_at, approval_method, approval_proof_paths,
       cost_breakdown, flow_version, applied_at, created_by)
    VALUES (${projectId}, ${TENANT_ID}, ${title}, ${description}, ${reason},
            ${totalPriceDelta}, 0, 'approved',
            ${approvedBy}, ${ts(approvedAtOffset)}, 'digital', ARRAY[]::text[],
            '[]'::jsonb, 2, ${ts(approvedAtOffset)}, ${owner.user_id})
    RETURNING id
  `;
  // Apply the diff lines + record them in change_order_lines.
  for (let i = 0; i < lines.length; i++) {
    const l = lines[i];
    if (l.action === 'modify') {
      // Update existing cost line — including label, since the CO can
      // rename it (e.g. "Tile package … (upgraded)").
      await sql`
        UPDATE public.project_cost_lines SET
          label = ${l.label},
          qty = ${l.qty},
          unit_cost_cents = ${l.unit_cost_cents},
          unit_price_cents = ${l.unit_price_cents},
          line_cost_cents = ${l.line_cost_cents},
          line_price_cents = ${l.line_price_cents},
          updated_at = NOW()
        WHERE id = ${l.original_line_id}
      `;
      // Re-key lineIds so subsequent inserts (bills/expenses/POs) can
      // reference the line under its new label.
      lineIds[l.label] = l.original_line_id;
      await sql`
        INSERT INTO public.change_order_lines
          (change_order_id, tenant_id, action, original_line_id, budget_category_id,
           category, label, qty, unit, unit_cost_cents, unit_price_cents,
           line_cost_cents, line_price_cents, sort_order, before_snapshot, notes)
        VALUES (${co.id}, ${TENANT_ID}, 'modify', ${l.original_line_id}, ${l.budget_category_id},
                ${l.category}, ${l.label}, ${l.qty}, ${l.unit},
                ${l.unit_cost_cents}, ${l.unit_price_cents},
                ${l.line_cost_cents}, ${l.line_price_cents},
                ${i}, ${JSON.stringify(l.before_snapshot)}::jsonb, ${l.notes ?? null})
      `;
    } else if (l.action === 'add') {
      const [newLine] = await sql`
        INSERT INTO public.project_cost_lines
          (project_id, budget_category_id, category, label, qty, unit,
           unit_cost_cents, unit_price_cents, markup_pct,
           line_cost_cents, line_price_cents, sort_order, photo_storage_paths)
        VALUES (${projectId}, ${l.budget_category_id}, ${l.category}, ${l.label},
                ${l.qty}, ${l.unit}, ${l.unit_cost_cents}, ${l.unit_price_cents},
                ${l.unit_cost_cents > 0 ? (((l.unit_price_cents - l.unit_cost_cents) / l.unit_cost_cents) * 100).toFixed(2) : 0},
                ${l.line_cost_cents}, ${l.line_price_cents}, ${l.sort_order ?? 999}, '[]'::jsonb)
        RETURNING id, label
      `;
      lineIds[l.label] = newLine.id;
      await sql`
        INSERT INTO public.change_order_lines
          (change_order_id, tenant_id, action, budget_category_id,
           category, label, qty, unit, unit_cost_cents, unit_price_cents,
           line_cost_cents, line_price_cents, sort_order, notes)
        VALUES (${co.id}, ${TENANT_ID}, 'add', ${l.budget_category_id},
                ${l.category}, ${l.label}, ${l.qty}, ${l.unit},
                ${l.unit_cost_cents}, ${l.unit_price_cents},
                ${l.line_cost_cents}, ${l.line_price_cents},
                ${i}, ${l.notes ?? null})
      `;
    }
  }
  // Snapshot the new baseline.
  await snapshot(`CO — ${title}`, ts(approvedAtOffset), approvedBy, co.id);
  return co.id;
}

// CO #1
{
  const oldLineId = lineIds['Tile package — floor + shower walls + niche'];
  const oldRow = (await sql`
    SELECT qty, unit, unit_cost_cents, unit_price_cents, line_cost_cents, line_price_cents
    FROM public.project_cost_lines WHERE id = ${oldLineId}
  `)[0];
  const newUnitCost = 620000;
  const newUnitPrice = 735000;
  await applyChangeOrder({
    title: 'Upgrade ensuite tile to marble-look porcelain + feature niche',
    description: 'Replace mid-grade ceramic tile with marble-look large-format porcelain throughout the ensuite, plus add a backlit feature niche behind the freestanding tub.',
    reason: 'Customer upgraded selection at the showroom mid-project after seeing live samples.',
    approvedAtOffset: -22,
    approvedBy: 'Daniel Mohan',
    lines: [
      {
        action: 'modify',
        original_line_id: oldLineId,
        budget_category_id: buckets['Ensuite bath'],
        category: 'material',
        label: 'Tile package — floor + shower walls + niche (upgraded)',
        qty: 1,
        unit: 'lot',
        unit_cost_cents: newUnitCost,
        unit_price_cents: newUnitPrice,
        line_cost_cents: newUnitCost,
        line_price_cents: newUnitPrice,
        before_snapshot: oldRow,
        notes: 'Upgraded to marble-look porcelain (12x24 + 2x6 mosaic accent).',
      },
    ],
  });
}

// ── more activity between CO #1 and CO #2 ──────────────────────────────────
// Bill for the delta on the upgraded tile material, tagged to upgraded line.
{
  const upgradedLineId = lineIds['Tile package — floor + shower walls + niche (upgraded)'];
  await sql`
    INSERT INTO public.project_bills
      (tenant_id, project_id, vendor, bill_date, description,
       amount_cents, gst_cents, status, budget_category_id, cost_line_id, cost_code)
    VALUES (${TENANT_ID}, ${projectId}, 'Stoneworks Tile', ${day(-19)},
            'Tile package upgrade — marble-look porcelain delta',
            625000, 31250, 'paid', ${buckets['Ensuite bath']},
            ${upgradedLineId}, 'MAT-TIL-2')
  `;
  totalBillCents += 625000;
}

// CO #2
{
  await applyChangeOrder({
    title: 'Add hardwired ensuite electric in-floor heat',
    description: 'Customer requested electric in-floor heat for the ensuite bathroom — hardwired thermostat, 50sqft mat under tile.',
    reason: 'Comfort upgrade requested after framing — wired and zoned during electrical rough-in window.',
    approvedAtOffset: -28,
    approvedBy: 'Priya Mohan',
    lines: [
      {
        action: 'add',
        budget_category_id: buckets['Ensuite bath'],
        category: 'material',
        label: 'In-floor electric heat mat + thermostat',
        qty: 1,
        unit: 'set',
        unit_cost_cents: 95000,
        unit_price_cents: 115000,
        line_cost_cents: 95000,
        line_price_cents: 115000,
        sort_order: 100,
        notes: 'Schluter Ditra-Heat — 50sqft.',
      },
      {
        action: 'add',
        budget_category_id: buckets['Ensuite bath'],
        category: 'sub',
        label: 'In-floor heat install + thermostat hookup',
        qty: 1,
        unit: 'lump',
        unit_cost_cents: 125000,
        unit_price_cents: 150000,
        line_cost_cents: 125000,
        line_price_cents: 150000,
        sort_order: 101,
        notes: 'Tile sub installed mat under porcelain.',
      },
    ],
  });
}

// Bill for the in-floor heat sub work
{
  const heatSubLineId = lineIds['In-floor heat install + thermostat hookup'];
  await sql`
    INSERT INTO public.project_bills
      (tenant_id, project_id, vendor, bill_date, description,
       amount_cents, gst_cents, status, budget_category_id, cost_line_id, cost_code)
    VALUES (${TENANT_ID}, ${projectId}, 'Stoneworks Tile', ${day(-15)},
            'In-floor heat mat install + thermostat',
            125000, 6250, 'paid', ${buckets['Ensuite bath']},
            ${heatSubLineId}, 'CO-HEAT-1')
  `;
  totalBillCents += 125000;
}
// Expense for the heat mat material (paid by ops on a card)
{
  const heatMatLineId = lineIds['In-floor electric heat mat + thermostat'];
  await sql`
    INSERT INTO public.expenses
      (tenant_id, user_id, project_id,
       budget_category_id, cost_line_id, amount_cents,
       vendor, description, expense_date)
    VALUES (${TENANT_ID}, ${owner.user_id}, ${projectId},
            ${buckets['Ensuite bath']}, ${heatMatLineId}, 95000,
            'Schluter', 'Ditra-Heat mat + thermostat', ${day(-29)})
  `;
  totalExpenseCents += 95000;
}

// ── photos via Imagen ───────────────────────────────────────────────────────
async function generateImage(prompt) {
  try {
    const result = await genai.models.generateImages({
      model: 'imagen-4.0-generate-001',
      prompt,
      config: { numberOfImages: 1, aspectRatio: '4:3', personGeneration: 'dont_allow' },
    });
    const img = result.generatedImages?.[0];
    if (!img?.image?.imageBytes) return null;
    return Buffer.from(img.image.imageBytes, 'base64');
  } catch (e) {
    console.log('  imagen failed:', e.message);
    return null;
  }
}

const photoSpecs = [
  { slug: 'before-garage-ceiling', tag: 'before', daysAgo: 56, caption: 'Before — existing garage ceiling, structural prep area',
    prompt: 'A realistic photograph of a suburban Canadian garage interior before renovation, looking up at the ceiling, exposed drywall and joists, single bare bulb fixture, garage door visible at the back, no people, contractor documentation style.' },
  { slug: 'framing-walls', tag: 'progress', daysAgo: 44, caption: 'New 2nd-storey framing — walls and joists in',
    prompt: 'A realistic photograph of new wood stud framing for a residential second storey addition over a garage, freshly framed exterior walls with sheathing, ceiling joists overhead, visible Tyvek wrap on the outside, blue chalk lines, work lights on a floor, contractor documentation style, no people.' },
  { slug: 'roof-tie-in', tag: 'progress', daysAgo: 39, caption: 'Roof tie-in — new shingles section',
    prompt: 'A realistic outdoor photograph of a residential home with a new second storey addition, roof tie-in in progress, fresh asphalt shingles being installed on the new section blending with the existing roofline, ladder visible, overcast Pacific Northwest day, contractor documentation style, no people.' },
  { slug: 'plumbing-rough', tag: 'progress', daysAgo: 33, caption: 'Plumbing rough — ensuite layout',
    prompt: 'A realistic photograph of a residential bathroom in plumbing rough-in stage, exposed wood stud walls with new copper PEX water lines and PVC drain pipes routed through, capped fixtures for vanity tub and toilet, plywood subfloor, contractor documentation style, no people.' },
  { slug: 'drywall-prime', tag: 'progress', daysAgo: 22, caption: 'Drywall complete — primed and ready for paint',
    prompt: 'A realistic photograph of a residential master bedroom with drywall fully installed, taped, mudded, and primed white throughout, smooth walls and ceilings, bare plywood subfloor, large window opening with light streaming in, contractor documentation style, no people.' },
  { slug: 'ensuite-tile', tag: 'progress', daysAgo: 15, caption: 'Ensuite tile + freestanding tub set',
    prompt: 'A realistic photograph of a nearly finished residential ensuite bathroom with marble-look porcelain large format tile on the floor and shower walls, freestanding white soaker tub installed against a tiled feature wall niche, no fixtures yet, drop cloths on the floor, contractor documentation style, no people.' },
  { slug: 'closet-trim', tag: 'progress', daysAgo: 6, caption: 'Walk-in closet trim install',
    prompt: 'A realistic photograph of a residential walk-in closet under construction, white painted walls, baseboards and door casings being installed, open studs visible where the closet system will mount, hardwood floor partially installed, contractor documentation style, no people.' },
];

let photoCount = 0;
for (const p of photoSpecs) {
  const buf = await generateImage(p.prompt);
  if (!buf) continue;
  const path = `${TENANT_ID}/${projectId}/${Date.now()}-${p.slug}.jpg`;
  const { error: upErr } = await supabase.storage.from('photos').upload(path, buf, {
    contentType: 'image/jpeg', upsert: false,
  });
  if (upErr) {
    console.log('  upload failed:', p.slug, upErr.message);
    continue;
  }
  const takenAt = ts(-p.daysAgo);
  await sql`
    INSERT INTO public.photos
      (tenant_id, project_id, customer_id, storage_path, tag, caption,
       taken_at, uploaded_at, uploader_user_id, source, mime, bytes,
       width, height, caption_source)
    VALUES (${TENANT_ID}, ${projectId}, ${customer.id},
            ${path}, ${p.tag}, ${p.caption},
            ${takenAt}, ${takenAt}, ${owner.user_id}, 'web', 'image/jpeg', ${buf.length},
            1280, 960, 'user')
  `;
  photoCount++;
  console.log(`  photo: ${p.slug}`);
  await wait(400);
}
console.log(`photos: ${photoCount}`);

// ── summary ─────────────────────────────────────────────────────────────────
const sums = await sql`
  SELECT
    (SELECT COALESCE(SUM(line_price_cents), 0) FROM public.project_cost_lines WHERE project_id = ${projectId}) AS revenue,
    (SELECT COALESCE(SUM(line_cost_cents), 0)  FROM public.project_cost_lines WHERE project_id = ${projectId}) AS planned_cost,
    (SELECT COALESCE(SUM(amount_cents), 0)     FROM public.project_bills WHERE project_id = ${projectId})       AS bills_cents,
    (SELECT COALESCE(SUM(amount_cents), 0)     FROM public.expenses WHERE project_id = ${projectId})            AS expenses_cents,
    (SELECT COALESCE(SUM(hours * hourly_rate_cents), 0)::bigint FROM public.time_entries WHERE project_id = ${projectId}) AS labour_cost_cents,
    (SELECT COUNT(*) FROM public.change_orders WHERE project_id = ${projectId}) AS co_count
`;
const r = sums[0];
const actualSpend = Number(r.bills_cents) + Number(r.expenses_cents) + Number(r.labour_cost_cents);
const burn = Number(r.revenue) > 0 ? (actualSpend / Number(r.revenue)) * 100 : 0;
console.log('\n========== SUMMARY ==========');
console.log(`project: ${project.name}`);
console.log(`url: https://app.heyhenry.io/projects/${projectId}`);
console.log(`revenue (estimate): $${(Number(r.revenue)/100).toLocaleString()}`);
console.log(`bills:    $${(Number(r.bills_cents)/100).toLocaleString()}`);
console.log(`expenses: $${(Number(r.expenses_cents)/100).toLocaleString()}`);
console.log(`labour:   $${(Number(r.labour_cost_cents)/100).toLocaleString()}`);
console.log(`actual:   $${(actualSpend/100).toLocaleString()}`);
console.log(`burn:     ${burn.toFixed(1)}%`);
console.log(`change orders: ${r.co_count}`);

await sql.end();
