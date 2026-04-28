/**
 * Pure render of the customer-facing estimate. Shared between the public
 * `/estimate/[code]` page and the authed `/projects/[id]/estimate/preview`
 * page so both show the exact same thing.
 */

import { Fragment } from 'react';
import { formatCurrency } from '@/lib/pricing/calculator';
import { EstimatePhotoLightbox } from './estimate-photo-lightbox';

export type EstimateRenderLine = {
  id: string;
  label: string;
  notes: string | null;
  qty: number;
  unit: string;
  unit_price_cents: number;
  line_price_cents: number;
  category: string;
  /**
   * Bucket this line belongs to. Used for grouping on the customer-facing
   * estimate. Lines without a bucket group under "Other".
   */
  budget_category_id?: string | null;
  budget_category_name?: string | null;
  bucket_section?: string | null;
  bucket_order?: number;
  /** Optional description for the bucket. Rendered as subtext under the bucket header. */
  bucket_description?: string | null;
  /** Signed URLs to any photos attached to this line. */
  photo_urls?: string[];
};

export type EstimateRenderProps = {
  businessName: string;
  /** Signed URL to the tenant's logo image, or null. */
  logoUrl: string | null;
  customerName: string;
  customerAddress?: string | null;
  projectName: string;
  description: string | null;
  /** Management fee decimal (e.g. 0.12 for 12%). */
  managementFeeRate: number;
  /** GST decimal (e.g. 0.05 for 5%). Set to 0 to hide the GST row. */
  gstRate: number;
  /**
   * Optional label override for the tax row (e.g. "HST 13%", "GST 5% + PST 7%").
   * If set, replaces the auto-computed "GST (X%)" label — use when the
   * tenant's province has HST or a non-standard breakdown.
   */
  taxLabel?: string;
  /** Optional quote date to show in the header. ISO string. */
  quoteDate?: string | null;
  lines: EstimateRenderLine[];
  status: 'draft' | 'pending_approval' | 'approved' | 'declined';
  approvedByName?: string | null;
  approvedAt?: string | null;
  declinedReason?: string | null;
  gstNumber?: string | null;
  wcbNumber?: string | null;
  /** Free-form terms / notes. Rendered below the total, above the tax/WCB footer. */
  termsText?: string | null;
  /**
   * Document framing: 'estimate' (default, ballpark) or 'quote' (fixed-price,
   * binding). Only affects the heading / status copy on the customer-facing page.
   */
  documentType?: 'estimate' | 'quote';
};

function formatDate(iso: string | null | undefined): string | null {
  if (!iso) return null;
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return null;
  return d.toLocaleDateString('en-CA', { month: 'long', day: 'numeric', year: 'numeric' });
}

/**
 * Group lines by bucket (budget_category_id) and then by section. Renders the same
 * columns in each bucket's own table so the customer sees the contractor's
 * chosen divisions (e.g. UPSTAIRS WORK → Closets, Vanity, Paint) rather
 * than a single flat list.
 */
function renderGroups(lines: EstimateRenderLine[]) {
  type Bucket = {
    key: string;
    bucketName: string;
    description: string | null;
    order: number;
    lines: EstimateRenderLine[];
  };
  type Section = {
    key: string;
    section: string | null;
    order: number;
    buckets: Bucket[];
  };
  const byBucket = new Map<string, Bucket & { section: string | null }>();
  for (const l of lines) {
    const key = l.budget_category_id ?? '__none__';
    const g = byBucket.get(key) ?? {
      key,
      section: l.bucket_section ?? null,
      bucketName: l.budget_category_name ?? 'Other',
      description: l.bucket_description ?? null,
      order: l.bucket_order ?? Number.MAX_SAFE_INTEGER,
      lines: [],
    };
    g.lines.push(l);
    byBucket.set(key, g);
  }
  const bySection = new Map<string, Section>();
  for (const b of byBucket.values()) {
    const sKey = b.section ?? '__none__';
    const s = bySection.get(sKey) ?? {
      key: sKey,
      section: b.section,
      order: b.order,
      buckets: [],
    };
    s.buckets.push({
      key: b.key,
      bucketName: b.bucketName,
      description: b.description,
      order: b.order,
      lines: b.lines,
    });
    s.order = Math.min(s.order, b.order);
    bySection.set(sKey, s);
  }
  const sections = Array.from(bySection.values())
    .map((s) => ({ ...s, buckets: s.buckets.sort((a, b) => a.order - b.order) }))
    .sort((a, b) => a.order - b.order);

  return (
    <div className="rounded-md border">
      <table className="w-full table-fixed text-sm">
        <colgroup>
          <col />
          <col className="w-28" />
        </colgroup>
        <thead>
          <tr className="border-b bg-muted/50">
            <th className="px-3 py-2 text-left font-medium">Item</th>
            <th className="px-3 py-2 text-right font-medium">Total</th>
          </tr>
        </thead>
        <tbody>
          {sections.map((sec) => (
            <Fragment key={sec.key}>
              {sec.section ? (
                <tr className="border-b bg-muted/30">
                  <td
                    colSpan={2}
                    className="px-3 py-1.5 text-[10px] font-semibold uppercase tracking-wider text-muted-foreground"
                  >
                    {sec.section}
                  </td>
                </tr>
              ) : null}
              {sec.buckets.flatMap((g) => [
                ...(g.description?.trim()
                  ? [
                      <tr key={`${g.key}__desc`} className="border-b bg-muted/10">
                        <td colSpan={2} className="px-3 py-2">
                          <p className="text-xs font-medium text-foreground">{g.bucketName}</p>
                          <p className="mt-0.5 whitespace-pre-wrap text-xs text-muted-foreground">
                            {g.description.trim()}
                          </p>
                        </td>
                      </tr>,
                    ]
                  : []),
                ...g.lines.map((l) => {
                  const hasDetail = !!l.notes || (l.photo_urls && l.photo_urls.length > 0);
                  const detailContent = hasDetail ? (
                    <>
                      {l.notes ? (
                        <p className="whitespace-pre-wrap text-xs text-muted-foreground">
                          {l.notes}
                        </p>
                      ) : null}
                      {l.photo_urls && l.photo_urls.length > 0 ? (
                        <EstimatePhotoLightbox urls={l.photo_urls} />
                      ) : null}
                    </>
                  ) : null;
                  return (
                    <Fragment key={l.id}>
                      <tr className={hasDetail ? 'align-top' : 'align-top border-b last:border-0'}>
                        <td className="px-3 py-2">
                          <p className="font-medium">{l.label}</p>
                          {/* Desktop: inline under the label */}
                          {hasDetail ? (
                            <div className="mt-0.5 hidden sm:block">{detailContent}</div>
                          ) : null}
                        </td>
                        <td className="px-3 py-2 text-right font-medium">
                          {formatCurrency(l.line_price_cents)}
                        </td>
                      </tr>
                      {/* Mobile: full-width row below */}
                      {hasDetail ? (
                        <tr className="border-b last:border-0 sm:hidden">
                          <td colSpan={2} className="px-3 pb-3 pt-0">
                            {detailContent}
                          </td>
                        </tr>
                      ) : null}
                    </Fragment>
                  );
                }),
              ])}
            </Fragment>
          ))}
        </tbody>
      </table>
    </div>
  );
}

export function EstimateRender({
  businessName,
  logoUrl,
  customerName,
  customerAddress,
  projectName,
  description,
  managementFeeRate,
  gstRate,
  taxLabel,
  quoteDate,
  lines,
  status,
  approvedByName,
  approvedAt,
  declinedReason,
  gstNumber,
  wcbNumber,
  termsText,
  documentType = 'estimate',
}: EstimateRenderProps) {
  const docLabel = documentType === 'quote' ? 'Quote' : 'Estimate';
  const subtotal = lines.reduce((s, l) => s + l.line_price_cents, 0);
  const mgmtFee = Math.round(subtotal * managementFeeRate);
  const beforeTax = subtotal + mgmtFee;
  const gst = Math.round(beforeTax * gstRate);
  const total = beforeTax + gst;

  const dateLabel = formatDate(quoteDate) ?? formatDate(new Date().toISOString());

  return (
    <>
      {/* Branded header: logo + business name on the left, Estimate title + date on the right. */}
      <header className="mb-8 flex items-start justify-between gap-6 border-b pb-6">
        <div className="flex min-w-0 items-center gap-3">
          {logoUrl ? (
            // biome-ignore lint/performance/noImgElement: signed URLs don't flow through next/image
            <img
              src={logoUrl}
              alt={businessName}
              className="h-12 w-auto max-w-[240px] object-contain"
            />
          ) : (
            <p className="truncate text-base font-semibold">{businessName}</p>
          )}
        </div>
        <div className="text-right">
          <p className="text-xs font-medium uppercase tracking-wider text-muted-foreground">
            {docLabel}
          </p>
          {dateLabel ? <p className="mt-0.5 text-sm text-muted-foreground">{dateLabel}</p> : null}
        </div>
      </header>

      {/* Customer + project block */}
      <div className="mb-6 grid gap-4 sm:grid-cols-2">
        <div>
          <p className="text-xs font-medium uppercase tracking-wider text-muted-foreground">
            Prepared for
          </p>
          <p className="mt-1 text-sm font-medium">{customerName}</p>
          {customerAddress ? (
            <p className="mt-0.5 whitespace-pre-line text-sm text-muted-foreground">
              {customerAddress}
            </p>
          ) : null}
        </div>
        <div>
          <p className="text-xs font-medium uppercase tracking-wider text-muted-foreground">
            Project
          </p>
          <p className="mt-1 text-sm font-medium">{projectName}</p>
        </div>
      </div>

      {status === 'approved' && approvedByName && approvedAt ? (
        <div className="mb-6 rounded-md bg-emerald-50 px-4 py-3 text-sm text-emerald-800">
          Approved by {approvedByName} on {formatDate(approvedAt)}.
        </div>
      ) : null}
      {status === 'declined' ? (
        <div className="mb-6 rounded-md bg-red-50 px-4 py-3 text-sm text-red-800">
          This {docLabel.toLowerCase()} was declined.
          {declinedReason ? ` Reason: ${declinedReason}` : ''}
        </div>
      ) : null}
      {status === 'draft' ? (
        <div className="mb-6 rounded-md bg-amber-50 px-4 py-3 text-sm text-amber-800">
          This {docLabel.toLowerCase()} is not yet published.
        </div>
      ) : null}

      {description ? (
        <p className="mb-6 whitespace-pre-wrap text-sm leading-relaxed text-muted-foreground">
          {description}
        </p>
      ) : null}

      {renderGroups(lines)}

      <div className="mt-4 space-y-1 text-sm">
        <div className="flex justify-between">
          <span className="text-muted-foreground">Subtotal</span>
          <span>{formatCurrency(subtotal)}</span>
        </div>
        {mgmtFee > 0 ? (
          <div className="flex justify-between">
            <span className="text-muted-foreground">
              Management fee ({Math.round(managementFeeRate * 100)}%)
            </span>
            <span>{formatCurrency(mgmtFee)}</span>
          </div>
        ) : null}
        {gst > 0 ? (
          <div className="flex justify-between">
            <span className="text-muted-foreground">
              {taxLabel ?? `GST (${(gstRate * 100).toFixed(gstRate * 100 < 1 ? 2 : 0)}%)`}
            </span>
            <span>{formatCurrency(gst)}</span>
          </div>
        ) : null}
        <div className="flex justify-between border-t pt-2 text-base font-semibold">
          <span>Total</span>
          <span>{formatCurrency(total)}</span>
        </div>
      </div>

      {termsText?.trim() ? (
        <section className="mt-6 border-t pt-4">
          <h3 className="mb-2 text-xs font-semibold uppercase tracking-wider text-muted-foreground">
            Terms &amp; notes
          </h3>
          <p className="whitespace-pre-wrap text-sm leading-relaxed text-foreground">
            {termsText.trim()}
          </p>
        </section>
      ) : null}

      {gstNumber || wcbNumber ? (
        <p className="mt-4 text-xs text-muted-foreground">
          {[gstNumber ? `GST: ${gstNumber}` : null, wcbNumber ? `WCB: ${wcbNumber}` : null]
            .filter(Boolean)
            .join('  ·  ')}
        </p>
      ) : null}
    </>
  );
}
