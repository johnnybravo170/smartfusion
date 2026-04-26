/**
 * Root 404 page. Server component — Sentry doesn't need to capture 404s
 * (they're noise, not errors), but we render a real branded page instead
 * of the bare Next.js fallback.
 */

import Link from 'next/link';
import { Button } from '@/components/ui/button';

export default function NotFound() {
  return (
    <div className="flex min-h-[60vh] flex-col items-center justify-center gap-4 p-8 text-center">
      <h1 className="text-3xl font-semibold">404</h1>
      <p className="text-muted-foreground max-w-md">This page doesn't exist or has moved.</p>
      <Button asChild>
        <Link href="/">Go home</Link>
      </Button>
    </div>
  );
}
