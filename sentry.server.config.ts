// Server-side Sentry init. Loaded from instrumentation.ts in the Node runtime.
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

  // PIPEDA: no IPs, cookies, headers, request bodies, or email/username.
  // We tag with UUIDs only via Sentry.setUser in the dashboard layout.
  sendDefaultPii: false,
  beforeSend: scrubEvent,
});
