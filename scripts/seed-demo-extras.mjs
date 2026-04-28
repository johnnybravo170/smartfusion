/**
 * Adds the rest of the "fully populated" demo to the existing Thompson project:
 *   - Photos uploaded to Supabase storage (real signed-URL-able paths)
 *   - Change orders (1 approved, 1 pending)
 *   - A second quote in 'sent' state for a follow-on patio scope
 *   - Project memos + notes
 *   - Sub-quotes (2 vendor-supplied)
 *   - Worker time entries + expenses
 */
import postgres from 'postgres';
import { createClient } from '@supabase/supabase-js';

const sql = postgres(process.env.DATABASE_URL, { ssl: 'require' });
const supabase = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY,
);

const TENANT_ID = '1f3ee53d-3767-4a10-abfb-e2c06b36fc12';

// Find the demo project + job + customer
const [project] = await sql`
  SELECT id, customer_id FROM public.projects
  WHERE tenant_id = ${TENANT_ID}
    AND name = 'Master Bathroom Reno + Outdoor Sauna'
  ORDER BY created_at DESC LIMIT 1
`;
const [job] = await sql`
  SELECT id FROM public.jobs
  WHERE tenant_id = ${TENANT_ID} AND customer_id = ${project.customer_id}
  ORDER BY created_at DESC LIMIT 1
`;
const [admin] = await sql`
  SELECT user_id FROM public.tenant_members
  WHERE tenant_id = ${TENANT_ID} AND role IN ('owner','admin')
  LIMIT 1
`;
console.log('project:', project.id, '| job:', job.id, '| admin:', admin.user_id);

// === PHOTOS ===
// Pull placeholder images from picsum.photos and upload to the photos bucket.
const photoSpecs = [
  { tag: 'before', caption: 'Existing bathroom — original tile + tub', seed: 'bath-before-1', daysAgo: 22 },
  { tag: 'before', caption: 'Old vanity removed for measurement', seed: 'bath-before-2', daysAgo: 21 },
  { tag: 'progress', caption: 'Demo complete — shower wall studs exposed', seed: 'bath-demo-1', daysAgo: 18 },
  { tag: 'progress', caption: 'Plumbing rough — new shower mixer + tub feed', seed: 'bath-rough-1', daysAgo: 14 },
  { tag: 'progress', caption: 'Heated floor mat laid before pour', seed: 'bath-rough-2', daysAgo: 10 },
  { tag: 'progress', caption: 'Drywall up + first coat of mud', seed: 'bath-drywall-1', daysAgo: 6 },
  { tag: 'progress', caption: 'Sauna pad — gravel base graded + compacted', seed: 'sauna-base-1', daysAgo: 5 },
  { tag: 'progress', caption: 'Excavation done — ready for forms', seed: 'sauna-excav-1', daysAgo: 4 },
  { tag: 'materials', caption: 'Cedar bench detail from supplier — for client review', seed: 'sauna-bench-ref', daysAgo: 12 },
  { tag: 'materials', caption: 'Tile sample lay-down — herringbone option', seed: 'tile-sample', daysAgo: 16 },
];

const photoIds = [];
const existingPhotoCount = (await sql`SELECT count(*) FROM public.photos WHERE project_id = ${project.id}`)[0].count;
if (Number(existingPhotoCount) >= 10) {
  console.log(`skipping photo upload — ${existingPhotoCount} already exist`);
} else for (let i = 0; i < photoSpecs.length; i++) {
  const spec = photoSpecs[i];
  const url = `https://picsum.photos/seed/${spec.seed}/1200/900`;
  const res = await fetch(url);
  if (!res.ok) {
    console.log('skip photo (fetch failed):', spec.seed);
    continue;
  }
  const buf = Buffer.from(await res.arrayBuffer());
  const path = `${TENANT_ID}/${job.id}/${Date.now()}-${spec.seed}.jpg`;
  const { error: upErr } = await supabase.storage.from('photos').upload(path, buf, {
    contentType: 'image/jpeg',
    upsert: false,
  });
  if (upErr) {
    console.log('skip photo (upload failed):', spec.seed, upErr.message);
    continue;
  }
  const takenAt = new Date(Date.now() - spec.daysAgo * 86400_000).toISOString();
  const [row] = await sql`
    INSERT INTO public.photos
      (tenant_id, job_id, project_id, customer_id, storage_path, tag, caption,
       taken_at, uploaded_at, uploader_user_id, source, mime, bytes,
       width, height, ai_caption, ai_tag, caption_source)
    VALUES (${TENANT_ID}, ${job.id}, ${project.id}, ${project.customer_id},
            ${path}, ${spec.tag}, ${spec.caption},
            ${takenAt}, ${takenAt}, ${admin.user_id}, 'web', 'image/jpeg', ${buf.length},
            1200, 900, ${'AI: ' + spec.caption}, ${spec.tag}, 'user')
    RETURNING id
  `;
  photoIds.push(row.id);
  process.stdout.write('.');
}
console.log('\nphotos:', photoIds.length);

// === CHANGE ORDERS ===
const [coApproved] = await sql`
  INSERT INTO public.change_orders
    (project_id, tenant_id, job_id, title, description, reason,
     cost_impact_cents, timeline_impact_days, status,
     approved_by_name, approved_at, approval_method, approval_proof_paths, created_by)
  VALUES (${project.id}, ${TENANT_ID}, ${job.id},
          'Upgrade shower waterproofing — Schluter Kerdi system',
          'Switch from standard tar-paper waterproofing to Schluter Kerdi membrane system on shower walls + curb. Includes board, membrane, sealant, and sloped pan kit.',
          'Client requested after seeing tile guy mention it during walkthrough. Marginal cost difference, large quality + warranty win.',
          85000, 1, 'approved',
          'Sarah Thompson', NOW() - INTERVAL '5 days', 'digital',
          ARRAY[]::text[], ${admin.user_id})
  RETURNING id
`;
const [coPending] = await sql`
  INSERT INTO public.change_orders
    (project_id, tenant_id, job_id, title, description, reason,
     cost_impact_cents, timeline_impact_days, status,
     approval_proof_paths, created_by)
  VALUES (${project.id}, ${TENANT_ID}, ${job.id},
          'Extend sauna bench to L-shape (add corner section)',
          'Add corner bench section to sauna interior. Adds approximately 30" of additional seating along the back wall.',
          'Mike requested during framing inspection — wants room for 4 adults instead of 3.',
          145000, 2, 'pending_approval',
          ARRAY[]::text[], ${admin.user_id})
  RETURNING id
`;
console.log('change orders:', coApproved.id.slice(0,8), '(accepted) +', coPending.id.slice(0,8), '(sent)');

// === SECOND QUOTE — sent state ===
const [quote2] = await sql`
  INSERT INTO public.quotes
    (tenant_id, customer_id, status, subtotal_cents, tax_cents, total_cents,
     notes, sent_at, approval_code)
  VALUES (${TENANT_ID}, ${project.customer_id}, 'sent',
          485000, 24250, 509250,
          'Phase 2 add-on: stone walkway from back door to sauna + low-voltage path lighting. Quote valid 30 days.',
          NOW() - INTERVAL '3 days',
          'thompson-walkway-2026')
  RETURNING id
`;
const quote2Lines = [
  ['Excavation + base prep — 35 lf walkway', 1, 'lump', 95000],
  ['Natural stone pavers — local basalt', 35, 'lf', 4800],
  ['Stone install labour', 35, 'lf', 5200],
  ['Polymeric sand + edging', 1, 'lot', 18000],
  ['Path lighting kit — 8 fixtures, copper finish', 1, 'set', 95000],
  ['Low-voltage transformer + wiring', 1, 'lot', 22000],
];
for (let i = 0; i < quote2Lines.length; i++) {
  const [label, qty, unit, unitPrice] = quote2Lines[i];
  await sql`
    INSERT INTO public.quote_line_items
      (quote_id, label, qty, unit, unit_price_cents, line_total_cents, sort_order)
    VALUES (${quote2.id}, ${label}, ${qty}, ${unit}, ${unitPrice}, ${qty * unitPrice}, ${i})
  `;
}
console.log('sent-state quote:', quote2.id);

// === PROJECT NOTES ===
const notes = [
  ['Client prefers no work on Saturdays before 9am — neighbour complaint history. Stick to weekday schedule.', 'text'],
  ['Sarah confirmed brushed brass for ALL fixtures — vanity faucets, shower system, towel bars. No mixed metals.', 'text'],
  ['Sauna footprint slightly larger than original spec (added 6" each side for cedar wall thickness). Customer aware.', 'text'],
  ['Building inspector Tony will be on site Wed for plumbing rough — needs path to bathroom clear.', 'text'],
  ['Mike asked about pre-wiring for future hot tub on the sauna pad. Quoted separately, deferred.', 'text'],
];
for (const [body, kind] of notes) {
  await sql`
    INSERT INTO public.project_notes
      (project_id, tenant_id, user_id, body, kind, metadata)
    VALUES (${project.id}, ${TENANT_ID}, ${admin.user_id}, ${body}, ${kind}, '{}'::jsonb)
  `;
}
console.log('notes:', notes.length);

// === PROJECT MEMOS (transcribed audio) ===
await sql`
  INSERT INTO public.project_memos
    (project_id, tenant_id, transcript, ai_extraction, status)
  VALUES (${project.id}, ${TENANT_ID},
          'Walking through the bathroom on day 18. Plumbing rough is in, looks tight. We had to shift the shower mixer about 2 inches to the left to clear a stud — going to update the tile layout to match. Floor mat goes down tomorrow morning, then we pour. Need to call Sarah about the grout colour, she still has not picked between the warm grey and the bone white. Sauna pad is sitting waiting for weather. Gravel is in, forms are ready, just need a dry day. Forecast looks ugly through Thursday.',
          ${JSON.stringify({
            action_items: [
              'Call Sarah re: grout colour',
              'Update tile layout for shifted mixer',
              'Watch sauna pad weather forecast',
            ],
            decisions: ['Mixer shifted 2" left to clear stud'],
            blockers: ['Sauna pad pour blocked on weather'],
          })},
          'ready')
`;
console.log('memos: 1');

// === SUB-QUOTES ===
const subs = [
  ['Henderson Plumbing', 'henderson@example.com', '+1-604-555-0901',
   320000, 'Plumbing rough-in + finish, including new shower mixer, tub install, vanity hookups, and fixture install. Excludes fixtures (provided by GC).',
   'accepted', -14],
  ['Mountain Tile Co.', 'sales@mountaintile.example.com', '+1-604-555-0234',
   415000, 'Tile install for bathroom — floor (60sf), walls (110sf), mosaic accent strip. Includes thinset, grout, sealing.',
   'pending_review', -3],
];
for (const [vendor, email, phone, total, scope, status, dayOffset] of subs) {
  const date = new Date(Date.now() + dayOffset * 86400_000).toISOString().slice(0,10);
  await sql`
    INSERT INTO public.project_sub_quotes
      (tenant_id, project_id, vendor_name, vendor_email, vendor_phone,
       total_cents, scope_description, status, quote_date, valid_until, source, created_by)
    VALUES (${TENANT_ID}, ${project.id}, ${vendor}, ${email}, ${phone},
            ${total}, ${scope}, ${status}, ${date},
            ${new Date(Date.now() + (dayOffset + 30) * 86400_000).toISOString().slice(0,10)},
            'manual', ${admin.user_id})
  `;
}
console.log('sub-quotes:', subs.length);

// === TIME ENTRIES (worker side — Jonathan as the user since no separate worker exists) ===
const timeEntries = [
  [-12, 6.5, 'Demo — tear-out of existing tile + tub', null],
  [-11, 7.0, 'Demo finish + bin loading', null],
  [-10, 5.5, 'Plumbing rough supervision + inspection prep', null],
  [-7, 4.0, 'Framing adjustments for niche', null],
  [-3, 6.0, 'Sauna pad excavation + grading', null],
];
const someBucket = await sql`SELECT id FROM public.project_cost_buckets WHERE project_id = ${project.id} AND name='Demolition' LIMIT 1`;
for (const [dayOffset, hours, notes] of timeEntries) {
  const entryDate = new Date(Date.now() + dayOffset * 86400_000).toISOString().slice(0,10);
  await sql`
    INSERT INTO public.time_entries
      (tenant_id, user_id, project_id, job_id, bucket_id, hours, hourly_rate_cents, charge_rate_cents,
       notes, entry_date)
    VALUES (${TENANT_ID}, ${admin.user_id}, ${project.id}, ${job.id}, ${someBucket[0]?.id ?? null},
            ${hours}, 7500, 9000, ${notes}, ${entryDate})
  `;
}
console.log('time entries:', timeEntries.length);

// === EXPENSES (worker side reimbursable / owner pickups) ===
const expenses = [
  [-15, 'Home Depot', 'Misc demo supplies — sledgehammer + safety gear', 18750],
  [-12, 'Lumber World', 'Pickup framing nails + brackets', 6800],
  [-9, 'Home Depot', 'Plumbing fittings + cement', 12450],
  [-5, 'Save-On Tools', 'Tile cutter blade replacement', 8900],
];
for (const [dayOffset, vendor, desc, amt] of expenses) {
  const expDate = new Date(Date.now() + dayOffset * 86400_000).toISOString().slice(0,10);
  await sql`
    INSERT INTO public.expenses
      (tenant_id, user_id, project_id, job_id, amount_cents, vendor, description, expense_date,
       tax_cents, bucket_id)
    VALUES (${TENANT_ID}, ${admin.user_id}, ${project.id}, ${job.id}, ${amt}, ${vendor}, ${desc}, ${expDate},
            ${Math.round(amt * 0.05)}, ${someBucket[0]?.id ?? null})
  `;
}
console.log('expenses:', expenses.length);

console.log('');
console.log('=== Demo project fully populated ===');
console.log('Project URL: https://heyhenry.io/projects/' + project.id);
console.log('Sent quote URL: https://heyhenry.io/quotes/' + quote2.id);

await sql.end();
