/**
 * Generate placeholder PWA icons from the SVG source.
 *
 * Usage: npx tsx scripts/generate-icons.ts
 *
 * Requires `sharp` (devDependency). If sharp is not installed, run:
 *   pnpm add -D sharp
 */

import { readFileSync } from 'fs';
import { dirname, join } from 'path';
import sharp from 'sharp';
import { fileURLToPath } from 'url';

const __dirname =
  typeof import.meta.dirname === 'string'
    ? import.meta.dirname
    : dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, '..');
const svgPath = join(ROOT, 'public', 'icons', 'icon.svg');
const svg = readFileSync(svgPath);

const sizes = [
  { name: 'icon-192.png', size: 192 },
  { name: 'icon-512.png', size: 512 },
  { name: 'apple-touch-icon.png', size: 180 },
] as const;

async function main() {
  for (const { name, size } of sizes) {
    const out = join(ROOT, 'public', 'icons', name);
    await sharp(svg).resize(size, size).png().toFile(out);
    console.log(`  ${name} (${size}x${size})`);
  }
  console.log('Done.');
}

main();
