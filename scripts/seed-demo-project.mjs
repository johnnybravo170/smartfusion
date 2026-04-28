/**
 * Seeds a comprehensive demo project for jonathan@smartfusion.ca:
 * Bathroom renovation + outdoor sauna build for "Sarah & Mike Thompson".
 * Realistic Canadian renovation pricing, multiple cost buckets per scope,
 * a mix of tasks across phases, and a few sample bills/expenses.
 */
import postgres from 'postgres';
const sql = postgres(process.env.DATABASE_URL, { ssl: 'require' });

const TENANT_ID = '1f3ee53d-3767-4a10-abfb-e2c06b36fc12'; // Connect Contracting
const today = new Date();
const todayStr = today.toISOString().slice(0, 10);
const startDate = new Date(today.getTime() - 21 * 24 * 60 * 60 * 1000)
  .toISOString()
  .slice(0, 10);
const targetEnd = new Date(today.getTime() + 56 * 24 * 60 * 60 * 1000)
  .toISOString()
  .slice(0, 10);

// 1. Customer
const [customer] = await sql`
  INSERT INTO public.customers
    (tenant_id, type, kind, name, email, phone, address_line1, city, province, postal_code, notes, tax_exempt)
  VALUES (${TENANT_ID}, 'residential', 'customer',
          'Sarah & Mike Thompson', 'thompsons.demo@example.com', '+1-604-555-0142',
          '4827 Birchwood Lane', 'North Vancouver', 'BC', 'V7G 2K8',
          'Demo customer — full bathroom reno + outdoor sauna build. Homeowners are flexible on finish dates, tight on Saturday access.',
          false)
  RETURNING id, name
`;
console.log('Customer:', customer.id, customer.name);

// 2. Project
const [project] = await sql`
  INSERT INTO public.projects
    (tenant_id, customer_id, name, description, management_fee_rate,
     start_date, target_end_date, percent_complete,
     portal_enabled, estimate_status, lifecycle_stage,
     estimate_approval_proof_paths, document_type)
  VALUES (${TENANT_ID}, ${customer.id},
          'Master Bathroom Reno + Outdoor Sauna',
          'Full master ensuite gut — new vanity, walk-in tile shower with linear drain, heated floors, freestanding tub. Plus 6x8 cedar outdoor sauna with electric heater on a new concrete pad behind the garage.',
          0.15,
          ${startDate}, ${targetEnd}, 28,
          true, 'approved', 'active',
          ARRAY[]::text[], 'estimate')
  RETURNING id, name
`;
console.log('Project:', project.id, project.name);

// 3. Cost buckets — Bathroom + Sauna sections
const buckets = [
  // Bathroom section
  { name: 'Demolition', section: 'Bathroom', est: 180000, order: 1 },
  { name: 'Plumbing rough + fixtures', section: 'Bathroom', est: 720000, order: 2 },
  { name: 'Electrical (heated floor + lighting)', section: 'Bathroom', est: 380000, order: 3 },
  { name: 'Framing + drywall + paint', section: 'Bathroom', est: 290000, order: 4 },
  { name: 'Tile + flooring', section: 'Bathroom', est: 850000, order: 5 },
  { name: 'Vanity + cabinetry', section: 'Bathroom', est: 420000, order: 6 },
  { name: 'Glass shower + hardware', section: 'Bathroom', est: 310000, order: 7 },
  // Sauna section
  { name: 'Concrete pad + foundation', section: 'Sauna', est: 220000, order: 10 },
  { name: 'Framing + sheathing + roof', section: 'Sauna', est: 480000, order: 11 },
  { name: 'Cedar interior + benches', section: 'Sauna', est: 410000, order: 12 },
  { name: 'Sauna heater + electrical', section: 'Sauna', est: 380000, order: 13 },
  { name: 'Glass door + window', section: 'Sauna', est: 240000, order: 14 },
  { name: 'Exterior siding + finish', section: 'Sauna', est: 320000, order: 15 },
];

const bucketIds = {};
for (const b of buckets) {
  const [row] = await sql`
    INSERT INTO public.project_cost_buckets
      (project_id, tenant_id, name, section, estimate_cents, display_order, is_visible_in_report)
    VALUES (${project.id}, ${TENANT_ID}, ${b.name}, ${b.section}, ${b.est}, ${b.order}, true)
    RETURNING id
  `;
  bucketIds[b.name] = row.id;
}
console.log('Buckets:', Object.keys(bucketIds).length);

// 4. Cost lines — a few representative items per bucket
const costLines = [
  // Demolition
  ['Demolition', 'labour', 'Demo crew (2 days, 2 people)', 32, 'hr', 7500, 9000],
  ['Demolition', 'overhead', 'Bin rental + dump fees', 1, 'each', 65000, 75000],

  // Plumbing
  ['Plumbing rough + fixtures', 'sub', 'Plumbing rough-in (Henderson Plumbing)', 1, 'lump', 280000, 320000],
  ['Plumbing rough + fixtures', 'material', 'Freestanding tub (Wyndham 67")', 1, 'each', 145000, 168000],
  ['Plumbing rough + fixtures', 'material', 'Linear shower drain + grate', 1, 'each', 32000, 38000],
  ['Plumbing rough + fixtures', 'material', 'Brushed brass shower system (rain head + handheld)', 1, 'set', 185000, 215000],
  ['Plumbing rough + fixtures', 'material', 'Toilet (Toto Aquia IV)', 1, 'each', 78000, 89000],

  // Electrical
  ['Electrical (heated floor + lighting)', 'sub', 'Electrical rough + finish', 1, 'lump', 165000, 190000],
  ['Electrical (heated floor + lighting)', 'material', 'Heated floor mat (50 sqft)', 50, 'sqft', 3200, 3700],
  ['Electrical (heated floor + lighting)', 'material', 'Vanity sconces + recessed pots', 1, 'set', 28000, 33000],

  // Framing/drywall
  ['Framing + drywall + paint', 'labour', 'Framing adjustments', 16, 'hr', 7500, 9000],
  ['Framing + drywall + paint', 'sub', 'Drywall + tape + mud', 1, 'lump', 120000, 138000],
  ['Framing + drywall + paint', 'sub', 'Paint (2 coats, primer)', 1, 'lump', 85000, 98000],

  // Tile
  ['Tile + flooring', 'material', 'Floor tile — 12x24 porcelain (60 sqft)', 60, 'sqft', 1800, 2100],
  ['Tile + flooring', 'material', 'Wall tile — 4x12 handmade ceramic (110 sqft)', 110, 'sqft', 2400, 2800],
  ['Tile + flooring', 'material', 'Mosaic accent strip', 12, 'lf', 4500, 5200],
  ['Tile + flooring', 'sub', 'Tile install labour', 1, 'lump', 360000, 415000],
  ['Tile + flooring', 'material', 'Thinset + grout + sealer', 1, 'lot', 28000, 32000],

  // Vanity
  ['Vanity + cabinetry', 'material', '60" double vanity (custom walnut)', 1, 'each', 285000, 328000],
  ['Vanity + cabinetry', 'material', 'Quartz countertop + backsplash', 1, 'each', 95000, 110000],
  ['Vanity + cabinetry', 'material', 'Vanity hardware + faucets', 1, 'set', 32000, 38000],

  // Glass shower
  ['Glass shower + hardware', 'sub', 'Custom frameless glass enclosure', 1, 'lump', 245000, 282000],
  ['Glass shower + hardware', 'material', 'Niche + corner shelf', 1, 'set', 22000, 26000],

  // === Sauna ===
  // Foundation
  ['Concrete pad + foundation', 'sub', 'Excavation + gravel base', 1, 'lump', 65000, 75000],
  ['Concrete pad + foundation', 'sub', 'Concrete pad pour (8x10)', 1, 'lump', 95000, 108000],
  ['Concrete pad + foundation', 'material', 'Rebar + forms + concrete (~4 yards)', 1, 'lot', 42000, 48000],

  // Framing
  ['Framing + sheathing + roof', 'labour', 'Framing crew (3 days)', 48, 'hr', 7500, 9000],
  ['Framing + sheathing + roof', 'material', 'Lumber package (2x6 walls, 2x8 rafters)', 1, 'lot', 145000, 168000],
  ['Framing + sheathing + roof', 'material', 'Sheathing + house wrap', 1, 'lot', 38000, 44000],
  ['Framing + sheathing + roof', 'material', 'Metal roof + flashing', 1, 'lot', 95000, 110000],

  // Cedar interior
  ['Cedar interior + benches', 'material', 'Western red cedar T&G (interior walls + ceiling)', 1, 'lot', 195000, 224000],
  ['Cedar interior + benches', 'material', 'Cedar bench lumber (upper + lower)', 1, 'lot', 78000, 90000],
  ['Cedar interior + benches', 'labour', 'Install cedar interior + benches', 24, 'hr', 7500, 9000],

  // Heater + electrical
  ['Sauna heater + electrical', 'material', 'Harvia Cilindro 8kW heater + stones', 1, 'each', 195000, 225000],
  ['Sauna heater + electrical', 'sub', '240V circuit + sub-panel from house', 1, 'lump', 145000, 168000],

  // Glass door
  ['Glass door + window', 'material', 'Tempered glass door (full pane)', 1, 'each', 145000, 168000],
  ['Glass door + window', 'material', 'Side window + trim', 1, 'lot', 65000, 75000],

  // Exterior
  ['Exterior siding + finish', 'material', 'Cedar shake siding', 1, 'lot', 165000, 190000],
  ['Exterior siding + finish', 'sub', 'Siding install + paint', 1, 'lump', 95000, 110000],
  ['Exterior siding + finish', 'material', 'Exterior door hardware + lighting', 1, 'lot', 28000, 33000],
];

let lineCount = 0;
for (let i = 0; i < costLines.length; i++) {
  const [bucketName, category, label, qty, unit, unitCost, unitPrice] = costLines[i];
  const lineCost = Math.round(qty * unitCost);
  const linePrice = Math.round(qty * unitPrice);
  const markup = unitCost > 0 ? ((unitPrice - unitCost) / unitCost) * 100 : 0;
  await sql`
    INSERT INTO public.project_cost_lines
      (project_id, bucket_id, category, label, qty, unit,
       unit_cost_cents, unit_price_cents, markup_pct,
       line_cost_cents, line_price_cents, sort_order, photo_storage_paths)
    VALUES (${project.id}, ${bucketIds[bucketName]}, ${category}, ${label},
            ${qty}, ${unit}, ${unitCost}, ${unitPrice}, ${markup.toFixed(2)},
            ${lineCost}, ${linePrice}, ${i}, '[]'::jsonb)
  `;
  lineCount++;
}
console.log('Cost lines:', lineCount);

// 5. Job (so tasks can attach)
const [job] = await sql`
  INSERT INTO public.jobs
    (tenant_id, customer_id, status, scheduled_at, started_at, notes)
  VALUES (${TENANT_ID}, ${customer.id}, 'in_progress', ${startDate}, ${startDate},
          'Master bathroom + outdoor sauna combined project. Crew working 4-day weeks until Sauna pad arrives.')
  RETURNING id
`;
console.log('Job:', job.id);

// 6. Tasks — mix of phases + statuses for visual variety
const tasks = [
  // Pre-Construction (done)
  ['Pre-Construction', 'verified', 'Final selections walkthrough with client', null, null, -10],
  ['Pre-Construction', 'verified', 'Building permit submitted', null, null, -7],
  ['Pre-Construction', 'verified', 'Order long-lead vanity (8wk lead time)', null, null, -14],

  // Demo (done)
  ['Demolition', 'verified', 'Disconnect plumbing + electrical', null, null, -3],
  ['Demolition', 'done', 'Tear out existing tile + tub', null, null, -2],
  ['Demolition', 'verified', 'Bin haul-out', null, null, -1],

  // Rough-in (in progress + waiting)
  ['Rough-In', 'in_progress', 'Plumbing rough — shower + vanity', null, 5, 0],
  ['Rough-In', 'waiting_material', 'Electrical heated floor mat (delivery Friday)', null, null, 3],
  ['Rough-In', 'ready', 'Framing adjustments for new niche', null, null, 4],

  // Inspection
  ['Inspection', 'ready', 'Plumbing inspection — booked Wednesday', null, null, 7],

  // Sauna foundation
  ['Sauna — Foundation', 'in_progress', 'Excavation + gravel base', null, 3, 1],
  ['Sauna — Foundation', 'blocked', 'Concrete pad pour (waiting on dry weather)', 'Forecast shows rain through Thursday — earliest pour Friday AM', null, 5],

  // Sauna framing
  ['Sauna — Framing', 'ready', 'Stack framing lumber on site', null, null, 6],

  // Finish (later)
  ['Finish', 'ready', 'Tile install — floor first then walls', null, null, 30],
  ['Finish', 'ready', 'Vanity install (after countertop template)', null, null, 35],

  // Punch / Closeout
  ['Closeout', 'ready', 'Final walkthrough + punch list with client', null, null, 56],
  ['Closeout', 'ready', 'Sauna heater commissioning + safety check', null, null, 56],

  // Owner-side personal
  ['Pre-Construction', 'waiting_client', 'Confirm grout colour selection', null, null, 2],
  ['Sauna — Heater', 'waiting_client', 'Decide between cedar bench oil vs raw', null, null, 8],
];

let taskCount = 0;
for (const [phase, status, title, blockerReason, daysActive, dueOffset] of tasks) {
  const dueDate = dueOffset != null
    ? new Date(today.getTime() + dueOffset * 24 * 60 * 60 * 1000).toISOString().slice(0, 10)
    : null;
  const completedAt = status === 'done' || status === 'verified'
    ? new Date(today.getTime() + (daysActive ?? -1) * 24 * 60 * 60 * 1000).toISOString()
    : null;
  const verifiedAt = status === 'verified'
    ? new Date(today.getTime() + (daysActive ?? -1) * 24 * 60 * 60 * 1000).toISOString()
    : null;
  await sql`
    INSERT INTO public.tasks
      (tenant_id, title, scope, job_id, phase, status, blocker_reason,
       created_by, visibility, due_date, completed_at, verified_at)
    VALUES (${TENANT_ID}, ${title}, 'project', ${job.id}, ${phase}, ${status}, ${blockerReason},
            'jonathan', 'internal', ${dueDate}, ${completedAt}, ${verifiedAt})
  `;
  taskCount++;
}
console.log('Tasks:', taskCount);

// 7. A few bills
const bills = [
  ['Henderson Plumbing', 'Plumbing rough-in deposit', 168000, 'Plumbing rough + fixtures', -10, 'paid'],
  ['Lumber World', 'Sauna framing lumber package', 152000, 'Framing + sheathing + roof', -5, 'paid'],
  ['Concrete Co', 'Pad pour deposit', 32000, 'Concrete pad + foundation', -3, 'pending'],
  ['Tile Outlet', 'Floor + wall tile delivery', 304000, 'Tile + flooring', -7, 'paid'],
];
for (const [vendor, desc, amt, bucketName, dayOffset, status] of bills) {
  const date = new Date(today.getTime() + dayOffset * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
  const gst = Math.round(amt * 0.05);
  await sql`
    INSERT INTO public.project_bills
      (tenant_id, project_id, vendor, bill_date, description, amount_cents, status, bucket_id, gst_cents)
    VALUES (${TENANT_ID}, ${project.id}, ${vendor}, ${date}, ${desc}, ${amt}, ${status}, ${bucketIds[bucketName]}, ${gst})
  `;
}
console.log('Bills:', bills.length);

// Summary
const sums = await sql`
  SELECT
    sum(line_cost_cents) AS cost,
    sum(line_price_cents) AS price
  FROM public.project_cost_lines WHERE project_id = ${project.id}
`;
console.log('');
console.log('=== Demo project ready ===');
console.log('Customer:', customer.name);
console.log('Project: ', project.name);
console.log('Total cost: $' + (sums[0].cost / 100).toLocaleString());
console.log('Total price: $' + (sums[0].price / 100).toLocaleString());
console.log('Margin: $' + ((sums[0].price - sums[0].cost) / 100).toLocaleString(),
            `(${((sums[0].price - sums[0].cost) / sums[0].price * 100).toFixed(1)}%)`);
console.log('Project URL: https://heyhenry.io/projects/' + project.id);

await sql.end();
