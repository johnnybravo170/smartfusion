/**
 * Server-side PDF generation for renovation quotes.
 *
 * Format matches Jon's real spreadsheet:
 *   CONNECT CONTRACTING
 *   Quote for [Customer]
 *   INTERIOR / EXTERIOR sections with task tables
 *   Subtotal + Management Fee + GST + Total
 */

import { jsPDF } from 'jspdf';
import autoTable from 'jspdf-autotable';
import { formatCurrency } from '@/lib/pricing/calculator';
import { calculateBucketTotal, calculateRenovationTotal } from '@/lib/pricing/renovation-quote';

type BucketForPdf = {
  name: string;
  section: string;
  description: string | null;
  estimate_cents: number;
  is_visible_in_report: boolean;
};

type CustomerForPdf = {
  name: string;
  email?: string | null;
  phone?: string | null;
  address_line1?: string | null;
  city?: string | null;
  province?: string | null;
  postal_code?: string | null;
};

type QuotePdfOptions = {
  tenantName: string;
  customer: CustomerForPdf;
  buckets: BucketForPdf[];
  managementFeeRate: number;
  gstRate?: number;
  projectName?: string;
  date?: string;
};

export async function generateRenovationQuotePdf(options: QuotePdfOptions): Promise<Buffer> {
  const {
    tenantName,
    customer,
    buckets,
    managementFeeRate,
    gstRate = 0.05,
    projectName,
    date,
  } = options;

  const doc = new jsPDF({ orientation: 'portrait', unit: 'mm', format: 'a4' });
  const pageWidth = doc.internal.pageSize.getWidth();
  const margin = 20;
  let y = margin;

  // -- Header: business name --
  doc.setFontSize(20);
  doc.setFont('helvetica', 'bold');
  doc.text(tenantName.toUpperCase(), margin, y);
  y += 10;

  // -- Quote for [Customer] --
  doc.setFontSize(14);
  doc.setFont('helvetica', 'normal');
  doc.text(`Quote for ${customer.name}`, margin, y);
  y += 6;

  if (projectName) {
    doc.setFontSize(10);
    doc.text(`Project: ${projectName}`, margin, y);
    y += 5;
  }

  if (date) {
    doc.setFontSize(10);
    doc.text(`Date: ${date}`, margin, y);
    y += 5;
  }

  // Customer address
  const addressParts = [
    customer.address_line1,
    customer.city,
    customer.province,
    customer.postal_code,
  ].filter(Boolean);
  if (addressParts.length > 0) {
    doc.setFontSize(9);
    doc.text(addressParts.join(', '), margin, y);
    y += 5;
  }

  y += 5;

  // Separate buckets by section
  const visibleBuckets = buckets.filter((b) => b.is_visible_in_report);
  const interiorBuckets = visibleBuckets.filter((b) => b.section === 'interior');
  const exteriorBuckets = visibleBuckets.filter((b) => b.section === 'exterior');
  const generalBuckets = visibleBuckets.filter((b) => b.section === 'general');

  // Helper to render a section table
  function renderSection(title: string, sectionBuckets: BucketForPdf[], startY: number): number {
    if (sectionBuckets.length === 0) return startY;

    doc.setFontSize(12);
    doc.setFont('helvetica', 'bold');
    doc.text(title.toUpperCase(), margin, startY);
    startY += 2;

    const tableBody = sectionBuckets.map((b) => [
      b.name,
      b.description || '',
      formatCurrency(b.estimate_cents),
    ]);

    const sectionTotal = calculateBucketTotal(sectionBuckets);

    autoTable(doc, {
      startY,
      head: [['Task', 'Description', 'Estimate']],
      body: tableBody,
      foot: [[`${title} Total`, '', formatCurrency(sectionTotal)]],
      margin: { left: margin, right: margin },
      headStyles: {
        fillColor: [51, 51, 51],
        textColor: [255, 255, 255],
        fontStyle: 'bold',
        fontSize: 9,
      },
      bodyStyles: { fontSize: 9 },
      footStyles: {
        fillColor: [240, 240, 240],
        textColor: [0, 0, 0],
        fontStyle: 'bold',
        fontSize: 9,
      },
      columnStyles: {
        0: { cellWidth: 45 },
        1: { cellWidth: 80 },
        2: { halign: 'right', cellWidth: 35 },
      },
      alternateRowStyles: { fillColor: [248, 250, 252] },
    });

    // biome-ignore lint/suspicious/noExplicitAny: jspdf-autotable extends jsPDF at runtime
    return (doc as any).lastAutoTable.finalY + 8;
  }

  y = renderSection('Interior', interiorBuckets, y);
  y = renderSection('Exterior', exteriorBuckets, y);
  y = renderSection('General', generalBuckets, y);

  // -- Totals block --
  const totals = calculateRenovationTotal(visibleBuckets, managementFeeRate, gstRate);

  doc.setDrawColor(200, 200, 200);
  doc.line(margin, y, pageWidth - margin, y);
  y += 6;

  const totalsX = pageWidth - margin - 80;
  const valuesX = pageWidth - margin;

  doc.setFontSize(10);
  doc.setFont('helvetica', 'normal');

  doc.text('Subtotal (ex-GST):', totalsX, y);
  doc.text(formatCurrency(totals.subtotal_cents), valuesX, y, { align: 'right' });
  y += 6;

  const feePercent = Math.round(managementFeeRate * 100);
  doc.text(`Management Fee (${feePercent}%):`, totalsX, y);
  doc.text(formatCurrency(totals.fee_cents), valuesX, y, { align: 'right' });
  y += 6;

  const gstPercent = Math.round(gstRate * 100);
  doc.text(`GST (${gstPercent}%):`, totalsX, y);
  doc.text(formatCurrency(totals.gst_cents), valuesX, y, { align: 'right' });
  y += 2;

  doc.setDrawColor(200, 200, 200);
  doc.line(totalsX, y, valuesX, y);
  y += 5;

  doc.setFontSize(13);
  doc.setFont('helvetica', 'bold');
  doc.text('TOTAL:', totalsX, y);
  doc.text(formatCurrency(totals.total_cents), valuesX, y, { align: 'right' });
  y += 12;

  // -- Terms --
  doc.setDrawColor(200, 200, 200);
  doc.line(margin, y, pageWidth - margin, y);
  y += 6;

  doc.setFontSize(8);
  doc.setTextColor(120, 120, 120);
  doc.text('Valid for 30 days from the date above.', margin, y);
  y += 4;
  doc.text('All prices in Canadian dollars (CAD). GST included where applicable.', margin, y);

  // -- Footer --
  doc.setFontSize(7);
  doc.setTextColor(160, 160, 160);
  doc.text('Generated by HeyHenry', pageWidth / 2, doc.internal.pageSize.getHeight() - 10, {
    align: 'center',
  });

  const arrayBuf = doc.output('arraybuffer');
  return Buffer.from(arrayBuf);
}
