import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { NextConfig } from 'next';

// Pin the Turbopack root to the workspace directory containing this
// package (one level up from ops/). Without this, Next.js picks
// whichever pnpm-workspace.yaml it finds first when walking up — in
// Claude worktrees that's the *main* checkout, which then drags the
// parent app's instrumentation/sentry files into the ops compile and
// crashes on a missing alias. The root must encompass the symlinked
// pnpm store at the workspace root, so we can't pin to ops/ itself.
const here = path.dirname(fileURLToPath(import.meta.url));
const workspaceRoot = path.resolve(here, '..');

const nextConfig: NextConfig = {
  reactStrictMode: true,
  turbopack: {
    root: workspaceRoot,
  },
};

export default nextConfig;
