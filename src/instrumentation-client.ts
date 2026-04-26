// Browser-side Sentry init.
// https://docs.sentry.io/platforms/javascript/guides/nextjs/

import * as Sentry from '@sentry/nextjs';
import { scrubEvent } from '@/lib/sentry/scrub';

Sentry.init({
  dsn: 'https://8b1420897a92740b7887ba850050467c@o4511284340457472.ingest.de.sentry.io/4511284356448336',

  // Only send events from real Vercel deploys. Local dev runs throw the
  // same errors over and over (missing Supabase envs, hot-reload glitches,
  // etc.) and would drown out real production signals.
  enabled: !!process.env.NEXT_PUBLIC_VERCEL_ENV,

  environment: process.env.NEXT_PUBLIC_VERCEL_ENV ?? 'development',

  tracesSampleRate: 1,

  enableLogs: true,

  // PIPEDA: no IPs, cookies, or default user PII. Tenant/user UUIDs come
  // from <SentryUserContext> mounted in the dashboard layout.
  sendDefaultPii: false,
  beforeSend: scrubEvent,
});

export const onRouterTransitionStart = Sentry.captureRouterTransitionStart;
