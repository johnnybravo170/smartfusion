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
