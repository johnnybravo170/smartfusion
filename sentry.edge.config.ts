// Edge runtime Sentry init (middleware, edge routes).
// https://docs.sentry.io/platforms/javascript/guides/nextjs/

import * as Sentry from '@sentry/nextjs';
import { scrubEvent } from '@/lib/sentry/scrub';

Sentry.init({
  dsn: 'https://8b1420897a92740b7887ba850050467c@o4511284340457472.ingest.de.sentry.io/4511284356448336',

  // Only send events from real Vercel deploys. See instrumentation-client.ts.
  enabled: !!process.env.VERCEL_ENV,

  environment: process.env.VERCEL_ENV ?? process.env.NODE_ENV,

  tracesSampleRate: 1,

  enableLogs: true,

  sendDefaultPii: false,
  beforeSend: scrubEvent,
});
