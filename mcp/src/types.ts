/**
 * Shared types and formatting helpers for the MCP server.
 */

/** Format cents as CAD currency string. */
export function formatCad(cents: number): string {
  const dollars = cents / 100;
  return new Intl.NumberFormat('en-CA', {
    style: 'currency',
    currency: 'CAD',
  }).format(dollars);
}

/** Format a date string or Date as a readable date. */
export function formatDate(value: string | Date | null | undefined): string {
  if (!value) return 'N/A';
  const d = typeof value === 'string' ? new Date(value) : value;
  if (Number.isNaN(d.getTime())) return 'N/A';
  return d.toLocaleDateString('en-CA', {
    year: 'numeric',
    month: 'short',
    day: 'numeric',
  });
}

/** Format a date with time. */
export function formatDateTime(value: string | Date | null | undefined): string {
  if (!value) return 'N/A';
  const d = typeof value === 'string' ? new Date(value) : value;
  if (Number.isNaN(d.getTime())) return 'N/A';
  return d.toLocaleDateString('en-CA', {
    year: 'numeric',
    month: 'short',
    day: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
  });
}

/** Build a text content response for MCP. */
export function textResult(text: string) {
  return {
    content: [{ type: 'text' as const, text }],
  };
}

/** Build an error response for MCP. */
export function errorResult(message: string) {
  return {
    content: [{ type: 'text' as const, text: `Error: ${message}` }],
    isError: true,
  };
}

/** Capitalize first letter of a string. */
export function capitalize(s: string): string {
  return s.charAt(0).toUpperCase() + s.slice(1);
}

/** Status label map for jobs. */
export const jobStatusLabels: Record<string, string> = {
  booked: 'Booked',
  in_progress: 'In Progress',
  complete: 'Complete',
  cancelled: 'Cancelled',
};

/** Status label map for quotes. */
export const quoteStatusLabels: Record<string, string> = {
  draft: 'Draft',
  sent: 'Sent',
  accepted: 'Accepted',
  rejected: 'Rejected',
  expired: 'Expired',
};

/** Status label map for invoices. */
export const invoiceStatusLabels: Record<string, string> = {
  draft: 'Draft',
  sent: 'Sent',
  paid: 'Paid',
  void: 'Void',
};
