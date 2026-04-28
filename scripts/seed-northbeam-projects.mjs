/**
 * Seed 5 demo projects on the Northbeam Construction tenant.
 * Idempotent: skips a project if a customer with the same email already exists.
 *
 * Run: node --env-file=.env.local scripts/seed-northbeam-projects.mjs
 */
import postgres from 'postgres';
import { GoogleGenAI } from '@google/genai';
import { createClient } from '@supabase/supabase-js';

const sql = postgres(process.env.DATABASE_URL, { ssl: 'require' });
const supabase = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY,
);
const genai = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY });

const TENANT_ID = '1f3ee53d-3767-4a10-abfb-e2c06b36fc12';
const today = new Date();
const day = (offset) => new Date(today.getTime() + offset * 86400_000).toISOString().slice(0, 10);
const ts = (offset) => new Date(today.getTime() + offset * 86400_000).toISOString();
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const fallbackPrompts = []; // record any prompts that fall back

// admin
const [admin] = await sql`
  SELECT user_id FROM public.tenant_members
  WHERE tenant_id = ${TENANT_ID} AND role = 'owner'
  LIMIT 1
`;
if (!admin) throw new Error('no owner found for tenant');
console.log('admin user_id:', admin.user_id);

// ---- Imagen helper ----
async function generateImage(prompt) {
  const tryModel = async (model) => {
    const result = await genai.models.generateImages({
      model,
      prompt,
      config: { numberOfImages: 1, aspectRatio: '4:3', personGeneration: 'dont_allow' },
    });
    const img = result.generatedImages?.[0];
    if (!img?.image?.imageBytes) return null;
    return Buffer.from(img.image.imageBytes, 'base64');
  };
  try {
    const buf = await tryModel('imagen-4.0-ultra-generate-001');
    if (buf) return buf;
  } catch (e) {
    console.log('  ultra failed, trying fallback:', e.message);
  }
  try {
    const buf = await tryModel('imagen-4.0-generate-001');
    if (buf) {
      fallbackPrompts.push(prompt.slice(0, 60));
      return buf;
    }
  } catch (e) {
    console.log('  fallback failed:', e.message);
  }
  return null;
}

async function uploadPhoto({ jobId, projectId, customerId, slug, prompt, tag, caption, daysAgo, folderId }) {
  const buf = await generateImage(prompt);
  if (!buf) {
    console.log('  ✗ skipped photo:', caption);
    return null;
  }
  const path = `${TENANT_ID}/${folderId ?? jobId ?? projectId}/${Date.now()}-${slug}.jpg`;
  const { error: upErr } = await supabase.storage.from('photos').upload(path, buf, {
    contentType: 'image/jpeg',
    upsert: false,
  });
  if (upErr) {
    console.log('  ✗ upload failed:', caption, upErr.message);
    return null;
  }
  const takenAt = ts(-daysAgo);
  const [row] = await sql`
    INSERT INTO public.photos
      (tenant_id, job_id, project_id, customer_id, storage_path, tag, caption,
       taken_at, uploaded_at, uploader_user_id, source, mime, bytes,
       width, height, caption_source)
    VALUES (${TENANT_ID}, ${jobId}, ${projectId}, ${customerId},
            ${path}, ${tag}, ${caption},
            ${takenAt}, ${takenAt}, ${admin.user_id}, 'web', 'image/jpeg', ${buf.length},
            1280, 960, 'user')
    RETURNING id
  `;
  console.log('  ✓ photo:', caption);
  await wait(500);
  return row.id;
}

// ---- Common: insert customer / project / buckets / lines / job / tasks / notes / bills ----
async function seedProject(spec) {
  const existing = await sql`
    SELECT id FROM public.customers
    WHERE tenant_id = ${TENANT_ID} AND email = ${spec.customer.email}
    LIMIT 1
  `;
  if (existing.length > 0) {
    console.log(`SKIP (customer exists): ${spec.customer.name}`);
    return null;
  }

  const c = spec.customer;
  const [customer] = await sql`
    INSERT INTO public.customers
      (tenant_id, type, kind, name, email, phone, address_line1, city, province, postal_code, notes, tax_exempt)
    VALUES (${TENANT_ID}, 'residential', 'customer', ${c.name}, ${c.email}, ${c.phone},
            ${c.address}, ${c.city}, 'BC', ${c.postal}, ${c.notes ?? null}, false)
    RETURNING id, name
  `;

  const p = spec.project;
  const [project] = await sql`
    INSERT INTO public.projects
      (tenant_id, customer_id, name, description, management_fee_rate,
       start_date, target_end_date, percent_complete,
       portal_enabled, estimate_status, lifecycle_stage,
       estimate_approval_proof_paths, document_type)
    VALUES (${TENANT_ID}, ${customer.id}, ${p.name}, ${p.description}, 0.18,
            ${p.start}, ${p.target_end}, ${p.percent},
            true, ${p.estimate_status}, ${p.lifecycle},
            ARRAY[]::text[], 'estimate')
    RETURNING id, name
  `;
  console.log(`\n=== ${project.name} (${project.id}) ===`);

  // buckets
  const bucketIds = {};
  for (let i = 0; i < spec.buckets.length; i++) {
    const b = spec.buckets[i];
    const [row] = await sql`
      INSERT INTO public.project_cost_buckets
        (project_id, tenant_id, name, section, estimate_cents, display_order, is_visible_in_report)
      VALUES (${project.id}, ${TENANT_ID}, ${b.name}, ${b.section ?? null}, ${b.est}, ${i + 1}, true)
      RETURNING id
    `;
    bucketIds[b.name] = row.id;
  }

  // cost lines
  for (let i = 0; i < spec.lines.length; i++) {
    const [bucketName, category, label, qty, unit, unitCost, unitPrice] = spec.lines[i];
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
  }

  let jobId = null;
  if (spec.createJob) {
    const [job] = await sql`
      INSERT INTO public.jobs
        (tenant_id, customer_id, status, scheduled_at, started_at, notes)
      VALUES (${TENANT_ID}, ${customer.id}, ${spec.jobStatus ?? 'in_progress'},
              ${p.start}, ${p.start}, ${spec.jobNotes ?? null})
      RETURNING id
    `;
    jobId = job.id;

    for (const t of spec.tasks ?? []) {
      const [phase, status, title, blockerReason, dueOffset, completedDayOffset] = t;
      const dueDate = dueOffset != null ? day(dueOffset) : null;
      const completedAt = (status === 'done' || status === 'verified') && completedDayOffset != null
        ? ts(completedDayOffset) : null;
      const verifiedAt = status === 'verified' && completedDayOffset != null ? ts(completedDayOffset) : null;
      await sql`
        INSERT INTO public.tasks
          (tenant_id, title, scope, job_id, phase, status, blocker_reason,
           created_by, visibility, due_date, completed_at, verified_at)
        VALUES (${TENANT_ID}, ${title}, 'project', ${jobId}, ${phase}, ${status}, ${blockerReason},
                'admin', 'internal', ${dueDate}, ${completedAt}, ${verifiedAt})
      `;
    }
  }

  // notes
  for (const note of spec.notes ?? []) {
    await sql`
      INSERT INTO public.project_notes
        (project_id, tenant_id, user_id, body, kind, metadata)
      VALUES (${project.id}, ${TENANT_ID}, ${admin.user_id}, ${note}, 'text', '{}'::jsonb)
    `;
  }

  // bills
  for (const b of spec.bills ?? []) {
    const [vendor, desc, amt, bucketName, dayOffset, status] = b;
    const date = day(dayOffset);
    const gst = Math.round(amt * 0.05);
    await sql`
      INSERT INTO public.project_bills
        (tenant_id, project_id, vendor, bill_date, description, amount_cents, status, bucket_id, gst_cents)
      VALUES (${TENANT_ID}, ${project.id}, ${vendor}, ${date}, ${desc}, ${amt}, ${status}, ${bucketIds[bucketName]}, ${gst})
    `;
  }

  // change orders
  for (const co of spec.changeOrders ?? []) {
    await sql`
      INSERT INTO public.change_orders
        (project_id, tenant_id, job_id, title, description, reason,
         cost_impact_cents, timeline_impact_days, status,
         approved_by_name, approved_at, approval_method, approval_proof_paths, created_by)
      VALUES (${project.id}, ${TENANT_ID}, ${jobId},
              ${co.title}, ${co.description}, ${co.reason},
              ${co.cost}, ${co.days}, ${co.status},
              ${co.approvedBy ?? null}, ${co.approvedAt ?? null}, ${co.method ?? 'digital'},
              ARRAY[]::text[], ${admin.user_id})
    `;
  }

  // sub-quotes
  for (const sq of spec.subQuotes ?? []) {
    await sql`
      INSERT INTO public.project_sub_quotes
        (tenant_id, project_id, vendor_name, vendor_email, vendor_phone,
         total_cents, scope_description, status, quote_date, valid_until, source, created_by)
      VALUES (${TENANT_ID}, ${project.id}, ${sq.vendor}, ${sq.email}, ${sq.phone},
              ${sq.total}, ${sq.scope}, ${sq.status}, ${day(sq.dayOffset)},
              ${day(sq.dayOffset + 30)}, 'manual', ${admin.user_id})
    `;
  }

  // events
  for (const ev of spec.events ?? []) {
    await sql`
      INSERT INTO public.project_events
        (tenant_id, project_id, kind, meta, actor, occurred_at)
      VALUES (${TENANT_ID}, ${project.id}, ${ev.kind}, ${JSON.stringify(ev.meta ?? {})},
              ${ev.actor ?? null}, ${ts(ev.dayOffset)})
    `;
  }

  // photos
  let photoCount = 0;
  for (const ph of spec.photos ?? []) {
    const id = await uploadPhoto({
      jobId, // nullable — project E has no job
      projectId: project.id,
      folderId: jobId ?? project.id, // storage path folder

      customerId: customer.id,
      slug: ph.slug,
      prompt: ph.prompt,
      tag: ph.tag,
      caption: ph.caption,
      daysAgo: ph.daysAgo,
    });
    if (id) photoCount++;
  }

  const sums = await sql`
    SELECT sum(line_price_cents) AS price FROM public.project_cost_lines WHERE project_id = ${project.id}
  `;

  return {
    id: project.id,
    name: project.name,
    stage: p.lifecycle,
    totalValue: Number(sums[0].price ?? 0) / 100,
    photoCount,
  };
}

// ============================================================================
// PROJECT A — Cedar Hollow Powder Room Refresh
// ============================================================================
const A = {
  customer: {
    name: 'Marcus & Aisha Petrov',
    email: 'petrov.demo@example.com',
    phone: '+1-604-555-0211',
    address: '218 Cedar Hollow Way',
    city: 'North Vancouver',
    postal: 'V7G 1L4',
    notes: 'Powder room refresh — previous reno crew left it unfinished. Tight schedule before in-laws visit.',
  },
  project: {
    name: 'Cedar Hollow Powder Room Refresh',
    description: 'Small powder room update — replace vanity, faucet, mirror, and toilet. Repaint and patch existing tile.',
    start: day(-9), target_end: day(5), percent: 25,
    estimate_status: 'approved', lifecycle: 'active',
  },
  buckets: [
    { name: 'Demolition', section: 'Powder Room', est: 35000 },
    { name: 'Plumbing + fixtures', section: 'Powder Room', est: 240000 },
    { name: 'Paint + finish', section: 'Powder Room', est: 95000 },
  ],
  lines: [
    ['Demolition', 'labour', 'Demo old vanity, toilet, mirror', 6, 'hr', 7500, 9000],
    ['Demolition', 'overhead', 'Disposal fees', 1, 'each', 8500, 10000],
    ['Plumbing + fixtures', 'material', 'Single 30" vanity (white shaker)', 1, 'each', 78000, 92000],
    ['Plumbing + fixtures', 'material', 'Quartz vanity top + integrated sink', 1, 'each', 42000, 50000],
    ['Plumbing + fixtures', 'material', 'Brushed nickel faucet', 1, 'each', 18000, 22000],
    ['Plumbing + fixtures', 'material', 'Comfort-height toilet (American Standard)', 1, 'each', 38000, 45000],
    ['Plumbing + fixtures', 'sub', 'Plumber half-day install', 1, 'lump', 42000, 50000],
    ['Plumbing + fixtures', 'material', 'Round mirror (24") + sconce', 1, 'set', 14000, 18000],
    ['Paint + finish', 'sub', 'Paint walls + trim (2 coats)', 1, 'lump', 48000, 58000],
    ['Paint + finish', 'material', 'Paint + supplies (Benjamin Moore)', 1, 'lot', 12000, 15000],
  ],
  createJob: true,
  jobStatus: 'in_progress',
  jobNotes: 'Powder room refresh, 5-day target.',
  tasks: [
    ['Demolition', 'verified', 'Disconnect plumbing + tear-out', null, -7, -7],
    ['Paint + finish', 'verified', 'Wall patching + paint prep', null, -4, -4],
    ['Plumbing + fixtures', 'in_progress', 'Vanity install', null, 1, null],
    ['Plumbing + fixtures', 'waiting_material', 'Mirror delivery (Wayfair, ETA Tue)', null, 2, null],
    ['Plumbing + fixtures', 'ready', 'Faucet + drain hookup', null, 2, null],
    ['Plumbing + fixtures', 'ready', 'Toilet install', null, 3, null],
    ['Paint + finish', 'ready', 'Final paint touch-ups', null, 4, null],
    ['Paint + finish', 'ready', 'Final walkthrough with client', null, 5, null],
  ],
  notes: [
    'Petrovs leave on Friday — must be 100% done before then.',
    'Aisha picked Benjamin Moore "Pale Oak" for walls.',
  ],
  bills: [
    ['Home Depot', 'Vanity + top + faucet pickup', 152000, 'Plumbing + fixtures', -6, 'paid'],
  ],
  photos: [
    { slug: 'powder-before', tag: 'before', caption: 'Existing powder room — old vanity + dated finishes', daysAgo: 9,
      prompt: 'A realistic photograph of a small dated 1990s suburban powder room before renovation, oak vanity with single sink, beige walls, brass faucet, dated round mirror, white toilet, vinyl flooring, contractor documentation style, no people.' },
    { slug: 'powder-demo', tag: 'progress', caption: 'Demo complete — vanity and toilet removed', daysAgo: 7,
      prompt: 'A realistic photograph of a small bathroom mid-renovation with vanity and toilet completely removed, exposed plumbing supply lines on the wall, drain capped on the floor, paint scuffs visible, beige tile floor, contractor documentation style, no people.' },
    { slug: 'powder-vanity-in', tag: 'progress', caption: 'New white shaker vanity installed', daysAgo: 1,
      prompt: 'A realistic photograph of a newly installed white shaker style 30 inch single bathroom vanity with quartz top and brushed nickel faucet against a freshly painted pale oak wall, no mirror yet, contractor documentation style, no people.' },
    { slug: 'powder-progress', tag: 'progress', caption: 'Walls painted, awaiting mirror + final fixtures', daysAgo: 0,
      prompt: 'A realistic photograph of a small powder room near completion, white shaker vanity with quartz top installed, freshly painted pale oak walls, new comfort height toilet installed, brushed nickel faucet, no mirror on the wall yet, contractor documentation style, no people.' },
  ],
};

// ============================================================================
// PROJECT B — Hillcrest Kitchen Remodel
// ============================================================================
const B = {
  customer: {
    name: 'Helen Chao',
    email: 'helen.chao.demo@example.com',
    phone: '+1-604-555-0388',
    address: '1426 Hillcrest Drive',
    city: 'Burnaby',
    postal: 'V5B 3J7',
    notes: 'Mid-range kitchen remodel — keeping existing footprint. Helen is detail-oriented, picks finishes carefully.',
  },
  project: {
    name: 'Hillcrest Kitchen Remodel',
    description: 'Full kitchen update keeping existing footprint. New cabinets, quartz counters, tile backsplash, lighting, and appliances.',
    start: day(-28), target_end: day(14), percent: 60,
    estimate_status: 'approved', lifecycle: 'active',
  },
  buckets: [
    { name: 'Demolition', section: 'Kitchen', est: 180000 },
    { name: 'Plumbing', section: 'Kitchen', est: 220000 },
    { name: 'Electrical', section: 'Kitchen', est: 280000 },
    { name: 'Cabinets', section: 'Kitchen', est: 1450000 },
    { name: 'Countertop', section: 'Kitchen', est: 580000 },
    { name: 'Tile + backsplash', section: 'Kitchen', est: 380000 },
    { name: 'Paint + finish', section: 'Kitchen', est: 220000 },
  ],
  lines: [
    ['Demolition', 'labour', 'Demo old cabinets + counters + tile (3 days, 2 people)', 48, 'hr', 7500, 9000],
    ['Demolition', 'overhead', 'Bin rental + disposal', 1, 'each', 75000, 88000],
    ['Plumbing', 'sub', 'Plumbing rough relocate sink + dishwasher', 1, 'lump', 145000, 175000],
    ['Plumbing', 'material', 'New disposal + pull-down faucet (Brizo)', 1, 'set', 48000, 58000],
    ['Electrical', 'sub', 'Electrical — pot lights, under-cabinet, dedicated circuits', 1, 'lump', 195000, 235000],
    ['Electrical', 'material', 'LED pot lights (12) + under-cab strip', 1, 'lot', 38000, 46000],
    ['Cabinets', 'material', 'Custom shaker cabinets (cabinet maker — Pacific Cabinetry)', 1, 'lump', 980000, 1180000],
    ['Cabinets', 'sub', 'Cabinet install', 1, 'lump', 195000, 235000],
    ['Cabinets', 'material', 'Cabinet hardware (matte black pulls)', 1, 'set', 32000, 38000],
    ['Countertop', 'material', 'Quartz countertop — Calacatta Laza (45sf)', 45, 'sqft', 9800, 11500],
    ['Countertop', 'sub', 'Counter template + install', 1, 'lump', 85000, 100000],
    ['Tile + backsplash', 'material', 'Backsplash tile — handmade zellige (35sf)', 35, 'sqft', 4200, 4900],
    ['Tile + backsplash', 'sub', 'Tile install + grout', 1, 'lump', 165000, 198000],
    ['Paint + finish', 'sub', 'Paint kitchen + adjacent dining', 1, 'lump', 95000, 115000],
    ['Paint + finish', 'material', 'Paint + supplies', 1, 'lot', 28000, 34000],
  ],
  createJob: true,
  jobStatus: 'in_progress',
  jobNotes: 'Kitchen remodel — currently between cabinet install and countertop template.',
  tasks: [
    ['Demolition', 'verified', 'Tear out cabinets + counters + appliances', null, -25, -25],
    ['Demolition', 'verified', 'Bin haul-out', null, -23, -23],
    ['Plumbing', 'verified', 'Plumbing rough — relocated sink', null, -20, -20],
    ['Electrical', 'verified', 'Electrical rough — pot light boxes + circuits', null, -18, -18],
    ['Plumbing', 'verified', 'Inspection — plumbing + electrical (passed)', null, -15, -15],
    ['Cabinets', 'in_progress', 'Cabinet install — uppers done, lowers in progress', null, 1, null],
    ['Tile + backsplash', 'in_progress', 'Backsplash layout dry-fit', null, 6, null],
    ['Countertop', 'waiting_client', 'Helen to pick exact slab at Cosentino showroom', null, 3, null],
    ['Cabinets', 'blocked', 'Pantry cabinet delivery delayed (supplier short on hardware)', 'Pacific Cabinetry confirmed Mon — earliest re-ship Wed next week', 8, null],
    ['Countertop', 'ready', 'Counter template (after slab pick)', null, 5, null],
    ['Tile + backsplash', 'ready', 'Backsplash full install (after counters)', null, 10, null],
    ['Paint + finish', 'ready', 'Final paint + touch-ups', null, 13, null],
  ],
  notes: [
    'Helen wants matte black hardware throughout — no mixed metals.',
    'Dishwasher panel-ready — match cabinet door.',
    'Pantry cabinet delay communicated to client; she is fine pushing finish 4 days.',
  ],
  bills: [
    ['Pacific Cabinetry', 'Cabinet deposit (50%)', 590000, 'Cabinets', -22, 'paid'],
    ['Cosentino', 'Quartz slab deposit', 145000, 'Countertop', -8, 'pending'],
  ],
  changeOrders: [
    { title: 'Add 6 recessed lights to dining area', description: 'Add 6 LED pot lights to adjacent dining ceiling while electrician is on site.', reason: 'Helen requested during electrical rough-in walkthrough.', cost: 180000, days: 1, status: 'approved', approvedBy: 'Helen Chao', approvedAt: ts(-16), method: 'digital' },
  ],
  subQuotes: [
    { vendor: 'Pacific Cabinetry', email: 'orders@pacificcab.example.com', phone: '+1-604-555-0901', total: 1180000, scope: 'Custom shaker kitchen cabinets — uppers + lowers + pantry. Painted finish, soft-close hardware.', status: 'accepted', dayOffset: -32 },
    { vendor: 'Mosaic Tile Install', email: 'jobs@mosaictile.example.com', phone: '+1-604-555-0734', total: 198000, scope: 'Backsplash install — handmade zellige (35sf), includes thinset, grout, sealing.', status: 'accepted', dayOffset: -10 },
  ],
  photos: [
    { slug: 'kitchen-before', tag: 'before', caption: 'Original kitchen — oak cabinets, laminate counters', daysAgo: 28,
      prompt: 'A realistic photograph of a dated 1990s suburban Canadian kitchen before renovation, golden oak cabinets, white laminate countertops, beige floor tile, white appliances, fluorescent ceiling fixture, contractor documentation style, no people.' },
    { slug: 'kitchen-demo', tag: 'progress', caption: 'Demo complete — back to studs and subfloor', daysAgo: 24,
      prompt: 'A realistic photograph of a kitchen mid-renovation, all cabinets and counters removed, exposed wood stud walls and subfloor, plumbing capped, electrical wires hanging, drywall dust, contractor documentation style, no people.' },
    { slug: 'kitchen-rough', tag: 'progress', caption: 'Plumbing + electrical rough-in', daysAgo: 19,
      prompt: 'A realistic photograph of a kitchen with new plumbing and electrical rough-in complete, copper PEX lines and PVC drain visible, electrical boxes for pot lights in ceiling, blue NMD wire runs, exposed studs, contractor documentation style, no people.' },
    { slug: 'kitchen-cabs', tag: 'progress', caption: 'Upper cabinets installed', daysAgo: 4,
      prompt: 'A realistic photograph of a kitchen with newly installed white shaker upper cabinets along two walls, lower cabinets partially installed, no countertops or backsplash yet, matte black drawer pulls, contractor documentation style, no people.' },
    { slug: 'kitchen-template', tag: 'progress', caption: 'Countertop template laid out', daysAgo: 2,
      prompt: 'A realistic photograph of a kitchen with installed white shaker cabinets and a brown craft paper countertop template laid across the cabinet boxes, masking tape edges, marker measurements visible, contractor documentation style, no people.' },
    { slug: 'kitchen-tile', tag: 'progress', caption: 'Backsplash dry-fit — zellige tile', daysAgo: 0,
      prompt: 'A realistic photograph of a partially installed kitchen backsplash, handmade cream zellige tiles in a grid pattern, half installed half pending, mortar visible behind unset tiles, white shaker cabinets below, contractor documentation style, no people.' },
  ],
};

// ============================================================================
// PROJECT C — Riverside Basement Suite (recently completed)
// ============================================================================
const C = {
  customer: {
    name: 'Jacob Whitewater',
    email: 'jwhitewater.demo@example.com',
    phone: '+1-604-555-0455',
    address: '8821 Riverside Cresc',
    city: 'Coquitlam',
    postal: 'V3K 2P2',
    notes: 'Basement suite buildout — legal secondary suite for rental income.',
  },
  project: {
    name: 'Riverside Basement Suite',
    description: 'Full basement legal secondary suite — kitchenette, full bathroom, separate entrance, two bedrooms.',
    start: day(-75), target_end: day(-3), percent: 100,
    estimate_status: 'approved', lifecycle: 'complete',
  },
  buckets: [
    { name: 'Demolition', section: 'Basement', est: 240000 },
    { name: 'Framing', section: 'Basement', est: 980000 },
    { name: 'Plumbing', section: 'Basement', est: 1450000 },
    { name: 'Electrical', section: 'Basement', est: 1280000 },
    { name: 'Drywall + paint', section: 'Basement', est: 1180000 },
    { name: 'Flooring', section: 'Basement', est: 880000 },
    { name: 'Kitchenette', section: 'Basement', est: 1450000 },
    { name: 'Bathroom', section: 'Basement', est: 1480000 },
  ],
  lines: [
    ['Demolition', 'labour', 'Demo existing partition walls + flooring', 32, 'hr', 7500, 9000],
    ['Demolition', 'overhead', 'Bin rental + disposal (2 bins)', 2, 'each', 65000, 78000],
    ['Framing', 'labour', 'Frame new walls (separate suite)', 80, 'hr', 7500, 9000],
    ['Framing', 'material', 'Lumber package (2x4 walls + headers)', 1, 'lot', 285000, 335000],
    ['Plumbing', 'sub', 'Plumbing rough — kitchen + full bath + laundry hookup', 1, 'lump', 950000, 1140000],
    ['Plumbing', 'material', 'Fixtures — toilet, vanity, tub/shower combo', 1, 'set', 245000, 290000],
    ['Electrical', 'sub', 'Electrical rough + finish — separate sub-panel for suite', 1, 'lump', 880000, 1060000],
    ['Electrical', 'material', 'Light fixtures + receptacles + smoke/CO', 1, 'lot', 195000, 230000],
    ['Drywall + paint', 'sub', 'Drywall + tape + mud + texture', 1, 'lump', 580000, 695000],
    ['Drywall + paint', 'sub', 'Paint — full suite (2 coats)', 1, 'lump', 320000, 385000],
    ['Flooring', 'material', 'Luxury vinyl plank — full suite (~750 sqft)', 750, 'sqft', 480, 580],
    ['Flooring', 'sub', 'Flooring install', 1, 'lump', 285000, 340000],
    ['Kitchenette', 'material', 'IKEA cabinets + counter + sink + faucet', 1, 'set', 480000, 565000],
    ['Kitchenette', 'material', 'Apartment-size appliances (fridge, range, microwave)', 1, 'set', 380000, 450000],
    ['Kitchenette', 'sub', 'Kitchenette install + plumbing connections', 1, 'lump', 195000, 235000],
    ['Bathroom', 'material', 'Tile (floor + tub surround)', 1, 'lot', 145000, 175000],
    ['Bathroom', 'sub', 'Tile install + grout', 1, 'lump', 285000, 340000],
    ['Bathroom', 'material', 'Vanity + mirror + lighting', 1, 'set', 165000, 195000],
  ],
  createJob: true,
  jobStatus: 'complete',
  jobNotes: 'Basement suite — complete. Final inspection passed.',
  tasks: [
    ['Demolition', 'verified', 'Demo existing finishes', null, -72, -72],
    ['Framing', 'verified', 'Frame new walls', null, -65, -65],
    ['Plumbing', 'verified', 'Plumbing rough', null, -58, -58],
    ['Electrical', 'verified', 'Electrical rough', null, -55, -55],
    ['Plumbing', 'verified', 'Inspection — plumbing rough (passed)', null, -52, -52],
    ['Electrical', 'verified', 'Inspection — electrical rough (passed)', null, -50, -50],
    ['Drywall + paint', 'verified', 'Insulation + vapour barrier', null, -45, -45],
    ['Drywall + paint', 'verified', 'Drywall + tape + mud', null, -40, -40],
    ['Drywall + paint', 'verified', 'Paint — primer + 2 coats', null, -32, -32],
    ['Flooring', 'verified', 'Flooring install', null, -25, -25],
    ['Kitchenette', 'verified', 'Kitchenette install + appliances', null, -18, -18],
    ['Bathroom', 'verified', 'Bathroom tile + fixtures', null, -12, -12],
    ['Bathroom', 'verified', 'Final inspection (passed)', null, -5, -5],
    ['Drywall + paint', 'verified', 'Punch list', null, -2, -2],
    ['Drywall + paint', 'verified', 'Final walkthrough with client', null, -1, -1],
  ],
  notes: [
    'Suite registered with city as legal secondary suite — paperwork filed by Jacob.',
    'Final inspection passed first attempt — no deficiencies.',
    'Final invoice issued, awaiting payment of remaining balance.',
  ],
  bills: [
    ['Lumber World', 'Framing lumber package', 295000, 'Framing', -68, 'paid'],
    ['Pacific Plumbing', 'Plumbing rough deposit', 570000, 'Plumbing', -60, 'paid'],
    ['IKEA', 'Kitchenette cabinets + appliances', 825000, 'Kitchenette', -22, 'paid'],
  ],
  photos: [
    { slug: 'base-before', tag: 'before', caption: 'Empty unfinished basement before reno', daysAgo: 75,
      prompt: 'A realistic photograph of an empty unfinished suburban Canadian basement before renovation, low ceiling with exposed floor joists and ducting, exposed concrete floor, bare stud walls with old fiberglass insulation, single bare bulb overhead, contractor documentation style, no people.' },
    { slug: 'base-framing', tag: 'progress', caption: 'New framing complete — separate suite layout', daysAgo: 65,
      prompt: 'A realistic photograph of a basement with all new wood stud framing complete, defining bedrooms, bathroom, and kitchen areas, exposed concrete floor, blue chalk lines visible, work lights on the floor, contractor documentation style, no people.' },
    { slug: 'base-elec', tag: 'progress', caption: 'Electrical + plumbing rough-in complete', daysAgo: 55,
      prompt: 'A realistic photograph of a basement with electrical and plumbing rough-in complete, blue NMD electrical wire runs through stud walls, copper PEX plumbing lines visible, electrical boxes for outlets, contractor documentation style, no people.' },
    { slug: 'base-drywall', tag: 'progress', caption: 'Drywall installed and primed', daysAgo: 35,
      prompt: 'A realistic photograph of a finished basement with drywall fully installed, taped, mudded, and primed white, smooth walls and ceilings throughout, defining suite rooms, bare concrete floor still visible, contractor documentation style, no people.' },
    { slug: 'base-kitchenette', tag: 'progress', caption: 'Kitchenette installed', daysAgo: 18,
      prompt: 'A realistic photograph of a finished basement kitchenette, white IKEA cabinets along one wall, laminate countertop, stainless apartment-size fridge and range, painted off-white walls, luxury vinyl plank floor, recessed lighting, contractor documentation style, no people.' },
    { slug: 'base-finished', tag: 'after', caption: 'Finished basement suite — living area', daysAgo: 2,
      prompt: 'A realistic photograph of a fully finished basement secondary suite living area, painted off-white walls, luxury vinyl plank wood-look flooring, recessed pot lights, baseboards installed, doors hung, no furniture, contractor documentation style, bright clean, no people.' },
  ],
};

// ============================================================================
// PROJECT D — Maple Heights Full Home Renovation (XL, early stage)
// ============================================================================
const D = {
  customer: {
    name: 'The Donahue Family',
    email: 'donahue.demo@example.com',
    phone: '+1-604-555-0512',
    address: '3140 Maple Heights Place',
    city: 'West Vancouver',
    postal: 'V7S 1L9',
    notes: 'Full home renovation while family lives in rental. ~6 month timeline.',
  },
  project: {
    name: 'Maple Heights Full Home Renovation',
    description: 'Complete interior renovation of 3500sf home — open floor plan, new kitchen, all baths, new flooring throughout, exterior paint + windows.',
    start: day(-12), target_end: day(95), percent: 10,
    estimate_status: 'approved', lifecycle: 'active',
  },
  buckets: [
    { name: 'Site prep + demo', section: 'Whole Home', est: 1850000 },
    { name: 'Structural framing', section: 'Whole Home', est: 2480000 },
    { name: 'Plumbing rough', section: 'Whole Home', est: 1980000 },
    { name: 'Electrical rough', section: 'Whole Home', est: 2240000 },
    { name: 'HVAC', section: 'Whole Home', est: 1450000 },
    { name: 'Insulation', section: 'Whole Home', est: 880000 },
    { name: 'Drywall', section: 'Whole Home', est: 1680000 },
    { name: 'Kitchen', section: 'Whole Home', est: 4500000 },
    { name: 'Master bath', section: 'Whole Home', est: 2680000 },
    { name: 'Secondary baths', section: 'Whole Home', est: 2480000 },
    { name: 'Flooring', section: 'Whole Home', est: 2880000 },
    { name: 'Exterior + paint', section: 'Whole Home', est: 1850000 },
  ],
  lines: [
    ['Site prep + demo', 'sub', 'Whole-home interior demo (5 days, full crew)', 1, 'lump', 1480000, 1780000],
    ['Site prep + demo', 'overhead', 'Bin rental (8 bins) + disposal', 8, 'each', 75000, 88000],
    ['Structural framing', 'sub', 'Structural framing — open kitchen wall + LVL beam', 1, 'lump', 1980000, 2380000],
    ['Structural framing', 'material', 'Engineered LVL beams + hardware', 1, 'lot', 380000, 450000],
    ['Plumbing rough', 'sub', 'Plumbing rough — 4 baths + kitchen + laundry', 1, 'lump', 1680000, 2020000],
    ['Plumbing rough', 'material', 'PEX + drainage materials', 1, 'lot', 240000, 285000],
    ['Electrical rough', 'sub', 'Electrical rough — full home rewire to current code', 1, 'lump', 1880000, 2260000],
    ['Electrical rough', 'material', 'Wire + boxes + service upgrade hardware', 1, 'lot', 320000, 380000],
    ['HVAC', 'sub', 'New furnace + AC + ductwork', 1, 'lump', 1180000, 1420000],
    ['Insulation', 'sub', 'Spray foam attic + batt walls', 1, 'lump', 720000, 865000],
    ['Drywall', 'sub', 'Whole-home drywall + tape + mud + texture', 1, 'lump', 1380000, 1660000],
    ['Kitchen', 'material', 'Custom kitchen cabinets + island', 1, 'lump', 1850000, 2220000],
    ['Kitchen', 'material', 'Quartz countertops + waterfall island', 1, 'lump', 580000, 695000],
    ['Kitchen', 'material', 'Appliance package (Sub-Zero/Wolf)', 1, 'set', 1180000, 1420000],
    ['Master bath', 'sub', 'Master bath — full custom (tile, tub, shower, vanity)', 1, 'lump', 2180000, 2620000],
    ['Secondary baths', 'sub', 'Three secondary baths — mid-grade build-out', 1, 'lump', 2020000, 2425000],
    ['Flooring', 'material', 'Engineered hardwood — entire main floor (1800sf)', 1800, 'sqft', 880, 1050],
    ['Flooring', 'sub', 'Flooring install', 1, 'lump', 580000, 695000],
    ['Flooring', 'material', 'Tile in baths + entry + mudroom', 1, 'lot', 380000, 450000],
    ['Exterior + paint', 'material', 'Replace 14 windows (Cascadia)', 14, 'each', 95000, 115000],
    ['Exterior + paint', 'sub', 'Window install', 1, 'lump', 280000, 335000],
    ['Exterior + paint', 'sub', 'Exterior paint — whole home', 1, 'lump', 240000, 290000],
  ],
  createJob: true,
  jobStatus: 'in_progress',
  jobNotes: 'Whole-home reno — currently in framing phase. Family in rental for duration.',
  tasks: [
    ['Site prep + demo', 'verified', 'Permits obtained — full reno + structural', null, -20, -20],
    ['Site prep + demo', 'verified', 'Demo whole interior', null, -8, -8],
    ['Site prep + demo', 'verified', 'Site cleanup + bin haul-out', null, -6, -6],
    ['Structural framing', 'verified', 'LVL beam delivery + staging', null, -4, -4],
    ['Structural framing', 'in_progress', 'Frame new open kitchen wall', null, 3, null],
    ['Plumbing rough', 'in_progress', 'Plumbing rough — main floor', null, 6, null],
    ['Exterior + paint', 'waiting_material', 'Window delivery (Cascadia, ETA 4 weeks)', null, 28, null],
    ['Flooring', 'waiting_material', 'Engineered oak flooring delivery (5 weeks lead)', null, 35, null],
    ['Site prep + demo', 'blocked', 'Excavate exterior drainage (rain delay)', 'Heavy rain forecast through next week — earliest dry day is +9d', 9, null],
    ['Electrical rough', 'ready', 'Electrical rough — main floor', null, 14, null],
    ['HVAC', 'ready', 'HVAC ductwork install', null, 18, null],
    ['Insulation', 'ready', 'Insulation', null, 28, null],
    ['Drywall', 'ready', 'Drywall — whole home', null, 35, null],
    ['Kitchen', 'ready', 'Kitchen cabinet install (after counters template)', null, 70, null],
    ['Master bath', 'ready', 'Master bath build-out', null, 60, null],
    ['Secondary baths', 'ready', 'Secondary baths', null, 65, null],
    ['Flooring', 'ready', 'Flooring install (post-drywall, pre-cabinets)', null, 50, null],
    ['Exterior + paint', 'ready', 'Exterior paint (weather-dependent)', null, 85, null],
  ],
  notes: [
    'Donahues are flexible on date but firm on quality — no shortcuts on tile or millwork.',
    'Architect on retainer for any structural changes — Brendan at Westcoast Studio.',
    'Sub-panel upgrade required (200A → 400A) due to all-electric heating + AC.',
  ],
  bills: [
    ['Lumber World', 'Framing materials — phase 1', 285000, 'Structural framing', -3, 'paid'],
    ['Bin Bros', 'Bin rentals (3 of 8)', 195000, 'Site prep + demo', -7, 'paid'],
  ],
  subQuotes: [
    { vendor: 'Westcoast Structural Engineering', email: 'projects@westcoastse.example.com', phone: '+1-604-555-0623', total: 320000, scope: 'Structural engineering review + sealed drawings for LVL beam + load transfer to foundation. Includes one site visit.', status: 'pending_review', dayOffset: -2 },
  ],
  photos: [
    { slug: 'maple-before-ext', tag: 'before', caption: 'Front exterior before renovation', daysAgo: 14,
      prompt: 'A realistic photograph of a 1980s West Vancouver suburban two story home from the street, dated stucco exterior in beige, original aluminum windows, dated landscaping, overcast Pacific Northwest daylight, no people, contractor documentation style.' },
    { slug: 'maple-demo-int', tag: 'progress', caption: 'Interior demo — main floor stripped to studs', daysAgo: 7,
      prompt: 'A realistic photograph of a residential home interior fully demolished, all drywall removed, exposed wood stud walls and floor joists overhead, plywood subfloor, debris piles, contractor documentation style, large open space, work lights, no people.' },
    { slug: 'maple-framing', tag: 'progress', caption: 'New framing — open kitchen wall', daysAgo: 4,
      prompt: 'A realistic photograph of a residential home interior with new wood stud framing in progress, large opening framed for an open concept kitchen wall removal, large LVL engineered beam installed across the opening, exposed studs, contractor documentation style, no people.' },
    { slug: 'maple-structural', tag: 'progress', caption: 'LVL beam in place — load transferred', daysAgo: 3,
      prompt: 'A realistic close-up photograph of a large engineered LVL beam newly installed across a residential opening, supported by triple stud columns at each end, joist hangers visible, exposed framing all around, contractor documentation style, no people.' },
    { slug: 'maple-mech', tag: 'progress', caption: 'Mechanical rough — exterior trench for drainage', daysAgo: 1,
      prompt: 'A realistic outdoor photograph of an excavated trench along the foundation of a residential home for new exterior drainage, gravel and dirt piled to one side, perforated black drain pipe partially laid, foundation wall visible, overcast Pacific Northwest day, no people, contractor documentation style.' },
    { slug: 'maple-current-ext', tag: 'progress', caption: 'Current exterior — protective wrap, demo bins', daysAgo: 0,
      prompt: 'A realistic outdoor photograph of a residential home mid-renovation, exterior partially covered in white Tyvek house wrap, large blue construction debris bins in the driveway, scaffolding on one side, contractor documentation style, overcast day, no people.' },
  ],
};

// ============================================================================
// PROJECT E — Sunset Boulevard Deck Rebuild (awaiting approval)
// ============================================================================
const E = {
  customer: {
    name: 'Erin Chau',
    email: 'erin.chau.demo@example.com',
    phone: '+1-604-555-0699',
    address: '5512 Sunset Boulevard',
    city: 'Vancouver',
    postal: 'V6N 2H8',
    notes: 'Existing rear deck is rotting and unsafe. Wants full rebuild before summer.',
  },
  project: {
    name: 'Sunset Boulevard Deck Rebuild',
    description: 'Full demolition and rebuild of failing rear cedar deck — approximately 14x18 feet, attached to house, includes new railings and stairs to grade.',
    start: day(7), target_end: day(28), percent: 0,
    estimate_status: 'pending_approval', lifecycle: 'awaiting_approval',
  },
  buckets: [
    { name: 'Demolition', section: 'Deck', est: 95000 },
    { name: 'Structural', section: 'Deck', est: 480000 },
    { name: 'Decking material', section: 'Deck', est: 580000 },
    { name: 'Railing', section: 'Deck', est: 420000 },
    { name: 'Finishing', section: 'Deck', est: 240000 },
  ],
  lines: [
    ['Demolition', 'labour', 'Demo existing deck + railings', 16, 'hr', 7500, 9000],
    ['Demolition', 'overhead', 'Bin rental + disposal', 1, 'each', 65000, 78000],
    ['Structural', 'labour', 'Frame new structure (PT joists + ledger + posts)', 32, 'hr', 7500, 9000],
    ['Structural', 'material', 'Pressure-treated framing lumber', 1, 'lot', 165000, 195000],
    ['Structural', 'material', 'Concrete pier blocks + Simpson hardware', 1, 'lot', 48000, 58000],
    ['Decking material', 'material', 'Cedar 5/4 decking boards (~280 sqft)', 280, 'sqft', 1450, 1700],
    ['Decking material', 'sub', 'Decking install + hidden fasteners', 1, 'lump', 145000, 175000],
    ['Railing', 'material', 'Aluminum railing system + glass panels', 1, 'set', 245000, 295000],
    ['Railing', 'sub', 'Railing install', 1, 'lump', 95000, 115000],
    ['Finishing', 'material', 'Stair stringers + treads + risers', 1, 'set', 85000, 100000],
    ['Finishing', 'sub', 'Stair build', 1, 'lump', 95000, 115000],
    ['Finishing', 'material', 'Cedar oil + sealant', 1, 'lot', 28000, 33000],
  ],
  createJob: false, // no job because estimate not approved yet
  notes: [
    'Estimate sent — awaiting approval. Erin viewed it 1 day ago.',
    'If approved, target start is +7 days. Cedar lumber needs 5-7 day lead from Lumber World.',
  ],
  events: [
    { kind: 'estimate_sent', dayOffset: -3, actor: 'admin', meta: {} },
    { kind: 'estimate_viewed', dayOffset: -1, actor: 'customer', meta: {} },
  ],
  photos: [
    { slug: 'deck-before', tag: 'before', caption: 'Existing rear deck — rotting structure for context', daysAgo: 4,
      prompt: 'A realistic outdoor photograph of an old failing residential cedar deck attached to the back of a Vancouver house, visible rot in the deck boards, sagging railings, peeling stain, moss in places, overgrown yard around it, overcast Pacific Northwest day, contractor documentation style, no people.' },
  ],
};

// ============================================================================
// RUN
// ============================================================================
const results = [];
for (const spec of [A, B, C, D, E]) {
  try {
    const r = await seedProject(spec);
    if (r) results.push(r);
  } catch (e) {
    console.error('FAILED on', spec.project.name, '—', e.message);
    console.error(e.stack);
  }
}

console.log('\n\n========== SUMMARY ==========');
let totalPhotos = 0;
let totalValue = 0;
for (const r of results) {
  console.log(`- ${r.id}  |  ${r.name}  |  ${r.stage}  |  $${r.totalValue.toLocaleString()}  |  ${r.photoCount} photos`);
  console.log(`  https://app.heyhenry.io/projects/${r.id}`);
  totalPhotos += r.photoCount;
  totalValue += r.totalValue;
}
console.log(`\nTotal photos: ${totalPhotos}`);
console.log(`Total cost-line value: $${totalValue.toLocaleString()}`);
if (fallbackPrompts.length > 0) {
  console.log(`\nFell back to imagen-4.0-generate-001 for ${fallbackPrompts.length} prompts:`);
  for (const p of fallbackPrompts) console.log('  -', p);
}

await sql.end();
