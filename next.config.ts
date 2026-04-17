import type { NextConfig } from 'next';

const nextConfig: NextConfig = {
  images: {
    remotePatterns: [new URL('https://*.supabase.co/storage/**')],
  },
};

export default nextConfig;
