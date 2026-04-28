/**
 * Regenerate the demo project photos with realistic construction imagery
 * via Imagen 4. Replaces the random picsum placeholders.
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
const [project] = await sql`
  SELECT id FROM public.projects
  WHERE tenant_id = ${TENANT_ID} AND name = 'Master Bathroom Reno + Outdoor Sauna'
  ORDER BY created_at DESC LIMIT 1
`;

// Pull existing photos to know which to update
const existing = await sql`
  SELECT id, caption, storage_path FROM public.photos
  WHERE project_id = ${project.id} ORDER BY taken_at
`;
console.log('existing photos:', existing.length);

// Realistic prompts for each photo, in the same order/captioning we seeded
const prompts = {
  'Existing bathroom — original tile + tub':
    'A realistic photograph of a dated 1990s suburban Canadian bathroom interior before renovation. Beige ceramic tile floor, a white acrylic alcove bathtub with chrome fixtures, dated oak vanity with a single sink, bronze hardware, faded wallpaper border, builder-grade light fixture. Slightly cluttered, lived-in. Natural daylight from a small window. Documentation photo style, no people, slight wide angle.',
  'Old vanity removed for measurement':
    'A realistic photograph of a residential bathroom mid-renovation, taken by a contractor for documentation. The dated oak vanity has been removed leaving exposed plumbing supply lines and a plywood floor patch where the vanity sat. Beige tile still on floor, walls have ghost outline of removed mirror. Tape measure on the floor. Construction site lighting, no people, documentation style.',
  'Demo complete — shower wall studs exposed':
    'A realistic contractor documentation photograph of a residential bathroom with the shower demolished. Wood stud wall framing fully exposed showing 2x4 studs, copper plumbing supply lines, and a black PVC drain stack. Subfloor is exposed plywood. Drywall dust visible. No people. Bright LED work light. Detailed, slightly wide angle, sharp focus.',
  'Plumbing rough — new shower mixer + tub feed':
    'A realistic close-up photograph of new bathroom plumbing rough-in. New copper PEX-A supply lines going to a brushed brass shower mixer rough valve mounted between wood studs. Black PVC drain visible below. Tub supply lines roughed in to one side. Construction documentation style, sharp focus, no people.',
  'Heated floor mat laid before pour':
    'A realistic overhead photograph of an electric heated floor heating mat laid out across a bathroom subfloor in a wavy serpentine pattern, ready for self-leveling concrete pour. Red wires, mesh backing visible. Wood stud walls in the background. Construction documentation lighting, sharp focus, no people.',
  'Drywall up + first coat of mud':
    'A realistic photograph of a residential bathroom interior with new drywall installed, taped joints with the first coat of joint compound applied (visible white mud lines). Empty room, no fixtures yet. Exposed concrete subfloor. Bright LED work light, contractor documentation photo style, no people.',
  'Sauna pad — gravel base graded + compacted':
    'A realistic outdoor backyard photograph of a freshly compacted gravel base for an outdoor sauna pad, perfectly level and rectangular about 8 by 10 feet, surrounded by green grass and a wooden fence in a Canadian Pacific Northwest backyard. A compacting tool resting nearby. Overcast daylight, no people, contractor documentation style.',
  'Excavation done — ready for forms':
    'A realistic outdoor photograph of a rectangular excavation in a residential backyard ready for a concrete pad pour, with clean vertical edges, gravel base visible at the bottom. Wooden form boards stacked nearby. A spade shovel leaning against a fence. Cedar fence in the background, Canadian backyard. Overcast lighting, no people.',
  'Cedar bench detail from supplier — for client review':
    'A realistic close-up product photograph of a Western Red Cedar sauna bench detail, showing the warm reddish-brown grain of horizontal slat construction with rounded edges. Vertical legs visible. Soft natural light, clean studio-like background. Catalog style, no people.',
  'Tile sample lay-down — herringbone option':
    'A realistic photograph of bathroom tile samples laid out on a workbench in a herringbone pattern. Rectangular handmade ceramic tiles in soft cream and warm grey shades arranged in two herringbone groupings to compare. Construction site lighting, contractor documentation style, no people.',
};

const wait = (ms) => new Promise((r) => setTimeout(r, ms));

let updated = 0;
for (const photo of existing) {
  const prompt = prompts[photo.caption];
  if (!prompt) {
    console.log('skip (no prompt):', photo.caption);
    continue;
  }
  try {
    const result = await genai.models.generateImages({
      model: 'imagen-4.0-generate-001',
      prompt,
      config: { numberOfImages: 1, aspectRatio: '4:3', personGeneration: 'dont_allow' },
    });
    const img = result.generatedImages?.[0];
    if (!img?.image?.imageBytes) {
      console.log('NO image returned for:', photo.caption);
      continue;
    }
    const buf = Buffer.from(img.image.imageBytes, 'base64');
    // Reuse the existing storage_path so URLs stay stable
    const { error: upErr } = await supabase.storage
      .from('photos')
      .upload(photo.storage_path, buf, {
        contentType: 'image/jpeg',
        upsert: true,
      });
    if (upErr) {
      console.log('upload failed:', photo.caption, upErr.message);
      continue;
    }
    await sql`UPDATE public.photos SET bytes = ${buf.length}, updated_at = now() WHERE id = ${photo.id}`;
    updated++;
    process.stdout.write('✓');
    await wait(800); // gentle on the API
  } catch (e) {
    console.log('\nFAILED:', photo.caption, '—', e.message);
  }
}

console.log(`\nupdated ${updated}/${existing.length} photos`);
await sql.end();
