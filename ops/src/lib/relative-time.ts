/**
 * Render an ISO timestamp as "X ago" / "in Y" relative to now.
 * Coarse buckets — operator dashboard, not a typing app.
 */
export function relativeTime(iso: string | Date | null | undefined, now = new Date()): string {
  if (!iso) return '—';
  const d = iso instanceof Date ? iso : new Date(iso);
  const diffMs = now.getTime() - d.getTime();
  const past = diffMs >= 0;
  const abs = Math.abs(diffMs);
  const sec = Math.round(abs / 1000);
  const min = Math.round(sec / 60);
  const hr = Math.round(min / 60);
  const day = Math.round(hr / 24);

  let out: string;
  if (sec < 60) out = `${sec}s`;
  else if (min < 60) out = `${min}m`;
  else if (hr < 48) out = `${hr}h`;
  else out = `${day}d`;

  return past ? `${out} ago` : `in ${out}`;
}
