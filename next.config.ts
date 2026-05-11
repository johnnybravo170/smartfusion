import { withSentryConfig } from '@sentry/nextjs';
import type { NextConfig } from 'next';

const nextConfig: NextConfig = {
  images: {
    remotePatterns: [new URL('https://*.supabase.co/storage/**')],
  },
  // The single `src/pages/api/henry/gemini-proxy.ts` route triggers Next's
  // pages-compat type augmentation in next-env.d.ts, which flips
  // useSearchParams/useParams/usePathname return types to nullable across
  // all app-router code. The project's `pnpm typecheck` step runs without
  // that augmentation and is the authoritative type gate; skip the
  // duplicate check inside `next build` so deploys don't spuriously fail.
  typescript: {
    ignoreBuildErrors: true,
  },
  experimental: {
    serverActions: {
      // Photo uploads travel through server actions as multipart FormData.
      // Next.js defaults to 1MB. Project intake batches multiple phone
      // jpgs + PDFs in a single action, so we lift to 50mb to match
      // Supabase Storage's 50MiB cap. Per-file 10MB enforcement still
      // happens inside each action.
      bodySizeLimit: '50mb',
    },
  },
};

export default withSentryConfig(nextConfig, {
  // For all available options, see:
  // https://www.npmjs.com/package/@sentry/webpack-plugin#options

  org: 'smart-fusion-marketing-inc-6r',

  project: 'heyhenry',

  // Only print logs for uploading source maps in CI
  silent: !process.env.CI,

  // For all available options, see:
  // https://docs.sentry.io/platforms/javascript/guides/nextjs/manual-setup/

  // Upload a larger set of source maps for prettier stack traces (increases build time)
  widenClientFileUpload: true,

  webpack: {
    // Enables automatic instrumentation of Vercel Cron Monitors. (Does not yet work with App Router route handlers.)
    // See the following for more information:
    // https://docs.sentry.io/product/crons/
    // https://vercel.com/docs/cron-jobs
    automaticVercelMonitors: true,

    // Tree-shaking options for reducing bundle size
    treeshake: {
      // Automatically tree-shake Sentry logger statements to reduce bundle size
      removeDebugLogging: true,
    },
  },
});
