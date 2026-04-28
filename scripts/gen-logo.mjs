/**
 * Generate logo variants for a fictitious contractor "Northbeam Construction"
 * via Imagen 4 ultra. Saves locally + uploads to a public-ish path so the
 * URLs are shareable.
 */
import { GoogleGenAI } from '@google/genai';
import { createClient } from '@supabase/supabase-js';
import fs from 'fs';

const genai = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY });
const supabase = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY,
);

const MODELS_TO_TRY = ['imagen-4.0-ultra-generate-001', 'imagen-4.0-generate-001'];

const variants = [
  {
    slug: 'northbeam-1-monogram',
    prompt: `A minimalist vector logo for a high-end Pacific Northwest renovation contractor named "Northbeam Construction". Clean monogram of an "N" cleverly integrated with a horizontal cedar beam silhouette. Single colour design, deep forest green on a clean white background. Modern, geometric, professional. No noise, no texture, sharp edges, vector-style. Centered on the canvas with generous white space. Tagline-free. Suitable for use as a logo at small sizes.`,
  },
  {
    slug: 'northbeam-2-roofline',
    prompt: `A minimalist vector logo for a Pacific Northwest renovation contractor named "Northbeam Construction". Mark: a stylized geometric mountain peak that doubles as a roof gable, with a single horizontal beam line cutting across. Wordmark "NORTHBEAM" in a strong modern sans-serif underneath the mark, "CONSTRUCTION" smaller below in tracked-out spacing. Single colour, deep slate navy on white background. Vector-style, sharp, professional, no texture. Centered.`,
  },
  {
    slug: 'northbeam-3-craft',
    prompt: `A minimalist craft-forward logo badge for a renovation contractor named "Northbeam Construction". Circular badge with an embedded silhouette of a hammer crossed with a cedar branch. Around the top of the circle, the words "NORTHBEAM" in tracked-out caps; bottom: "EST. 2026". Single colour design, charcoal black on warm cream background. Professional, vector-style, clean lines, no shading or photographic detail. Centered on the canvas.`,
  },
];

const results = [];
for (const v of variants) {
  let img = null;
  let usedModel = null;
  for (const model of MODELS_TO_TRY) {
    try {
      const res = await genai.models.generateImages({
        model,
        prompt: v.prompt,
        config: { numberOfImages: 1, aspectRatio: '1:1', personGeneration: 'dont_allow' },
      });
      const got = res.generatedImages?.[0];
      if (got?.image?.imageBytes) {
        img = got;
        usedModel = model;
        break;
      }
    } catch (e) {
      console.log(`  ${model} failed:`, e.message);
    }
  }
  if (!img) {
    console.log('FAILED:', v.slug);
    continue;
  }
  const buf = Buffer.from(img.image.imageBytes, 'base64');
  const localPath = `/tmp/${v.slug}.jpg`;
  fs.writeFileSync(localPath, buf);
  // Upload to ops/photos bucket under a logos/ prefix
  const remotePath = `demo-logos/${v.slug}.jpg`;
  const { error } = await supabase.storage.from('photos').upload(remotePath, buf, {
    contentType: 'image/jpeg',
    upsert: true,
  });
  if (error) {
    console.log('upload err:', error.message);
  }
  // Signed URL for sharing (1 day)
  const { data: signed } = await supabase.storage
    .from('photos')
    .createSignedUrl(remotePath, 86400);
  results.push({ slug: v.slug, model: usedModel, localPath, remoteUrl: signed?.signedUrl });
  console.log(`✓ ${v.slug} (${usedModel}) — ${(buf.length / 1024).toFixed(0)}KB`);
}

console.log('\n=== Logo URLs (24h signed) ===');
for (const r of results) {
  console.log(`\n${r.slug} (${r.model})`);
  console.log(`  local: ${r.localPath}`);
  console.log(`  url:   ${r.remoteUrl}`);
}
