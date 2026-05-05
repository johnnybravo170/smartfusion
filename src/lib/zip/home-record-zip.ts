/**
 * Server-side Home Record ZIP archive builder. Slice 6c of the Customer
 * Portal & Home Record build.
 *
 * Folder layout the homeowner unzips:
 *
 *   <Project name>/
 *     README.txt                — plain-text project summary + folder map
 *     home-record.pdf           — the branded PDF (if generated)
 *     photos/
 *       before/
 *       progress/
 *       behind-the-wall/
 *       issue/
 *       completion/
 *       highlight/
 *     documents/
 *       contract/
 *       permit/
 *       warranty/
 *       manual/
 *       inspection/
 *       coi/
 *       other/
 *
 * Empty folders are omitted. Files are named after the original filename
 * when we can recover one (taken from storage_path); otherwise we fall
 * back to a stable id-based name. The ZIP is built fully in-memory then
 * returned as a Buffer because Supabase Storage's `upload` API doesn't
 * support streaming. For typical residential reno projects (≤ 100 photos
 * + ≤ 50 docs at 1-3 MB each) this is well within Vercel's 1 GB function
 * memory.
 */

import { PassThrough } from 'node:stream';
import archiver from 'archiver';
import type { HomeRecordSnapshotV1 } from '@/lib/db/queries/home-records';
import { type PortalPhotoTag, portalPhotoTagLabels } from '@/lib/validators/portal-photo';
import { type DocumentType, documentTypeLabels } from '@/lib/validators/project-document';
import { selectionCategoryLabels } from '@/lib/validators/project-selection';

const PHOTO_TAG_FOLDER: Record<PortalPhotoTag, string> = {
  before: 'before',
  progress: 'progress',
  behind_wall: 'behind-the-wall',
  issue: 'issue',
  completion: 'completion',
  marketing: 'highlight',
};

const DOC_TYPE_FOLDER: Record<DocumentType, string> = {
  contract: 'contract',
  permit: 'permit',
  warranty: 'warranty',
  manual: 'manual',
  inspection: 'inspection',
  coi: 'coi',
  other: 'other',
};

export type ZipPhoto = {
  storage_path: string;
  bytes: Buffer;
  /** Original filename if known; otherwise we pick a name from storage_path. */
  filename: string;
  tag: PortalPhotoTag;
};

export type ZipDoc = {
  storage_path: string;
  bytes: Buffer;
  filename: string;
  type: DocumentType;
};

function safeFilename(name: string, fallback: string, ext = 'bin'): string {
  const cleaned = name
    .replace(/[/\\?%*:|"<>]/g, '_')
    .replace(/\s+/g, ' ')
    .trim();
  if (cleaned.length === 0) return `${fallback}.${ext}`;
  if (cleaned.length > 120) return `${cleaned.slice(0, 120)}.${ext}`;
  return cleaned;
}

function formatDate(iso: string | null | undefined): string {
  if (!iso) return '';
  return new Date(iso).toLocaleDateString('en-CA', {
    month: 'long',
    day: 'numeric',
    year: 'numeric',
  });
}

export function buildHomeRecordReadme(snapshot: HomeRecordSnapshotV1): string {
  const lines: string[] = [];
  lines.push(`HOME RECORD — ${snapshot.project.name}`);
  lines.push('='.repeat(Math.min(60, snapshot.project.name.length + 14)));
  lines.push('');
  lines.push(`Prepared by: ${snapshot.contractor.name}`);
  lines.push(`Generated:   ${formatDate(snapshot.generated_at)}`);
  if (snapshot.customer.name) {
    lines.push(`Homeowner:   ${snapshot.customer.name}`);
  }
  if (snapshot.customer.address) {
    lines.push(`Address:     ${snapshot.customer.address}`);
  }
  lines.push('');

  if (snapshot.project.description) {
    lines.push('Project summary');
    lines.push('---------------');
    lines.push(snapshot.project.description);
    lines.push('');
  }

  if (snapshot.project.start_date || snapshot.project.target_end_date) {
    if (snapshot.project.start_date)
      lines.push(`Started: ${formatDate(snapshot.project.start_date)}`);
    if (snapshot.project.target_end_date)
      lines.push(`Target completion: ${formatDate(snapshot.project.target_end_date)}`);
    lines.push('');
  }

  // Selections — quick text version. Useful when the homeowner is at
  // the paint store with the print-out and wants to grep.
  if (snapshot.selections.length > 0) {
    lines.push('What we used in your home');
    lines.push('-------------------------');
    const byRoom = new Map<string, typeof snapshot.selections>();
    for (const sel of snapshot.selections) {
      const key = sel.room.trim() || 'Unsorted';
      const list = byRoom.get(key) ?? [];
      list.push(sel);
      byRoom.set(key, list);
    }
    for (const [room, items] of byRoom.entries()) {
      lines.push('');
      lines.push(`  ${room}`);
      for (const s of items) {
        const cat = selectionCategoryLabels[s.category] ?? s.category;
        const name = [s.brand, s.name].filter(Boolean).join(' ');
        const detail = [s.code, s.finish].filter(Boolean).join(' • ');
        const supplier = [s.supplier, s.sku ? `SKU ${s.sku}` : null].filter(Boolean).join(' • ');
        lines.push(
          `    - ${cat}: ${name || '—'}${detail ? ` (${detail})` : ''}${
            supplier ? ` [${supplier}]` : ''
          }`,
        );
      }
    }
    lines.push('');
  }

  lines.push('Folder map');
  lines.push('----------');
  lines.push('  home-record.pdf      — the branded handoff document');
  lines.push('  photos/              — every photo, organized by category');
  lines.push('    before/            — what your home looked like before');
  lines.push('    progress/          — work in progress');
  lines.push('    behind-the-wall/   — what is behind the walls (keep these forever!)');
  lines.push('    completion/        — finished work');
  lines.push('    issue/             — issues we documented during the job');
  lines.push('    highlight/         — featured shots');
  lines.push('  documents/           — contracts, permits, warranties, manuals, inspections, COIs');
  lines.push('');
  lines.push(`A permanent record from ${snapshot.contractor.name}.`);
  lines.push('Save this folder somewhere safe — it works forever.');
  lines.push('');
  return lines.join('\n');
}

export async function generateHomeRecordZip(
  snapshot: HomeRecordSnapshotV1,
  photos: ZipPhoto[],
  docs: ZipDoc[],
  pdfBytes: Buffer | null,
): Promise<Buffer> {
  return new Promise<Buffer>((resolve, reject) => {
    const archive = archiver('zip', { zlib: { level: 6 } });
    const passthrough = new PassThrough();
    const chunks: Buffer[] = [];

    passthrough.on('data', (chunk: Buffer) => chunks.push(chunk));
    passthrough.on('end', () => resolve(Buffer.concat(chunks)));
    passthrough.on('error', reject);
    archive.on('error', reject);
    archive.pipe(passthrough);

    // README at the root.
    archive.append(buildHomeRecordReadme(snapshot), { name: 'README.txt' });

    // PDF if available.
    if (pdfBytes) {
      archive.append(pdfBytes, { name: 'home-record.pdf' });
    }

    // Photos by tag folder. A photo with multiple tags appears in each
    // tag's folder under the same filename — small disk cost, but means
    // a homeowner browsing "behind-the-wall" sees every behind-wall
    // photo even if it was also tagged "completion".
    const photoUsedNames = new Set<string>();
    for (const photo of photos) {
      const folder = `photos/${PHOTO_TAG_FOLDER[photo.tag]}`;
      const baseName = safeFilename(
        photo.filename,
        photo.storage_path.split('/').pop() ?? 'photo',
        'jpg',
      );
      let name = `${folder}/${baseName}`;
      // Unique-suffix in case two photos collapse to the same name in
      // the same folder.
      let suffix = 1;
      while (photoUsedNames.has(name)) {
        const dot = baseName.lastIndexOf('.');
        const stem = dot >= 0 ? baseName.slice(0, dot) : baseName;
        const ext = dot >= 0 ? baseName.slice(dot) : '';
        name = `${folder}/${stem}-${suffix}${ext}`;
        suffix += 1;
      }
      photoUsedNames.add(name);
      archive.append(photo.bytes, { name });
    }

    // Documents by type folder.
    const docUsedNames = new Set<string>();
    for (const doc of docs) {
      const folder = `documents/${DOC_TYPE_FOLDER[doc.type]}`;
      const baseName = safeFilename(
        doc.filename,
        doc.storage_path.split('/').pop() ?? 'document',
        'pdf',
      );
      let name = `${folder}/${baseName}`;
      let suffix = 1;
      while (docUsedNames.has(name)) {
        const dot = baseName.lastIndexOf('.');
        const stem = dot >= 0 ? baseName.slice(0, dot) : baseName;
        const ext = dot >= 0 ? baseName.slice(dot) : '';
        name = `${folder}/${stem}-${suffix}${ext}`;
        suffix += 1;
      }
      docUsedNames.add(name);
      archive.append(doc.bytes, { name });
    }

    archive.finalize();
  });
}

// Re-exports so call sites don't have to import from two places.
export { documentTypeLabels, portalPhotoTagLabels };
