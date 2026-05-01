/**
 * Timezone-aware date formatting utilities.
 * All display dates should go through these functions.
 */

const DEFAULT_TZ = 'America/Vancouver';

export function formatDate(
  date: string | Date | null | undefined,
  options?: { timezone?: string; style?: 'short' | 'medium' | 'long' },
): string {
  if (!date) return '\u2014';
  const d = typeof date === 'string' ? new Date(date) : date;
  if (Number.isNaN(d.getTime())) return '\u2014';

  const tz = options?.timezone || DEFAULT_TZ;
  const style = options?.style || 'medium';

  return new Intl.DateTimeFormat('en-CA', {
    dateStyle: style,
    timeZone: tz,
  }).format(d);
}

export function formatDateTime(
  date: string | Date | null | undefined,
  options?: {
    timezone?: string;
    dateStyle?: 'short' | 'medium' | 'long';
    timeStyle?: 'short' | 'medium';
  },
): string {
  if (!date) return '\u2014';
  const d = typeof date === 'string' ? new Date(date) : date;
  if (Number.isNaN(d.getTime())) return '\u2014';

  const tz = options?.timezone || DEFAULT_TZ;

  return new Intl.DateTimeFormat('en-CA', {
    dateStyle: options?.dateStyle || 'medium',
    timeStyle: options?.timeStyle || 'short',
    timeZone: tz,
  }).format(d);
}

/**
 * Compact date for dense lists ("Apr 25"). When the date isn't in the
 * current calendar year, append a 2-digit year ("Apr 25 '25") so the
 * operator still has anchor without spending the width on a full year.
 */
export function formatDateShort(
  date: string | Date | null | undefined,
  options?: { timezone?: string },
): string {
  if (!date) return '—';
  const d = typeof date === 'string' ? new Date(date) : date;
  if (Number.isNaN(d.getTime())) return '—';

  const tz = options?.timezone || DEFAULT_TZ;
  const monthDay = new Intl.DateTimeFormat('en-CA', {
    month: 'short',
    day: 'numeric',
    timeZone: tz,
  }).format(d);

  const dateYear = Number(
    new Intl.DateTimeFormat('en-CA', { year: 'numeric', timeZone: tz }).format(d),
  );
  const currentYear = Number(
    new Intl.DateTimeFormat('en-CA', { year: 'numeric', timeZone: tz }).format(new Date()),
  );
  if (dateYear !== currentYear) {
    return `${monthDay} '${String(dateYear).slice(-2)}`;
  }
  return monthDay;
}

export function formatRelativeTime(
  date: string | Date | null | undefined,
  options?: { timezone?: string },
): string {
  if (!date) return '\u2014';
  const d = typeof date === 'string' ? new Date(date) : date;
  if (Number.isNaN(d.getTime())) return '\u2014';

  const now = new Date();
  const diffMs = now.getTime() - d.getTime();
  const diffSecs = Math.floor(diffMs / 1000);
  const diffMins = Math.floor(diffSecs / 60);
  const diffHours = Math.floor(diffMins / 60);
  const diffDays = Math.floor(diffHours / 24);

  if (diffSecs < 60) return 'Just now';
  if (diffMins < 60) return `${diffMins}m ago`;
  if (diffHours < 24) return `${diffHours}h ago`;
  if (diffDays === 1) return 'Yesterday';
  if (diffDays < 7) return `${diffDays}d ago`;

  return formatDate(d, options);
}
