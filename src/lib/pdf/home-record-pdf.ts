/**
 * Server-side Home Record PDF generator. Slice 6b of the Customer
 * Portal & Home Record build.
 *
 * Mirrors the structure of the public /home-record/<slug> web page —
 * cover + phases + selections-by-room + photos-by-tag (with
 * behind-the-wall as a labelled section) + decisions + COs +
 * documents-by-type. Photos are embedded as JPEG/PNG bytes (resolved
 * from signed URLs at generation time) so the PDF is permanent
 * regardless of bucket lifecycle.
 *
 * Built on jsPDF + jspdf-autotable to match the existing renovation-
 * quote PDF (`src/lib/pdf/renovation-quote-pdf.ts`). Helvetica only,
 * portrait A4, 20mm margins.
 */

import { jsPDF } from 'jspdf';
import autoTable from 'jspdf-autotable';
import type { HomeRecordSnapshotV1 } from '@/lib/db/queries/home-records';
import {
  PORTAL_PHOTO_TAG_DISPLAY_ORDER,
  type PortalPhotoTag,
  portalPhotoTagLabels,
} from '@/lib/validators/portal-photo';
import {
  DOCUMENT_TYPE_DISPLAY_ORDER,
  type DocumentType,
  documentTypeLabels,
} from '@/lib/validators/project-document';
import {
  type SelectionCategory,
  selectionCategoryLabels,
} from '@/lib/validators/project-selection';

const cadFormat = new Intl.NumberFormat('en-CA', { style: 'currency', currency: 'CAD' });

function formatDate(iso: string | null | undefined): string {
  if (!iso) return '';
  return new Date(iso).toLocaleDateString('en-CA', {
    month: 'long',
    day: 'numeric',
    year: 'numeric',
  });
}

/**
 * Photo bytes ready to embed. Caller resolves signed URLs and fetches
 * bytes; we don't hit the network from inside the PDF code path.
 */
export type EmbeddablePhoto = {
  storage_path: string;
  /** Base64 (no data: prefix) ready for jsPDF.addImage */
  base64: string;
  /** 'JPEG' | 'PNG' — jsPDF format hint */
  format: 'JPEG' | 'PNG';
};

export type EmbeddableDoc = {
  storage_path: string;
  /** Pre-signed URL — clickable in the PDF */
  url: string;
};

const PAGE_WIDTH_MM = 210;
const PAGE_HEIGHT_MM = 297;
const MARGIN = 18;

export function generateHomeRecordPdf(
  snapshot: HomeRecordSnapshotV1,
  embeddedPhotos: EmbeddablePhoto[],
  embeddedDocs: EmbeddableDoc[],
): Buffer {
  const doc = new jsPDF({ orientation: 'portrait', unit: 'mm', format: 'a4' });
  const photosByPath = new Map(embeddedPhotos.map((p) => [p.storage_path, p]));
  const docsByPath = new Map(embeddedDocs.map((d) => [d.storage_path, d]));
  let y = MARGIN;

  function checkPage(needed: number): void {
    if (y + needed > PAGE_HEIGHT_MM - MARGIN) {
      doc.addPage();
      y = MARGIN;
    }
  }

  function sectionTitle(title: string): void {
    checkPage(14);
    doc.setFont('helvetica', 'bold');
    doc.setFontSize(13);
    doc.setTextColor(20);
    doc.text(title, MARGIN, y);
    y += 6;
    doc.setDrawColor(220);
    doc.line(MARGIN, y, PAGE_WIDTH_MM - MARGIN, y);
    y += 4;
    doc.setTextColor(60);
    doc.setFontSize(10);
    doc.setFont('helvetica', 'normal');
  }

  // ============================================================
  // Cover header
  // ============================================================
  doc.setFont('helvetica', 'bold');
  doc.setFontSize(11);
  doc.setTextColor(120);
  doc.text('HOME RECORD', PAGE_WIDTH_MM / 2, MARGIN + 4, { align: 'center' });

  doc.setFontSize(22);
  doc.setTextColor(15);
  doc.text(snapshot.project.name, PAGE_WIDTH_MM / 2, MARGIN + 14, { align: 'center' });

  doc.setFont('helvetica', 'normal');
  doc.setFontSize(11);
  doc.setTextColor(80);
  if (snapshot.customer.name) {
    const headerLine = snapshot.customer.address
      ? `${snapshot.customer.name} — ${snapshot.customer.address}`
      : snapshot.customer.name;
    doc.text(headerLine, PAGE_WIDTH_MM / 2, MARGIN + 22, { align: 'center' });
  }

  doc.setFontSize(9);
  doc.setTextColor(140);
  doc.text(
    `Prepared by ${snapshot.contractor.name} • Generated ${formatDate(snapshot.generated_at)}`,
    PAGE_WIDTH_MM / 2,
    MARGIN + 30,
    { align: 'center' },
  );

  y = MARGIN + 42;

  // ============================================================
  // Project summary
  // ============================================================
  if (snapshot.project.description) {
    sectionTitle('Project summary');
    const lines = doc.splitTextToSize(snapshot.project.description, PAGE_WIDTH_MM - 2 * MARGIN);
    checkPage(lines.length * 4.5);
    doc.text(lines, MARGIN, y);
    y += lines.length * 4.5 + 2;

    if (snapshot.project.start_date || snapshot.project.target_end_date) {
      const range = [
        snapshot.project.start_date ? `Started ${formatDate(snapshot.project.start_date)}` : null,
        snapshot.project.target_end_date
          ? `Target ${formatDate(snapshot.project.target_end_date)}`
          : null,
      ]
        .filter(Boolean)
        .join(' • ');
      doc.setFontSize(9);
      doc.setTextColor(140);
      doc.text(range, MARGIN, y);
      doc.setFontSize(10);
      doc.setTextColor(60);
      y += 6;
    }
    y += 4;
  }

  // ============================================================
  // Phases
  // ============================================================
  if (snapshot.phases.length > 0) {
    sectionTitle('Project phases');
    autoTable(doc, {
      startY: y,
      margin: { left: MARGIN, right: MARGIN },
      theme: 'plain',
      styles: { fontSize: 9, cellPadding: 1.5 },
      head: [['Phase', 'Status']],
      body: snapshot.phases.map((p) => [
        p.name,
        p.status === 'complete'
          ? `Completed ${formatDate(p.completed_at)}`
          : p.status === 'in_progress'
            ? p.started_at
              ? `Started ${formatDate(p.started_at)}`
              : 'In progress'
            : 'Upcoming',
      ]),
      didDrawPage: () => {
        // no-op
      },
    });
    // biome-ignore lint/suspicious/noExplicitAny: jsPDF autoTable mutates instance
    y = ((doc as any).lastAutoTable?.finalY ?? y) + 6;
  }

  // ============================================================
  // Selections — grouped by room
  // ============================================================
  if (snapshot.selections.length > 0) {
    sectionTitle('What we used in your home');
    const byRoom = new Map<string, typeof snapshot.selections>();
    for (const sel of snapshot.selections) {
      const key = sel.room.trim() || 'Unsorted';
      const list = byRoom.get(key) ?? [];
      list.push(sel);
      byRoom.set(key, list);
    }
    for (const [room, items] of byRoom.entries()) {
      checkPage(20);
      doc.setFont('helvetica', 'bold');
      doc.setFontSize(11);
      doc.text(room, MARGIN, y);
      y += 4;
      doc.setFont('helvetica', 'normal');
      doc.setFontSize(9);

      autoTable(doc, {
        startY: y,
        margin: { left: MARGIN, right: MARGIN },
        theme: 'striped',
        styles: { fontSize: 9, cellPadding: 1.5 },
        head: [['Category', 'Brand / name', 'Code / finish', 'Supplier / SKU']],
        body: items.map((s) => [
          selectionCategoryLabels[s.category as SelectionCategory] ?? s.category,
          [s.brand, s.name].filter(Boolean).join(' '),
          [s.code, s.finish].filter(Boolean).join(' • '),
          [s.supplier, s.sku ? `SKU ${s.sku}` : null].filter(Boolean).join(' • '),
        ]),
      });
      // biome-ignore lint/suspicious/noExplicitAny: jsPDF autoTable mutates instance
      y = ((doc as any).lastAutoTable?.finalY ?? y) + 4;
    }
    y += 2;
  }

  // ============================================================
  // Photos — per category, including behind-the-wall as its own block
  // ============================================================
  if (embeddedPhotos.length > 0) {
    sectionTitle('Photos');
    const buckets = new Map<PortalPhotoTag, typeof snapshot.photos>();
    for (const photo of snapshot.photos) {
      for (const tag of photo.portal_tags) {
        const list = buckets.get(tag) ?? [];
        list.push(photo);
        buckets.set(tag, list);
      }
    }

    for (const tag of PORTAL_PHOTO_TAG_DISPLAY_ORDER) {
      const bucket = buckets.get(tag) ?? [];
      const drawable = bucket.filter((p) => photosByPath.has(p.storage_path));
      if (drawable.length === 0) continue;

      checkPage(8);
      doc.setFont('helvetica', 'bold');
      doc.setFontSize(11);
      doc.text(portalPhotoTagLabels[tag], MARGIN, y);
      if (tag === 'behind_wall') {
        doc.setFont('helvetica', 'italic');
        doc.setFontSize(8);
        doc.setTextColor(140);
        doc.text(' — for future repairs and resale', MARGIN + 32, y);
        doc.setFont('helvetica', 'normal');
        doc.setFontSize(10);
        doc.setTextColor(60);
      }
      y += 5;

      // 3-up grid; each thumbnail ~55mm wide.
      const cols = 3;
      const gap = 4;
      const colWidth = (PAGE_WIDTH_MM - 2 * MARGIN - gap * (cols - 1)) / cols;
      const thumbHeight = colWidth * 0.75;

      for (let i = 0; i < drawable.length; i += cols) {
        checkPage(thumbHeight + 3);
        for (let c = 0; c < cols && i + c < drawable.length; c++) {
          const photo = drawable[i + c];
          const embed = photosByPath.get(photo.storage_path);
          if (!embed) continue;
          const x = MARGIN + c * (colWidth + gap);
          try {
            doc.addImage(embed.base64, embed.format, x, y, colWidth, thumbHeight);
          } catch {
            // bad image — silently skip; better than crashing the whole PDF
          }
        }
        y += thumbHeight + gap;
      }
      y += 2;
    }
  }

  // ============================================================
  // Decisions
  // ============================================================
  if (snapshot.decisions.length > 0) {
    sectionTitle('Decisions');
    autoTable(doc, {
      startY: y,
      margin: { left: MARGIN, right: MARGIN },
      theme: 'plain',
      styles: { fontSize: 9, cellPadding: 1.5 },
      head: [['Decision', 'Outcome']],
      body: snapshot.decisions.map((d) => [
        d.label + (d.description ? `\n${d.description}` : ''),
        `${d.decided_value === 'approved' ? 'Approved' : 'Declined'}` +
          (d.decided_by_customer ? `\nby ${d.decided_by_customer}` : '') +
          (d.decided_at ? `\non ${formatDate(d.decided_at)}` : ''),
      ]),
    });
    // biome-ignore lint/suspicious/noExplicitAny: jsPDF autoTable mutates instance
    y = ((doc as any).lastAutoTable?.finalY ?? y) + 6;
  }

  // ============================================================
  // Change orders
  // ============================================================
  if (snapshot.change_orders.length > 0) {
    sectionTitle('Change orders');
    autoTable(doc, {
      startY: y,
      margin: { left: MARGIN, right: MARGIN },
      theme: 'striped',
      styles: { fontSize: 9, cellPadding: 1.5 },
      head: [['Title', 'Cost', 'Approved', 'Days']],
      body: snapshot.change_orders.map((co) => [
        co.title + (co.description ? `\n${co.description}` : ''),
        cadFormat.format((co.cost_impact_cents ?? 0) / 100),
        [co.approved_by_name, co.approved_at ? formatDate(co.approved_at) : null]
          .filter(Boolean)
          .join('\n'),
        co.timeline_impact_days ? `+${co.timeline_impact_days}` : '',
      ]),
    });
    // biome-ignore lint/suspicious/noExplicitAny: jsPDF autoTable mutates instance
    y = ((doc as any).lastAutoTable?.finalY ?? y) + 6;
  }

  // ============================================================
  // Documents — listed with clickable links
  // ============================================================
  if (snapshot.documents.length > 0) {
    sectionTitle('Documents & warranties');
    const byType = new Map<DocumentType, typeof snapshot.documents>();
    for (const d of snapshot.documents) {
      const list = byType.get(d.type) ?? [];
      list.push(d);
      byType.set(d.type, list);
    }
    for (const type of DOCUMENT_TYPE_DISPLAY_ORDER) {
      const docs = byType.get(type) ?? [];
      if (docs.length === 0) continue;
      checkPage(10);
      doc.setFont('helvetica', 'bold');
      doc.setFontSize(10);
      doc.text(documentTypeLabels[type], MARGIN, y);
      y += 4;
      doc.setFont('helvetica', 'normal');
      doc.setFontSize(9);
      for (const d of docs) {
        checkPage(5);
        const url = docsByPath.get(d.storage_path)?.url;
        const line = `• ${d.title}${d.expires_at ? ` (expires ${formatDate(d.expires_at)})` : ''}`;
        doc.text(line, MARGIN + 2, y);
        if (url) {
          // textWithLink renders text and overlays a clickable URL.
          doc.setTextColor(40, 90, 200);
          doc.textWithLink('Open', PAGE_WIDTH_MM - MARGIN - 14, y, { url });
          doc.setTextColor(60);
        }
        y += 4.5;
      }
      y += 2;
    }
  }

  // ============================================================
  // Footer (last page)
  // ============================================================
  checkPage(12);
  doc.setDrawColor(220);
  doc.line(MARGIN, y, PAGE_WIDTH_MM - MARGIN, y);
  y += 5;
  doc.setFontSize(8);
  doc.setTextColor(140);
  doc.text(
    `A permanent record from ${snapshot.contractor.name}. Save this file — it works forever.`,
    PAGE_WIDTH_MM / 2,
    y,
    { align: 'center' },
  );

  return Buffer.from(doc.output('arraybuffer'));
}
