/**
 * Append a `?from=&fromLabel=` pair to a detail-page URL so the page's
 * `<DetailPageNav>` can render a labelled smart-back ("Back to Customer
 * Billing") instead of falling through to the generic browser-history
 * back. Use this when you know exactly where the operator is coming from
 * — typically inside a project tab linking out to an invoice / quote /
 * job / contact.
 *
 * Skip threading for plain list rows (e.g. /invoices table → invoice
 * detail). DetailPageNav's same-origin referrer check already covers
 * that case with `router.back()`.
 *
 * Example:
 *   withFrom(`/invoices/${id}`, `/projects/${projectId}?tab=invoices`,
 *            'Customer Billing')
 *   → `/invoices/abc?from=%2Fprojects%2Fxyz%3Ftab%3Dinvoices&fromLabel=Customer%20Billing`
 */
export function withFrom(href: string, fromHref: string, fromLabel: string): string {
  const sep = href.includes('?') ? '&' : '?';
  return `${href}${sep}from=${encodeURIComponent(fromHref)}&fromLabel=${encodeURIComponent(fromLabel)}`;
}
