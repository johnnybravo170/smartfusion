import Link from 'next/link';

/**
 * HeyHenry wordmark — the H badge from /icons/icon.svg paired with the
 * wordmark in HeyHenry's primary type. Used in auth pages, marketing
 * touchpoints inside the app, and anywhere we need a "this is HeyHenry"
 * anchor that isn't the dashboard logo (which is the tenant's business).
 */
export function HeyHenryWordmark({ className = '' }: { className?: string }) {
  return (
    <Link href="/" className={`inline-flex items-center gap-2 ${className}`} aria-label="HeyHenry">
      <span
        aria-hidden
        className="inline-flex size-7 items-center justify-center rounded-md bg-foreground text-background font-bold text-sm"
      >
        H
      </span>
      <span className="text-lg font-semibold tracking-tight">HeyHenry</span>
    </Link>
  );
}
