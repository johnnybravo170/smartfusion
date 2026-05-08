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
   * Budget category this line belongs to. Used for grouping on the customer-facing
   * estimate. Lines without a category group under "Other".
   */
  budget_category_id?: string | null;
  budget_category_name?: string | null;
  budget_category_section?: string | null;
  budget_category_order?: number;
  /** Optional description for the category. Rendered as subtext under the category header. */
  budget_category_description?: string | null;
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
  /** IANA timezone for the contractor (e.g. 'America/Vancouver'). */
  timezone?: string | null;
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

function formatDate(iso: string | null | undefined, tz: string | null | undefined): string | null {
  if (!iso) return null;
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return null;
  return new Intl.DateTimeFormat('en-CA', {
    dateStyle: 'long',
    timeZone: tz ?? 'America/Vancouver',
  }).format(d);
}

/**
 * Group lines by category (budget_category_id) and then by section.
 *
 * Customer view layout:
 *   - Section header: prominent (sm-base text, bold, distinct bar) so
 *     the operator's chosen divisions are obvious at a glance.
 *   - Category: native <details>, collapsed by default. The summary
 *     row shows the category name + the sum of its line prices —
 *     enough info that a customer can scan the full estimate without
 *     opening anything. Click to expand for individual line items,
 *     descriptions, and photos.
 *   - Print stylesheet at the bottom forces every <details> open
 *     when the page is printed/saved-as-PDF, so the printed
 *     estimate is always complete.
 *
 * Layout uses a CSS grid (`grid-cols-[1fr_auto]`) instead of a
 * <table> so the disclosure widget can wrap each category cleanly
 * without fighting <table> semantics.
 */
function renderGroups(lines: EstimateRenderLine[]) {
  type Category = {
    key: string;
    categoryName: string;
    description: string | null;
    order: number;
    lines: EstimateRenderLine[];
  };
  type Section = {
    key: string;
    section: string | null;
    order: number;
    categories: Category[];
  };
  const byCategory = new Map<string, Category & { section: string | null }>();
  for (const l of lines) {
    const key = l.budget_category_id ?? '__none__';
    const g = byCategory.get(key) ?? {
      key,
      section: l.budget_category_section ?? null,
      categoryName: l.budget_category_name ?? 'Other',
      description: l.budget_category_description ?? null,
      order: l.budget_category_order ?? Number.MAX_SAFE_INTEGER,
      lines: [],
    };
    g.lines.push(l);
    byCategory.set(key, g);
  }
  const bySection = new Map<string, Section>();
  for (const b of byCategory.values()) {
    const sKey = b.section ?? '__none__';
    const s = bySection.get(sKey) ?? {
      key: sKey,
      section: b.section,
      order: b.order,
      categories: [],
    };
    s.categories.push({
      key: b.key,
      categoryName: b.categoryName,
      description: b.description,
      order: b.order,
      lines: b.lines,
    });
    s.order = Math.min(s.order, b.order);
    bySection.set(sKey, s);
  }
  const sections = Array.from(bySection.values())
    .map((s) => ({ ...s, categories: s.categories.sort((a, b) => a.order - b.order) }))
    .sort((a, b) => a.order - b.order);

  return (
    <>
      {/* Print: force every <details> open so PDF / paper output is
       *  complete even though the on-screen default is collapsed. */}
      <style>{`
        @media print {
          .estimate-categories details > *:not(summary) {
            display: block !important;
          }
          .estimate-categories details summary::-webkit-details-marker {
            display: none;
          }
          .estimate-categories details .estimate-chevron {
            display: none;
          }
        }
      `}</style>
      <div className="estimate-categories overflow-hidden rounded-md border">
        <div className="grid grid-cols-[1fr_auto] gap-x-3 border-b bg-muted/50 px-4 py-2 text-sm font-medium">
          <div>Item</div>
          <div className="text-right">Total</div>
        </div>
        {sections.map((sec) => (
          <Fragment key={sec.key}>
            {sec.section ? (
              <div className="border-b bg-foreground/5 px-4 py-2.5 text-sm font-bold uppercase tracking-wider text-foreground">
                {sec.section}
              </div>
            ) : null}
            {sec.categories.map((g) => {
              const categoryTotal = g.lines.reduce((s, l) => s + l.line_price_cents, 0);
              return (
                <details
                  key={g.key}
                  className="group border-b last:border-0 [&_summary]:list-none [&_summary::-webkit-details-marker]:hidden"
                >
                  <summary className="grid cursor-pointer grid-cols-[1fr_auto] items-baseline gap-x-3 px-4 py-3 hover:bg-muted/30">
                    <div className="flex items-baseline gap-2">
                      <span
                        aria-hidden
                        className="estimate-chevron inline-block w-3 text-muted-foreground transition-transform group-open:rotate-90"
                      >
                        ›
                      </span>
                      <span className="font-medium">{g.categoryName}</span>
                      <span className="text-xs text-muted-foreground">
                        {g.lines.length} {g.lines.length === 1 ? 'item' : 'items'}
                      </span>
                    </div>
                    <span className="font-medium tabular-nums">
                      {formatCurrency(categoryTotal)}
                    </span>
                  </summary>
                  <div className="bg-muted/10 px-4 pb-3 pt-1">
                    {g.description?.trim() ? (
                      <p className="mb-2 whitespace-pre-wrap text-xs text-muted-foreground">
                        {g.description.trim()}
                      </p>
                    ) : null}
                    <div className="divide-y divide-dashed">
                      {g.lines.map((l) => {
                        const hasDetail = !!l.notes || (l.photo_urls && l.photo_urls.length > 0);
                        return (
                          <div
                            key={l.id}
                            className="grid grid-cols-[1fr_auto] items-baseline gap-x-3 py-2"
                          >
                            <div>
                              <p className="text-sm">{l.label}</p>
                              {hasDetail ? (
                                <div className="mt-1 space-y-1">
                                  {l.notes ? (
                                    <p className="whitespace-pre-wrap text-xs text-muted-foreground">
                                      {l.notes}
                                    </p>
                                  ) : null}
                                  {l.photo_urls && l.photo_urls.length > 0 ? (
                                    <EstimatePhotoLightbox urls={l.photo_urls} />
                                  ) : null}
                                </div>
                              ) : null}
                            </div>
                            <span className="text-sm tabular-nums">
                              {formatCurrency(l.line_price_cents)}
                            </span>
                          </div>
                        );
                      })}
                    </div>
                  </div>
                </details>
              );
            })}
          </Fragment>
        ))}
      </div>
    </>
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
  timezone,
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

  const dateLabel =
    formatDate(quoteDate, timezone) ?? formatDate(new Date().toISOString(), timezone);

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
          Approved by {approvedByName} on {formatDate(approvedAt, timezone)}.
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
