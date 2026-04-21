/**
 * Pure render of the customer-facing estimate. Shared between the public
 * `/estimate/[code]` page (what the customer sees) and the authed
 * `/projects/[id]/estimate/preview` page (what the operator sees before
 * sending). Adding a banner, CTA, etc. should happen in the caller — this
 * component only renders the estimate body.
 */

import { formatCurrency } from '@/lib/pricing/calculator';

export type EstimateRenderLine = {
  id: string;
  label: string;
  notes: string | null;
  qty: number;
  unit: string;
  unit_price_cents: number;
  line_price_cents: number;
  category: string;
};

export type EstimateRenderProps = {
  businessName: string;
  customerName: string;
  projectName: string;
  description: string | null;
  managementFeeRate: number;
  lines: EstimateRenderLine[];
  status: 'draft' | 'pending_approval' | 'approved' | 'declined';
  approvedByName?: string | null;
  approvedAt?: string | null;
  declinedReason?: string | null;
};

export function EstimateRender({
  businessName,
  customerName,
  projectName,
  description,
  managementFeeRate,
  lines,
  status,
  approvedByName,
  approvedAt,
  declinedReason,
}: EstimateRenderProps) {
  const subtotal = lines.reduce((s, l) => s + l.line_price_cents, 0);
  const mgmtFee = Math.round(subtotal * managementFeeRate);
  const total = subtotal + mgmtFee;

  return (
    <>
      <div className="mb-6 text-center">
        <p className="text-sm font-medium text-muted-foreground">{businessName}</p>
        <h1 className="mt-1 text-2xl font-semibold">Estimate</h1>
        <p className="mt-1 text-sm text-muted-foreground">
          {projectName} · for {customerName}
        </p>
      </div>

      {status === 'approved' && approvedByName && approvedAt ? (
        <div className="mb-6 rounded-md bg-emerald-50 px-4 py-3 text-sm text-emerald-800">
          Approved by {approvedByName} on{' '}
          {new Date(approvedAt).toLocaleDateString('en-CA', {
            month: 'long',
            day: 'numeric',
            year: 'numeric',
          })}
          .
        </div>
      ) : null}
      {status === 'declined' ? (
        <div className="mb-6 rounded-md bg-red-50 px-4 py-3 text-sm text-red-800">
          This estimate was declined.
          {declinedReason ? ` Reason: ${declinedReason}` : ''}
        </div>
      ) : null}
      {status === 'draft' ? (
        <div className="mb-6 rounded-md bg-amber-50 px-4 py-3 text-sm text-amber-800">
          This estimate is not yet published.
        </div>
      ) : null}

      {description ? (
        <p className="mb-6 whitespace-pre-wrap text-sm leading-relaxed text-muted-foreground">
          {description}
        </p>
      ) : null}

      <div className="overflow-x-auto rounded-md border">
        <table className="w-full text-sm">
          <thead>
            <tr className="border-b bg-muted/50">
              <th className="px-3 py-2 text-left font-medium">Item</th>
              <th className="px-3 py-2 text-right font-medium">Qty</th>
              <th className="px-3 py-2 text-left font-medium">Unit</th>
              <th className="px-3 py-2 text-right font-medium">Price</th>
              <th className="px-3 py-2 text-right font-medium">Total</th>
            </tr>
          </thead>
          <tbody>
            {lines.map((l) => (
              <tr key={l.id} className="align-top border-b last:border-0">
                <td className="px-3 py-2">
                  <p className="font-medium">{l.label}</p>
                  {l.notes ? (
                    <p className="whitespace-pre-wrap text-xs text-muted-foreground">{l.notes}</p>
                  ) : null}
                </td>
                <td className="px-3 py-2 text-right">{Number(l.qty)}</td>
                <td className="px-3 py-2 text-muted-foreground">{l.unit}</td>
                <td className="px-3 py-2 text-right">{formatCurrency(l.unit_price_cents)}</td>
                <td className="px-3 py-2 text-right font-medium">
                  {formatCurrency(l.line_price_cents)}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

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
        <div className="flex justify-between border-t pt-2 text-base font-semibold">
          <span>Total</span>
          <span>{formatCurrency(total)}</span>
        </div>
      </div>
    </>
  );
}
