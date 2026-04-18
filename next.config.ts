import type { NextConfig } from 'next';

const nextConfig: NextConfig = {
  images: {
    remotePatterns: [new URL('https://*.supabase.co/storage/**')],
  },
  experimental: {
    serverActions: {
      // Photo uploads travel through uploadPhotoAction as multipart FormData.
      // Next.js defaults to 1MB which is too small for resized phone camera
      // JPEGs (2-4MB is common). Bumped to 15MB to match the Supabase
      // Storage upload cap of 50MiB comfortably.
      bodySizeLimit: '15mb',
    },
  },
};

export default nextConfig;
