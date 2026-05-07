/**
 * Glenwood demo project — top up with extras the customer would have
 * actually populated by this stage of the project:
 *
 *   - 5 more project photos (later-stage finish + customer site visits)
 *   - 8 idea-board items (4 generated inspiration images, 2 notes, 2 links)
 *   - 5 more selections to fill out the rooms
 *
 * Idempotent at the photo/idea/selection level via a slug/title check, so
 * re-running just adds whatever's missing.
 *
 * Run: node --env-file=.env.local scripts/seed-glenwood-extras.mjs
 */
import { GoogleGenAI } from '@google/genai';
import { createClient } from '@supabase/supabase-js';
import postgres from 'postgres';

const TENANT_ID = '1f3ee53d-3767-4a10-abfb-e2c06b36fc12';
const PROJECT_NAME = 'Glenwood Heights Master Suite Addition';

const sql = postgres(process.env.DATABASE_URL, { ssl: 'require' });
const supabase = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY,
);
const genai = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY });

const today = new Date();
const ts = (offset) => new Date(today.getTime() + offset * 86400_000).toISOString();
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

// ── locate project + customer + owner ──────────────────────────────────────
const [project] = await sql`
  SELECT id, customer_id FROM public.projects
  WHERE tenant_id = ${TENANT_ID} AND name = ${PROJECT_NAME}
  LIMIT 1
`;
if (!project) throw new Error(`project not found: ${PROJECT_NAME}`);
const projectId = project.id;
const customerId = project.customer_id;

const [owner] = await sql`
  SELECT user_id FROM public.tenant_members
  WHERE tenant_id = ${TENANT_ID} AND role = 'owner' LIMIT 1
`;
console.log(`project: ${projectId}`);

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

// ── extra project photos ───────────────────────────────────────────────────
// portalTags drives whether the photo shows in the public /portal/<slug>
// gallery (filter: client_visible=true AND portal_tags <> '{}'). Vocabulary:
// before | progress | behind_wall | issue | completion | marketing.
const photoSpecs = [
  {
    slug: 'electrical-rough-bedroom',
    tag: 'progress',
    portalTags: ['behind_wall'],
    daysAgo: 30,
    caption: 'Electrical rough — bedroom outlets + ceiling boxes',
    prompt:
      'A realistic photograph of a residential master bedroom in electrical rough-in stage, exposed wood stud walls with new yellow Romex cable runs, blue plastic outlet boxes mounted at switch and outlet height, a ceiling junction box for the future light fixture, plywood subfloor, contractor documentation style, no people.',
  },
  {
    slug: 'in-floor-heat-mat',
    tag: 'progress',
    portalTags: ['behind_wall'],
    daysAgo: 27,
    caption: 'In-floor heat mat laid before tile',
    prompt:
      'A realistic overhead photograph of an electric heated floor mat with red wires laid in serpentine pattern across an ensuite bathroom subfloor, ready for self-leveling and tile, mesh backing visible, exposed wood stud walls in the background, contractor documentation style, no people.',
  },
  {
    slug: 'vanity-installed',
    tag: 'progress',
    portalTags: ['progress', 'marketing'],
    daysAgo: 8,
    caption: 'Double vanity set + quartz top installed',
    prompt:
      'A realistic photograph of a newly installed white shaker double vanity in a residential ensuite bathroom, polished Calacatta-look quartz countertop, two undermount white sinks, brushed gold faucets installed, mirrors not yet up, drop cloths on the floor, contractor documentation style, no people.',
  },
  {
    slug: 'closet-system-mounted',
    tag: 'progress',
    portalTags: ['progress', 'marketing'],
    daysAgo: 4,
    caption: 'Walk-in closet system mounted',
    prompt:
      'A realistic photograph of a residential walk-in closet with a fully installed white melamine custom closet system — open shelving, hanging rods, soft-close drawers — but no clothes yet, hardwood floor, soft daylight from the bedroom doorway, no people, contractor documentation style.',
  },
  {
    slug: 'hardwood-finished-bedroom',
    tag: 'progress',
    portalTags: ['progress'],
    daysAgo: 5,
    caption: 'Bedroom hardwood finished — paint touch-ups in progress',
    prompt:
      'A realistic photograph of a nearly finished residential master bedroom with new wide-plank engineered white oak hardwood flooring, white walls freshly painted, baseboards installed, a single drop cloth folded in the corner, paint can and roller on the floor, daylight through a large window, contractor documentation style, no people.',
  },
];

let photoCount = 0;
for (const p of photoSpecs) {
  const dup = await sql`
    SELECT 1 FROM public.photos
    WHERE project_id = ${projectId} AND caption = ${p.caption} LIMIT 1
  `;
  if (dup.length > 0) {
    console.log(`  skip photo (dup): ${p.slug}`);
    continue;
  }
  const buf = await generateImage(p.prompt);
  if (!buf) continue;
  const path = `${TENANT_ID}/${projectId}/${Date.now()}-${p.slug}.jpg`;
  const { error: upErr } = await supabase.storage.from('photos').upload(path, buf, {
    contentType: 'image/jpeg',
    upsert: false,
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
       width, height, caption_source, portal_tags, client_visible)
    VALUES (${TENANT_ID}, ${projectId}, ${customerId},
            ${path}, ${p.tag}, ${p.caption},
            ${takenAt}, ${takenAt}, ${owner.user_id}, 'web', 'image/jpeg', ${buf.length},
            1280, 960, 'user', ${p.portalTags ?? []}, true)
  `;
  photoCount++;
  console.log(`  photo: ${p.slug}`);
  await wait(400);
}
console.log(`photos added: ${photoCount}`);

// ── idea-board items ───────────────────────────────────────────────────────
// Image inspiration items get generated via Imagen and uploaded to the
// idea-board path under the photos bucket. Notes + links are inserted
// directly. customer_id is set so the portal can group "their" items.

async function uploadIdeaBoardImage(itemId, buf) {
  const path = `${TENANT_ID}/idea-board-${projectId}/${itemId}.jpg`;
  const { error } = await supabase.storage.from('photos').upload(path, buf, {
    contentType: 'image/jpeg',
    upsert: false,
  });
  if (error) throw error;
  return path;
}

const ideaImageSpecs = [
  {
    title: 'Backlit niche behind the tub — love this',
    room: 'Ensuite',
    notes:
      'Saw this on a reno blog — what we want is a niche this size centered behind the freestanding tub, warm white LED.',
    daysAgo: 38,
    prompt:
      'A realistic interior design photograph of a luxury ensuite bathroom featuring a freestanding white soaker tub against a tiled feature wall with a backlit recessed niche, warm white LED accent lighting glowing behind the tub, marble-look porcelain tile, soft daylight, magazine-quality, no people.',
  },
  {
    title: 'Vanity light style we like',
    room: 'Ensuite',
    notes: 'Three pendants over the double vanity, not bar lights.',
    daysAgo: 35,
    prompt:
      'A realistic interior design photograph of three matching brushed brass pendant lights hanging in a row over a double vanity bathroom mirror, soft warm globes, modern transitional style, marble countertop visible below, magazine-quality, no people.',
  },
  {
    title: 'Closet with an island — too much?',
    room: 'Walk-in closet',
    notes: 'Priya saw this on Pinterest. Probably too big for our space but love the drawer detail.',
    daysAgo: 30,
    prompt:
      'A realistic photograph of a luxury residential walk-in closet with a center island featuring soft-close drawers and a stone top, white shaker cabinetry around the perimeter with hanging rods and open shelving, hardwood floor, magazine-quality, no people.',
  },
  {
    title: 'Bedroom feeling — soft, layered',
    room: 'Bedroom',
    notes: 'For the styling — neutral linens, lots of texture, no bold colors.',
    daysAgo: 18,
    prompt:
      'A realistic interior design photograph of a softly styled master bedroom, neutral cream and warm grey palette, layered linen bedding on a low-profile bed, oak nightstands, sheer linen curtains, large window with soft natural light, hardwood floors, magazine-quality, no people.',
  },
];

let ideaCount = 0;
for (const spec of ideaImageSpecs) {
  const dup = await sql`
    SELECT 1 FROM public.project_idea_board_items
    WHERE project_id = ${projectId} AND title = ${spec.title} LIMIT 1
  `;
  if (dup.length > 0) {
    console.log(`  skip idea (dup): ${spec.title}`);
    continue;
  }
  const buf = await generateImage(spec.prompt);
  if (!buf) continue;
  // We want the storage path to include the row id, so insert first with a
  // placeholder, then update once we know the path.
  const [row] = await sql`
    INSERT INTO public.project_idea_board_items
      (tenant_id, project_id, customer_id, kind, image_storage_path, title, notes, room, created_at, updated_at)
    VALUES (${TENANT_ID}, ${projectId}, ${customerId}, 'image',
            ${'pending'}, ${spec.title}, ${spec.notes}, ${spec.room},
            ${ts(-spec.daysAgo)}, ${ts(-spec.daysAgo)})
    RETURNING id
  `;
  const path = await uploadIdeaBoardImage(row.id, buf);
  await sql`
    UPDATE public.project_idea_board_items
    SET image_storage_path = ${path}
    WHERE id = ${row.id}
  `;
  ideaCount++;
  console.log(`  idea image: ${spec.title}`);
  await wait(400);
}

const noteSpecs = [
  {
    title: 'Toiletry organization',
    notes:
      'Quick thought — can we get a tall pull-out between the two sinks for hairdryer + tools? Outlets inside please.',
    room: 'Ensuite',
    daysAgo: 22,
  },
  {
    title: 'Robe hooks',
    notes: 'Two robe hooks on the back of the bedroom door (his + hers). Brushed gold to match the faucets.',
    room: 'Ensuite',
    daysAgo: 9,
  },
];
for (const n of noteSpecs) {
  const dup = await sql`
    SELECT 1 FROM public.project_idea_board_items
    WHERE project_id = ${projectId} AND title = ${n.title} LIMIT 1
  `;
  if (dup.length > 0) {
    console.log(`  skip note (dup): ${n.title}`);
    continue;
  }
  await sql`
    INSERT INTO public.project_idea_board_items
      (tenant_id, project_id, customer_id, kind, notes, title, room, created_at, updated_at)
    VALUES (${TENANT_ID}, ${projectId}, ${customerId}, 'note',
            ${n.notes}, ${n.title}, ${n.room},
            ${ts(-n.daysAgo)}, ${ts(-n.daysAgo)})
  `;
  ideaCount++;
  console.log(`  idea note: ${n.title}`);
}

const linkSpecs = [
  {
    title: 'Pinterest — ensuite tile inspiration',
    source_url: 'https://www.pinterest.com/search/pins/?q=marble%20ensuite%20feature%20wall',
    room: 'Ensuite',
    notes: 'Lots of these on Pinterest. The 4th and 6th are closest to what we want.',
    daysAgo: 41,
  },
  {
    title: 'Innotech — closet finishes',
    source_url: 'https://www.innotechclosets.com/galleries/walk-in-closets',
    room: 'Walk-in closet',
    notes: 'Looked at the catalog you sent — leaning toward the "Pure White" finish, not the Macchiato.',
    daysAgo: 12,
  },
];
for (const l of linkSpecs) {
  const dup = await sql`
    SELECT 1 FROM public.project_idea_board_items
    WHERE project_id = ${projectId} AND title = ${l.title} LIMIT 1
  `;
  if (dup.length > 0) {
    console.log(`  skip link (dup): ${l.title}`);
    continue;
  }
  await sql`
    INSERT INTO public.project_idea_board_items
      (tenant_id, project_id, customer_id, kind, source_url, title, notes, room, created_at, updated_at)
    VALUES (${TENANT_ID}, ${projectId}, ${customerId}, 'link',
            ${l.source_url}, ${l.title}, ${l.notes}, ${l.room},
            ${ts(-l.daysAgo)}, ${ts(-l.daysAgo)})
  `;
  ideaCount++;
  console.log(`  idea link: ${l.title}`);
}
console.log(`idea board items added: ${ideaCount}`);

// ── more selections ────────────────────────────────────────────────────────
const selectionSpecs = [
  {
    room: 'Ensuite',
    category: 'fixture',
    brand: 'Brizo',
    name: 'Levoir thermostatic shower trim',
    code: 'BR-T75598-LG',
    finish: 'Luxe gold',
    supplier: 'Robinson Bath Centre',
    sku: 'T75598-LG',
    notes: 'Matches the vanity faucets. Thermostatic + volume — fixed showerhead + handheld on slide bar.',
  },
  {
    room: 'Ensuite',
    category: 'fixture',
    brand: 'Toto',
    name: 'Drake II one-piece toilet',
    code: 'TOTO-MS604114CEFG-01',
    finish: 'Cotton white',
    supplier: 'Robinson Bath Centre',
    sku: 'MS604114CEFG#01',
    notes: '1.28 GPF, comfort height, soft-close seat included.',
  },
  {
    room: 'Ensuite',
    category: 'tile',
    brand: 'Marazzi',
    name: 'Classentino Marble — feature niche mosaic',
    code: 'MZ-CL-2x6-HEX',
    finish: 'Polished mosaic',
    supplier: 'Stoneworks Tile',
    sku: 'CL-MOS-2x6',
    notes: 'Used inside the backlit niche behind the tub — change-order #1.',
  },
  {
    room: 'Walk-in closet',
    category: 'cabinets',
    brand: 'Innotech Closets',
    name: 'Pure White melamine system',
    code: 'INNO-PW-WIC',
    finish: 'Pure White matte',
    supplier: 'Innotech Closets',
    sku: 'WIC-CUSTOM-PW',
    notes: 'Soft-close drawers, two hanging zones, valet rod, closed shoe shelves.',
  },
  {
    room: 'Bedroom',
    category: 'paint',
    brand: 'Benjamin Moore',
    name: 'Classic Gray (ceiling)',
    code: 'BM OC-23',
    finish: 'Aura matte ceiling',
    supplier: 'Benjamin Moore',
    sku: 'OC-23',
    notes: 'Subtle warm gray on the ceiling — lifts the room without going stark.',
  },
  {
    room: 'Ensuite',
    category: 'hardware',
    brand: 'Emtek',
    name: 'Round cabinet pulls (4")',
    code: 'EMTEK-86375US4',
    finish: 'Satin brass',
    supplier: 'Banbury Lane',
    sku: '86375US4',
    notes: 'On the vanity drawer + door fronts. 4" centers.',
  },
];

let selCount = 0;
for (let i = 0; i < selectionSpecs.length; i++) {
  const s = selectionSpecs[i];
  const dup = await sql`
    SELECT 1 FROM public.project_selections
    WHERE project_id = ${projectId} AND room = ${s.room} AND name = ${s.name} LIMIT 1
  `;
  if (dup.length > 0) {
    console.log(`  skip selection (dup): ${s.room} / ${s.name}`);
    continue;
  }
  await sql`
    INSERT INTO public.project_selections
      (tenant_id, project_id, room, category, brand, name, code, finish,
       supplier, sku, notes, display_order)
    VALUES (${TENANT_ID}, ${projectId}, ${s.room}, ${s.category}, ${s.brand}, ${s.name},
            ${s.code}, ${s.finish}, ${s.supplier}, ${s.sku}, ${s.notes}, ${100 + i})
  `;
  selCount++;
  console.log(`  selection: ${s.room} / ${s.name}`);
}
console.log(`selections added: ${selCount}`);

console.log('\n========== DONE ==========');
console.log(`photos:    +${photoCount}`);
console.log(`ideas:     +${ideaCount}`);
console.log(`selections: +${selCount}`);
console.log(`url: https://app.heyhenry.io/projects/${projectId}`);

await sql.end();
