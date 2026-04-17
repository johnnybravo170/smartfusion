/**
 * Small relative-time helper. No external date lib — we use Intl for the
 * absolute fallback and compare timestamps by hand for recent intervals.
 *
 * Returns values like "just now", "2m ago", "3h ago", "Yesterday",
 * "3d ago", or an absolute date (e.g. "Apr 14") for anything older than a
 * week. Callers pair the output with a `title` attribute that carries the
 * full ISO so hovering reveals precision.
 *
 * All formatters accept an optional `timezone` string (IANA) so dates
 * render in the tenant's local time instead of the server's UTC.
 */

const DEFAULT_TZ = 'America/Vancouver';

function makeDateFormatter(tz: string) {
  return new Intl.DateTimeFormat('en-CA', {
    month: 'short',
    day: 'numeric',
    timeZone: tz,
  });
}

function makeDateYearFormatter(tz: string) {
  return new Intl.DateTimeFormat('en-CA', {
    month: 'short',
    day: 'numeric',
    year: 'numeric',
    timeZone: tz,
  });
}

export function formatRelativeTime(
  iso: string,
  now: Date = new Date(),
  timezone: string = DEFAULT_TZ,
): string {
  const ts = new Date(iso);
  if (Number.isNaN(ts.getTime())) return '\u2014';

  const diffMs = now.getTime() - ts.getTime();
  const diffSec = Math.round(diffMs / 1000);
  const diffMin = Math.round(diffSec / 60);
  const diffHour = Math.round(diffMin / 60);
  const diffDay = Math.round(diffHour / 24);

  if (diffSec < 45) return 'just now';
  if (diffMin < 60) return `${diffMin}m ago`;
  if (diffHour < 24) return `${diffHour}h ago`;
  if (diffDay === 1) return 'Yesterday';
  if (diffDay < 7) return `${diffDay}d ago`;

  const sameYear = ts.getFullYear() === now.getFullYear();
  const formatter = sameYear ? makeDateFormatter(timezone) : makeDateYearFormatter(timezone);
  return formatter.format(ts);
}

function makeTimestampFormatter(tz: string) {
  return new Intl.DateTimeFormat('en-CA', {
    dateStyle: 'medium',
    timeStyle: 'short',
    timeZone: tz,
  });
}

export function formatAbsolute(iso: string, timezone: string = DEFAULT_TZ): string {
  const ts = new Date(iso);
  if (Number.isNaN(ts.getTime())) return iso;
  return makeTimestampFormatter(timezone).format(ts);
}

/**
 * Bucket for worklog grouping: 'Today' / 'Yesterday' / absolute date string.
 */
function makeDayHeadingFormatter(tz: string) {
  return new Intl.DateTimeFormat('en-CA', {
    weekday: 'long',
    month: 'short',
    day: 'numeric',
    timeZone: tz,
  });
}

export function dayBucketLabel(
  iso: string,
  now: Date = new Date(),
  timezone: string = DEFAULT_TZ,
): string {
  const ts = new Date(iso);
  if (Number.isNaN(ts.getTime())) return 'Unknown';

  const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  const tsDay = new Date(ts.getFullYear(), ts.getMonth(), ts.getDate());
  const diffDays = Math.round((today.getTime() - tsDay.getTime()) / (24 * 3600 * 1000));
  if (diffDays === 0) return 'Today';
  if (diffDays === 1) return 'Yesterday';

  const sameYear = ts.getFullYear() === now.getFullYear();
  if (sameYear) {
    return makeDayHeadingFormatter(timezone).format(ts);
  }
  return makeDateYearFormatter(timezone).format(ts);
}

/**
 * Due date bucket for the todos list.
 * Returns 'overdue' | 'today' | 'upcoming' | 'none'.
 */
export function todoDueBucket(
  due_date: string | null | undefined,
  now: Date = new Date(),
): 'overdue' | 'today' | 'upcoming' | 'none' {
  if (!due_date) return 'none';
  // due_date is a DATE (YYYY-MM-DD); parse as local midnight to avoid TZ drift.
  const [y, m, d] = due_date.slice(0, 10).split('-').map(Number);
  if (!y || !m || !d) return 'none';
  const due = new Date(y, m - 1, d);
  const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());

  if (due.getTime() < today.getTime()) return 'overdue';
  if (due.getTime() === today.getTime()) return 'today';
  return 'upcoming';
}

/**
 * Human label for a due date like "Today", "Tomorrow", "Fri Apr 18".
 */
function makeDueLabelFormatter(tz: string) {
  return new Intl.DateTimeFormat('en-CA', {
    weekday: 'short',
    month: 'short',
    day: 'numeric',
    timeZone: tz,
  });
}

export function formatDueDate(
  iso: string,
  now: Date = new Date(),
  timezone: string = DEFAULT_TZ,
): string {
  const [y, m, d] = iso.slice(0, 10).split('-').map(Number);
  if (!y || !m || !d) return iso;
  const due = new Date(y, m - 1, d);
  const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  const diffDays = Math.round((due.getTime() - today.getTime()) / (24 * 3600 * 1000));

  if (diffDays === 0) return 'Today';
  if (diffDays === 1) return 'Tomorrow';
  if (diffDays === -1) return 'Yesterday';
  return makeDueLabelFormatter(timezone).format(due);
}
